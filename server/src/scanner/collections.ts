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

export interface CollectionCandidate {
  id: string
  title: string
}

export interface DetectedCollection<T extends CollectionCandidate = CollectionCandidate> {
  name: string
  movies: T[]
}

export function detectCollections<T extends CollectionCandidate>(movies: T[]): DetectedCollection<T>[] {
  const groups = new Map<string, T[]>()

  for (const movie of movies) {
    const base = stripCollectionSuffix(movie.title)
    const existing = groups.get(base) ?? []
    existing.push(movie)
    groups.set(base, existing)
  }

  const collections: DetectedCollection<T>[] = []
  for (const [base, members] of groups) {
    if (members.length < 2) continue
    // Sort by year if available (duck-typed); stable otherwise.
    const sorted = [...members].sort((a, b) => {
      const ya = (a as any).year ?? (a as any).sortYear ?? 0
      const yb = (b as any).year ?? (b as any).sortYear ?? 0
      return ya - yb
    })
    collections.push({
      name: base,
      movies: sorted,
    })
  }

  return collections
}
