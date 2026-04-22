import type { MovieItem } from './scanner.ts'

const ROMAN = /\b(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)$/i
const COLLECTION_TOKENS = [
  /\s+Part\s+\w+(?:\s*[-–—]\s*.+)?$/i,
  /\s+Chapter\s+\w+(?:\s*[-–—]\s*.+)?$/i,
  /\s+Vol(?:ume|\.)\s*\w+(?:\s*[-–—]\s*.+)?$/i,
]

export function stripCollectionSuffix(title: string): string {
  let t = title.replace(/\s*\(\d{4}\)$/, '').trim()
  for (const pattern of COLLECTION_TOKENS) {
    t = t.replace(pattern, '').trim()
  }
  t = t.replace(ROMAN, '').trim()
  t = t.replace(/[-–—]+$/, '').trim()
  return t
}

export interface Collection {
  id: string
  name: string
  movies: MovieItem[]
}

export function detectCollections(movies: MovieItem[]): Collection[] {
  const groups = new Map<string, MovieItem[]>()

  for (const movie of movies) {
    const base = stripCollectionSuffix(movie.title)
    const existing = groups.get(base) ?? []
    existing.push(movie)
    groups.set(base, existing)
  }

  const collections: Collection[] = []
  for (const [base, members] of groups) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => a.year - b.year)
    collections.push({
      id: Buffer.from(base).toString('hex').slice(0, 16),
      name: base,
      movies: sorted,
    })
  }

  return collections
}
