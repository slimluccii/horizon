export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number    // kbps; 0 = unlimited
  container: string[]
}

export type PlaybackMethod = 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'

/**
 * Single source of truth for every error `code` the server can emit on the
 * wire (via `errorReply`/`sendNotFound`/… or `throw Object.assign(new Error(),
 * { code })`). Both the server and the SDK reference this object so a new code
 * cannot be introduced on one side without the other seeing it.
 *
 * Values are stable kebab-case strings — they are part of the API contract.
 */
export const ErrorCodes = {
  AUDIO_TRACK_INVALID: 'audio-track-invalid',
  CALLER_FORBIDDEN: 'caller-forbidden',
  FETCH_FAILED: 'fetch-failed',
  FFMPEG_SPAWN_FAILED: 'ffmpeg-spawn-failed',
  IMAGE_NOT_FOUND: 'image-not-found',
  INVALID_INPUT: 'invalid-input',
  INVALID_PATH: 'invalid-path',
  INVALID_SIZE: 'invalid-size',
  MAX_SESSIONS: 'max-sessions',
  MEDIA_NOT_FOUND: 'media-not-found',
  NAME_TAKEN: 'name-taken',
  NO_USER: 'no-user',
  NOT_FOUND: 'not-found',
  NOT_READY: 'not-ready',
  OWNER_EXISTS: 'owner-exists',
  OWNER_PROTECTED: 'owner-protected',
  PROGRESS_NOT_FOUND: 'progress-not-found',
  ROLE_IMMUTABLE: 'role-immutable',
  SEEK_RESTART_FAILED: 'seek-restart-failed',
  SESSION_NOT_FOUND: 'session-not-found',
  TMDB_DISABLED: 'tmdb-disabled',
  TRANSCODE_FAILED: 'transcode-failed',
  UNKNOWN_SCENARIO: 'unknown-scenario',
  USER_MISMATCH: 'user-mismatch',
  USER_NOT_FOUND: 'user-not-found',
} as const

/** Every server-emitted error code, derived from {@link ErrorCodes}. */
export type ServerErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Codes the client/SDK raises locally (never sent by the server) — e.g. a
 * playback session timing out attaching, or a probe failing in the browser.
 */
export type ClientErrorCode =
  | 'session-attach-timeout' | 'capabilities-unsupported' | 'file-read-error'
  | 'probe-failed' | 'session-destroyed' | 'network-error'

export type HorizonErrorCode = ServerErrorCode | ClientErrorCode

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

export interface ExternalIds {
  tmdb?: number
  tvdb?: number
  imdb?: string
}

export interface Person {
  name: string
  role?: string
  profilePath?: string | null
}

export interface MovieMetadata {
  kind: 'movie'
  tmdbId?: number
  imdbId?: string
  title: string
  originalTitle?: string
  tagline?: string
  overview?: string
  releaseDate?: string
  runtimeMinutes?: number
  rating?: number
  ratingCount?: number
  genres?: string[]
  posterPath?: string | null
  backdropPath?: string | null
  cast?: Person[]
  directors?: Person[]
}

export interface ShowMetadataInfo {
  kind: 'show'
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  title: string
  originalTitle?: string
  tagline?: string
  overview?: string
  firstAirDate?: string
  status?: string
  rating?: number
  ratingCount?: number
  genres?: string[]
  posterPath?: string | null
  backdropPath?: string | null
  network?: string
}

export interface EpisodeMetadata {
  kind: 'episode'
  tmdbId?: number
  showTmdbId?: number
  season: number
  episode: number
  title?: string
  overview?: string
  airDate?: string
  rating?: number
  ratingCount?: number
  runtimeMinutes?: number
  stillPath?: string | null
}

export interface MediaItem {
  id: string
  title: string
  year?: number
  /** Episode only — season number in the show. */
  season?: number
  /** Episode only — episode number within the season. */
  episode?: number
  duration: number
  resolution: string
  videoCodec: string
  hdr: { dv: boolean; hdr10: boolean; hdr10plus: boolean }
  audioTracks: AudioTrack[]
  subtitleTracks: SubtitleTrack[]
  container: string
  externalIds?: ExternalIds
  /** Provider-enriched metadata. Movie items get MovieMetadata, episode items
   *  get EpisodeMetadata. Optional — absent when no provider configured / no
   *  match found. */
  metadata?: MovieMetadata | EpisodeMetadata
}

export interface SeasonSummary {
  number: number
  episodeCount: number
}

export interface ShowSummary {
  id: string
  title: string
  seasons: SeasonSummary[]
  externalIds?: ExternalIds
  metadata?: ShowMetadataInfo
}

import type { Preferences } from './preferences.ts'

export interface User {
  id: string
  name: string
  avatar: string | null
  preferences: Preferences
  role: 'owner' | 'admin' | 'member'
  createdAt: number
  updatedAt: number
}

export interface WatchProgress {
  mediaId: string
  positionMs: number
  durationMs: number
  watched: boolean
  updatedAt: number
}

export interface ContinueWatchingItem {
  mediaId: string
  kind: 'movie' | 'episode'
  positionMs: number
  durationMs: number
  percent: number
  updatedAt: number
  media: MediaItem
  show?: MediaItem
}

/**
 * Wire shape returned by GET/PATCH /settings/server.
 * tmdbToken is masked: "set" | "unset" — never the real value.
 */
export interface ServerSettings {
  // Library
  watchedThresholdPct: number
  scanCronHour: number
  scanConcurrency: number
  watchFs: boolean
  watchDebounceMs: number
  // Metadata
  tmdbToken: 'set' | 'unset'
  metadataBatchSize: number
  metadataMaxAgeMovieDays: number
  metadataMaxAgeShowDays: number
  metadataMaxAgeEpDays: number
  // Playback
  maxSessions: number
  maxRenditions: number
  wsGraceMs: number
  wsAttachMs: number
  forceEncoder: string | null
  tonemapOperator: string
  tonemapParam: number | null
  tonemapDesat: number | null
  updatedAt: number
}

export type ServerSettingsPatch = Partial<Omit<ServerSettings, 'tmdbToken' | 'updatedAt'> & { tmdbToken?: string | null }>
