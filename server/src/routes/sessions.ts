import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { MediaRepo } from '../repos/media.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import type { SessionManager } from '../session/manager.ts'
import type { ClientCapabilities } from '../transcode/decision.ts'
import type { Profile } from '../transcode/profiles.ts'
import { decidePlayback } from '../transcode/decision.ts'
import { selectInitialProfile, selectRenditionLadder } from '../transcode/profiles.ts'
import { SEGMENT_DURATION_SEC, createSessionDir, spawnFfmpeg } from '../transcode/ffmpeg.ts'
import { extractSubtitles } from '../transcode/subtitles.ts'
import { handleWsMessage } from '../ws/handler.ts'
import { createProgressFlusher } from '../ws/progress-flusher.ts'
import { sendNotFound, overCapacity } from './errors.ts'

interface CreateSessionBody {
  mediaId: string
  capabilities: ClientCapabilities
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
  userId?: string
  startPositionMs?: number
}

const WS_PING_INTERVAL_MS = 15_000

/**
 * Choose the rendition ladder for a playback decision. Tone-mapped HDR is
 * single-rendition + capped to 1080p because:
 *  - tone-map runs on CPU (no zimg / no GPU tone-map on macOS) — 4K HDR
 *    tonemap is slower than real-time on most machines
 *  - parallel renditions share the same CPU-bound tonemap filter, adding
 *    latency without bandwidth benefit
 */
function selectProfilesForPlayback(
  decision: ReturnType<typeof decidePlayback>,
  capabilities: ClientCapabilities,
  resolution: string,
  maxRenditions: number,
): Profile[] {
  const [srcW] = (resolution ?? '1920x1080').split('x').map(s => parseInt(s, 10))
  let topProfile = selectInitialProfile(capabilities.maxBitrate, srcW)
  if (decision.needsToneMap && topProfile.width > 1920) {
    topProfile = { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080 }
  }
  return decision.method === 'transcode' && !decision.needsToneMap
    ? selectRenditionLadder(topProfile, maxRenditions, srcW)
    : [topProfile]
}

export function registerSessions(
  app: FastifyInstance,
  cfg: Config,
  hwAccel: HwAccel,
  media: MediaRepo,
  sessions: SessionManager,
  progressRepo: ProgressRepo,
) {
  app.post<{ Body: CreateSessionBody }>('/sessions', async (req, reply) => {
    const { mediaId, capabilities, audioTrackIndex = 0, subtitleTrackIndex = null } = req.body

    const mediaItem = media.getById(mediaId)
    if (!mediaItem) return sendNotFound(reply, 'media-not-found', 'Media not found')
    if (sessions.size() >= cfg.maxSessions) return overCapacity(reply, 'max-sessions', 'Server at capacity')

    // Build a ProbeResult-compatible view of the MediaItem. videoBitrate is
    // not stored in media_items — default 0 so the bitrate check is permissive.
    const probeView = {
      duration: mediaItem.durationSec ?? 0,
      resolution: mediaItem.resolution ?? '1920x1080',
      videoCodec: mediaItem.videoCodec ?? '',
      videoBitrate: 0,
      hdr: mediaItem.hdr ?? { dv: false, hdr10: false, hdr10plus: false },
      audioTracks: mediaItem.audioTracks ?? [],
      subtitleTracks: mediaItem.subtitleTracks ?? [],
      container: mediaItem.container ?? '',
    }
    const decision = decidePlayback(probeView, capabilities)
    const profiles = selectProfilesForPlayback(decision, capabilities, probeView.resolution, cfg.maxRenditions)

    // Create session first so its ID is known, then create the session dir
    // using that same ID — keeps session dir path and session ID in sync.
    const session = sessions.create({
      mediaId,
      filePath: mediaItem.filePath!,
      method: decision.method,
      capabilities,
      selectedAudioTrack: audioTrackIndex,
      selectedSubtitleTrack: subtitleTrackIndex,
      profiles,
      renditionCodecs: [],
      needsToneMap: decision.needsToneMap,
      toneMap: cfg.toneMap,
      sessionDir: '',
      sessionReady: false,
      durationSec: mediaItem.durationSec ?? 0,
      userId: req.body.userId ?? undefined,
    })
    session.sessionDir = await createSessionDir(session.id)

    // Handle seek-on-create for resume playback
    if (req.body.startPositionMs && req.body.startPositionMs > 0 && decision.method !== 'direct-play') {
      const segNum = Math.floor(req.body.startPositionMs / 1000 / SEGMENT_DURATION_SEC)
      session.currentStartSegment = segNum
      session.seekPositionMs = req.body.startPositionMs
    }

    if (decision.method !== 'direct-play') {
      spawnFfmpeg(session, hwAccel, profiles, audioTrackIndex).then(() => {
        session.sessionReady = true
        session.state = 'active'
        session.wsSocket?.send(JSON.stringify({
          type: 'session-ready',
          method: session.method,
          streamUrl: `/sessions/${session.id}/stream.m3u8`,
          profile: profiles[0],
          reconnectToken: session.reconnectToken,
        }))
        // Extract text subs in background; tracked on session so destroy() reaps it.
        extractSubtitles(mediaItem.filePath!, mediaItem.subtitleTracks ?? [], session.sessionDir, session)
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

    session._flusher = createProgressFlusher(session, progressRepo)

    socket.on('message', (raw: Buffer) => {
      let parsed: unknown
      try { parsed = JSON.parse(raw.toString()) } catch { return }
      try {
        handleWsMessage(parsed, session, sessions, cfg, hwAccel)
      } catch (err) {
        console.error(`Session ${session.id}: WS handler error`, err)
      }
    })

    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) socket.ping()
    }, WS_PING_INTERVAL_MS)

    socket.on('close', () => {
      session._flusher?.finalFlush()
      session._flusher?.stop()
      session._flusher = undefined
      clearInterval(pingInterval)
      if (session.state === 'destroyed') return
      session.state = 'detached'
      session.wsSocket = undefined
      session.graceTimer = setTimeout(() => sessions.destroy(session.id), cfg.wsGraceMs)
    })
  })
}
