/**
 * SessionRuntime — per-Session state machine for the ffmpeg-restart lifecycle.
 *
 * Owns the state previously expressed as `session.ffmpegRestartInFlight` +
 * bare `currentStartSegment` + `seekPositionMs` fields. Replaces the two
 * divergent lock paths (segments.ts inline mutation + `withRestartLock` in
 * transcode/restart.ts) with one explicit state machine.
 *
 * State transitions:
 *
 *      idle ──seekTo / changeAudioTrack / changeProfile / applyRestart──▶ restarting
 *      restarting ─────────────────────────(restart promise settles)─────▶ idle
 *      * ──markDestroyed─▶ destroyed (terminal)
 *
 * Concurrent transition requests while `restarting` return `{ok:false,
 * reason:'busy'}` — callers decide whether to drop or retry. Transitions on
 * a `destroyed` runtime return `{ok:false, reason:'destroyed'}`.
 *
 * See CONTEXT.md → SessionRuntime / SegmentDecision.
 */
import type { Session } from '../domain/types.ts'
import type { HwAccel } from '../domain/hwaccel.ts'
import type { Profile } from '../domain/profiles.ts'
import type { PlaybackPlan } from '../domain/plan.ts'
import { planWithAudioTrack, planWithBurnIn, planWithProfile } from '../domain/plan.ts'
import { SEGMENT_DURATION_SEC } from '../domain/segments.ts'
import {
  restartAtSegment as defaultRestartAtSegment,
  restartWithReset as defaultRestartWithReset,
} from './restart.ts'
import { headSegment as defaultHeadSegment, evictSegmentsBelow, pauseFfmpeg, resumeFfmpeg } from '../infrastructure/ffmpeg/ffmpeg.ts'
import { createTranscodeThrottle } from './throttle.ts'

/** Lookahead window (segments). A segment request inside `[startSegment,
 *  head + LOOKAHEAD)`, where head is the newest segment the run has written,
 *  is treated as "the current ffmpeg run will produce it shortly" — wait.
 *  Beyond that window is a seek — restart. Measured from the head, not the run
 *  start, because a player at the live edge of the encoder asks for head + 1. */
export const SEEK_LOOKAHEAD_SEGMENTS = 30

/** Hard ceiling on how long a single restart action (ffmpeg respawn +
 *  pre-buffer) may run before the state machine gives up and returns to
 *  `idle`. Without it, a hung ffmpeg leaves the runtime stuck in `restarting`
 *  forever, so every subsequent seek/track-change returns `busy` — the session
 *  is permanently wedged. On timeout the action keeps running in the
 *  background (best-effort), but the runtime is unblocked. */
export const RESTART_TIMEOUT_MS = 30_000

export type RuntimeStateKind = 'idle' | 'restarting' | 'destroyed'

export interface RestartTarget {
  segNum: number
  plan: PlaybackPlan
  /** true = restartWithReset (wipe init.mp4); false = restartAtSegment (preserve init). */
  withReset: boolean
}

export type RuntimeState =
  | { kind: 'idle' }
  | { kind: 'restarting'; target: RestartTarget }
  | { kind: 'destroyed' }

export type SegmentDecision =
  | { kind: 'serve' }                        // file is or will be on disk; just wait
  | { kind: 'wait' }                         // in-range; current run will produce it
  | { kind: 'restart'; segNum: number }      // out-of-range; caller should applyRestart

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'destroyed'; error?: unknown }

export type RestartFn = (
  session: Session, hwAccel: HwAccel, plan: PlaybackPlan, segNum: number,
) => Promise<void>

export type RestartWithResetFn = (
  session: Session, hwAccel: HwAccel, plan: PlaybackPlan, segNum: number,
) => Promise<void>

export interface SessionRuntime {
  state(): RuntimeState
  startSegment(): number
  seekPositionMs(): number

