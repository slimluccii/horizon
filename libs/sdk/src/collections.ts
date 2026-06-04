import type { MediaItem } from './types.ts'

export interface CollectionSummary {
  id: string
  name: string
  tmdbId: number | null
  posterPath: string | null
  backdropPath: string | null
  movies: MediaItem[]
}
