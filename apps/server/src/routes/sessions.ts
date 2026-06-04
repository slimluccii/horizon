import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { MediaRepo } from '../contexts/library/index.ts'
import type { UserRepo } from '../contexts/identity/index.ts'
import type { ProgressRepo } from '../repos/progress.ts'
import type { ServerSettings } from '../contexts/settings/index.ts'
import type { SessionManager } from '../session/manager.ts'
import type { PlaybackOrchestrator, StartPlaybackInput } from '../session/playback.ts'
import { handleWsMessage, resetWsAuth } from '../ws/handler.ts'
import { createProgressFlusher } from '../ws/progress-flusher.ts'
import { sendNotFound, overCapacity, badRequest, errorReply, ErrorCodes } from './errors.ts'
import { resolveCallerRole, canAccessSession } from '../contexts/identity/index.ts'
import { requireReconnectToken } from './segments.ts'

const WS_PING_INTERVAL_MS = 15_000

/**
 * Syntactic validation for the POST /sessions body. Guarantees well-formed
 * input (types + basic bounds) before it reaches the orchestrator. Semantic
 * validation against the probed media (track-index bounds, startPositionMs vs
 * duration) happens in PlaybackOrchestrator.startPlayback, which is the only
 * layer that knows what the media actually contains. `.strict()` rejects
 * unknown keys, matching the settings/progress route pattern.
 */
const ClientCapabilitiesSchema = z.object({
  videoCodecs: z.array(z.string()),
  audioCodecs: z.array(z.string()),
  hdr: z.array(z.string()),
  maxBitrate: z.number(),
  container: z.array(z.string()),
}).strict()

const StartPlaybackBodySchema = z.object({
  mediaId: z.string().min(1),
  capabilities: ClientCapabilitiesSchema,
  audioTrackIndex: z.number().int().min(0).optional(),
  subtitleTrackIndex: z.number().int().min(-1).nullable().optional(),
  userId: z.string().optional(),
  startPositionMs: z.number().int().min(0).optional(),
}).strict()

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
    // Syntactic validation first — reject malformed bodies before any auth or
    // domain work so the client gets a clear 400 rather than a deep ffmpeg
    // failure.
    const parsed = StartPlaybackBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(reply, ErrorCodes.INVALID_INPUT, parsed.error.message)
    }
    const input = parsed.data

    // The caller is the authenticated session user (req.user, set by the global
    // requireAuth hook). Playback is always tied to a user (for watch-history +
    // capacity accounting). owner/admin may delegate playback on behalf of
    // another household member; members may only play as themselves.
    const caller = resolveCallerRole(req)
    if (!caller) return badRequest(reply, ErrorCodes.NO_USER, 'Authentication required')

    const requestedUserId = input.userId
    if (requestedUserId && requestedUserId !== caller.id && caller.role === 'member') {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Only owner/admin can start playback for another user')
    }

    let started
    try {
      started = orchestrator.startPlayback({ ...input, userId: requestedUserId || caller.id })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === ErrorCodes.MEDIA_NOT_FOUND) return sendNotFound(reply, ErrorCodes.MEDIA_NOT_FOUND, 'Media not found')
      if (code === ErrorCodes.USER_NOT_FOUND) return badRequest(reply, ErrorCodes.NO_USER, 'User not found')
      if (code === ErrorCodes.AUDIO_TRACK_INVALID) return badRequest(reply, ErrorCodes.AUDIO_TRACK_INVALID, 'Audio track not available for this media')
      if (code === ErrorCodes.INVALID_INPUT) return badRequest(reply, ErrorCodes.INVALID_INPUT, (err as Error).message)
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

  app.delete<{ Params: { id: string }; Querystring: { token?: string } }>('/sessions/:id', async (req, reply) => {
    const session = sessions.get(req.params.id)
    // Idempotent: a DELETE for an unknown/already-destroyed session is a no-op
    // success, so a client that races its own teardown never sees an error.
    if (!session) return reply.status(204).send()
    // Proof-of-knowledge gate: destroying a session is a privileged op (it kills
    // ffmpeg + frees a capacity slot). Only the client that created the session
    // holds its reconnectToken, so require it here — otherwise anyone who guessed
    // a sessionId could tear down another user's playback.
    if (!requireReconnectToken(session, req, reply)) return
    // Ownership gate on top of the token: a member who somehow holds a token
    // for another user's session still may not tear it down. owner/admin may
    // destroy any session; headless sessions are destroyable by anyone.
    if (!canAccessSession(session.userId, resolveCallerRole(req))) {
      return errorReply(reply, 403, ErrorCodes.CALLER_FORBIDDEN, 'Not authorized for this session')
    }
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

    // Ownership gate. The hello handshake later proves token knowledge, but the
    // authenticated session identity (req.user, from the cookie/bearer that rode
    // the WS upgrade) must also be entitled to this session: a member may attach
    // only to their own session, owner/admin to any, and a headless session
    // (no userId) to any authenticated user. 4001 = unauthorized close code.
    if (!canAccessSession(session.userId, resolveCallerRole(req))) {
      socket.close(4001, ErrorCodes.UNAUTHORIZED)
      return
    }

    clearTimeout(session.attachTimer)
    clearTimeout(session.graceTimer)
    session.wsSocket = socket
    session.state = 'active'
    // A fresh socket is unauthenticated until it sends a valid `hello`. Reset
    // any prior auth state so a reconnecting client must re-handshake before
    // its playback commands are honoured.
    resetWsAuth(session)

    if (session.sessionReady) {
      socket.send(JSON.stringify({
        type: 'session-ready',
        method: session.plan.method,
        streamUrl: session.plan.method === 'direct-play'
          ? `/api/sessions/${session.id}/direct`
          : `/api/sessions/${session.id}/stream.m3u8`,
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
