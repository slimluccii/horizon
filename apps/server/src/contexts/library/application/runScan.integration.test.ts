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

  describe('stable ids', () => {
    function setup() {
      const moviesRoot = path.join(tmpRoot, 'movies')
      const showsRoot = path.join(tmpRoot, 'shows')
      mkdirSync(moviesRoot, { recursive: true })
      mkdirSync(showsRoot, { recursive: true })
      const db = openDatabase(':memory:')
      migrate(db)
      const media = createMediaRepo(db)
      const collections = createCollectionsRepo(db)
      const scanWith = (cfg: { moviesRoots: string[]; showsRoots: string[] }) => {
        const full = { ...cfg, cacheDir: tmpRoot, scanConcurrency: 2 }
        return runScan(fullScope(full), full, { media, collections })
      }
      const scan = () => scanWith({ moviesRoots: [moviesRoot], showsRoots: [showsRoot] })
      return { moviesRoot, showsRoot, db, media, collections, scan, scanWith }
    }

    it('keeps a movie id when a quality upgrade renames the file', async () => {
      const { moviesRoot, media, scan } = setup()
      const dir = path.join(moviesRoot, 'Oppenheimer (2023) {tmdb-872585}')
      mkdirSync(dir)
      writeFileSync(path.join(dir, 'Oppenheimer (2023) WEBDL-1080p.mkv'), '')
      await scan()
      const before = media.listMovies()[0].id

      rmSync(path.join(dir, 'Oppenheimer (2023) WEBDL-1080p.mkv'))
      writeFileSync(path.join(dir, 'Oppenheimer (2023) Bluray-2160p.mp4'), '')
      const result = await scan()

      expect(media.listMovies().map(m => m.id)).toEqual([before])
      expect(result.itemsAdded).toBe(0)
      expect(result.itemsRemoved).toBe(0)
      expect(media.getInternalRow(before)!.filePath).toContain('Bluray-2160p.mp4')
    })

    it('keeps an untagged movie id across a rename that keeps title and year', async () => {
      const { moviesRoot, media, scan } = setup()
      writeFileSync(path.join(moviesRoot, 'Tenet (2020) 720p.mkv'), '')
      await scan()
      const before = media.listMovies()[0].id

      rmSync(path.join(moviesRoot, 'Tenet (2020) 720p.mkv'))
      mkdirSync(path.join(moviesRoot, 'Tenet (2020)'))
      writeFileSync(path.join(moviesRoot, 'Tenet (2020)', 'Tenet (2020) 1080p.mkv'), '')
      await scan()

      expect(media.listMovies().map(m => m.id)).toEqual([before])
    })

    it('keeps show and episode ids when the library root moves', async () => {
      const { showsRoot, media, scan, scanWith } = setup()
      const season = path.join(showsRoot, 'Breaking Bad {tvdb-81189}', 'Season 01')
      mkdirSync(season, { recursive: true })
      writeFileSync(path.join(season, 'Breaking Bad - S01E01 - Pilot.mkv'), '')
      await scan()
      const show = media.listShows()[0].id
      const episode = media.getEpisodes(show)[0].id

      const newRoot = path.join(tmpRoot, 'tv')
      const newSeason = path.join(newRoot, 'Breaking Bad {tvdb-81189}', 'Season 01')
      mkdirSync(newSeason, { recursive: true })
      writeFileSync(path.join(newSeason, 'Breaking Bad - S01E01 - Pilot WEBDL-1080p.mkv'), '')
      rmSync(showsRoot, { recursive: true })
      await scanWith({ moviesRoots: [], showsRoots: [newRoot] })

      expect(media.listShows().map(s => s.id)).toEqual([show])
      expect(media.getEpisodes(show).map(e => e.id)).toEqual([episode])
    })

    it('merges one show that is split across two folders', async () => {
      const { showsRoot, media, scan } = setup()
      const a = path.join(showsRoot, 'disk1', 'Frieren {tvdb-424536}', 'Season 01')
      const b = path.join(showsRoot, 'disk2', 'Frieren {tvdb-424536}', 'Season 02')
      mkdirSync(a, { recursive: true })
      mkdirSync(b, { recursive: true })
      writeFileSync(path.join(a, 'Frieren - S01E01.mkv'), '')
      writeFileSync(path.join(b, 'Frieren - S02E01.mkv'), '')
      await scan()

      expect(media.listShows()).toHaveLength(1)
      expect(media.getEpisodes(media.listShows()[0].id)).toHaveLength(2)
    })

    it('keeps the larger file when two files are the same movie, and reports the other', async () => {
      const { moviesRoot, media, scan } = setup()
      mkdirSync(path.join(moviesRoot, 'hd'))
      mkdirSync(path.join(moviesRoot, 'uhd'))
      writeFileSync(path.join(moviesRoot, 'hd', 'Dune (2021) {tmdb-438631} 1080p.mkv'), 'small')
      writeFileSync(path.join(moviesRoot, 'uhd', 'Dune (2021) {tmdb-438631} 2160p.mkv'), 'much larger file')
      const result = await scan()

      expect(media.listMovies()).toHaveLength(1)
      expect(media.getInternalRow(media.listMovies()[0].id)!.filePath).toContain('2160p')
      expect(result.duplicates).toEqual([path.join(moviesRoot, 'hd', 'Dune (2021) {tmdb-438631} 1080p.mkv')])
    })

    it('keeps the larger file when a subtree scan only sees the smaller one', async () => {
      const { moviesRoot, showsRoot, media, collections, scan } = setup()
      mkdirSync(path.join(moviesRoot, 'hd'))
      mkdirSync(path.join(moviesRoot, 'uhd'))
      const small = path.join(moviesRoot, 'hd', 'Dune (2021) {tmdb-438631} 1080p.mkv')
      writeFileSync(small, 'small')
      writeFileSync(path.join(moviesRoot, 'uhd', 'Dune (2021) {tmdb-438631} 2160p.mkv'), 'much larger file')
      await scan()

      const cfg = { moviesRoots: [moviesRoot], showsRoots: [showsRoot], cacheDir: tmpRoot, scanConcurrency: 2 }
      const scope = { moviesPaths: [path.join(moviesRoot, 'hd')], showsPaths: [], fullScope: false }
      const result = await runScan(scope, cfg, { media, collections })

      expect(result.duplicates).toEqual([small])
      expect(media.listMovies()).toHaveLength(1)
      expect(media.getInternalRow(media.listMovies()[0].id)!.filePath).toContain('2160p')
    })

    it('takes over the file of a row that was stored under a path-based id', async () => {
      const { moviesRoot, db, media, scan } = setup()
      const file = path.join(moviesRoot, 'Tenet (2020).mkv')
      writeFileSync(file, '')
      db.prepare(
        `INSERT INTO media_items (id, kind, title, file_path, mtime_ms, size_bytes, first_seen_at, last_seen_at)
         VALUES ('legacy-path-hash', 'movie', 'Tenet', ?, 0, 0, 0, 0)`,
      ).run(file)

      await scan()

      expect(media.listMovies()).toHaveLength(1)
      expect(media.listMovies()[0].id).not.toBe('legacy-path-hash')
      expect(media.getById('legacy-path-hash')).toBeNull()
    })

    it('lets a file move to a new identity when its tag is corrected', async () => {
      const { moviesRoot, media, scan } = setup()
      const wrong = path.join(moviesRoot, 'Dune (2021) {tmdb-841}.mkv')
      writeFileSync(wrong, '')
      await scan()
      const before = media.listMovies()[0].id

      rmSync(wrong)
      writeFileSync(path.join(moviesRoot, 'Dune (2021) {tmdb-438631}.mkv'), '')
      await scan()

      expect(media.listMovies()).toHaveLength(1)
      expect(media.listMovies()[0].id).not.toBe(before)
    })
  })
})
