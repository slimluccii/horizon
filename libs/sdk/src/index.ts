// sdk/src/index.ts
export { HorizonClient, isRoleChangedError, isProgressNotFoundError } from './client.ts'
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
  ServerSettings, ServerSettingsPatch,
} from './types.ts'
export { tmdbImageUrl } from './metadata.ts'
export { PreferencesSchema, SUPPORTED_LANGUAGES } from './preferences.ts'
export type { Preferences } from './preferences.ts'
