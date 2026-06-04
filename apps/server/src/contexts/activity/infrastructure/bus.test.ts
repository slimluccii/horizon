import { describe, it, expect, vi } from 'vitest'
import { createActivityBus } from './bus.ts'

describe('activity bus', () => {
  it('stamps monotonic seq + ts and buffers in order', () => {
    let t = 100
    const bus = createActivityBus({ bufferSize: 10, now: () => t++ })
    bus.emit({ kind: 'meta:start', message: 'a' })
    bus.emit({ kind: 'meta:done', refreshed: 1, failed: 0, durationMs: 5, message: 'b' })
    const r = bus.recent()
    expect(r.map(e => e.seq)).toEqual([0, 1])
    expect(r.map(e => e.ts)).toEqual([100, 101])
    expect(r.map(e => e.message)).toEqual(['a', 'b'])
  })

  it('caps the ring buffer, dropping oldest', () => {
    const bus = createActivityBus({ bufferSize: 3, now: () => 0 })
    for (let i = 0; i < 5; i++) bus.emit({ kind: 'error', code: 'x', message: String(i) })
    expect(bus.recent().map(e => e.message)).toEqual(['2', '3', '4'])
  })

  it('delivers to subscribers and stops after unsubscribe', () => {
    const bus = createActivityBus({ now: () => 0 })
    const seen: string[] = []
    const off = bus.subscribe(e => seen.push(e.message))
    bus.emit({ kind: 'error', code: 'x', message: 'one' })
    off()
    bus.emit({ kind: 'error', code: 'x', message: 'two' })
    expect(seen).toEqual(['one'])
  })

  it('drops a subscriber that throws without breaking emit', () => {
    const bus = createActivityBus({ now: () => 0 })
    const good: string[] = []
    bus.subscribe(() => { throw new Error('bad') })
    bus.subscribe(e => good.push(e.message))
    expect(() => bus.emit({ kind: 'error', code: 'x', message: 'ok' })).not.toThrow()
    bus.emit({ kind: 'error', code: 'x', message: 'ok2' })
    expect(good).toEqual(['ok', 'ok2'])
  })
})
