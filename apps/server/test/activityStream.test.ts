import { describe, it, expect } from 'vitest'
import { streamActivity } from '../src/routes/activityStream.ts'
import { createActivityBus } from '../src/activity/bus.ts'

/** Fake req.raw — captures the 'close' handler so the test can fire it. */
function fakeClose() {
  let handler: (() => void) | null = null
  return {
    on(_e: 'close', cb: () => void) { handler = cb },
    fire() { handler?.() },
  }
}

/** Fake injectable timers — never actually schedule; track clears + fire ping. */
function fakeTimers() {
  let pingCb: (() => void) | null = null
  let cleared = 0
  return {
    timers: {
      setInterval(cb: () => void) { pingCb = cb; return 'H' },
      clearInterval() { cleared++ },
    },
    ping() { pingCb?.() },
    get cleared() { return cleared },
  }
}

describe('streamActivity', () => {
  it('replays the ring buffer then streams live events', () => {
    const bus = createActivityBus({ now: () => 0 })
    bus.emit({ kind: 'meta:start', message: 'replayed' })
    const writes: string[] = []
    const close = fakeClose()
    const t = fakeTimers()

    streamActivity(bus, { write: s => writes.push(s) }, close, { timers: t.timers })

    expect(writes.join('')).toContain('"message":"replayed"')   // replay on connect
    bus.emit({ kind: 'meta:done', refreshed: 1, failed: 0, durationMs: 1, message: 'live' })
    expect(writes.join('')).toContain('"message":"live"')        // live after subscribe
  })

  it('on disconnect clears the ping and unsubscribes (no leak, no further writes)', () => {
    const bus = createActivityBus({ now: () => 0 })
    const writes: string[] = []
    const close = fakeClose()
    const t = fakeTimers()

    streamActivity(bus, { write: s => writes.push(s) }, close, { timers: t.timers })
    close.fire()                                  // client disconnects

    expect(t.cleared).toBe(1)                     // keep-alive interval cleared
    const before = writes.length
    bus.emit({ kind: 'error', code: 'x', message: 'after-close' })
    expect(writes.length).toBe(before)            // unsubscribed → no further writes
  })

  it('fires keep-alive pings via the injected timer', () => {
    const bus = createActivityBus({ now: () => 0 })
    const writes: string[] = []
    const t = fakeTimers()
    streamActivity(bus, { write: s => writes.push(s) }, fakeClose(), { timers: t.timers })
    t.ping()
    expect(writes.some(w => w.startsWith(': ping'))).toBe(true)
  })
})
