import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface HwAccel {
  ffmpegVersion: string
  encoder: string
  h264Encoder: string
  hevcEncoder: string
  hwaccelDecode: string[]
  /** Whether the chosen H.264 encoder accepts `-a53cc`. Not every encoder has
   *  the option, and ffmpeg rejects the whole command for one it does not know. */
  h264SupportsA53cc: boolean
}

const ENCODER_PRIORITY: Array<{
  name: string
  h264: string
  hevc: string
  decode: string[]
}> = [
  {
    name: 'videotoolbox',
    h264: 'h264_videotoolbox',
    hevc: 'hevc_videotoolbox',
    decode: ['-hwaccel', 'videotoolbox'],
  },
  {
    name: 'nvenc',
    h264: 'h264_nvenc',
    hevc: 'hevc_nvenc',
    decode: ['-hwaccel', 'nvdec'],
  },
  {
    name: 'qsv',
    h264: 'h264_qsv',
    hevc: 'hevc_qsv',
    decode: ['-hwaccel', 'qsv', '-init_hw_device', 'qsv=hw'],
  },
]

async function getFFmpegVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'])
    return stdout.split('\n')[0] ?? 'unknown'
  } catch {
    throw new Error('ffmpeg not found in PATH — install ffmpeg to use Horizon')
  }
}

async function getAvailableEncoders(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-encoders', '-v', 'quiet'])
    const encoders = new Set<string>()
    for (const line of stdout.split('\n')) {
      const match = /^\s*[VAS].+?\s+(\S+)\s/.exec(line)
      if (match) encoders.add(match[1])
    }
    return encoders
  } catch {
    return new Set()
  }
}

/**
 * Whether an encoder can actually encode a frame on THIS host — not merely
 * whether ffmpeg lists it. Distribution ffmpeg builds (e.g. Debian) compile in
 * h264_nvenc / hevc_nvenc / *_qsv unconditionally, so `-encoders` reports them
 * even with no GPU. Selecting one on that basis means every real transcode
 * fails at spawn ("Cannot load libcuda" / "No device available"). A throwaway
 * 64×64 encode to /dev/null is the only reliable signal: it forces the encoder
 * to initialise its hardware device and returns non-zero when there is none.
 * Bounded by a timeout so a wedged driver can't hang startup.
 */
async function encoderWorks(name: string): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=0.1',
      '-frames:v', '1', '-c:v', name, '-f', 'null', '-',
    ], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Whether an encoder exposes a private option in this ffmpeg build. `-h
 * encoder=…` exits 0 even for an encoder it does not recognise, so the option
 * line itself is the only signal. Help goes to stderr on some builds.
 */
async function encoderHasOption(name: string, option: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-h', `encoder=${name}`])
    return new RegExp(`^\\s*-${option}\\s`, 'm').test(stdout + stderr)
  } catch {
    return false
  }
}

export async function detectHwAccel(forceEncoder?: string): Promise<HwAccel> {
  const ffmpegVersion = await getFFmpegVersion()
  const available = await getAvailableEncoders()

  if (forceEncoder) {
    console.log(`Using forced encoder: ${forceEncoder}`)
    const h264Encoder = forceEncoder.includes('h264') ? forceEncoder : 'libx264'
    return {
      ffmpegVersion,
      encoder: forceEncoder,
      h264Encoder,
      hevcEncoder: forceEncoder.includes('hevc') ? forceEncoder : 'libx265',
      hwaccelDecode: [],
      h264SupportsA53cc: await encoderHasOption(h264Encoder, 'a53cc'),
    }
  }

  for (const opt of ENCODER_PRIORITY) {
    // Listed AND actually functional. Verify each codec independently: a host
    // may have a working hw H.264 path but a broken/absent HEVC one, in which
    // case we keep hw for H.264 and fall back to libx265 for HEVC rather than
    // rejecting the whole family.
    const h264Ok = available.has(opt.h264) && await encoderWorks(opt.h264)
    const hevcOk = available.has(opt.hevc) && await encoderWorks(opt.hevc)
    if (h264Ok || hevcOk) {
      console.log(`Hardware acceleration: ${opt.name} (h264=${h264Ok ? opt.h264 : 'libx264'}, hevc=${hevcOk ? opt.hevc : 'libx265'})`)
      const h264Encoder = h264Ok ? opt.h264 : 'libx264'
      return {
        ffmpegVersion,
        encoder: opt.name,
        h264Encoder,
        hevcEncoder: hevcOk ? opt.hevc : 'libx265',
        // Only advertise hw decode when we actually selected this hw family.
        hwaccelDecode: opt.decode,
        h264SupportsA53cc: await encoderHasOption(h264Encoder, 'a53cc'),
      }
    }
  }

  console.log('Hardware acceleration: none (CPU only)')
  return {
    ffmpegVersion,
    encoder: 'cpu',
    h264Encoder: 'libx264',
    hevcEncoder: 'libx265',
    hwaccelDecode: [],
    h264SupportsA53cc: await encoderHasOption('libx264', 'a53cc'),
  }
}
