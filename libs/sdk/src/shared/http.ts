import type { MediaItem } from '../library/mediaItem.ts'

export interface WatchProgress {
  mediaId: string
  positionMs: number
  durationMs: number
  watched: boolean
  updatedAt: number
}

export interface ContinueWatchingItem {
  mediaId: string
  kind: 'movie' | 'episode'
  positionMs: number
  durationMs: number
  percent: number
  updatedAt: number
  media: MediaItem
  show?: MediaItem
}

/**
 * Wire shape returned by GET/PATCH /settings/server.
 * tmdbToken is masked: "set" | "unset" — never the real value.
 */
export interface ServerSettings {
  // Library
  watchedThresholdPct: number
  scanCronHour: number
  scanConcurrency: number
  watchFs: boolean
  watchDebounceMs: number
  moviesRoots: string[]
  showsRoots: string[]
  // Metadata
  tmdbToken: 'set' | 'unset'
  metadataBatchSize: number
  metadataMaxAgeMovieDays: number
  metadataMaxAgeShowDays: number
  metadataMaxAgeEpDays: number
  // Playback
  maxSessions: number
  maxRenditions: number
  wsGraceMs: number
  wsAttachMs: number
  forceEncoder: string | null
  tonemapOperator: string
  tonemapParam: number | null
  tonemapDesat: number | null
  updatedAt: number
}

export type ServerSettingsPatch = Partial<Omit<ServerSettings, 'tmdbToken' | 'updatedAt'> & { tmdbToken?: string | null }>

/** A single directory entry returned by the confined folder browser. */
export interface BrowseEntry {
  name: string
  path: string
}

/**
 * Wire shape returned by GET /library/browse. `entries` are the immediate
 * subdirectories of the browsed path (the filesystem root when no path is given);
 * `parent` is the parent directory, or null at the filesystem root.
 */
export interface BrowseResult {
  entries: BrowseEntry[]
  parent: string | null
}

/** A finished scan's summary (subset of the server's ScanResult). */
export interface ScanResultSummary {
  scope: { fullScope: boolean } & Record<string, unknown>
  itemsSeen: number
  itemsAdded: number
  itemsRemoved: number
  itemsFailed: number
  durationMs: number
}

/** One row of recent scan history. */
export interface ScanHistoryEntry {
  id: number
  trigger: 'boot' | 'cron' | 'manual' | 'watcher' | 'metadata'
  scope: string
  startedAt: number
  finishedAt: number | null
  itemsSeen: number
  itemsAdded: number
  itemsRemoved: number
  metadataRefreshed: number
  errors: string[] | null
}

/**
 * Wire shape of GET /library/scan-status — a combined health snapshot for the
 * admin panel. `scan.running` / `metadata.running` drive the live indicator.
 */
export interface ScanStatusResponse {
  scan: {
    running: boolean
    current: { trigger: string; scope: string; startedAt: number; processed: number; total: number } | null
    pendingPaths: string[]
    lastResult: ScanResultSummary | null
    lastFinishedAt: number | null
  }
  metadata: {
    running: boolean
    configured: boolean
    lastResult: { refreshed: number; failed: number; changesFeedHits: number; durationMs: number } | null
    errorState: { code: string; message: string; firstOccurredAt: number } | null
  }
  recentRuns: ScanHistoryEntry[]
}
