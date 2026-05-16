import type { PlaybackPlan } from '../transcode/plan.ts'

export type SessionState = 'pre-buffer' | 'active' | 'detached' | 'parked' | 'destroyed'

export interface Session {
  id: string
  mediaId: string
  filePath: string
  state: SessionState
  /** Source of truth for encoding decisions. Stamped at session create from
   *  buildPlan(probe, capabilities, ...); mutated when the user picks a new
   *  profile or audio track. Restart actuators read from here exclusively;
   *  no field on Session duplicates plan contents. */
  plan: PlaybackPlan
  selectedSubtitleTrack: number | null
  /** Codec strings for each rendition, written by spawnFfmpeg from the
   *  rendered args. Used by the master playlist + WS notify. */
  renditionCodecs: string[]
  sessionDir: string
  sessionReady: boolean
  /** Total media duration in seconds — used to build static VOD playlist. */
  durationSec: number
  /** Segment number the current ffmpeg run started producing from.
   *  Initial spawn = 0; seek-triggered restarts set this to the requested segment. */
  currentStartSegment: number
  ffmpegPid?: number
  ffmpegProcess?: import('node:child_process').ChildProcess
  /** Wall-clock time the current ffmpeg run was spawned. Used for cold-start
   *  instrumentation — segment route logs elapsed when it serves seg0. */
  spawnedAt?: number
  /** De-dup guard — logFirstSegment only logs once per spawn run. */
  firstSegLoggedAt?: number
  /** Side-channel ffmpeg for text-subtitle extraction. Killed on destroy. */
  subtitleProcess?: import('node:child_process').ChildProcess
  wsSocket?: import('ws').WebSocket
  reconnectToken: string
  attachTimer?: NodeJS.Timeout
  graceTimer?: NodeJS.Timeout
  seekPositionMs: number
  createdAt: number
  /** User on whose behalf this session was created (sourced from POST body).
   *  Undefined for headless / anonymous sessions — progress flushes no-op in
   *  that case. */
  userId?: string
  /** Last reported client playback position. Dirty flag is inferred by
   *  comparison against the last-flushed position in the flusher. */
  lastProgress?: { positionMs: number; durationMs: number; at: number }
  /** Attached by the WS upgrade handler; cleared on close. Lives here rather
   *  than in a WeakMap so final-flush on destroy can find it. */
  _flusher?: import('../ws/progress-flusher.ts').ProgressFlusher
}
