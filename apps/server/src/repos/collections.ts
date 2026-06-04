import type { DatabaseSync } from '../db/index.ts'

export interface Collection {
  id: string
  name: string
  tmdbId: number | null
  posterPath: string | null
  backdropPath: string | null
  movieIds: string[]
}

export interface CollectionsRepo {
  /** Replace the entire collection set. Used after a rescan — simpler than
   *  diffing and avoids leaving orphan rows. */
  replaceAll(collections: Collection[]): void
  list(): Collection[]
}

export function createCollectionsRepo(db: DatabaseSync): CollectionsRepo {
  return {
    replaceAll(collections) {
      const now = Date.now()
      db.exec('BEGIN')
      try {
        db.exec('DELETE FROM collections')   // cascades to collection_items
        const insCol = db.prepare(
          'INSERT INTO collections (id, name, tmdb_id, poster_path, backdrop_path, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        const insItem = db.prepare(
          'INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)',
        )
        for (const c of collections) {
          insCol.run(c.id, c.name, c.tmdbId, c.posterPath, c.backdropPath, now)
          c.movieIds.forEach((mediaId, pos) => insItem.run(c.id, mediaId, pos))
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    list() {
      const cols = db.prepare(
        'SELECT id, name, tmdb_id, poster_path, backdrop_path FROM collections ORDER BY name ASC',
      ).all() as { id: string; name: string; tmdb_id: number | null; poster_path: string | null; backdrop_path: string | null }[]
      const itemsByCollection = new Map<string, string[]>()
      const itemRows = db.prepare(
        `SELECT collection_id, media_id
           FROM collection_items
          ORDER BY collection_id, position`,
      ).all() as { collection_id: string; media_id: string }[]
      for (const row of itemRows) {
        const arr = itemsByCollection.get(row.collection_id) ?? []
        arr.push(row.media_id)
        itemsByCollection.set(row.collection_id, arr)
      }
      return cols.map(c => ({
        id: c.id,
        name: c.name,
        tmdbId: c.tmdb_id,
        posterPath: c.poster_path,
        backdropPath: c.backdrop_path,
        movieIds: itemsByCollection.get(c.id) ?? [],
      }))
    },
  }
}
