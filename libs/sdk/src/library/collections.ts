import type { MediaItem } from './mediaItem.ts'

export interface CollectionSummary {
  id: string
  name: string
  tmdbId: number | null
  posterPath: string | null
  backdropPath: string | null
  movies: MediaItem[]
}

export type GridEntry =
  | { kind: 'movie'; movie: MediaItem }
  | { kind: 'collection'; collection: CollectionSummary }

/** Merge a flat movie list with collections for the Movies grid.
 *  collapse=false → every movie as its own entry (no collections).
 *  collapse=true  → one entry per collection + every movie NOT in any
 *  collection, sorted: collections by name, then movies by title. */
export function mergeMoviesAndCollections(
  movies: MediaItem[],
  collections: CollectionSummary[],
  collapse: boolean,
): GridEntry[] {
  if (!collapse) return movies.map(movie => ({ kind: 'movie', movie }))

  const inCollection = new Set<string>()
  for (const c of collections) for (const m of c.movies) inCollection.add(m.id)

  const colEntries: GridEntry[] = [...collections]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(collection => ({ kind: 'collection', collection }))

  const movieEntries: GridEntry[] = movies
    .filter(m => !inCollection.has(m.id))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(movie => ({ kind: 'movie', movie }))

  return [...colEntries, ...movieEntries]
}
