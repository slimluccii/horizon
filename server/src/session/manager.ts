import crypto from 'node:crypto'
import type { Config } from '../config.ts'
import type { Session, SessionState } from './types.ts'
import { cleanupSessionDir, killFfmpeg } from '../transcode/ffmpeg.ts'

export interface SessionManager {
  create(partial: Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs'>): Session
  get(id: string): Session | undefined
  getByReconnectToken(token: string): Session | undefined
  destroy(id: string): Promise<void>
  size(): number
}

export function createSessionManager(cfg: Config): SessionManager {
  const sessions = new Map<string, Session>()
  const byToken = new Map<string, string>()

  function create(partial: Omit<Session, 'id' | 'reconnectToken' | 'createdAt' | 'state' | 'seekPositionMs'>): Session {
    if (sessions.size >= cfg.maxSessions) {
      throw Object.assign(new Error('Server at session capacity'), { code: 'max-sessions' })
    }

    const id = crypto.randomUUID()
    const reconnectToken = crypto.randomBytes(32).toString('hex')
    const session: Session = {
      ...partial,
      id,
      reconnectToken,
      state: 'pre-buffer',
      seekPositionMs: 0,
      createdAt: Date.now(),
    }
    sessions.set(id, session)
    byToken.set(reconnectToken, id)

    session.attachTimer = setTimeout(async () => {
      if (session.state === 'pre-buffer') {
        console.log(`Session ${id}: WS attach timeout`)
        await destroy(id)
      }
    }, cfg.wsAttachMs)

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

    clearTimeout(session.attachTimer)
    clearTimeout(session.graceTimer)
    killFfmpeg(session)
    await cleanupSessionDir(session.sessionDir)
    byToken.delete(session.reconnectToken)
    sessions.delete(id)
    session.state = 'destroyed' as SessionState
  }

  return { create, get, getByReconnectToken, destroy, size: () => sessions.size }
}