  /** Note every segment request, served from disk or not; this is what paces the encoder. */
  onSegmentRequested(segNum: number): void

  /** Sync: classify a segment request against the current run's window. */
  requestSegment(segNum: number, rendition?: number): SegmentDecision

  /** Apply a restart triggered by an out-of-range segment request (HTTP path).
   *  Re-checks the window inside the lock — concurrent restarts that already
   *  covered `segNum` short-circuit to `{ok:true}`. */
  applyRestart(segNum: number, rendition?: number): Promise<TransitionResult>

  /** Apply a seek (WS-driven). Uses restartWithReset (wipes init) so the
   *  client reload of HLS source picks up a fresh init.mp4. */
  seekTo(positionMs: number): Promise<TransitionResult>

  /** Change audio track. Wipes init (codec config change). Rebuilds plan. */
  changeAudioTrack(index: number, positionMs?: number): Promise<TransitionResult>

  /** Change profile (quality override). Preserves init. Rebuilds plan. */
  changeProfile(profile: Profile, positionMs?: number): Promise<TransitionResult>

  /** Switch image-subtitle burn-in on/off/to another track. Wipes init (the
   *  filter graph changes). Only valid on transcode sessions. */
  changeBurnInSubtitle(burnInSubtitleIndex: number | null, positionMs?: number): Promise<TransitionResult>

  /** Swap in a completely rebuilt plan (bandwidth demote to transcode).
   *  Wipes init — the method/codec config changes wholesale. */
  applyPlanSwap(newPlan: PlaybackPlan, positionMs?: number): Promise<TransitionResult>

  /** Orchestrator hook: seed initial startSegment + seekPositionMs from a
   *  startPositionMs on session create. No restart spawned — orchestrator
   *  spawns ffmpeg from these values on its own. Must be called before any
   *  transition. */
  initializeSeek(positionMs: number): void

  /** Move to terminal `destroyed`. Idempotent. Pending transitions complete;
   *  subsequent transitions return `{ok:false, reason:'destroyed'}`. */
  markDestroyed(): void
}

export interface SessionRuntimeDeps {
  session: Session
  hwAccel: HwAccel
  doRestart?: RestartFn
  doRestartWithReset?: RestartWithResetFn
  headSegment?: (session: Session, rendition?: number) => number | null
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
  const { session, hwAccel } = deps
  const doRestart = deps.doRestart ?? defaultRestartAtSegment
  const doRestartWithReset = deps.doRestartWithReset ?? defaultRestartWithReset
  const headSegment = deps.headSegment ?? defaultHeadSegment
  const throttle = createTranscodeThrottle({
    session,
    headSegment,
    pause: pauseFfmpeg,
    resume: resumeFfmpeg,
    evictBelow: (s, segNum) => { void evictSegmentsBelow(s, segNum) },
  })

  let state: RuntimeState = { kind: 'idle' }

  function msToSegment(ms: number): number {
    return Math.max(0, Math.floor(ms / 1000 / SEGMENT_DURATION_SEC))
  }

  // Only asked about segments that are missing on disk, so one below the head was evicted and will not come back.
  function inRange(segNum: number, rendition: number): boolean {
    const start = session.currentStartSegment
    if (segNum < start) return false
    const written = headSegment(session, rendition)
    if (written !== null && segNum < written) return false
    const head = Math.max(start - 1, written ?? start - 1)
    return segNum <= head + SEEK_LOOKAHEAD_SEGMENTS
  }

