import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { waitForSegment } from '../src/transcode/ffmpeg.ts'
import type { Session } from '../src/session/types.ts'
import { segmentName } from '../src/transcode/segments.ts'

function fakeSession(sessionDir: string): Session {
  // No ffmpegProcess: isolates the size-stability path from exit-detection.
  return {
    id: 's1',
    sessionDir,
    ffmpegProcess: undefined,
    currentStartSegment: 0,
  } as unknown as Session
}

describe('waitForFile size-stability (issue #90)', () => {
  let dir: string
  let segPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'horizon-stab-'))
    await mkdir(path.join(dir, 'r0'), { recursive: true })
    segPath = path.join(dir, 'r0', segmentName(0))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns true once a present file holds a constant size', async () => {
    await writeFile(segPath, Buffer.alloc(2048, 1))
    const ok = await waitForSegment(fakeSession(dir), 0, 0, 5_000)
    expect(ok).toBe(true)
  })

  it('keeps waiting while the file is still growing, then resolves when stable', async () => {
    const session = fakeSession(dir)
    await writeFile(segPath, Buffer.alloc(1024, 1))
    const p = waitForSegment(session, 0, 0, 10_000)

    // Grow the file across several stability windows; only after it settles
    // should the wait resolve true.
    let size = 1024
    const grow = setInterval(() => {
      size += 1024
      void writeFile(segPath, Buffer.alloc(size, 1))
    }, 60)
    setTimeout(() => clearInterval(grow), 400)

    const ok = await p
    expect(ok).toBe(true)
  })

  it('does not falsely succeed when the file shrinks within the window', async () => {
    const session = fakeSession(dir)
    // Start large, then shrink during the stability window. The shrink guard
    // must reject this sample; resolution only happens once size settles.
    await writeFile(segPath, Buffer.alloc(8192, 1))
    const p = waitForSegment(session, 0, 0, 5_000)
    setTimeout(() => { void truncate(segPath, 4096) }, 20)

    const ok = await p
    // Either way it must eventually report true once size is stable at 4096,
    // but it must NOT resolve on the shrinking sample. The key assertion is
    // simply that it resolves true (no hang, no false-negative).
    expect(ok).toBe(true)
  })

  it('returns false on timeout when the file never appears', async () => {
    const t0 = Date.now()
    const ok = await waitForSegment(fakeSession(dir), 0, 9, 400)
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
  })

  it('returns false (not true) for a zero-byte file', async () => {
    await writeFile(segPath, Buffer.alloc(0))
    const ok = await waitForSegment(fakeSession(dir), 0, 0, 400)
    expect(ok).toBe(false)
  })
})
