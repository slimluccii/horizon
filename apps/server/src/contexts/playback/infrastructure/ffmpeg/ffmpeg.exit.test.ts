import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Session } from '../../domain/types.ts'
import type { PlaybackPlan } from '../../domain/plan.ts'
import type { HwAccel } from '../../domain/hwaccel.ts'

class FakeProc extends EventEmitter {
  pid = 1234
  killed = false
  exitCode: number | null = null
  signalCode: string | null = null
  stderr = new EventEmitter()
  signals: string[] = []
  kill(signal: string) {
    this.signals.push(signal)
    this.killed = true
    return true
  }
  exit(code: number | null, signal: string | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

const spawned: FakeProc[] = []
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    const proc = new FakeProc()
    spawned.push(proc)
    return proc
  },
}))

const { spawnFfmpeg, killFfmpeg } = await import('./ffmpeg.ts')

const plan: PlaybackPlan = {
  method: 'transcode',
  needsToneMap: false,
  toneMap: { operator: 'hable', postCorrection: true },
  renditions: [
    { profile: { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080, h264Level: '4.2' }, videoCodec: 'avc1.640028' },
  ],
  audioTrackIndex: 0,
  audioStrategy: 'aac',
  videoStrategy: 'transcode',
  burnInSubtitleIndex: null,
}

const hwAccel: HwAccel = {
  ffmpegVersion: '6.0', encoder: 'videotoolbox', h264Encoder: 'h264_videotoolbox',
  hevcEncoder: 'hevc_videotoolbox', hwaccelDecode: ['-hwaccel', 'videotoolbox'],
}

describe('ffmpeg exit reporting', () => {
  let dir: string
  let sent: any[]
  let session: Session

  beforeEach(async () => {
    spawned.length = 0
    dir = await mkdtemp(path.join(tmpdir(), 'horizon-exit-'))
    sent = []
    session = {
      id: 's1',
      filePath: '/media/x.mkv',
      sessionDir: dir,
      wsSocket: { send: (data: string) => sent.push(JSON.parse(data)) },
    } as unknown as Session
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const start = () => spawnFfmpeg(session, hwAccel, plan, {
    sourceFilePath: '/media/x.mkv', sessionDir: dir, startSegment: 0, seekPositionMs: 0,
  })

  it('says nothing to the client when the transcode finishes, since the viewer is still watching', async () => {
    await start()
    spawned[0].exit(0)
    expect(sent).toEqual([])
  })

  it('does not report a failure when it stopped ffmpeg itself', async () => {
    await start()
    killFfmpeg(session)
    spawned[0].exit(255)
    expect(sent).toEqual([])
  })

  it('reports a fatal transcode failure when ffmpeg dies on its own', async () => {
    await start()
    spawned[0].exit(1)
    expect(sent).toMatchObject([{ type: 'error', code: 'transcode-failed', fatal: true }])
  })

  it('still reports a crash of the replacement process after an intentional stop', async () => {
    await start()
    killFfmpeg(session)
    spawned[0].exit(255)
    await start()
    spawned[1].exit(1)
    expect(sent).toMatchObject([{ type: 'error', code: 'transcode-failed', fatal: true }])
  })
})
