import type { MediaRepo } from '../infrastructure/persistence/media.ts'
import type { KeyframeIndexRepo } from '../infrastructure/persistence/keyframeIndex.ts'
import type { Keyframe } from '../infrastructure/probe/keyframes.ts'

export interface KeyframeIndexerDeps {
  media: MediaRepo
  index: KeyframeIndexRepo
  extract: (filePath: string, signal?: AbortSignal) => Promise<Keyframe[]>
  /** False while someone is watching; reading a whole file then competes with playback for the disk. */
  isIdle: () => boolean
  retryWhenBusyMs?: number
}

export interface KeyframeIndexer {
  /** Index this file next, even while someone is watching: they just tried to play it. */
  request(mediaId: string): void
  /** Queue every playable file that has no current index. */
  indexLibrary(): void
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>
  stop(): void
}

/** Reads keyframes one file at a time in the background. Extraction demuxes the whole file. */
export function createKeyframeIndexer(deps: KeyframeIndexerDeps): KeyframeIndexer {
  const retryWhenBusyMs = deps.retryWhenBusyMs ?? 60_000
  const requested: string[] = []
  let library: string[] = []
  const failed = new Set<string>()
  const abort = new AbortController()
  let running: Promise<void> | null = null
  let kickedWhileRunning = false
  let retryTimer: NodeJS.Timeout | undefined

  function next(): string | undefined {
    if (requested.length > 0) return requested.shift()
    if (library.length === 0) return undefined
    if (deps.isIdle()) return library.shift()
    retryTimer ??= setTimeout(() => { retryTimer = undefined; kick() }, retryWhenBusyMs)
    return undefined
  }

  async function indexOne(mediaId: string): Promise<void> {
    if (failed.has(mediaId) || deps.index.get(mediaId)) return
    const row = deps.media.getInternalRow(mediaId)
    if (!row?.filePath || row.deletedAt != null || row.mtimeMs == null || row.sizeBytes == null) return
    try {
      const keyframes = await deps.extract(row.filePath, abort.signal)
      deps.index.put(mediaId, { mtimeMs: row.mtimeMs, sizeBytes: row.sizeBytes, keyframes })
    } catch (err) {
      failed.add(mediaId)
      if (!abort.signal.aborted) console.error(`Keyframe index: could not read ${row.filePath}: ${(err as Error).message}`)
    }
  }

  function kick(): void {
    if (abort.signal.aborted) return
    if (running) { kickedWhileRunning = true; return }
    running = (async () => {
      // Start on the next tick, so calls made together are ordered by priority and not by arrival.
      await Promise.resolve()
      for (let id = next(); id !== undefined && !abort.signal.aborted; id = next()) await indexOne(id)
    })().finally(() => {
      running = null
      if (kickedWhileRunning) { kickedWhileRunning = false; kick() }
    })
  }

  return {
    request(mediaId) {
      if (!requested.includes(mediaId)) requested.unshift(mediaId)
      kick()
    },
    indexLibrary() {
      library = deps.index.listUnindexed().filter(id => !failed.has(id))
      kick()
    },
    async idle() {
      while (running) await running
    },
    stop() {
      clearTimeout(retryTimer)
      abort.abort()
    },
  }
}
