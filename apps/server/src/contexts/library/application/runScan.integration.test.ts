import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../../../platform/db/connection.ts'
import { migrate } from '../../../platform/db/migrations.ts'
import { createMediaRepo } from '../infrastructure/persistence/media.ts'
import { createCollectionsRepo } from '../infrastructure/persistence/collections.ts'
import { createChangesCursorRepo } from '../infrastructure/persistence/scanState.ts'
import { createMetadataRefreshWorker, DEFAULT_REFRESH_CONFIG } from '../../metadata/index.ts'
import { rescan, runScan, fullScope } from './runScan.ts'

// Stub probe — scanner is generally backed by ffprobe. We inject a fake via
// vi.spyOn so these tests don't need ffprobe on PATH.
import * as probeMod from '../infrastructure/probe/probe.ts'

function fakeProbe(_filePath: string) {
  return {
    duration: 10,
    resolution: '1920x1080',
    videoCodec: 'h264',
    videoBitrate: 1000,
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [],
    subtitleTracks: [],
    container: 'matroska',
  }
}

describe('rescan (integration)', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'horizon-scan-'))
    vi.spyOn(probeMod, 'probe').mockImplementation(async (p: string) => fakeProbe(p) as any)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('ingests movie + show + episode, soft-deletes missing on second pass', async () => {
    const moviesRoot = path.join(tmpRoot, 'movies')
    const showsRoot = path.join(tmpRoot, 'shows')
    const showDir = path.join(showsRoot, 'A Knight of the Seven Kingdoms (2026) {tvdb-1}')
    const seasonDir = path.join(showDir, 'Season 01')
    mkdirSync(moviesRoot, { recursive: true })
    mkdirSync(seasonDir, { recursive: true })
    writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}.mkv'), '')
    writeFileSync(path.join(seasonDir, 'A Knight (2026) - S01E01 - Pilot [WEB].mkv'), '')

    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const collections = createCollectionsRepo(db)

    await rescan({
      moviesRoots: [moviesRoot],
      showsRoots: [showsRoot],
      cacheDir: tmpRoot,
      scanConcurrency: 2,
    }, { media, collections, tmdb: null })

    expect(media.listMovies().map(m => m.title)).toEqual(['Oppenheimer'])
    expect(media.listShows().map(s => s.title)).toEqual(['A Knight of the Seven Kingdoms'])
    expect(media.getEpisodes(media.listShows()[0].id)).toHaveLength(1)

    // Remove the episode, rescan
    rmSync(path.join(seasonDir, 'A Knight (2026) - S01E01 - Pilot [WEB].mkv'))
    await rescan({
      moviesRoots: [moviesRoot],
      showsRoots: [showsRoot],
      cacheDir: tmpRoot,
      scanConcurrency: 2,
    }, { media, collections, tmdb: null })
    // Content-based detection: a show is defined by its episode files. With the
    // only episode removed, the show folder holds no episodes, so the show row
    // is soft-deleted along with the episode.
    expect(media.listShows()).toHaveLength(0)
  })

  it('detects shows nested below a category folder, not the wrapper', async () => {
    // root/anime/Frieren/Season 01/S01E01.mkv  +  root/Breaking Bad/S01E02.mkv
    const root = path.join(tmpRoot, 'shows')
    mkdirSync(path.join(root, 'anime', 'Frieren', 'Season 01'), { recursive: true })
    mkdirSync(path.join(root, 'Breaking Bad'), { recursive: true })
    writeFileSync(path.join(root, 'anime', 'Frieren', 'Season 01', 'S01E01.mkv'), 'x')
    writeFileSync(path.join(root, 'Breaking Bad', 'S01E02.mkv'), 'x')

    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const collections = createCollectionsRepo(db)

    const cfg = { showsRoots: [root], moviesRoots: [], cacheDir: tmpRoot, scanConcurrency: 2 }
    await runScan(fullScope(cfg), cfg, { media, collections })

    const titles = media.listShows().map(s => s.title).sort()
    expect(titles).toEqual(['Breaking Bad', 'Frieren'])
    expect(titles).not.toContain('anime')
  })

  it('reports live progress (addTotal + tick per item)', async () => {
    const moviesRoot = path.join(tmpRoot, 'movies')
    mkdirSync(moviesRoot, { recursive: true })
    writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}.mkv'), '')
    writeFileSync(path.join(moviesRoot, 'Dune (2021) {tmdb-1}.mkv'), '')

    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const collections = createCollectionsRepo(db)

    let total = 0
    let processed = 0
    const cfg = { moviesRoots: [moviesRoot], showsRoots: [], cacheDir: tmpRoot, scanConcurrency: 2 }
    await runScan(fullScope(cfg), cfg, { media, collections }, {
      addTotal: (n) => { total += n },
      tick: () => { processed += 1 },
    })

    expect(total).toBe(2)        // two movie candidates discovered
    expect(processed).toBe(2)    // each ticked once on completion
  })

  it('emits scan:detected per movie/show and scan:done with counts', async () => {
    const moviesRoot = path.join(tmpRoot, 'movies')
    const showsRoot = path.join(tmpRoot, 'tv')
    const seasonDir = path.join(showsRoot, 'Breaking Bad', 'Season 01')
    mkdirSync(moviesRoot, { recursive: true })
    mkdirSync(seasonDir, { recursive: true })
    writeFileSync(path.join(moviesRoot, 'Inception (2010).mkv'), '')
    writeFileSync(path.join(seasonDir, 'Breaking Bad - S01E01 - Pilot.mkv'), '')

    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const collections = createCollectionsRepo(db)

    const events: any[] = []
    const bus = { emit: (e: any) => events.push(e), subscribe: () => () => {}, recent: () => [] }
    const cfg = { moviesRoots: [moviesRoot], showsRoots: [showsRoot], cacheDir: tmpRoot, scanConcurrency: 2 }
    const res = await runScan(fullScope(cfg), cfg, { media, collections, bus })

    const detected = events.filter(e => e.kind === 'scan:detected')
    expect(detected.some(e => e.mediaKind === 'movie' && e.title === 'Inception')).toBe(true)
    expect(detected.some(e => e.mediaKind === 'show' && e.title === 'Breaking Bad')).toBe(true)
    expect(detected.some(e => e.mediaKind === 'episode')).toBe(false) // episodes not emitted
    expect(res.movies).toBe(1)
    expect(res.shows).toBe(1)
  })

  it('counts a probe timeout as a failed item, not a crash (#72)', async () => {
    const moviesRoot = path.join(tmpRoot, 'movies')
    mkdirSync(moviesRoot, { recursive: true })
    writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}.mkv'), '')

    // Simulate the timeout: execFileAsync rejects with a timeout error which
    // propagates out of probe(). The scanner's .catch(() => null) must turn
    // this into a failed-count increment instead of crashing the scan.
    vi.spyOn(probeMod, 'probe').mockImplementation(async () => {
      throw Object.assign(new Error('ffprobe timed out'), { killed: true, signal: 'SIGTERM' })
    })

    const db = openDatabase(':memory:')
    migrate(db)
    const media = createMediaRepo(db)
    const collections = createCollectionsRepo(db)

    const cfg = {
      moviesRoots: [moviesRoot],
      showsRoots: [],
      cacheDir: tmpRoot,
      scanConcurrency: 2,
    }
    const result = await runScan(fullScope(cfg), cfg, { media, collections })

    expect(result.itemsFailed).toBe(1)
    expect(media.listMovies()).toHaveLength(0)
  })

  describe('data safety', () => {
    const fakeTmdb = {
      async movieByTmdbId(id: number) { return { tmdbId: id, title: 'Oppenheimer', overview: 'A physicist.' } },
      async movieByImdbId() { return null },
      async searchMovie() { return null },
      async showByTmdbId() { return null },
      async showByTvdbId() { return null },
      async searchShow() { return null },
      async episode() { return null },
      async changedMovieIds() { return [] },
      async changedShowIds() { return [] },
    } as any

    function setup() {
      const moviesRoot = path.join(tmpRoot, 'movies')
      mkdirSync(moviesRoot, { recursive: true })
      const db = openDatabase(':memory:')
      migrate(db)
      const media = createMediaRepo(db)
      const collections = createCollectionsRepo(db)
      const cfg = { moviesRoots: [moviesRoot], showsRoots: [], cacheDir: tmpRoot, scanConcurrency: 2 }
      const scan = () => runScan(fullScope(cfg), cfg, { media, collections })
      return { moviesRoot, db, media, scan }
    }

    it('keeps TMDB metadata across a rescan', async () => {
      const { moviesRoot, db, media, scan } = setup()
      writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}.mkv'), '')
      await scan()

      const worker = createMetadataRefreshWorker(
        { ...DEFAULT_REFRESH_CONFIG, changesFeedExtraCap: 0 },
        { media, tmdb: fakeTmdb, changesCursor: createChangesCursorRepo(db) },
      )
      const refreshed = await worker.run({ useChangesFeed: false })
      expect(refreshed.refreshed).toBe(1)
      expect(media.listMovies()[0].metadata).toMatchObject({ overview: 'A physicist.' })

      await scan()

      expect(media.listMovies()[0].metadata).toMatchObject({ overview: 'A physicist.' })
    })

    it('does not resurrect a soft-deleted item when a metadata refresh lands after the delete', async () => {
      const { moviesRoot, db, media, scan } = setup()
      const file = path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}.mkv')
      writeFileSync(file, '')
      writeFileSync(path.join(moviesRoot, 'Tenet (2020).mkv'), '')
      await scan()

      const slowTmdb = {
        ...fakeTmdb,
        async movieByTmdbId(id: number) {
          rmSync(file)
          await scan()
          return fakeTmdb.movieByTmdbId(id)
        },
      }
      const worker = createMetadataRefreshWorker(
        { ...DEFAULT_REFRESH_CONFIG, changesFeedExtraCap: 0 },
        { media, tmdb: slowTmdb, changesCursor: createChangesCursorRepo(db) },
      )
      await worker.run({ useChangesFeed: false })

      expect(media.listMovies().map(m => m.title)).toEqual(['Tenet'])
    })

    it('keeps the library when a root is unreadable', async () => {
      const { moviesRoot, media, scan } = setup()
      writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023).mkv'), '')
      await scan()

      rmSync(moviesRoot, { recursive: true })
      const result = await scan()

      expect(result.itemsRemoved).toBe(0)
      expect(result.unavailableRoots).toEqual([moviesRoot])
      expect(media.listMovies()).toHaveLength(1)
    })

    it('keeps the library when a root is present but empty, as an unmounted bind mount is', async () => {
      const { moviesRoot, media, scan } = setup()
      writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023).mkv'), '')
      await scan()

      rmSync(moviesRoot, { recursive: true })
      mkdirSync(moviesRoot)
      const result = await scan()

      expect(result.itemsRemoved).toBe(0)
      expect(result.unavailableRoots).toEqual([moviesRoot])
      expect(media.listMovies()).toHaveLength(1)
    })

    it('still removes an item whose file is gone while the root has other content', async () => {
      const { moviesRoot, media, scan } = setup()
      writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023).mkv'), '')
      writeFileSync(path.join(moviesRoot, 'Tenet (2020).mkv'), '')
      await scan()

      rmSync(path.join(moviesRoot, 'Tenet (2020).mkv'))
      const result = await scan()

      expect(result.itemsRemoved).toBe(1)
      expect(result.unavailableRoots).toEqual([])
      expect(media.listMovies().map(m => m.title)).toEqual(['Oppenheimer'])
    })

    it('keeps an existing item whose probe fails while the file is still on disk', async () => {
      const { moviesRoot, media, scan } = setup()
      writeFileSync(path.join(moviesRoot, 'Oppenheimer (2023).mkv'), '')
      writeFileSync(path.join(moviesRoot, 'Tenet (2020).mkv'), '')
      await scan()

      vi.spyOn(probeMod, 'probe').mockImplementation(async (p: string) => {
        if (p.includes('Tenet')) throw new Error('ffprobe timed out')
        return fakeProbe(p) as any
      })
      const result = await scan()

      expect(result.itemsFailed).toBe(1)
      expect(result.itemsRemoved).toBe(0)
      expect(media.listMovies().map(m => m.title).sort()).toEqual(['Oppenheimer', 'Tenet'])
    })
  })
})
