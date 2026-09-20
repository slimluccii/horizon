import type { AudioTrack, SubtitleTrack } from '../playback/session.ts'
import type { MovieMetadata, EpisodeMetadata, ShowMetadataInfo } from '../metadata/metadata.ts'

export interface ExternalIds {
  tmdb?: number
  tvdb?: number
  imdb?: string
}

/**
 * A movie, show or episode as the server sends it. This is the single
 * definition of that wire shape: the server's repository returns this type, so
 * a field that changes on one side fails the other side's typecheck.
 */
export interface MediaItem {
  id: string
  kind: 'movie' | 'show' | 'episode'
  /** Episode only — the show it belongs to. */
  parentId: string | null
  title: string
  /** Release year (movies) or first-air year (shows and episodes). */
  year: number | null
  /** Episode only — season number in the show. */
  season: number | null
  /** Episode only — episode number within the season. */
  episode: number | null
  /** Episode only — last episode in a multi-episode file; equals `episode` otherwise. */
  episodeEnd: number | null
  /** Null for shows, and for files that have not been probed yet. */
  durationSec: number | null
  resolution: string | null
  videoCodec: string | null
  /** Source video bitrate in bits/s; null when not yet probed. */
  videoBitrate: number | null
  container: string | null
  hdr: { dv: boolean; hdr10: boolean; hdr10plus: boolean } | null
  audioTracks: AudioTrack[] | null
  subtitleTracks: SubtitleTrack[] | null
  externalIds: ExternalIds
  /** Provider-enriched metadata; null when no provider is configured or nothing matched. */
  metadata: MovieMetadata | EpisodeMetadata | ShowMetadataInfo | null
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
