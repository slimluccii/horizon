import crypto from 'node:crypto'
import { ErrorCodes } from '@horizon/sdk'
import type { Session } from './types.ts'
import type { SessionRuntime } from './runtime.ts'
import type { ServerSettings } from '../repos/serverSettings.ts'
import { cleanupSessionDir, killFfmpeg } from '../transcode/ffmpeg.ts'

export interface SessionManager {
  create(partial: Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs' | 'currentStartSegment'>): Session
  get(id: string): Session | undefined
  getByReconnectToken(token: string): Session | undefined
  destroy(id: string): Promise<void>
  size(): number
  /** Attach a SessionRuntime to a Session right after create. Only the
   *  PlaybackOrchestrator should call this. */
  attachRuntime(id: string, runtime: SessionRuntime): void
  /** Retrieve the runtime for a Session. Returns undefined if the session
   *  doesn't exist or no runtime was attached (e.g. direct-play sessions
   *  that don't need restart state). */
  getRuntime(id: string): SessionRuntime | undefined
}

export function createSessionManager(serverSettings: ServerSettings): SessionManager {
  const sessions = new Map<string, Session>()
  const runtimes = new Map<string, SessionRuntime>()
  const byToken = new Map<string, string>()

  function create(partial: Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs' | 'currentStartSegment'>): Session {
    const { maxSessions, wsAttachMs } = serverSettings.get()
    if (sessions.size >= maxSessions) {
      throw Object.assign(new Error('Server at session capacity'), { code: ErrorCodes.MAX_SESSIONS })
    }

    const id = crypto.randomUUID()
    const reconnectToken = crypto.randomBytes(32).toString('hex')
    const session: Session = {
      ...partial,
      id,
      reconnectToken,
      state: 'pre-buffer',
      seekPositionMs: 0,
      currentStartSegment: 0,
      createdAt: Date.now(),
    }
    sessions.set(id, session)
    byToken.set(reconnectToken, id)

    session.attachTimer = setTimeout(async () => {
      if (session.state === 'pre-buffer') {
        console.log(`Session ${id}: WS attach timeout`)
        await destroy(id)
      }
    }, wsAttachMs)

    return session
  }

  function get(id: string) { return sessions.get(id) }

  function getByReconnectToken(token: string) {
    const id = byToken.get(token)
    return id ? sessions.get(id) : undefined
  }

  async function destroy(id: string) {
    const session = sessions.get(id)
    if (!session) return

    // Each cleanup step is isolated: a failure in one must never abort the
    // others or prevent the session from being marked destroyed. This
    // guarantees the ffmpeg process is killed and bookkeeping is cleared even
    // if (say) cleanupSessionDir throws on a stuck filesystem.

    // Mark runtime destroyed first so any in-flight transition observes the
    // terminal state when it returns to update bookkeeping.
    try { runtimes.get(id)?.markDestroyed() } catch (err) {
      console.error(`Session ${id}: markDestroyed failed`, err)
    }

    try { clearTimeout(session.attachTimer) } catch {/* not set */}
    try { clearTimeout(session.graceTimer) } catch {/* not set */}

    try { killFfmpeg(session) } catch (err) {
      console.error(`Session ${id}: killFfmpeg failed`, err)
    }

    if (session.subtitleProcess && !session.subtitleProcess.killed) {
      try { session.subtitleProcess.kill('SIGTERM') } catch {/* gone */}
    }

    await cleanupSessionDir(session.sessionDir).catch((err) => {
      console.error(`Session ${id}: cleanup failed`, err)
    })

    byToken.delete(session.reconnectToken)
    sessions.delete(id)
    runtimes.delete(id)
    session.state = 'destroyed'
  }

  return {
    create, get, getByReconnectToken, destroy,
    size: () => sessions.size,
    attachRuntime: (id, runtime) => { runtimes.set(id, runtime) },
    getRuntime: (id) => runtimes.get(id),
  }
}
