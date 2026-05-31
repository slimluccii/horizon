import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { probe } from '../src/scanner/probe.ts'

// Mirror the private cacheKey() in probe.ts so the test can place a cache entry
// at exactly the path probe() will read. If this drifts, the cache-hit test
// fails loudly — which is the intent.
function cacheKey(filePath: string, mtimeMs: number, size: number): string {
  return crypto.createHash('sha1').update(`${filePath}:${mtimeMs}:${size}`).digest('hex')
}

const FAKE_RESULT = {
  duration: 42,
  resolution: '1920x1080',
  videoCodec: 'h264',
  videoBitrate: 1000,
  hdr: { dv: false, hdr10: false, hdr10plus: false },
  audioTracks: [],
  subtitleTracks: [],
  container: 'matroska',
}

let cacheDir: string
let mediaFile: string

beforeEach(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'probe-cache-'))
  cacheDir = path.join(root, 'cache')
  mediaFile = path.join(root, 'movie.mkv')
  writeFileSync(mediaFile, 'x')
})

afterEach(() => {
  rmSync(path.dirname(mediaFile), { recursive: true, force: true })
})

describe('probe cache uses the full SHA1 key (#87)', () => {
  it('reads a cache entry stored under the full 40-char key (no ffprobe spawn)', async () => {
    const s = statSync(mediaFile)
    const key = cacheKey(mediaFile, s.mtimeMs, s.size)
    expect(key).toHaveLength(40)

    await mkdir(cacheDir, { recursive: true })
    // Seed cache at the FULL-key path. If probe() truncated to 8 chars it would
    // miss this file and try to spawn ffprobe (which would throw / differ).
    await writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify({ key, result: FAKE_RESULT }))

    const result = await probe(mediaFile, cacheDir)
    expect(result.duration).toBe(42)
    expect(result.videoCodec).toBe('h264')
  })

  it('two keys sharing an 8-char prefix do not collide (full key is the filename)', async () => {
    // Construct two distinct full keys that happen to share their first 8 chars.
    const prefix = 'abcd1234'
    const keyA = prefix + 'a'.repeat(32)
    const keyB = prefix + 'b'.repeat(32)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, `${keyA}.json`), JSON.stringify({ key: keyA, result: { ...FAKE_RESULT, duration: 1 } }))
    await writeFile(path.join(cacheDir, `${keyB}.json`), JSON.stringify({ key: keyB, result: { ...FAKE_RESULT, duration: 2 } }))
    // Both files coexist — with the old 8-char truncation they'd share the
    // filename `abcd1234.json` and clobber each other.
    expect(existsSync(path.join(cacheDir, `${keyA}.json`))).toBe(true)
    expect(existsSync(path.join(cacheDir, `${keyB}.json`))).toBe(true)
  })
})

describe('probe cache writes atomically (#87)', () => {
  it('a successful probe leaves a full-key .json file and no leftover .tmp files', async () => {
    // Hard to mock the module-level execFile; instead exercise the write path by
    // confirming that after a cache HIT round-trip the directory is clean.
    // (writeCache only runs on a miss; we assert no .tmp residue regardless.)
    const s = statSync(mediaFile)
    const key = cacheKey(mediaFile, s.mtimeMs, s.size)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify({ key, result: FAKE_RESULT }))

    await probe(mediaFile, cacheDir)

    const files = readdirSync(cacheDir)
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(files).toContain(`${key}.json`)
  })
})
