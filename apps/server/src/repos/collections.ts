import type { DatabaseSync } from '../db/index.ts'

export interface Collection {
  id: string
  name: string
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
        const insCol = db.prepare('INSERT INTO collections (id, name, updated_at) VALUES (?, ?, ?)')
        const insItem = db.prepare(
          'INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)',
        )
        for (const c of collections) {
          insCol.run(c.id, c.name, now)
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
        'SELECT id, name FROM collections ORDER BY name ASC',
      ).all() as { id: string; name: string }[]
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
        movieIds: itemsByCollection.get(c.id) ?? [],
      }))
    },
  }
}
