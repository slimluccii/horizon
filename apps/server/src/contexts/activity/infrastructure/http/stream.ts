import type { ActivityBus } from '../bus.ts'
import type { ActivityEvent } from '@horizon/sdk'

/** Serialize one activity event as an SSE `data:` frame. */
export function sseFrame(evt: ActivityEvent): string {
  return `data: ${JSON.stringify(evt)}\n\n`
}

/** Minimal sink the SSE stream writes to (subset of `reply.raw`). */
export interface SseSink {
  write(chunk: string): void
}

/** Minimal connection-close signal (subset of `req.raw`). */
export interface CloseSignal {
  on(event: 'close', cb: () => void): void
}

/** Timer hooks, injectable so the keep-alive ping is testable. */
export interface StreamTimers {
  setInterval(cb: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const REAL_TIMERS: StreamTimers = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

/**
 * Replay the activity ring buffer to `sink`, then stream live events until the
 * connection closes. On close, the keep-alive ping is cleared and the bus
 * subscription is removed (no leaked subscribers/timers). Extracted from the
 * route so the replay + cleanup paths are unit-testable without an open socket.
 *
 * Returns the cleanup function (also wired to `close`) so tests can assert it.
 */
export function streamActivity(
  bus: ActivityBus,
  sink: SseSink,
  close: CloseSignal,
  opts: { pingMs?: number; timers?: StreamTimers } = {},
): () => void {
  const timers = opts.timers ?? REAL_TIMERS
  const pingMs = opts.pingMs ?? 15_000

  for (const evt of bus.recent()) sink.write(sseFrame(evt))
  const unsub = bus.subscribe(evt => sink.write(sseFrame(evt)))
  const ping = timers.setInterval(() => sink.write(': ping\n\n'), pingMs)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    timers.clearInterval(ping)
    unsub()
  }
  close.on('close', cleanup)
  return cleanup
}
