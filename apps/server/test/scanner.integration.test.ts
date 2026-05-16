import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { createMediaRepo } from '../src/repos/media.ts'
import { createCollectionsRepo } from '../src/repos/collections.ts'
import { rescan } from '../src/scanner/scanner.ts'

// Stub probe — scanner is generally backed by ffprobe. We inject a fake via
// vi.spyOn so these tests don't need ffprobe on PATH.
import * as probeMod from '../src/scanner/probe.ts'

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
    expect(media.getEpisodes(media.listShows()[0].id)).toHaveLength(0)
  })
})
