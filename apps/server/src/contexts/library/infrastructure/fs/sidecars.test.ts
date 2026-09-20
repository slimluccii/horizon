import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverSidecarSubtitles, mergeSidecarTracks } from './sidecars.ts'
import type { SubtitleTrack } from '../probe/probe.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'horizon-sidecars-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function touch(name: string): Promise<void> {
  await writeFile(path.join(dir, name), '1\n00:00:01,000 --> 00:00:02,000\nHi\n')
}

describe('discoverSidecarSubtitles', () => {
  it('finds matching sidecars and parses language + forced tags (happy path)', async () => {
    const media = path.join(dir, 'Movie (2010).mkv')
    await touch('Movie (2010).en.srt')
    await touch('Movie (2010).nl.forced.srt')
    await touch('Movie (2010).ass')
    await touch('Other Movie (2011).en.srt')   // different basename — ignored
    await touch('Movie (2010).jpg')            // not a subtitle ext — ignored

    const found = await discoverSidecarSubtitles(media)
    expect(found).toEqual([
      { fileName: 'Movie (2010).ass', codec: 'ass', language: 'und', forced: false },
      { fileName: 'Movie (2010).en.srt', codec: 'subrip', language: 'en', forced: false },
      { fileName: 'Movie (2010).nl.forced.srt', codec: 'subrip', language: 'nl', forced: true },
    ])
  })

  it('returns [] for an unreadable directory (edge path)', async () => {
    const found = await discoverSidecarSubtitles(path.join(dir, 'missing', 'Movie (2010).mkv'))
    expect(found).toEqual([])
  })

  it('does not match a sidecar whose name merely shares a prefix without the dot separator', async () => {
    const media = path.join(dir, 'Movie (2010).mkv')
    await touch('Movie (2010) extended.en.srt')
    const found = await discoverSidecarSubtitles(media)
    expect(found).toEqual([])
  })
})

describe('mergeSidecarTracks', () => {
  it('appends externals after embedded tracks, preserving embedded ffmpeg indexes', () => {
    const embedded: SubtitleTrack[] = [
      { index: 0, codec: 'hdmv_pgs_subtitle', language: 'eng', forced: false, embeddable: false },
      { index: 1, codec: 'subrip', language: 'dut', forced: false, embeddable: true },
    ]
    const merged = mergeSidecarTracks(embedded, [
      { fileName: 'M.en.srt', codec: 'subrip', language: 'en', forced: false },
    ])
    expect(merged).toHaveLength(3)
    expect(merged[0].index).toBe(0)
    expect(merged[1].index).toBe(1)
    expect(merged[2]).toEqual({
      index: 2, codec: 'subrip', language: 'en', forced: false,
      embeddable: true, external: true, externalFileName: 'M.en.srt',
    })
  })
})
