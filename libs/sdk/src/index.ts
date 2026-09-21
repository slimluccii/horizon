// sdk/src/index.ts
export { HorizonClient, isRoleChangedError, isProgressNotFoundError } from './client/client.ts'
export { PlaybackSession } from './playback/session.ts'
export type { PlaybackSessionOptions, SessionState } from './playback/session.ts'
export { detectCapabilities } from './playback/capabilities.ts'
export { BandwidthSampler } from './playback/bandwidth.ts'
export type { BandwidthSample } from './playback/bandwidth.ts'
export { ErrorCodes } from './shared/errors.ts'
export type {
  HorizonError, HorizonWarning, HorizonErrorCode,
  ServerErrorCode, ClientErrorCode,
} from './shared/errors.ts'
export type {
  ClientCapabilities,
} from './playback/capabilities.ts'
export type {
  PlaybackMethod, QualityProfile,
  SessionInfo, AudioTrack, SubtitleTrack, ActiveSessionSummary,
} from './playback/session.ts'
export type {
  MediaItem, ShowSummary, SeasonSummary, ExternalIds,
} from './library/mediaItem.ts'
export type {
  MovieMetadata, ShowMetadataInfo, EpisodeMetadata, Person,
} from './metadata/metadata.ts'
export type {
  User, AuthSession, DeviceMode, DeviceSession, ProfileSummary, SetPasswordResult, PairStartResult, PairPollResult,
} from './identity/user.ts'
export type { HouseholdView, InviteKind, InviteResult } from './identity/household.ts'
export type {
  WatchProgress, ContinueWatchingItem,
  ServerSettings, ServerSettingsPatch,
  BrowseEntry, BrowseResult,
  ScanStatusResponse, ScanHistoryEntry, ScanResultSummary,
} from './shared/http.ts'
export { tmdbImageUrl } from './metadata/metadata.ts'
export { PreferencesSchema, SUPPORTED_LANGUAGES, trackMatchesLanguage, preferredQualityMaxBitrate } from './identity/preferences.ts'
export { pickInitialTracks, isImageSubtitle, type InitialTracks } from './playback/trackSelection.ts'
export type { Preferences } from './identity/preferences.ts'
export * from './library/collections.ts'
export * from './activity/activity.ts'
export * from './activity/activityReducer.ts'
