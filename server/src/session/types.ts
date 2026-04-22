import type { ClientCapabilities, PlaybackDecision } from '../transcode/decision.ts'
import type { Profile } from '../transcode/profiles.ts'

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
  sessionDir: string
  sessionReady: boolean
  ffmpegPid?: number
  ffmpegProcess?: import('node:child_process').ChildProcess
  /** Guard: drop concurrent restart requests so we never SIGTERM + spawn into the same dirs twice. */
  ffmpegRestartInFlight?: boolean
  wsSocket?: import('ws').WebSocket
  reconnectToken: string
  attachTimer?: NodeJS.Timeout
  graceTimer?: NodeJS.Timeout
  seekPositionMs: number
  createdAt: number
}
