// Library context — public surface.
// Media items, scanning, collections, library HTTP adapter, and persistence repos.

// Persistence repos + their row/domain types.
export {
  createMediaRepo,
  type MediaRepo,
  type MediaItem,
  type MediaItemRow,
  type MediaItemBase,
  type MovieUpsert,
  type ShowUpsert,
  type EpisodeUpsert,
  type StaleMetadataPick,
  type HdrFlags,
  type ExternalIds,
} from './infrastructure/persistence/media.ts'
export { createCollectionsRepo, type CollectionsRepo, type Collection } from './infrastructure/persistence/collections.ts'
export {
  createScanRootsRepo,
  createChangesCursorRepo,
  createScanHistoryRepo,
  type ScanRootsRepo,
  type ChangesCursorRepo,
  type ScanHistoryRepo,
  type ScanTrigger,
  type ScanRootRow,
  type ChangesCursorRow,
  type ScanHistoryRow,
} from './infrastructure/persistence/scanState.ts'

// Scanning orchestration.
export {
  createScanManager,
  type ScanManager,
  type ScanManagerDeps,
  type ScanStatus,
  type ScanRequest,
} from './application/scanManager.ts'
export {
  runScan,
  rescan,
  fullScope,
  classifyPath,
  type ScanConfig,
  type ScanDeps,
  type ScanResult,
  type ScanScope,
  type ScanProgressReporter,
  type ScanCounts,
} from './application/runScan.ts'

// Domain rules + types.
export { buildCollections, type BuiltCollection } from './domain/collection.ts'
export { parseIds, parseIdsFromPath, mergeIds } from './domain/ids.ts'

// Filesystem adapters.
export { walkVideoFiles } from './infrastructure/fs/walker.ts'
export { startWatcher, type WatcherHandle, type WatcherConfig } from './infrastructure/fs/watcher.ts'

// Probe adapter.
export { probe, parseProbeOutput, type ProbeResult, type AudioTrack, type SubtitleTrack } from './infrastructure/probe/probe.ts'

// HTTP adapter.
export { registerLibrary, sseFrame } from './infrastructure/http/library.ts'
