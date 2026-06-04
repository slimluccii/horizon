import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/** Default cache TTL — refresh metadata weekly so updated overviews / cast
 *  changes propagate without manual invalidation. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface Envelope<T> {
  fetchedAt: number
  data: T
}

function keyHash(parts: (string | number)[]): string {
  return crypto.createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 16)
}

function entryPath(cacheDir: string, namespace: string, key: string): string {
  return path.join(cacheDir, 'metadata', namespace, `${key}.json`)
}

/**
 * Read+parse a cached metadata entry. Returns null on miss, parse error,
 * or staleness (older than ttlMs). The fast path here keeps the scanner
 * snappy on rescans of stable libraries.
 */
export async function readMetaCache<T>(
  cacheDir: string,
  namespace: string,
  parts: (string | number)[],
  ttlMs = DEFAULT_TTL_MS,
): Promise<T | null> {
  const file = entryPath(cacheDir, namespace, keyHash(parts))
  try {
    const raw = await readFile(file, 'utf8')
    const env = JSON.parse(raw) as Envelope<T>
    if (Date.now() - env.fetchedAt > ttlMs) return null
    return env.data
  } catch { return null }
}

export async function writeMetaCache<T>(
  cacheDir: string,
  namespace: string,
  parts: (string | number)[],
  data: T,
): Promise<void> {
  const file = entryPath(cacheDir, namespace, keyHash(parts))
  await mkdir(path.dirname(file), { recursive: true })
  const env: Envelope<T> = { fetchedAt: Date.now(), data }
  await writeFile(file, JSON.stringify(env))
}

/**
 * Cache a binary blob (image) keyed by source URL. Returns the path on disk;
 * caller streams it back. Used by the image proxy to avoid round-tripping to
 * TMDB on every poster render.
 */
export async function imageCachePath(cacheDir: string, sourceUrl: string): Promise<string> {
  const ext = path.extname(new URL(sourceUrl).pathname) || '.jpg'
  const key = crypto.createHash('sha1').update(sourceUrl).digest('hex')
  return path.join(cacheDir, 'metadata', 'images', `${key}${ext}`)
}

export async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}
