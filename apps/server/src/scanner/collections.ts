import crypto from 'node:crypto'
import type { MediaItem } from '../repos/media.ts'
import type { MovieMetadata } from '../contexts/metadata/index.ts'

export interface BuiltCollection {
  id: string
  name: string
  tmdbId: number
  posterPath: string | null
  backdropPath: string | null
  movieIds: string[]
}

function hashId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

function movieMeta(m: MediaItem): MovieMetadata | null {
  return (m.metadata as MovieMetadata | undefined)?.kind === 'movie' ? (m.metadata as MovieMetadata) : null
}

/** Group owned movies into collections using TMDB `belongs_to_collection`.
 *  Only collections with 2+ owned films are kept; members are year-sorted. */
export function buildCollections(movies: MediaItem[]): BuiltCollection[] {
  const groups = new Map<number, MediaItem[]>()
  const info = new Map<number, { name: string; posterPath: string | null; backdropPath: string | null }>()

  for (const m of movies) {
    const col = movieMeta(m)?.collection
    if (!col) continue
    const arr = groups.get(col.tmdbId) ?? []
    arr.push(m)
    groups.set(col.tmdbId, arr)
    if (!info.has(col.tmdbId)) {
      info.set(col.tmdbId, { name: col.name, posterPath: col.posterPath ?? null, backdropPath: col.backdropPath ?? null })
    }
  }

  const out: BuiltCollection[] = []
  for (const [tmdbId, members] of groups) {
    if (members.length < 2) continue
    const meta = info.get(tmdbId)!
    const sorted = [...members].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
    out.push({
      id: hashId(`tmdb-collection:${tmdbId}`),
      name: meta.name,
      tmdbId,
      posterPath: meta.posterPath,
      backdropPath: meta.backdropPath,
      movieIds: sorted.map(m => m.id),
    })
  }
  return out
}
