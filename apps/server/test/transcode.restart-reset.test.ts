import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Record cross-cut ordering of lifecycle calls so we can assert that the old
// process is fully drained before its outputs are touched.
const order: string[] = []

// Mock only the process-orchestration primitives. waitForExit lives inside
// restart.ts itself (not imported) so it runs for real against our fake proc.
vi.mock('../src/transcode/ffmpeg.ts', () => ({
  killFfmpeg: vi.fn((session: any) => {
    order.push('kill')
    if (session.ffmpegProcess) session.ffmpegProcess.killed = true
  }),
  spawnFfmpeg: vi.fn(() => {
    order.push('spawn')
    return Promise.resolve()
  }),
}))

const { restartWithReset, cleanupRenditionFiles } = await import('../src/transcode/restart.ts')

function fakePlan() {
  return {
    method: 'transcode',
    renditions: [{ profile: { name: 'x' }, videoCodec: 'avc1' }],
  } as any
}

/** A fake ChildProcess that stays alive until we fire exit(). */
function fakeProc() {
  const ee = new EventEmitter() as any
  ee.exitCode = null
  ee.signalCode = null
  ee.killed = false
  ee.fireExit = () => {
    ee.exitCode = 0
    ee.emit('exit', 0, null)
  }
  return ee
}

describe('restartWithReset cleanup ordering (issue #58)', () => {
  let dir: string

  beforeEach(async () => {
    order.length = 0
    dir = await mkdtemp(path.join(tmpdir(), 'horizon-reset-'))
    await mkdir(path.join(dir, 'r0'), { recursive: true })
    await writeFile(path.join(dir, 'r0', 'init.mp4'), Buffer.alloc(64))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('does not delete rendition files while the old process is still alive', async () => {
    const proc = fakeProc()
    const segPath = path.join(dir, 'r0', 'seg00000.m4s')
    await writeFile(segPath, Buffer.alloc(16))
    const session: any = {
      id: 's2',
      sessionDir: dir,
      filePath: '/m.mkv',
      ffmpegProcess: proc,
      currentStartSegment: 0,
    }

    const p = restartWithReset(session, { name: 'cpu' } as any, fakePlan(), 0)

    // While the process is alive, the rendition dir (and its files) must be
    // untouched — cleanup is gated behind waitForExit.
    await new Promise(r => setTimeout(r, 30))
    const stillThere = await readdir(path.join(dir, 'r0'))
    expect(stillThere).toContain('seg00000.m4s')

    proc.fireExit()
    await p

    // After exit, reset-mode cleanup removed the whole rendition dir.
    const gone = await readdir(path.join(dir, 'r0')).then(() => false, () => true)
    expect(gone).toBe(true)
  })

  it('cleanupRenditionFiles with keepInit=false wipes the entire rendition dir tree', async () => {
    await writeFile(path.join(dir, 'r0', 'seg00000.m4s'), Buffer.alloc(16))
    const session: any = { sessionDir: dir }
    await cleanupRenditionFiles(session, 1, { keepInit: false })
    const gone = await readdir(path.join(dir, 'r0')).then(() => false, () => true)
    expect(gone).toBe(true)
  })
})
