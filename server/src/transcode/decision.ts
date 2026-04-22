import type { ProbeResult } from '../scanner/probe.ts'

export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number
  container: string[]
}

export type PlaybackMethod = 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'

export interface PlaybackDecision {
  method: PlaybackMethod
  needsToneMap: boolean
  audioTranscodeNeeded: boolean
}

const CONTAINER_MAP: Record<string, string[]> = {
  'matroska,webm': ['matroska', 'webm', 'mkv'],
  'mov,mp4,m4a,3gp,3g2,mj2': ['mp4', 'mov', 'm4a'],
}

function containerSupported(ffContainer: string, clientContainers: string[]): boolean {
  const aliases = CONTAINER_MAP[ffContainer] ?? [ffContainer]
  return aliases.some(a => clientContainers.includes(a))
}

function hdrSupported(hdr: ProbeResult['hdr'], clientHdr: string[]): boolean {
  if (hdr.dv && !clientHdr.includes('dv')) return false
  if ((hdr.hdr10 || hdr.hdr10plus) && !clientHdr.includes('hdr10') && !clientHdr.includes('dv')) return false
  return true
}

export function decidePlayback(probe: ProbeResult, caps: ClientCapabilities): PlaybackDecision {
  const sourceBitrateKbps = Math.round(probe.videoBitrate / 1000)
  const bitrateOk = caps.maxBitrate === 0 || sourceBitrateKbps <= caps.maxBitrate

  const videoCodecOk = caps.videoCodecs.includes(probe.videoCodec)
  const hdrOk = hdrSupported(probe.hdr, caps.hdr)
  const containerOk = containerSupported(probe.container, caps.container)
  const defaultAudio = probe.audioTracks.find(t => t.default) ?? probe.audioTracks[0]
  const audioOk = defaultAudio ? caps.audioCodecs.includes(defaultAudio.codec) : true

  const needsToneMap = (probe.hdr.dv || probe.hdr.hdr10 || probe.hdr.hdr10plus) && !hdrOk

  if (videoCodecOk && hdrOk && audioOk && containerOk && bitrateOk) {
    return { method: 'direct-play', needsToneMap: false, audioTranscodeNeeded: false }
  }

  if (videoCodecOk && hdrOk && audioOk && !containerOk && bitrateOk) {
    return { method: 'direct-stream', needsToneMap: false, audioTranscodeNeeded: false }
  }

  if (videoCodecOk && hdrOk && !audioOk && bitrateOk) {
    return { method: 'partial-transcode', needsToneMap: false, audioTranscodeNeeded: true }
  }

  return { method: 'transcode', needsToneMap, audioTranscodeNeeded: true }
}
