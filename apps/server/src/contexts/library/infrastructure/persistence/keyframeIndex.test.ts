import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createKeyframeIndexRepo, type KeyframeIndexRepo } from './keyframeIndex.ts'

let db: DatabaseSync
let repo: KeyframeIndexRepo

function seedMovie(id: string, mtimeMs: number, sizeBytes: number) {
  db.prepare(
    `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes, first_seen_at, last_seen_at)
     VALUES (?, 'movie', ?, ?, ?, ?, 0, 0)`,
  ).run(id, `Title ${id}`, `/movies/${id}.mkv`, mtimeMs, sizeBytes)
}

const keyframes = [{ ptsSec: 0, dtsSec: -0.083 }, { ptsSec: 2.5, dtsSec: 2.417 }]

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  repo = createKeyframeIndexRepo(db)
  seedMovie('m1', 1000, 5000)
})

describe('keyframe index', () => {
  it('returns what was stored for the file as it is now', () => {
    repo.put('m1', { mtimeMs: 1000, sizeBytes: 5000, keyframes })
    expect(repo.get('m1')).toEqual(keyframes)
  })

  it('is empty for a file that has not been indexed', () => {
    expect(repo.get('m1')).toBeNull()
  })

  it('ignores an index made for an earlier version of the file, as after a quality upgrade', () => {
    repo.put('m1', { mtimeMs: 1000, sizeBytes: 5000, keyframes })
    db.prepare('UPDATE media_items SET mtime_ms = 2000, size_bytes = 9000 WHERE id = ?').run('m1')
    expect(repo.get('m1')).toBeNull()
  })

  it('replaces the index when the file is indexed again', () => {
    repo.put('m1', { mtimeMs: 1000, sizeBytes: 5000, keyframes })
    repo.put('m1', { mtimeMs: 1000, sizeBytes: 5000, keyframes: [keyframes[0]] })
    expect(repo.get('m1')).toEqual([keyframes[0]])
  })

  it('goes away with the media item', () => {
    repo.put('m1', { mtimeMs: 1000, sizeBytes: 5000, keyframes })
    db.prepare('DELETE FROM media_items WHERE id = ?').run('m1')
    expect(db.prepare('SELECT COUNT(*) n FROM keyframe_index').get()).toEqual({ n: 0 })
  })
})
