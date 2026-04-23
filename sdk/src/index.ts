// sdk/src/index.ts
export { HorizonClient } from './client.ts'
export { PlaybackSession } from './session.ts'
export type { PlaybackSessionOptions, SessionState } from './session.ts'
export { detectCapabilities } from './capabilities.ts'
export { BandwidthSampler } from './bandwidth.ts'
export type { BandwidthSample } from './bandwidth.ts'
export type {
  ClientCapabilities, PlaybackMethod, QualityProfile,
  HorizonError, HorizonWarning, HorizonErrorCode,
  SessionInfo, MediaItem, AudioTrack, SubtitleTrack,
  ShowSummary, SeasonSummary,
  ExternalIds, MovieMetadata, ShowMetadataInfo, EpisodeMetadata, Person,
  User, WatchProgress, ContinueWatchingItem,
} from './types.ts'
export { tmdbImageUrl } from './metadata.ts'
