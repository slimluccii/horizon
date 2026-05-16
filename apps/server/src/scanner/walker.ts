import { readdir } from 'node:fs/promises'
import path from 'node:path'

const VIDEO_EXT_RE = /\.(mkv|mp4|mov|avi|m4v)$/i

export interface WalkResult {
  /** Absolute paths to candidate video files. */
  files: string[]
  /** Directories visited (telemetry). */
  dirsSeen: number
}

export interface WalkOptions {
  /** Hard ceiling on directories visited — defensive, prevents pathological loops. */
  maxDirs?: number
}

/**
 * Walk `root` and collect video files. Iterative (no deep recursion stack).
 *
 * **Why no dir-mtime gate:** POSIX only bumps a directory's mtime when its
 * *immediate* contents change (entry added/removed/renamed). Editing a file
 * deep in a subtree does not propagate to ancestor dirs. So the gate cannot
 * be used to recursively prune. The expensive part (`ffprobe`) is already
 * skipped by the per-file mtime+size cache in `probe.ts`. Walking dirs is
 * cheap; readdir of a few hundred folders is sub-second.
 */
export async function walkVideoFiles(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const files: string[] = []
  let dirsSeen = 0
  const max = opts.maxDirs ?? 200_000

  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    dirsSeen++
    if (dirsSeen > max) {
      throw new Error(`walkVideoFiles: exceeded ${max} directories under ${root}`)
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue                             // unreadable dir — skip silently
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (VIDEO_EXT_RE.test(entry.name)) files.push(full)
    }
  }
  return { files, dirsSeen }
}
