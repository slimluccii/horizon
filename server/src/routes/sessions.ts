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
import { createSessionDir, spawnFfmpeg } from '../transcode/ffmpeg.ts'
import { extractSubtitles } from '../transcode/subtitles.ts'
import { handleWsMessage } from '../ws/handler.ts'

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
    const topProfile = selectInitialProfile(capabilities.maxBitrate, srcW)
    const profiles = decision.method === 'transcode'
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
      const content = await readFile(path.join(session.sessionDir, 'r0', 'index.m3u8'), 'utf8')
      return reply.header('Content-Type', 'application/vnd.apple.mpegurl').send(content)
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
    const r = req.params.r
    const playlistPath = path.join(session.sessionDir, `r${r}`, 'index.m3u8')
    if (!existsSync(playlistPath)) return reply.status(404).send({ error: 'Not ready', code: 'not-ready' })
    let content = await readFile(playlistPath, 'utf8')
    // FFmpeg writes segment URIs relative to the playlist URL. Since this
    // playlist is served at /sessions/:id/renditions/:r.m3u8, the browser
    // resolves bare names like "seg001.m4s" against /sessions/:id/renditions/,
    // which has no route. Prefix every segment reference with the rendition
    // index so requests land on the existing /sessions/:id/renditions/:r/:seg route.
    //   URI="init_N.mp4"  →  URI="N/init_N.mp4"
    //   seg001.m4s        →  N/seg001.m4s   (bare lines after #EXTINF)
    content = content.replace(/URI="(init_\d+\.mp4)"/g, `URI="${r}/$1"`)
    content = content.replace(/^([^#\s][^\n]*\.m4s)$/gm, `${r}/$1`)
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
      const segName = path.basename(req.params.seg)
      const segPath = path.join(session.sessionDir, `r${req.params.r}`, segName)
      if (!existsSync(segPath)) return reply.status(404).send({ error: 'Segment not found', code: 'not-found' })
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
