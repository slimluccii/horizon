/**
 * Parse external IDs out of paths and filenames. Supports the bracket-tag
 * convention used by Sonarr/Radarr-style libraries: `{tmdb-12345}`,
 * `{tvdb-67890}`, `{imdb-tt1234567}`.
 *
 * IDs may live anywhere in the path — movie dir, filename, or show dir.
 * Filename takes priority over directory because per-file overrides win.
 */

export interface ExternalIds {
  tmdb?: number
  tvdb?: number
  imdb?: string
}

const TMDB_RE = /\{tmdb-(\d+)\}/i
const TVDB_RE = /\{tvdb-(\d+)\}/i
const IMDB_RE = /\{imdb-(tt\d+)\}/i

/** Pull external IDs from a single string (filename or dir name). */
export function parseIds(s: string): ExternalIds {
  const out: ExternalIds = {}
  const tmdb = TMDB_RE.exec(s)
  const tvdb = TVDB_RE.exec(s)
  const imdb = IMDB_RE.exec(s)
  if (tmdb) out.tmdb = parseInt(tmdb[1], 10)
  if (tvdb) out.tvdb = parseInt(tvdb[1], 10)
  if (imdb) out.imdb = imdb[2] ?? imdb[1]   // group 1 is "ttN" via the capture
  return out
}

/** Merge IDs from multiple sources; later sources override earlier ones. */
export function mergeIds(...sources: ExternalIds[]): ExternalIds {
  return sources.reduce<ExternalIds>((acc, src) => ({ ...acc, ...src }), {})
}

/** Convenience: pull IDs from any path component matching the bracket pattern. */
export function parseIdsFromPath(filePath: string): ExternalIds {
  // Walk the path segments + filename, merging everything found. This handles
  // `Movies/Oppenheimer (2023) {tmdb-872585}/Oppenheimer (2023).mkv` where
  // the ID lives on the directory but not the file.
  return filePath.split(/[\\/]/).reduce<ExternalIds>(
    (acc, seg) => mergeIds(acc, parseIds(seg)),
    {},
  )
}
