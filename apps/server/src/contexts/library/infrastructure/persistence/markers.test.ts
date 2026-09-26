import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../../platform/db/connection.ts'
import { migrate } from '../../../../platform/db/migrations.ts'
import { createMarkersRepo, type MarkersRepo } from './markers.ts'

let db: DatabaseSync
let repo: MarkersRepo

function seedEpisode(id: string, mtimeMs: number, sizeBytes: number) {
  db.prepare(
    `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes, first_seen_at, last_seen_at)
     VALUES (?, 'episode', ?, ?, ?, ?, 0, 0)`,
  ).run(id, `Title ${id}`, `/tv/${id}.mkv`, mtimeMs, sizeBytes)
}

const file = { mtimeMs: 1000, sizeBytes: 5000 }
const intro = { kind: 'intro' as const, startMs: 51_000, endMs: 96_000 }
const credits = { kind: 'credits' as const, startMs: 1_204_000, endMs: 1_243_000 }

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  repo = createMarkersRepo(db)
  seedEpisode('e1', file.mtimeMs, file.sizeBytes)
})

describe('markers', () => {
  it('returns the markers stored for the file as it is now', () => {
    repo.replace('e1', 'chapter', { ...file, markers: [intro, credits] })
    expect(repo.get('e1')).toEqual([intro, credits])
  })

  it('is empty for a file that has no markers', () => {
    expect(repo.get('e1')).toEqual([])
  })

  it('ignores markers made for an earlier version of the file, as after a quality upgrade', () => {
    repo.replace('e1', 'chapter', { ...file, markers: [intro] })
    db.prepare('UPDATE media_items SET mtime_ms = 2000, size_bytes = 9000 WHERE id = ?').run('e1')
    expect(repo.get('e1')).toEqual([])
  })

  it('replaces what a source stored before, including markers it no longer finds', () => {
    repo.replace('e1', 'chapter', { ...file, markers: [intro, credits] })
    repo.replace('e1', 'chapter', { ...file, markers: [credits] })
    expect(repo.get('e1')).toEqual([credits])
  })

  it('prefers a chapter marker over a fingerprint marker of the same kind', () => {
    repo.replace('e1', 'fingerprint', { ...file, markers: [{ ...intro, startMs: 50_000 }] })
    repo.replace('e1', 'chapter', { ...file, markers: [intro] })
    expect(repo.get('e1')).toEqual([intro])
  })

  it('keeps a fingerprint marker for a kind the chapters do not name', () => {
    repo.replace('e1', 'chapter', { ...file, markers: [credits] })
    repo.replace('e1', 'fingerprint', { ...file, markers: [intro] })
    expect(repo.get('e1')).toEqual([intro, credits])
  })

  it('goes away with the media item', () => {
    repo.replace('e1', 'chapter', { ...file, markers: [intro] })
    db.prepare('DELETE FROM media_items WHERE id = ?').run('e1')
    expect(db.prepare('SELECT COUNT(*) n FROM media_markers').get()).toEqual({ n: 0 })
  })
})
