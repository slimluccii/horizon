import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface HwAccel {
  ffmpegVersion: string
  encoder: string
  h264Encoder: string
  hevcEncoder: string
  hwaccelDecode: string[]
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

export async function detectHwAccel(forceEncoder?: string): Promise<HwAccel> {
  const ffmpegVersion = await getFFmpegVersion()
  const available = await getAvailableEncoders()

  if (forceEncoder) {
    console.log(`Using forced encoder: ${forceEncoder}`)
    return {
      ffmpegVersion,
      encoder: forceEncoder,
      h264Encoder: forceEncoder.includes('h264') ? forceEncoder : 'libx264',
      hevcEncoder: forceEncoder.includes('hevc') ? forceEncoder : 'libx265',
      hwaccelDecode: [],
    }
  }

  for (const opt of ENCODER_PRIORITY) {
    if (available.has(opt.h264) || available.has(opt.hevc)) {
      console.log(`Hardware acceleration: ${opt.name}`)
      return {
        ffmpegVersion,
        encoder: opt.name,
        h264Encoder: available.has(opt.h264) ? opt.h264 : 'libx264',
        hevcEncoder: available.has(opt.hevc) ? opt.hevc : 'libx265',
        hwaccelDecode: opt.decode,
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
  }
}
