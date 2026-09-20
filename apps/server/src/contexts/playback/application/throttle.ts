import type { ChildProcess } from 'node:child_process'
import type { Session } from '../domain/types.ts'

/** Segments are 1 s, so the encoder is held about two minutes ahead of the player. */
export const PAUSE_WHEN_AHEAD_SEGMENTS = 120
export const RESUME_WHEN_AHEAD_SEGMENTS = 60
export const THROTTLE_CHECK_INTERVAL_MS = 2_000
/** Matches the 90 s back buffer hls.js keeps, so a short rewind never needs the disk. */
export const KEEP_BEHIND_SEGMENTS = 90

export interface TranscodeThrottleDeps {
  session: Session
  headSegment: (session: Session) => number | null
  pause: (session: Session) => void
  resume: (session: Session) => void
  evictBelow: (session: Session, segNum: number) => void
  now?: () => number
}

export interface TranscodeThrottle {
  onSegmentRequested(segNum: number): void
}

/**
 * Holds the encoder a bounded distance ahead of the player. Demand is measured
 * from segment requests, which every client makes, not from progress reports.
 * The same check drops the segments the player has left behind.
 */
export function createTranscodeThrottle(deps: TranscodeThrottleDeps): TranscodeThrottle {
  const { session, headSegment, pause, resume, evictBelow } = deps
  const now = deps.now ?? Date.now
  // A restart spawns a fresh, running process, so "paused" is tied to the process it was applied to.
  let pausedProcess: ChildProcess | null = null
  let evicted: { proc: ChildProcess; below: number } | null = null
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

      // A restart wipes the directory, so what was evicted belongs to the process that wrote it.
      const evictedBelow = evicted?.proc === proc ? evicted.below : session.currentStartSegment ?? 0
      const keepFrom = segNum - KEEP_BEHIND_SEGMENTS
      if (keepFrom > evictedBelow) {
        evictBelow(session, keepFrom)
        evicted = { proc, below: keepFrom }
      }

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
