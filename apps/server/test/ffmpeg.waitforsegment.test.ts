import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { waitForSegment } from '../src/transcode/ffmpeg.ts'
import type { Session } from '../src/session/types.ts'
import { segmentName } from '../src/transcode/segments.ts'

/** Minimal fake ffmpeg process exposing the exit-state fields waitForFile reads. */
interface FakeProc {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  killed: boolean
}

function fakeSession(sessionDir: string, proc?: FakeProc): Session {
  return {
    id: 's1',
    sessionDir,
    ffmpegProcess: proc as unknown as Session['ffmpegProcess'],
    currentStartSegment: 0,
  } as unknown as Session
}

describe('waitForSegment (issue #57: early exit on ffmpeg failure)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'horizon-wfs-'))
    await mkdir(path.join(dir, 'r0'), { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves immediately (well under the deadline) once ffmpeg exits', async () => {
    // Process is alive at call time, then "crashes" right away.
    const proc: FakeProc = { exitCode: null, signalCode: null, killed: false }
    const session = fakeSession(dir, proc)

    // Use a long timeout so a hang would be obvious — the fix must resolve fast.
    const t0 = Date.now()
    const p = waitForSegment(session, 0, 5, 60_000)

    // Simulate ffmpeg crashing on the next tick.
    setTimeout(() => { proc.exitCode = 1 }, 20)

    const ok = await p
    const elapsed = Date.now() - t0
    expect(ok).toBe(false)
    // Before the fix this hung for the full 60s deadline; after, it resolves promptly.
    expect(elapsed).toBeLessThan(2_000)
  })

  it('still times out independently when no process is present (deadline backstop)', async () => {
    const session = fakeSession(dir, undefined)
    const t0 = Date.now()
    const ok = await waitForSegment(session, 0, 5, 500)
    const elapsed = Date.now() - t0
    expect(ok).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('resolves true when the segment file arrives before ffmpeg exits', async () => {
    const proc: FakeProc = { exitCode: null, signalCode: null, killed: false }
    const session = fakeSession(dir, proc)
    const segPath = path.join(dir, 'r0', segmentName(5))

    const p = waitForSegment(session, 0, 5, 30_000)
    setTimeout(() => { void writeFile(segPath, Buffer.alloc(1024, 1)) }, 20)

    const ok = await p
    expect(ok).toBe(true)
  })
})
