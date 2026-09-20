import type { Keyframe } from '../../library/index.ts'
import { SEGMENT_DURATION_SEC } from './segments.ts'

export type { Keyframe }

/** Where each HLS segment of a session starts and how long it lasts. */
export interface SegmentTimeline {
  count: number
  startSec(segNum: number): number
  durationSec(segNum: number): number
  /** The segment that holds this position, clamped to the timeline. */
  segmentAt(positionSec: number): number
  /** EXT-X-TARGETDURATION: the longest segment, rounded up. */
  targetDurationSec: number
}

export interface KeyframeTimeline extends SegmentTimeline {
  startDtsSec(segNum: number): number
}

interface TimedSession {
  durationSec: number
  keyframes?: Keyframe[]
  plan?: { method: string; videoStrategy: string }
}

const timelines = new WeakMap<Keyframe[], KeyframeTimeline>()

/** The keyframe timeline of a session whose current plan copies the video; undefined for an encode or direct play. */
export function copyTimelineOf(session: TimedSession): KeyframeTimeline | undefined {
  const copies = session.plan?.videoStrategy === 'copy' && session.plan.method !== 'direct-play'
  if (!copies || !session.keyframes) return undefined
  let timeline = timelines.get(session.keyframes)
  if (!timeline) {
    timeline = keyframeTimeline(session.keyframes, session.durationSec)
    timelines.set(session.keyframes, timeline)
  }
  return timeline
}

/** An encode cuts fixed-length segments; a stream copy follows the source keyframes. */
export function sessionTimeline(session: TimedSession): SegmentTimeline {
  return copyTimelineOf(session) ?? uniformTimeline(session.durationSec)
}

const MIN_AVERAGE_GAP_SEC = 0.5
const MAX_GAP_SEC = 20

/** Fixed-length segments, which is what an encode produces. */
export function uniformTimeline(totalSec: number): SegmentTimeline {
  const count = Math.max(1, Math.ceil(totalSec / SEGMENT_DURATION_SEC))
  return {
    count,
    targetDurationSec: SEGMENT_DURATION_SEC,
    startSec: n => n * SEGMENT_DURATION_SEC,
    durationSec: n => (n === count - 1 ? Math.max(0.001, totalSec - n * SEGMENT_DURATION_SEC) : SEGMENT_DURATION_SEC),
    segmentAt: sec => Math.min(count - 1, Math.max(0, Math.floor(sec / SEGMENT_DURATION_SEC))),
  }
}

/** One segment per keyframe gap, which is the only cut a stream copy can make. */
export function keyframeTimeline(keyframes: Keyframe[], totalSec: number): KeyframeTimeline {
  const count = keyframes.length
  const durationSec = (n: number) =>
    Math.max(0.001, (n === count - 1 ? totalSec : keyframes[n + 1].ptsSec) - keyframes[n].ptsSec)
  let longest = 0
  for (let n = 0; n < count; n++) longest = Math.max(longest, durationSec(n))
  return {
    count,
    targetDurationSec: Math.ceil(longest),
    startSec: n => keyframes[n].ptsSec,
    startDtsSec: n => keyframes[n].dtsSec,
    durationSec,
    segmentAt(sec) {
      let lo = 0
      let hi = count - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (keyframes[mid].ptsSec <= sec) lo = mid
        else hi = mid - 1
      }
      return lo
    },
  }
}

/** All-intra files would become a segment per frame, and a very long gap cannot be seeked or buffered sensibly. */
export function copyEligible(keyframes: Keyframe[], totalSec: number): boolean {
  if (keyframes.length === 0 || keyframes[0].ptsSec > 0.5) return false
  if (totalSec / keyframes.length < MIN_AVERAGE_GAP_SEC) return false
  const timeline = keyframeTimeline(keyframes, totalSec)
  return timeline.targetDurationSec <= MAX_GAP_SEC
}
