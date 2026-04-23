import type { ClientCapabilities, PlaybackDecision } from '../transcode/decision.ts'
import type { Profile } from '../transcode/profiles.ts'
import type { ToneMapConfig } from '../transcode/tonemap.ts'

export type SessionState = 'pre-buffer' | 'active' | 'detached' | 'parked' | 'destroyed'

export interface Session {
  id: string
  mediaId: string
  filePath: string
  state: SessionState
  method: PlaybackDecision['method']
  capabilities: ClientCapabilities
  selectedAudioTrack: number
  selectedSubtitleTrack: number | null
  profiles: Profile[]
  renditionCodecs: string[]
  needsToneMap: boolean
  /** Tone-map configuration applied when needsToneMap is true. Stamped at
   *  session creation so a config change between sessions doesn't affect an
   *  in-flight encode mid-restart. */
  toneMap: ToneMapConfig
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
  /** Guard: drop concurrent restart requests so we never SIGTERM + spawn into the same dirs twice. */
  ffmpegRestartInFlight?: boolean
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
