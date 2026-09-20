import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../../platform/db/connection.ts'
import { migrate } from '../../../platform/db/migrations.ts'
import { createMediaRepo } from '../infrastructure/persistence/media.ts'
import { createKeyframeIndexRepo, type KeyframeIndexRepo } from '../infrastructure/persistence/keyframeIndex.ts'
import { createKeyframeIndexer } from './keyframeIndexer.ts'

let db: DatabaseSync
let index: KeyframeIndexRepo

function seed(id: string, kind: 'movie' | 'show' = 'movie') {
  db.prepare(
    `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, 0)`,
  ).run(id, kind, id, kind === 'show' ? null : `/m/${id}.mkv`, Number(id.replace(/\D/g, '')) || 0)
}

const keyframes = [{ ptsSec: 0, dtsSec: 0 }, { ptsSec: 2, dtsSec: 2 }]
const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  index = createKeyframeIndexRepo(db)
})
afterEach(() => { vi.useRealTimers() })

function indexer(opts: { idle?: () => boolean; extract?: (file: string) => Promise<typeof keyframes> } = {}) {
  const extracted: string[] = []
  const extract = opts.extract ?? (async (file: string) => { extracted.push(file); return keyframes })
  const worker = createKeyframeIndexer({
    media: createMediaRepo(db), index, extract, isIdle: opts.idle ?? (() => true), retryWhenBusyMs: 1000,
  })
  return { worker, extracted }
}

describe('keyframe indexer', () => {
  it('indexes a requested file and stores the result for the file as it is', async () => {
    seed('m1')
    const { worker, extracted } = indexer()
    worker.request('m1')
    await worker.idle()
    expect(extracted).toEqual(['/m/m1.mkv'])
    expect(index.get('m1')).toEqual(keyframes)
  })

  it('works through the library one file at a time, and skips shows and files that are already indexed', async () => {
    seed('m1'); seed('m2'); seed('m3'); seed('s1', 'show')
    index.put('m2', { mtimeMs: 1, sizeBytes: 1, keyframes })
    let running = 0
    let peak = 0
    const seen: string[] = []
    const { worker } = indexer({
      extract: async file => { peak = Math.max(peak, ++running); seen.push(file); await settle(); running--; return keyframes },
    })
    worker.indexLibrary()
    await worker.idle()
    expect(seen).toEqual(['/m/m1.mkv', '/m/m3.mkv'])
    expect(peak).toBe(1)
  })

  it('puts a requested file ahead of the rest of the library', async () => {
    seed('m1'); seed('m2'); seed('m3')
    const { worker, extracted } = indexer()
    worker.indexLibrary()
    worker.request('m3')
    await worker.idle()
    expect(extracted[0]).toBe('/m/m3.mkv')
    expect(extracted).toHaveLength(3)
  })

  it('leaves the library for later while someone is watching, but still indexes a requested file', async () => {
    vi.useFakeTimers()
    seed('m1'); seed('m2')
    let idle = false
    const { worker, extracted } = indexer({ idle: () => idle })
    worker.indexLibrary()
    worker.request('m2')
    await vi.advanceTimersByTimeAsync(10)
    expect(extracted).toEqual(['/m/m2.mkv'])

    idle = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(extracted).toEqual(['/m/m2.mkv', '/m/m1.mkv'])
  })

  it('moves on when a file cannot be read, and does not try it again in this run', async () => {
    seed('m1'); seed('m2')
    const tried: string[] = []
    const { worker } = indexer({
      extract: async file => { tried.push(file); if (file.includes('m1')) throw new Error('ffprobe failed'); return keyframes },
    })
    worker.indexLibrary()
    await worker.idle()
    worker.indexLibrary()
    await worker.idle()
    expect(tried).toEqual(['/m/m1.mkv', '/m/m2.mkv'])
    expect(index.get('m2')).toEqual(keyframes)
  })
})
