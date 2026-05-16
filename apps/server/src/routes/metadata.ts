import type { FastifyInstance } from 'fastify'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Config } from '../config.ts'
import { imageCachePath, fileExists } from '../metadata/cache.ts'
import { sendNotFound, badRequest, serverError } from './errors.ts'

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p'

/** Allowed TMDB image widths. Keep this small + explicit so users can't pull
 *  arbitrary sizes that bypass our cache (each size is a separate URL). */
const ALLOWED_SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'])

/** Pixel widths used for mock posters/backdrops served via picsum.photos.
 *  Heights derive from aspect: 2:3 for posters/stills (closer match), 16:9 for backdrops. */
const MOCK_SIZE_WIDTH: Record<string, number> = {
  w92: 92, w154: 154, w185: 185, w342: 342, w500: 500, w780: 780, original: 1280,
}

/** Build a picsum URL for a mock asset path. Returns null on malformed input. */
function mockImageUrl(tail: string, size: string): string | null {
  // Shape: mock/<kind>/<seed>.<ext>  e.g.  mock/poster/inception.jpg
  const m = /^mock\/(poster|backdrop|still)\/([^/]+?)\.[a-z]+$/i.exec(tail)
  if (!m) return null
  const kind = m[1]
  const seed = m[2]
  const w = MOCK_SIZE_WIDTH[size] ?? 500
  const h = kind === 'backdrop' ? Math.round(w * 9 / 16) : Math.round(w * 3 / 2)
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`
}

/**
 * Image proxy + cache for TMDB posters / backdrops / stills.
 *
 * Why proxy instead of letting the browser fetch image.tmdb.org directly:
 *   - First load is fast (TMDB CDN), but offline / restricted networks break.
 *   - Cache survives browser cache eviction.
 *   - One place to swap providers later (Fanart.tv, custom uploads).
 *
 * URL shape: `/metadata/image/:size/*` where `*` is the provider-relative
 * path, e.g. `/metadata/image/w500/xyz.jpg`. Path must NOT contain `..`.
 */
export function registerMetadata(app: FastifyInstance, cfg: Config): void {
  app.get<{ Params: { size: string; '*': string } }>(
    '/metadata/image/:size/*',
    async (req, reply) => {
      const { size } = req.params
      const tail = req.params['*']
      if (!ALLOWED_SIZES.has(size)) return badRequest(reply, 'invalid-size', 'Invalid image size')
      if (!tail || tail.includes('..')) return badRequest(reply, 'invalid-path', 'Invalid image path')

      // Mock posters bypass TMDB and proxy from picsum.photos so dev seeds work
      // without a TMDB token and without baking real CDN paths into fixtures.
      const sourceUrl = tail.startsWith('mock/')
        ? mockImageUrl(tail, size)
        : `${TMDB_IMAGE_BASE}/${size}/${tail}`
      if (!sourceUrl) return badRequest(reply, 'invalid-path', 'Invalid image path')
      const cachePath = await imageCachePath(cfg.cacheDir, sourceUrl)

      reply.header('Cache-Control', 'public, max-age=2592000, immutable')
      reply.header('Content-Type', guessContentType(tail))

      // Cache hit: serve directly from disk.
      if (await fileExists(cachePath)) {
        return reply.send(createReadStream(cachePath))
      }

      // Cache miss: fetch upstream and tee — stream one branch back to the
      // client while the other writes to a temp cache file. The browser starts
      // rendering as bytes arrive instead of waiting for the full body to land
      // on disk first.
      let upstream: Response
      try {
        upstream = await fetch(sourceUrl)
      } catch (err) {
        console.warn(`Image proxy fetch failed: ${(err as Error).message}`)
        return serverError(reply, 'fetch-failed', 'Image fetch failed')
      }
      if (!upstream.ok || !upstream.body) {
        return sendNotFound(reply, 'image-not-found', `Upstream ${upstream.status}`)
      }

      const upstreamLen = upstream.headers.get('content-length')
      if (upstreamLen) reply.header('Content-Length', upstreamLen)

      // Tee the web ReadableStream into two independent streams.
      const [forClient, forCache] = upstream.body.tee()
      void persistImage(forCache, cachePath).catch(err =>
        console.warn(`Image cache write failed: ${(err as Error).message}`),
      )
      return reply.send(Readable.fromWeb(forClient as never))
    },
  )
}

/** Write the image to a randomized temp file then rename to its final path.
 *  Random temp name prevents two concurrent requests for the same URL from
 *  scribbling over each other; rename is atomic on the same filesystem. */
async function persistImage(stream: ReadableStream<Uint8Array>, finalPath: string): Promise<void> {
  await mkdir(path.dirname(finalPath), { recursive: true })
  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const out = createWriteStream(tmpPath)
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(value)) await new Promise<void>(res => out.once('drain', () => res()))
    }
    await new Promise<void>(res => out.end(() => res()))
    await rename(tmpPath, finalPath)
  } catch (err) {
    out.destroy()
    throw err
  }
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}
