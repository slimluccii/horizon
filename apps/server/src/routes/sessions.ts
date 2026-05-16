import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { MediaRepo } from '../repos/media.ts'
import type { UserRepo } from '../repos/users.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import type { SessionManager } from '../session/manager.ts'
import type { PlaybackOrchestrator, StartPlaybackInput } from '../session/playback.ts'
import { handleWsMessage } from '../ws/handler.ts'
import { createProgressFlusher } from '../ws/progress-flusher.ts'
import { sendNotFound, overCapacity, badRequest } from './errors.ts'

const WS_PING_INTERVAL_MS = 15_000

export function registerSessions(
  app: FastifyInstance,
  cfg: Config,
  hwAccel: HwAccel,
  sessions: SessionManager,
  progressRepo: ProgressRepo,
  orchestrator: PlaybackOrchestrator,
) {
  app.post<{ Body: StartPlaybackInput }>('/sessions', async (req, reply) => {
    let started
    try {
      started = orchestrator.startPlayback(req.body)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'media-not-found') return sendNotFound(reply, code, 'Media not found')
      if (code === 'user-not-found') return badRequest(reply, 'no-user', 'User not found')
      if (code === 'max-sessions') return overCapacity(reply, code, 'Server at capacity')
      throw err
    }

    const { info, ready } = started

    // Route owns WS transport: notify the client once ffmpeg is ready. If the
    // client hasn't attached yet, the WS upgrade handler emits `session-ready`
    // itself on attach (using `sessionReady` state), so this is idempotent.
    ready
      .then(() => {
        const s = sessions.get(info.sessionId)
        s?.wsSocket?.send(JSON.stringify({
          type: 'session-ready',
          method: info.method,
          streamUrl: info.streamUrl,
          profile: info.profiles[0],
          reconnectToken: info.reconnectToken,
        }))
      })
      .catch(err => req.log.error({ err, sessionId: info.sessionId }, 'playback ready failed'))

    return {
      sessionId: info.sessionId,
      method: info.method,
      streamUrl: info.streamUrl,
      wsUrl: info.wsUrl,
      profiles: info.profiles,
      selectedAudioTrack: info.selectedAudioTrack,
      selectedSubtitleTrack: info.selectedSubtitleTrack,
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
        method: session.plan.method,
        streamUrl: session.plan.method === 'direct-play'
          ? `/sessions/${session.id}/direct`
          : `/sessions/${session.id}/stream.m3u8`,
        profile: session.plan.renditions[0].profile,
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
