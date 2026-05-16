/**
 * HLS segment naming + duration constants. Leaf module — no imports from
 * within transcode/, so plan.ts, render.ts, ffmpeg.ts, runtime.ts can all
 * import without cycles.
 */

/** HLS segment duration in seconds. Must match `-hls_time` in the muxer args.
 *  Shorter segments = faster first-byte (seg0 arrives sooner) at the cost of
 *  more files on disk + more playlist entries. 1s is aggressive but works
 *  with -g set to match (24 at 24fps = 1s GOP). */
export const SEGMENT_DURATION_SEC = 1

/** Segment number zero-padding (5 digits → supports ~66 hours at 4 s/seg). */
export const SEG_PAD = 5

/** Render a segment filename, e.g. segmentName(42) → "seg00042.m4s". */
export function segmentName(n: number): string {
  return `seg${String(n).padStart(SEG_PAD, '0')}.m4s`
}
