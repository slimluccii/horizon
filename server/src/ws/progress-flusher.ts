import type { Session } from '../session/types.ts'
import type { ProgressRepo } from '../repos/progress.ts'

const FLUSH_INTERVAL_MS = 30_000

/**
 * Per-session flusher: keeps the last reported position in session.lastProgress
 * and writes to DB at most once every FLUSH_INTERVAL_MS when dirty. Attach on
 * WS connect, call finalFlush() on close.
 */
export interface ProgressFlusher {
  record(positionMs: number, durationMs: number): void
  finalFlush(): void
  stop(): void
}

export function createProgressFlusher(
  session: Session,
  progress: ProgressRepo,
): ProgressFlusher {
  let lastFlushedPos = -1

  const doFlush = () => {
    if (!session.userId) return
    const cur = session.lastProgress
    if (!cur) return
    if (cur.positionMs === lastFlushedPos) return
    progress.setProgress(session.userId, session.mediaId, {
      positionMs: cur.positionMs,
      durationMs: cur.durationMs,
    })
    lastFlushedPos = cur.positionMs
  }

  const timer = setInterval(doFlush, FLUSH_INTERVAL_MS)

  return {
    record(positionMs, durationMs) {
      session.lastProgress = { positionMs, durationMs, at: Date.now() }
    },
    finalFlush: doFlush,
    stop() { clearInterval(timer) },
  }
}
