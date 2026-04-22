import { spawn } from 'node:child_process'
import { mkdir, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { HwAccel } from './hwaccel.ts'
import type { Profile } from './profiles.ts'
import type { Session } from '../session/types.ts'

export async function createSessionDir(sessionId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'horizon', 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function cleanupSessionDir(sessionDir: string): Promise<void> {
  await rm(sessionDir, { recursive: true, force: true })
}

export function killFfmpeg(session: Session): void {
  if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGTERM')
    setTimeout(() => {
      if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
        session.ffmpegProcess.kill('SIGKILL')
      }
    }, 2000)
  }
}

export function pauseFfmpeg(session: Session): void {
  session.ffmpegProcess?.kill('SIGSTOP')
}

export function resumeFfmpeg(session: Session): void {
  session.ffmpegProcess?.kill('SIGCONT')
}

function buildTranscodeArgs(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
): { args: string[]; renditionCodecs: string[] } {
  const { filePath, seekPositionMs, sessionDir, needsToneMap } = session
  const seekSecs = seekPositionMs / 1000
  const canHevc = session.capabilities.videoCodecs.includes('hevc')

  const args: string[] = []
  const renditionCodecs: string[] = []

  if (hwAccel.hwaccelDecode.length > 0) {
    args.push(...hwAccel.hwaccelDecode)
  }

  if (seekSecs > 0) {
    args.push('-ss', seekSecs.toFixed(3))
  }

  args.push('-i', filePath)

  for (let i = 0; i < profiles.length; i++) {
    args.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`)
  }

  const scaleBase = (p: Profile) =>
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2`
  const toneMapFilter =
    'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    const useHevc = canHevc && p.width >= 1920
    const vEncoder = useHevc ? hwAccel.hevcEncoder : hwAccel.h264Encoder
    renditionCodecs.push(useHevc ? 'hvc1.1.6.L150.90' : 'avc1.640028')

    const vfValue = needsToneMap
      ? `${toneMapFilter},${scaleBase(p)}`
      : scaleBase(p)

    args.push(
      `-c:v:${i}`, vEncoder,
      `-b:v:${i}`, `${p.videoBitrate}k`,
      `-maxrate:v:${i}`, `${Math.round(p.videoBitrate * 1.1)}k`,
      `-bufsize:v:${i}`, `${p.videoBitrate * 2}k`,
      `-vf:${i}`, vfValue,
      `-g:v:${i}`, '48',
      `-sc_threshold:v:${i}`, '0',
      `-c:a:${i}`, 'aac',
      `-b:a:${i}`, `${p.audioBitrate}k`,
      `-ac:a:${i}`, '2',
    )
  }

  const varStreamMap = profiles.map((_, i) => `v:${i},a:${i}`).join(' ')
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `${sessionDir}/r%v/seg%03d.m4s`,
    '-var_stream_map', varStreamMap,
    `${sessionDir}/r%v/index.m3u8`,
  )

  return { args, renditionCodecs }
}

function buildDirectStreamArgs(
  session: Session,
  audioTrackIndex: number,
): string[] {
  const { filePath, seekPositionMs, sessionDir } = session
  const seekSecs = seekPositionMs / 1000
  const args: string[] = []
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  args.push('-i', filePath)
  args.push('-map', '0:v:0', `-map`, `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'copy')
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%03d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

function buildPartialTranscodeArgs(
  session: Session,
  hwAccel: HwAccel,
  profile: Profile,
  audioTrackIndex: number,
): string[] {
  const { filePath, seekPositionMs, sessionDir } = session
  const seekSecs = seekPositionMs / 1000
  const args: string[] = []
  if (hwAccel.hwaccelDecode.length > 0) args.push(...hwAccel.hwaccelDecode)
  if (seekSecs > 0) args.push('-ss', seekSecs.toFixed(3))
  args.push('-i', filePath)
  args.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}`)
  args.push('-c:v', 'copy', '-c:a', 'aac', `-b:a`, `${profile.audioBitrate}k`)
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', `${sessionDir}/r0/seg%03d.m4s`,
    `${sessionDir}/r0/index.m3u8`,
  )
  return args
}

export async function waitForSegments(sessionDir: string, renditionCount: number, minSegments = 3): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    let allReady = true
    for (let r = 0; r < renditionCount; r++) {
      const dir = path.join(sessionDir, `r${r}`)
      const files = await readdir(dir).catch(() => [])
      const segs = files.filter(f => f.endsWith('.m4s'))
      if (segs.length < minSegments) { allReady = false; break }
    }
    if (allReady) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('FFmpeg pre-buffer timeout')
}

export async function spawnFfmpeg(
  session: Session,
  hwAccel: HwAccel,
  profiles: Profile[],
  audioTrackIndex: number,
): Promise<void> {
  const { sessionDir, method } = session

  const renditionCount = method === 'transcode' ? profiles.length : 1
  for (let r = 0; r < renditionCount; r++) {
    await mkdir(path.join(sessionDir, `r${r}`), { recursive: true })
  }

  let args: string[]
  if (method === 'transcode') {
    const result = buildTranscodeArgs(session, hwAccel, profiles, audioTrackIndex)
    args = result.args
    session.renditionCodecs = result.renditionCodecs
  } else if (method === 'direct-stream') {
    args = buildDirectStreamArgs(session, audioTrackIndex)
  } else if (method === 'partial-transcode') {
    args = buildPartialTranscodeArgs(session, hwAccel, profiles[0], audioTrackIndex)
  } else {
    return
  }

  const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  session.ffmpegProcess = proc
  session.ffmpegPid = proc.pid

  proc.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.HORIZON_DEBUG) process.stderr.write(chunk)
  })

  proc.on('error', (err) => {
    // spawn-level failure (e.g. ffmpeg binary missing). Notify client; surface for caller via exit handler.
    try {
      session.wsSocket?.send(JSON.stringify({
        type: 'error',
        code: 'ffmpeg-spawn-failed',
        message: err.message,
        fatal: true,
      }))
    } catch {/* socket may be gone */}
  })

  proc.on('exit', (code) => {
    try {
      if (code !== 0 && code !== null) {
        session.wsSocket?.send(JSON.stringify({
          type: 'error',
          code: 'transcode-failed',
          message: `FFmpeg exited with code ${code}`,
          fatal: true,
        }))
      } else if (code === 0) {
        session.wsSocket?.send(JSON.stringify({ type: 'ended' }))
      }
    } catch {/* socket may be gone */}
  })

  await waitForSegments(sessionDir, renditionCount, 3)
}
