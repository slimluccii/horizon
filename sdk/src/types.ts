export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number    // kbps; 0 = unlimited
  container: string[]
}

export type PlaybackMethod = 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'

export type HorizonErrorCode =
  | 'media-not-found' | 'session-not-found' | 'session-attach-timeout'
  | 'capabilities-unsupported' | 'transcode-failed' | 'file-read-error'
  | 'audio-track-invalid' | 'max-sessions' | 'probe-failed'
  | 'session-destroyed' | 'network-error'

export interface HorizonError {
  code: HorizonErrorCode
  message: string
  fatal: boolean
}

export interface HorizonWarning {
  code: string
  message: string
}

export interface QualityProfile {
  name?: string
  videoBitrate: number
  audioBitrate: number
  width?: number
  height?: number
  videoCodec?: string   // not included in server Profile; optional for display only
  audioCodec?: string
}

export interface SessionInfo {
  sessionId: string
  method: PlaybackMethod
  streamUrl: string
  wsUrl: string
  profiles: QualityProfile[]
  selectedAudioTrack: number
  selectedSubtitleTrack: number | null
}

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string
  title: string
  default: boolean
}

export interface SubtitleTrack {
  index: number
  codec: string
  language: string
  forced: boolean
  embeddable: boolean
}

export interface MediaItem {
  id: string
  title: string
  year?: number
  duration: number
  resolution: string
  videoCodec: string
  hdr: { dv: boolean; hdr10: boolean; hdr10plus: boolean }
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  container: string
}