  async function transition(
    target: RestartTarget,
    action: () => Promise<void>,
  ): Promise<TransitionResult> {
    if (state.kind === 'destroyed') return { ok: false, reason: 'destroyed' }
    if (state.kind === 'restarting') return { ok: false, reason: 'busy' }
    state = { kind: 'restarting', target }
    let timer: NodeJS.Timeout | undefined
    try {
      // Race the restart against a hard timeout so a hung ffmpeg can never
      // wedge the runtime in `restarting`. The losing action keeps running in
      // the background (best-effort) but the state machine is freed.
      await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('restart-timeout')), RESTART_TIMEOUT_MS)
        }),
      ])
      return { ok: true }
    } catch (err) {
      if (err instanceof Error && err.message === 'restart-timeout') {
        console.error(`Session ${session.id}: ffmpeg restart timed out after ${RESTART_TIMEOUT_MS}ms`)
      }
      return { ok: false, reason: 'busy', error: err }
    } finally {
      clearTimeout(timer)
      const current = state as RuntimeState
      if (current.kind !== 'destroyed') state = { kind: 'idle' }
    }
  }

  return {
    state: () => state,
    startSegment: () => session.currentStartSegment,
    seekPositionMs: () => session.seekPositionMs,

    onSegmentRequested: throttle.onSegmentRequested,

    requestSegment(segNum, rendition = 0) {
      if (inRange(segNum, rendition)) return { kind: 'wait' }
      return { kind: 'restart', segNum }
    },

    async applyRestart(segNum, rendition = 0) {
      if (state.kind === 'destroyed') return { ok: false, reason: 'destroyed' }
      if (state.kind === 'restarting') return { ok: false, reason: 'busy' }
      if (inRange(segNum, rendition)) return { ok: true }
      const target: RestartTarget = { segNum, plan: session.plan, withReset: false }
      return transition(target, () =>
        doRestart(session, hwAccel, target.plan, target.segNum),
      )
    },

    async seekTo(positionMs) {
      const segNum = msToSegment(positionMs)
      const target: RestartTarget = { segNum, plan: session.plan, withReset: true }
      const result = await transition(target, () =>
        doRestartWithReset(session, hwAccel, target.plan, target.segNum),
      )
      if (result.ok) session.seekPositionMs = positionMs
      return result
    },

    async changeAudioTrack(index, positionMs) {
      const newPlan = planWithAudioTrack(session.plan, index)
      session.plan = newPlan
      const segNum = positionMs !== undefined
        ? msToSegment(positionMs)
        : msToSegment(session.seekPositionMs)
      const target: RestartTarget = { segNum, plan: newPlan, withReset: true }
      return transition(target, () =>
        doRestartWithReset(session, hwAccel, target.plan, target.segNum),
      )
    },

    async applyPlanSwap(newPlan, positionMs) {
      session.plan = newPlan
      const segNum = positionMs !== undefined
        ? msToSegment(positionMs)
        : msToSegment(session.seekPositionMs)
      const target: RestartTarget = { segNum, plan: newPlan, withReset: true }
      return transition(target, () =>
        doRestartWithReset(session, hwAccel, target.plan, target.segNum),
      )
    },

    async changeBurnInSubtitle(burnInSubtitleIndex, positionMs) {
      const newPlan = planWithBurnIn(session.plan, burnInSubtitleIndex)
      session.plan = newPlan
      const segNum = positionMs !== undefined
        ? msToSegment(positionMs)
        : msToSegment(session.seekPositionMs)
      const target: RestartTarget = { segNum, plan: newPlan, withReset: true }
      return transition(target, () =>
        doRestartWithReset(session, hwAccel, target.plan, target.segNum),
      )
    },

    async changeProfile(profile, positionMs) {
      const segNum = positionMs !== undefined
        ? msToSegment(positionMs)
        : session.currentStartSegment
      const newPlan = planWithProfile(session.plan, profile)
      session.plan = newPlan
      const target: RestartTarget = { segNum, plan: newPlan, withReset: false }
      return transition(target, () =>
        doRestart(session, hwAccel, target.plan, target.segNum),
      )
    },

    initializeSeek(positionMs) {
      session.seekPositionMs = positionMs
      session.currentStartSegment = msToSegment(positionMs)
    },

    markDestroyed() {
      state = { kind: 'destroyed' }
    },
  }
}
