import { watch } from 'node:fs'
import path from 'node:path'
import type { ScanManager } from './manager.ts'

const VIDEO_EXT_RE = /\.(mkv|mp4|mov|avi|m4v)$/i

export interface WatcherConfig {
  /** Roots to watch. Watcher attaches one recursive watch per root. */
  roots: string[]
  /** Debounce window — events accumulate here before being flushed to the
   *  ScanManager. Bursty operations (rsync, cp -r) collapse into one scan. */
  debounceMs: number
}

export interface WatcherHandle {
  stop(): void
}

/**
 * Start a recursive `fs.watch` on each root and forward changes to the
 * ScanManager as subtree scan requests.
 *
 * Important caveats — these are why we keep a nightly full scan as backstop:
 *
 *  - Recursive watching only works on macOS (FSEvents) and Linux (inotify ≥ 6.0)
 *    inside Node 22+. On other platforms or older kernels, the call throws and
 *    we fall back to no watcher (caller decides; we just log).
 *  - inotify queue can overflow on mass file operations; events past the cap
 *    are silently dropped. Nightly catches the gap.
 *  - Some Docker storage drivers don't propagate inotify reliably; bind mounts
 *    of native ZFS/ext4 do.
 *
 * Path debouncing strategy: we collect changed *parent* directories (not file
 * paths) into a Set, then flush as a single ScanManager request after
 * `debounceMs` of quiet time.
 */
export function startWatcher(cfg: WatcherConfig, manager: ScanManager): WatcherHandle {
  const dirty = new Set<string>()
  let flushTimer: NodeJS.Timeout | null = null
  const watchers: ReturnType<typeof watch>[] = []

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (dirty.size === 0) return
      const paths = [...dirty]
      dirty.clear()
      manager.request({ trigger: 'watcher', paths })
        .catch(err => console.error('Watcher flush error:', err))
    }, cfg.debounceMs)
  }

  function onChange(root: string, filename: string | null): void {
    if (!filename) {
      // No filename means we lost track of what changed — schedule a scan of
      // the whole root.
      dirty.add(root)
      scheduleFlush()
      return
    }
    // We only care about video files (and dirs that *might* contain them).
    // Filename-only filter: skip dotfiles, partial downloads, sidecar files.
    const base = path.basename(filename)
    if (base.startsWith('.')) return
    if (base.endsWith('.part') || base.endsWith('.!qB') || base.endsWith('.tmp')) return

    // Walk up to the parent dir of the changed entry — that's our scan unit.
    // For TV shows, this is "the season folder"; for movies, "the movie folder".
    const full = path.join(root, filename)
    const parent = path.dirname(full)
    // Bound the scan unit at the root.
    const safeParent = parent.startsWith(root) ? parent : root
    dirty.add(safeParent)

    // If it's clearly a video file, also fast-track. (We already added the parent,
    // so this is mostly informational — kept simple.)
    if (VIDEO_EXT_RE.test(base)) { /* already covered */ }

    scheduleFlush()
  }

  for (const root of cfg.roots) {
    try {
      const w = watch(root, { recursive: true, persistent: false }, (_evt, filename) => {
        onChange(root, filename)
      })
      w.on('error', err => {
        console.warn(`Watcher error on ${root}: ${(err as Error).message}`)
      })
      watchers.push(w)
      console.log(`Watcher: attached recursively to ${root}`)
    } catch (err) {
      // Recursive watching unsupported — log and continue. Nightly scan picks up.
      console.warn(
        `Watcher: cannot watch ${root} recursively (${(err as Error).message}). ` +
        `Periodic scan will still detect changes.`,
      )
    }
  }

  return {
    stop() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      for (const w of watchers) {
        try { w.close() } catch { /* already closed */ }
      }
    },
  }
}
