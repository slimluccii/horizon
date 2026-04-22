import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { LibraryIndex } from '../scanner/scanner.ts'
import type { SessionManager } from '../session/manager.ts'
import type { ClientCapabilities } from '../transcode/decision.ts'
import type { Profile } from '../transcode/profiles.ts'
import { decidePlayback } from '../transcode/decision.ts'
import { selectInitialProfile, selectRenditionLadder } from '../transcode/profiles.ts'
import {
  createSessionDir, spawnFfmpeg, restartAtSegment, waitForSegment,
  SEGMENT_DURATION_SEC, segmentName,
} from '../transcode/ffmpeg.ts'
import { extractSubtitles } from '../transcode/subtitles.ts'
import { handleWsMessage } from '../ws/handler.ts'

/** Lookahead window: segs >= currentStartSegment and within this many ahead are
 *  considered "current ffmpeg will get to them"; further-out segs trigger restart. */
const SEEK_LOOKAHEAD_SEGMENTS = 250

/** Build a static VOD-style rendition playlist covering the entire media duration.
 *  Segments are listed by their deterministic filename — they may not yet exist
 *  on disk; the segment route will spawn / wait for ffmpeg to produce them. */
function buildRenditionPlaylist(renditionIdx: number, durationSec: number): string {
  const totalSegs = Math.max(1, Math.ceil(durationSec / SEGMENT_DURATION_SEC))
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION_SEC}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${renditionIdx}/init_${renditionIdx}.mp4"`,
  ]
  for (let i = 0; i < totalSegs; i++) {
    const isLast = i === totalSegs - 1
    const dur = isLast
      ? Math.max(0.001, durationSec - i * SEGMENT_DURATION_SEC)
      : SEGMENT_DURATION_SEC
    lines.push(`#EXTINF:${dur.toFixed(3)},`)
    lines.push(`${renditionIdx}/${segmentName(i)}`)
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

interface CreateSessionBody {
  mediaId: string
  capabilities: ClientCapabilities
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
}

function buildMasterPlaylist(
  sessionId: string,
  profiles: Profile[],
  renditionCodecs: string[],
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '']
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    const bw = (p.videoBitrate + p.audioBitrate) * 1000
    const vCodec = renditionCodecs[i] ?? 'avc1.640028'
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${p.width}x${p.height},CODECS="${vCodec},mp4a.40.2"`)
    lines.push(`/sessions/${sessionId}/renditions/${i}.m3u8`)
  }
  return lines.join('\n')
}

export function registerSessions(
  app: FastifyInstance,
  cfg: Config,
  hwAccel: HwAccel,
  index: LibraryIndex,
  sessions: SessionManager,
) {
  app.post<{ Body: CreateSessionBody }>('/sessions', async (req, reply) => {
    const { mediaId, capabilities, audioTrackIndex = 0, subtitleTrackIndex = null } = req.body

    const media = index.byId.get(mediaId)
    if (!media) return reply.status(404).send({ error: 'Media not found', code: 'media-not-found' })

    if (sessions.size() >= cfg.maxSessions) {
      return reply.status(503).send({ error: 'Server at capacity', code: 'max-sessions' })
    }

    const decision = decidePlayback(media, capabilities)
    const [srcW] = (media.resolution ?? '1920x1080').split('x').map(Number)
    let topProfile = selectInitialProfile(capabilities.maxBitrate, srcW)
    // Tone-map runs on CPU (no zimg / no GPU tonemap on macOS) — 4K HDR
    // tonemap is slower than real-time on most machines, blowing cold-start.
    // Force 1080p for tonemapped streams; user gets full quality if they
    // upgrade later via quality-override (which restarts at the new profile).
    if (decision.needsToneMap && topProfile.width > 1920) {
      topProfile = { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080 }
    }
    // Tonemap also caps to single rendition: parallel encodes share the same
    // CPU-bound tonemap filter — adds latency without bandwidth benefit.
    const profiles = decision.method === 'transcode' && !decision.needsToneMap
      ? selectRenditionLadder(topProfile, cfg.maxRenditions, srcW)
      : [topProfile]

    // Create session first so its ID is known, then create the session dir using
    // that same ID — keeps session dir path and session ID in sync.
    const session = sessions.create({
      mediaId,
      filePath: media.filePath,
      method: decision.method,
      capabilities,
      selectedAudioTrack: audioTrackIndex,
      selectedSubtitleTrack: subtitleTrackIndex,
      profiles,
      renditionCodecs: [],
      needsToneMap: decision.needsToneMap,
      sessionDir: '',   // filled in below
      sessionReady: false,
      durationSec: media.duration,
    })
    const sessionDir = await createSessionDir(session.id)
    session.sessionDir = sessionDir

    if (decision.method !== 'direct-play') {
      spawnFfmpeg(session, hwAccel, profiles, audioTrackIndex).then(() => {
        session.sessionReady = true
        session.state = 'active'
        if (session.wsSocket) {
          session.wsSocket.send(JSON.stringify({
            type: 'session-ready',
            method: session.method,
            streamUrl: `/sessions/${session.id}/stream.m3u8`,
            profile: profiles[0],
            reconnectToken: session.reconnectToken,
          }))
        }
        // extract text subtitles in background; track on session so destroy() can kill it
        extractSubtitles(media.filePath, media.subtitleTracks ?? [], session.sessionDir, session)
          .catch(err => console.error(`Session ${session.id}: subtitle extraction error`, err))
      }).catch(err => {
        sessions.destroy(session.id)
        console.error('FFmpeg start error:', err)
      })
    } else {
      session.sessionReady = true
    }

    const streamUrl = decision.method === 'direct-play'
      ? `/sessions/${session.id}/direct`
      : `/sessions/${session.id}/stream.m3u8`

    return {
      sessionId: session.id,
      method: decision.method,
      streamUrl,
      wsUrl: `/sessions/${session.id}/ws`,
      profiles,
      selectedAudioTrack: audioTrackIndex,
      selectedSubtitleTrack: subtitleTrackIndex,
    }
  })

  app.get<{ Params: { id: string } }>('/sessions/:id/stream.m3u8', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
    if (session.method === 'direct-stream' || session.method === 'partial-transcode') {
      // Single rendition served as static VOD; segs resolve to /sessions/:id/renditions/0/...
      // (relative path "renditions/0/segNNNNN.m4s" against /sessions/:id/stream.m3u8 URL).
      const inner = buildRenditionPlaylist(0, session.durationSec)
      // Rewrite bare "0/seg…" → "renditions/0/seg…" so browser resolution lands on the seg route.
      const rewritten = inner
        .replace(/^0\//gm, 'renditions/0/')
        .replace(/URI="0\//g, 'URI="renditions/0/')
      return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(rewritten)
    }
    const master = buildMasterPlaylist(session.id, session.profiles, session.renditionCodecs)
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(master)
  })

  app.get<{ Params: { id: string; r: string } }>('/sessions/:id/renditions/:r.m3u8', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
    if (!/^\d+$/.test(req.params.r)) {
      return reply.status(400).send({ error: 'Invalid rendition', code: 'invalid-input' })
    }
    // Static VOD playlist covering the entire media duration. Segments listed
    // here may not yet exist on disk — the segment route below produces them
    // on demand, restarting ffmpeg if a request lands outside the current run's
    // segment range (= seek).
    const content = buildRenditionPlaylist(parseInt(req.params.r, 10), session.durationSec)
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(content)
  })

  app.get<{ Params: { id: string; r: string; seg: string } }>(
    '/sessions/:id/renditions/:r/:seg',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
      if (!/^\d+$/.test(req.params.r)) {
        return reply.status(400).send({ error: 'Invalid rendition', code: 'invalid-input' })
      }
      const r = parseInt(req.params.r, 10)
      const segReq = path.basename(req.params.seg)
      const segPath = path.join(session.sessionDir, `r${r}`, segReq)

      // Init segments live in the rendition dir but aren't sequenced; serve directly.
      // Briefly wait if not on disk yet — ffmpeg writes init alongside seg0.
      if (segReq.startsWith('init_')) {
        if (!existsSync(segPath)) {
          const deadline = Date.now() + 30_000
          while (Date.now() < deadline) {
            await new Promise(res => setTimeout(res, 100))
            if (existsSync(segPath)) break
            const p = session.ffmpegProcess
            if (p && (p.exitCode !== null || p.signalCode !== null)) break
          }
        }
        if (!existsSync(segPath)) return reply.status(404).send({ error: 'Init not ready', code: 'not-ready' })
        return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
      }

      // Parse "segNNNNN.m4s" → segment number
      const m = /^seg(\d+)\.m4s$/.exec(segReq)
      if (!m) return reply.status(400).send({ error: 'Invalid segment name', code: 'invalid-input' })
      const segNum = parseInt(m[1], 10)

      // Fast path: segment already on disk
      if (existsSync(segPath)) {
        return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
      }

      // Out-of-range request = seek. Trigger ffmpeg restart at the requested seg.
      // In-range requests just wait for the current ffmpeg run to catch up.
      const start = session.currentStartSegment
      const inRange = segNum >= start && segNum < start + SEEK_LOOKAHEAD_SEGMENTS

      if (!inRange && !session.ffmpegRestartInFlight) {
        console.log(`Session ${session.id}: seek detected — req seg${segNum}, current start ${start}`)
        session.ffmpegRestartInFlight = true
        try {
          // Re-check inside lock — another concurrent request may have just restarted.
          const stillStart = session.currentStartSegment
          const stillInRange = segNum >= stillStart && segNum < stillStart + SEEK_LOOKAHEAD_SEGMENTS
          if (!stillInRange) {
            await restartAtSegment(session, hwAccel, session.profiles, segNum)
          }
        } catch (err) {
          console.error(`Session ${session.id}: seek-restart failed`, err)
          return reply.status(500).send({ error: 'Seek restart failed', code: 'seek-restart-failed' })
        } finally {
          session.ffmpegRestartInFlight = false
        }
      } else if (!inRange) {
        console.log(`Session ${session.id}: seek waiting on in-flight restart (req seg${segNum}, current start ${start})`)
      }

      const ok = await waitForSegment(session, r, segNum, 60_000)
      if (!ok || !existsSync(segPath)) {
        return reply.status(404).send({ error: 'Segment not produced', code: 'not-ready' })
      }
      return reply.header('Content-Type', 'video/mp4').send(createReadStream(segPath))
    },
  )

  app.get<{ Params: { id: string } }>('/sessions/:id/direct', async (req, reply) => {
    const session = sessions.get(req.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
    const { size } = statSync(session.filePath)
    const range = req.headers.range
    if (range) {
      const [startStr, endStr] = range.replace('bytes=', '').split('-')
      const start = parseInt(startStr, 10)
      const end = endStr ? parseInt(endStr, 10) : size - 1
      if (isNaN(start) || isNaN(end) || start < 0 || end >= size || start > end) {
        return reply.status(416).header('Content-Range', `bytes */${size}`).send()
      }
      reply.status(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', end - start + 1)
        .header('Content-Type', 'video/x-matroska')
      return reply.send(createReadStream(session.filePath, { start, end }))
    }
    reply.header('Content-Type', 'video/x-matroska').header('Content-Length', size)
    return reply.send(createReadStream(session.filePath))
  })

  app.get<{ Params: { id: string; trackIdx: string } }>(
    '/sessions/:id/subtitles/:trackIdx.vtt',
    async (req, reply) => {
      const session = sessions.get(req.params.id)
      if (!session) return reply.status(404).send({ error: 'Session not found', code: 'session-not-found' })
      if (!/^\d+$/.test(req.params.trackIdx)) {
        return reply.status(400).send({ error: 'Invalid track index', code: 'invalid-input' })
      }
      const vttPath = path.join(session.sessionDir, `sub_${req.params.trackIdx}.vtt`)
      if (!existsSync(vttPath)) return reply.status(404).send({ error: 'Subtitle not ready', code: 'not-ready' })
      const content = await readFile(vttPath, 'utf8')
      return reply.header('Content-Type', 'text/vtt').send(content)
    },
  )

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    await sessions.destroy(req.params.id)
    return reply.status(204).send()
  })

  app.get<{ Params: { id: string } }>('/sessions/:id/ws', { websocket: true }, (connection, req) => {
    const socket = connection.socket
    const session = sessions.get(req.params.id)
    if (!session) {
      socket.close(4004, 'session-not-found')
      return
    }

    clearTimeout(session.attachTimer)
    clearTimeout(session.graceTimer)
    session.wsSocket = socket
    session.state = 'active'

    if (session.sessionReady) {
      socket.send(JSON.stringify({
        type: 'session-ready',
        method: session.method,
        streamUrl: session.method === 'direct-play'
          ? `/sessions/${session.id}/direct`
          : `/sessions/${session.id}/stream.m3u8`,
        profile: session.profiles[0],
        reconnectToken: session.reconnectToken,
      }))
    }

    socket.on('message', (raw: Buffer) => {
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return // ignore malformed JSON
      }
      try {
        handleWsMessage(msg, session, sessions, cfg, hwAccel)
      } catch (err) {
        console.error(`Session ${session.id}: WS handler error`, err)
      }
    })

    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.ping()
      }
    }, 15_000)

    socket.on('close', () => {
      clearInterval(pingInterval)
      if (session.state === 'destroyed') return
      session.state = 'detached'
      session.wsSocket = undefined
      session.graceTimer = setTimeout(() => {
        sessions.destroy(session.id)
      }, cfg.wsGraceMs)
    })
  })
}
