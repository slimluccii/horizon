/**
 * Normalized metadata returned by the metadata layer. Detached from any
 * provider's wire shape so we can swap TMDB → TVDB → ... without touching the
 * UI. Optional fields stay undefined when the provider didn't return them.
 */

export interface Person {
  name: string
  /** Character name for cast, role/job for crew. */
  role?: string
  /** Provider-relative profile image path; resolve with `/metadata/image/...`. */
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
  releaseDate?: string             // ISO date YYYY-MM-DD
  runtimeMinutes?: number
  rating?: number                  // 0–10
  ratingCount?: number
  genres?: string[]
  posterPath?: string | null
  backdropPath?: string | null
  cast?: Person[]
  directors?: Person[]
  /** TMDB belongs_to_collection, when the film is part of a franchise. */
  collection?: {
    tmdbId: number
    name: string
    posterPath?: string | null
    backdropPath?: string | null
  }
}

export interface ShowMetadata {
  kind: 'show'
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  title: string
  originalTitle?: string
  tagline?: string
  overview?: string
  firstAirDate?: string
  status?: string                  // "Returning Series", "Ended", ...
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
  /** Episode still frame. */
  stillPath?: string | null
}

export type Metadata = MovieMetadata | ShowMetadata | EpisodeMetadata
