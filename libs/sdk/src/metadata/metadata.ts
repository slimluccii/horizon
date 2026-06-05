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
  collection?: {
    tmdbId: number
    name: string
    posterPath?: string | null
    backdropPath?: string | null
  }
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

/**
 * Resolve a TMDB-relative image path (e.g. `/abc.jpg`) to a URL served by
 * Horizon's image proxy. Returns null when path is missing so call sites can
 * render placeholders inline without checking twice.
 */
export type ImageSize = 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'original'

export function tmdbImageUrl(
  path: string | null | undefined,
  size: ImageSize = 'w500',
  baseUrl = '',
): string | null {
  if (!path) return null
  // TMDB paths arrive with a leading slash; strip it so the URL doesn't
  // double-slash and so the proxy's `*` segment matches as expected.
  const tail = path.replace(/^\//, '')
  return `${baseUrl}/api/metadata/image/${size}/${tail}`
}
