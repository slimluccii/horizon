import type { ChildProcess } from 'node:child_process'
import type { Session } from '../domain/types.ts'

/** Segments are 1 s, so the encoder is held about two minutes ahead of the player. */
export const PAUSE_WHEN_AHEAD_SEGMENTS = 120
export const RESUME_WHEN_AHEAD_SEGMENTS = 60
export const THROTTLE_CHECK_INTERVAL_MS = 2_000

export interface TranscodeThrottleDeps {
  session: Session
  headSegment: (session: Session) => number | null
  pause: (session: Session) => void
  resume: (session: Session) => void
  now?: () => number
}

export interface TranscodeThrottle {
  onSegmentRequested(segNum: number): void
}

/**
 * Holds the encoder a bounded distance ahead of the player. Demand is measured
 * from segment requests, which every client makes, not from progress reports.
 */
export function createTranscodeThrottle(deps: TranscodeThrottleDeps): TranscodeThrottle {
  const { session, headSegment, pause, resume } = deps
  const now = deps.now ?? Date.now
  // A restart spawns a fresh, running process, so "paused" is tied to the process it was applied to.
  let pausedProcess: ChildProcess | null = null
  let lastHead: number | null = null
  let lastCheckAt = Number.NEGATIVE_INFINITY

  return {
    onSegmentRequested(segNum) {
      const proc = session.ffmpegProcess
      if (!proc || session.state === 'parked') return
      const paused = pausedProcess === proc

      const beyondKnownHead = lastHead !== null && segNum > lastHead
      if (!beyondKnownHead && now() - lastCheckAt < THROTTLE_CHECK_INTERVAL_MS) return
      lastCheckAt = now()
      lastHead = headSegment(session)
      if (lastHead === null) return

      const ahead = lastHead - segNum
      if (paused && ahead <= RESUME_WHEN_AHEAD_SEGMENTS) {
        resume(session)
        pausedProcess = null
      } else if (!paused && ahead >= PAUSE_WHEN_AHEAD_SEGMENTS) {
        pause(session)
        pausedProcess = proc
      }
    },
  }
}
