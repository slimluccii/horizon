import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Capture the lifecycle call order and whether the old process was still
// alive at spawn time — that aliveness is exactly the two-processes-coexist
// window issue #79 is about.
const order: string[] = []
let oldProcessAliveAtSpawn = false

vi.mock('../src/transcode/ffmpeg.ts', () => ({
  killFfmpeg: vi.fn((session: any) => {
    order.push('kill')
    // SIGTERM only — process is still alive immediately after kill().
    if (session.ffmpegProcess) session.ffmpegProcess.killed = true
  }),
  spawnFfmpeg: vi.fn((session: any) => {
    const p = session.ffmpegProcess
    if (p && p.exitCode === null && p.signalCode === null) oldProcessAliveAtSpawn = true
    order.push('spawn')
    // Simulate the new process taking over the session handle.
    return Promise.resolve()
  }),
}))

const { restartWithReset } = await import('../src/transcode/restart.ts')

function fakePlan() {
  return {
    method: 'transcode',
    renditions: [{ profile: { name: 'x' }, videoCodec: 'avc1' }],
  } as any
}

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

describe('restartWithReset process lifecycle (issue #79)', () => {
  let dir: string

  beforeEach(async () => {
    order.length = 0
    oldProcessAliveAtSpawn = false
    dir = await mkdtemp(path.join(tmpdir(), 'horizon-lifecycle-'))
    await mkdir(path.join(dir, 'r0'), { recursive: true })
    await writeFile(path.join(dir, 'r0', 'init.mp4'), Buffer.alloc(64))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('awaits old process exit before spawning the replacement (no two-process window)', async () => {
    const proc = fakeProc()
    const session: any = {
      id: 's1',
      sessionDir: dir,
      filePath: '/m.mkv',
      ffmpegProcess: proc,
      currentStartSegment: 0,
    }

    const p = restartWithReset(session, { name: 'cpu' } as any, fakePlan(), 5)

    // kill ran, spawn is blocked while the old process is still alive.
    await new Promise(r => setTimeout(r, 30))
    expect(order).toEqual(['kill'])

    proc.fireExit()
    await p

    expect(order).toEqual(['kill', 'spawn'])
    expect(oldProcessAliveAtSpawn).toBe(false)
  })

  it('still proceeds (bounded) if the old process never acknowledges the kill', async () => {
    // Process never exits. waitForExit must fall through after KILL_DRAIN_MS
    // (500ms) rather than blocking forever.
    const proc = fakeProc()
    const session: any = {
      id: 's2',
      sessionDir: dir,
      filePath: '/m.mkv',
      ffmpegProcess: proc,
      currentStartSegment: 0,
    }
    const t0 = Date.now()
    await restartWithReset(session, { name: 'cpu' } as any, fakePlan(), 0)
    const elapsed = Date.now() - t0
    expect(order).toEqual(['kill', 'spawn'])
    expect(elapsed).toBeGreaterThanOrEqual(400) // waited out the drain
    expect(elapsed).toBeLessThan(2_000)         // but bounded
  })

  it('does not wait when there is no existing process', async () => {
    const session: any = {
      id: 's3',
      sessionDir: dir,
      filePath: '/m.mkv',
      ffmpegProcess: undefined,
      currentStartSegment: 0,
    }
    const t0 = Date.now()
    await restartWithReset(session, { name: 'cpu' } as any, fakePlan(), 0)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(order).toEqual(['kill', 'spawn'])
  })
})
