import type { AudioTrack, SubtitleTrack } from '../playback/session.ts'
import type { MovieMetadata, EpisodeMetadata, ShowMetadataInfo } from '../metadata/metadata.ts'

export interface ExternalIds {
  tmdb?: number
  tvdb?: number
  imdb?: string
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
