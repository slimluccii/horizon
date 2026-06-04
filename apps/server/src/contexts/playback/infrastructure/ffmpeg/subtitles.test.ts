import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Fake ffmpeg child process; tests drive its exit explicitly.
let lastProc: any

function makeFakeProc() {
  const ee = new EventEmitter() as any
  ee.exitCode = null
  ee.signalCode = null
  ee.killed = false
  ee.stderr = new EventEmitter()
  ee.kill = vi.fn((sig: NodeJS.Signals) => {
    ee.killed = true
    ee.signalCode = sig
    return true
  })
  return ee
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    lastProc = makeFakeProc()
    return lastProc
  }),
}))

// mkdir is irrelevant to these tests; stub it so the spawn path is reached
// synchronously (important under fake timers, where real fs I/O won't settle).
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(() => Promise.resolve()),
}))

const { extractSubtitles } = await import('./subtitles.ts')

const tracks = [{ index: 0, codec: 'subrip', embeddable: true, language: 'eng', title: 'English' }] as any

describe('extractSubtitles exit semantics (issue #80)', () => {
  // mkdir is mocked out, so this path never actually touches disk.
  const dir = path.join(tmpdir(), 'horizon-subs-test')

  beforeEach(() => {
    lastProc = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects when the extraction times out (SIGKILL from timeout != success)', async () => {
    vi.useFakeTimers()
    const session: any = {}
    const p = extractSubtitles('/m.mkv', tracks, dir, session)
    // Attach a catch immediately so the rejection isn't flagged unhandled.
    const settled = p.then(() => 'resolved', (e: Error) => e.message)

    // Let mkdir/spawn microtasks flush, then trip the timeout.
    await vi.advanceTimersByTimeAsync(0)
    expect(lastProc).toBeDefined()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    // The timeout handler killed the process; simulate the resulting exit.
    lastProc.emit('exit', null, 'SIGKILL')

    const result = await settled
    expect(result).toContain('timed out')
    expect(lastProc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(session.subtitleProcess).toBeUndefined()
  })

  it('resolves on a clean exit (code 0)', async () => {
    const session: any = {}
    const p = extractSubtitles('/m.mkv', tracks, dir, session)
    await Promise.resolve()
    // wait for spawn to have happened
    while (!lastProc) await new Promise(r => setTimeout(r, 5))
    lastProc.emit('exit', 0, null)
    await expect(p).resolves.toBeUndefined()
    expect(session.subtitleProcess).toBeUndefined()
  })

  it('resolves when killed by session cleanup (SIGTERM, not timed out)', async () => {
    const session: any = {}
    const p = extractSubtitles('/m.mkv', tracks, dir, session)
    while (!lastProc) await new Promise(r => setTimeout(r, 5))
    // Session destroy kills the process; this is expected, not an error.
    lastProc.emit('exit', null, 'SIGTERM')
    await expect(p).resolves.toBeUndefined()
    expect(session.subtitleProcess).toBeUndefined()
  })

  it('rejects on a non-zero exit code (real ffmpeg failure)', async () => {
    const session: any = {}
    const p = extractSubtitles('/m.mkv', tracks, dir, session)
    const settled = p.then(() => 'resolved', (e: Error) => e.message)
    while (!lastProc) await new Promise(r => setTimeout(r, 5))
    lastProc.emit('exit', 1, null)
    expect(await settled).toContain('exited code=1')
    expect(session.subtitleProcess).toBeUndefined()
  })
})
