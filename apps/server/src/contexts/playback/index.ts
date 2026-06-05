// Playback context — public surface.
// Playback sessions, transcode planning, ffmpeg + ws adapters, watch progress,
// and the HTTP route adapters (sessions, segments, playlists, progress).

// Hardware acceleration detection + capability type.
export { detectHwAccel, type HwAccel } from './domain/hwaccel.ts'

// Tone-mapping rules (also consumed by platform config validation).
export {
  isToneMapOperator,
  buildToneMapPrefix,
  ALL_TONEMAP_OPERATORS,
  type ToneMapOperator,
  type ToneMapConfig,
} from './domain/tonemap.ts'

// Session management.
export { createSessionManager, type SessionManager } from './application/manager.ts'

// Playback orchestration.
export {
  createPlaybackOrchestrator,
  type PlaybackOrchestrator,
  type PlaybackOrchestratorDeps,
  type StartPlaybackInput,
  type StartPlaybackResult,
  type PlaybackSessionInfo,
  type Spawner,
  type SubtitleExtractor,
} from './application/playback.ts'

// Watch-progress persistence.
export {
  createProgressRepo,
  type ProgressRepo,
  type WatchProgress,
  type ContinueWatchingItem,
  type ProgressInput,
  type ProgressRepoOpts,
} from './infrastructure/persistence/progress.ts'

// HTTP route adapters.
export { registerSessions } from './infrastructure/http/sessions.ts'
export { registerPlaylists } from './infrastructure/http/playlists.ts'
export { registerSegments } from './infrastructure/http/segments.ts'
export { registerProgress } from './infrastructure/http/progress.ts'
