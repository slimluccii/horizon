export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number    // kbps; 0 = unlimited
  container: string[]
}

const CODEC_TESTS: Array<{ codec: string; mimeType: string }> = [
  { codec: 'hevc', mimeType: 'video/mp4; codecs="hvc1.1.6.L150.90"' },
  { codec: 'h264', mimeType: 'video/mp4; codecs="avc1.640028"' },
  { codec: 'av1',  mimeType: 'video/mp4; codecs="av01.0.08M.08"' },
  { codec: 'vp9',  mimeType: 'video/webm; codecs="vp9"' },
]

const AUDIO_TESTS: Array<{ codec: string; mimeType: string }> = [
  { codec: 'eac3', mimeType: 'audio/mp4; codecs="ec-3"' },
  { codec: 'ac3',  mimeType: 'audio/mp4; codecs="ac-3"' },
  { codec: 'aac',  mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
  { codec: 'opus', mimeType: 'audio/webm; codecs="opus"' },
]

const HDR_TESTS: Array<{ format: string; mimeType: string }> = [
  { format: 'dv',    mimeType: 'video/mp4; codecs="dvhe.08.07"' },
  { format: 'hdr10', mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
]

function supported(mimeType: string): boolean {
  if (typeof MediaSource === 'undefined') return false
  try {
    return MediaSource.isTypeSupported(mimeType)
  } catch {
    return false
  }
}

export function detectCapabilities(overrides?: Partial<ClientCapabilities>): ClientCapabilities {
  const videoCodecs = CODEC_TESTS.filter(t => supported(t.mimeType)).map(t => t.codec)
  const audioCodecs = AUDIO_TESTS.filter(t => supported(t.mimeType)).map(t => t.codec)
  const hdr = HDR_TESTS.filter(t => supported(t.mimeType)).map(t => t.format)
  const container = ['mp4']
  if (typeof MediaSource === 'undefined') {
    // non-browser: return safe defaults
    return {
      videoCodecs: overrides?.videoCodecs ?? ['h264'],
      audioCodecs: overrides?.audioCodecs ?? ['aac'],
      hdr: overrides?.hdr ?? [],
      maxBitrate: overrides?.maxBitrate ?? 0,
      container: overrides?.container ?? ['mp4'],
    }
  }
  // ensure h264 + aac always present as fallback
  if (!videoCodecs.includes('h264')) videoCodecs.push('h264')
  if (!audioCodecs.includes('aac')) audioCodecs.push('aac')

  return {
    videoCodecs: overrides?.videoCodecs ?? videoCodecs,
    audioCodecs: overrides?.audioCodecs ?? audioCodecs,
    hdr: overrides?.hdr ?? hdr,
    maxBitrate: overrides?.maxBitrate ?? 0,
    container: overrides?.container ?? container,
  }
}
