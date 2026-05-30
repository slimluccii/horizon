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
  | 'caller-forbidden'

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
