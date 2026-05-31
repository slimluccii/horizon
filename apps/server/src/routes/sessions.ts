import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { MediaRepo } from '../repos/media.ts'
import type { UserRepo } from '../repos/users.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import type { ServerSettings } from '../repos/serverSettings.ts'
import type { SessionManager } from '../session/manager.ts'
import type { PlaybackOrchestrator, StartPlaybackInput } from '../session/playback.ts'
import { handleWsMessage } from '../ws/handler.ts'
import { createProgressFlusher } from '../ws/progress-flusher.ts'
import { sendNotFound, overCapacity, badRequest, errorReply, ErrorCodes } from './errors.ts'
import { resolveCallerRole } from './authz.ts'

const WS_PING_INTERVAL_MS = 15_000

export function registerSessions(
  app: FastifyInstance,
  cfg: Config,
  hwAccel: HwAccel,
  sessions: SessionManager,
  progressRepo: ProgressRepo,
  orchestrator: PlaybackOrchestrator,
  serverSettings: ServerSettings,
  users: UserRepo,
) {
  app.post<{ Body: StartPlaybackInput }>('/sessions', async (req, reply) => {
    // Authenticate the caller via X-Horizon-User. Playback is always tied to a
    // user (for watch-history + capacity accounting). owner/admin may delegate
    // playback on behalf of another household member; members may only play as
    // themselves.
    const caller = resolveCallerRole(users, req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Missing or unknown X-Horizon-User header')

    const requestedUserId = req.body?.userId
    if (requestedUserId && requestedUserId !== caller.id && caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner/admin can start playback for another user')
    }

    let started
    try {
      started = orchestrator.startPlayback({ ...req.body, userId: requestedUserId || caller.id })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === ErrorCodes.MEDIA_NOT_FOUND) return sendNotFound(reply, ErrorCodes.MEDIA_NOT_FOUND, 'Media not found')
      if (code === ErrorCodes.USER_NOT_FOUND) return badRequest(reply, ErrorCodes.NO_USER, 'User not found')
      if (code === ErrorCodes.MAX_SESSIONS) return overCapacity(reply, ErrorCodes.MAX_SESSIONS, 'Server at capacity')
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
      socket.close(4004, ErrorCodes.SESSION_NOT_FOUND)
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
      session.graceTimer = setTimeout(() => sessions.destroy(session.id), serverSettings.get().wsGraceMs)
    })
  })
}
