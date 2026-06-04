import { describe, it, expect, vi } from 'vitest'
import {
  createSessionRuntime,
  SEEK_LOOKAHEAD_SEGMENTS,
  RESTART_TIMEOUT_MS,
  type RestartFn,
  type RestartWithResetFn,
} from './runtime.ts'
import type { Session } from '../domain/types.ts'
import type { HwAccel } from '../domain/hwaccel.ts'

const hwAccel = { name: 'cpu' } as unknown as HwAccel

const sampleProfile = { name: '1080p', videoBitrate: 8000, audioBitrate: 192, width: 1920, height: 1080 }

function fakePlan(overrides: Partial<import('../domain/plan.ts').PlaybackPlan> = {}): import('../domain/plan.ts').PlaybackPlan {
  return {
    method: 'transcode',
    needsToneMap: false,
    toneMap: { operator: 'hable', postCorrection: true },
    renditions: [{ profile: sampleProfile, videoCodec: 'avc1.640028' }],
    audioTrackIndex: 0,
    audioStrategy: 'aac',
    videoStrategy: 'transcode',
    ...overrides,
  }
}

function fakeSession(overrides: Partial<Session> & { plan?: import('../domain/plan.ts').PlaybackPlan } = {}): Session {
  return {
    id: 's1',
    mediaId: 'm1',
    filePath: '/m.mkv',
    state: 'pre-buffer',
    plan: overrides.plan ?? fakePlan(),
    selectedSubtitleTrack: null,
    renditionCodecs: [],
    sessionDir: '/tmp/s1',
    sessionReady: false,
    durationSec: 3600,
    currentStartSegment: 0,
    seekPositionMs: 0,
    reconnectToken: 'tok',
    createdAt: Date.now(),
    ...overrides,
  } as Session
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (e: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((r, rej) => { resolve = r; reject = rej })
  promise.catch(() => {})  // pre-attach to avoid raw-unhandled flags
  return { promise, resolve, reject }
}

describe('SessionRuntime', () => {
  describe('requestSegment / applyRestart', () => {
    it('classifies in-range as wait, out-of-range as restart', () => {
      const session = fakeSession({ currentStartSegment: 100 })
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: vi.fn() as unknown as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      expect(runtime.requestSegment(100).kind).toBe('wait')
      expect(runtime.requestSegment(100 + SEEK_LOOKAHEAD_SEGMENTS - 1).kind).toBe('wait')

      const r1 = runtime.requestSegment(100 + SEEK_LOOKAHEAD_SEGMENTS)
      expect(r1.kind).toBe('restart')
      if (r1.kind === 'restart') expect(r1.segNum).toBe(100 + SEEK_LOOKAHEAD_SEGMENTS)

      const r2 = runtime.requestSegment(50)
      expect(r2.kind).toBe('restart')
    })

    it('applyRestart invokes doRestart and transitions idle → restarting → idle', async () => {
      const session = fakeSession({ currentStartSegment: 0 })
      const d = deferred()
      const doRestart = vi.fn(async (s: Session, _hw, _profiles, segNum: number) => {
        s.currentStartSegment = segNum
        await d.promise
      })
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: doRestart as unknown as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      expect(runtime.state().kind).toBe('idle')

      const pending = runtime.applyRestart(500)
      expect(runtime.state().kind).toBe('restarting')

      d.resolve()
      const res = await pending
      expect(res.ok).toBe(true)
      expect(runtime.state().kind).toBe('idle')
      expect(doRestart).toHaveBeenCalledWith(session, hwAccel, session.plan, 500)
    })

    it('returns busy when a restart is already in flight', async () => {
      const session = fakeSession()
      const d = deferred()
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: (async () => d.promise) as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      const first = runtime.applyRestart(500)
      const second = await runtime.applyRestart(800)
      expect(second).toEqual({ ok: false, reason: 'busy' })

      d.resolve()
      await first
    })

    it('returns ok without restart if window already covers segNum after concurrent restart', async () => {
      const session = fakeSession({ currentStartSegment: 600 })
      const doRestart = vi.fn() as unknown as RestartFn
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      // segNum 610 is inside [600, 600+30). Concurrent restart already landed.
      const res = await runtime.applyRestart(610)
      expect(res).toEqual({ ok: true })
      expect(doRestart).not.toHaveBeenCalled()
    })

    it('surfaces actuator failure as busy + error and returns to idle', async () => {
      const session = fakeSession()
      const d = deferred()
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: (async () => { await d.promise }) as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      const pending = runtime.applyRestart(500)
      d.reject(new Error('ffmpeg died'))
      const res = await pending
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toBe('busy')
        expect(String(res.error)).toMatch(/ffmpeg died/)
      }
      expect(runtime.state().kind).toBe('idle')
    })

    it('returns busy+error and unwedges when the restart action times out', async () => {
      vi.useFakeTimers()
      try {
        const session = fakeSession()
        const never = deferred() // doRestart that never settles
        const runtime = createSessionRuntime({
          session, hwAccel,
          doRestart: (async () => { await never.promise }) as RestartFn,
          doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
        })

        const pending = runtime.applyRestart(500)
        expect(runtime.state().kind).toBe('restarting')

        // Fire the timeout.
        await vi.advanceTimersByTimeAsync(RESTART_TIMEOUT_MS)
        const res = await pending

        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.reason).toBe('busy')
          expect(String((res.error as Error)?.message)).toMatch(/restart-timeout/)
        }
        // Crucially, the runtime is back to idle — not wedged in `restarting`.
        expect(runtime.state().kind).toBe('idle')
        never.resolve() // let the orphaned action settle
      } finally {
        vi.useRealTimers()
      }
    })

    it('a restart timeout does not break subsequent transitions', async () => {
      vi.useFakeTimers()
      try {
        const session = fakeSession()
        const never = deferred()
        let call = 0
        const doRestart: RestartFn = (async (_s, _hw, _plan, segNum: number) => {
          call += 1
          if (call === 1) { await never.promise; return } // first hangs → times out
          session.currentStartSegment = segNum                // second succeeds fast
        }) as RestartFn
        const runtime = createSessionRuntime({
          session, hwAccel,
          doRestart,
          doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
        })

        const first = runtime.applyRestart(500)
        await vi.advanceTimersByTimeAsync(RESTART_TIMEOUT_MS)
        const firstRes = await first
        expect(firstRes.ok).toBe(false)
        expect(runtime.state().kind).toBe('idle')

        // A fresh restart after the timeout works normally.
        const secondRes = await runtime.applyRestart(800)
        expect(secondRes).toEqual({ ok: true })
        expect(runtime.state().kind).toBe('idle')
        never.resolve()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('seekTo', () => {
    it('calls restartWithReset with the right segment + preserves sub-segment ms', async () => {
      const session = fakeSession()
      const doRestartWithReset = vi.fn(async (s: Session, _hw, _plan, segNum: number) => {
        s.currentStartSegment = segNum
        s.seekPositionMs = segNum * 1000  // actuator rounds to segment boundary (1s/seg)
      })
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: vi.fn() as unknown as RestartFn,
        doRestartWithReset: doRestartWithReset as unknown as RestartWithResetFn,
      })

      const res = await runtime.seekTo(123_500)  // 123.5s → seg 123 at 1s/seg
      expect(res.ok).toBe(true)
      expect(doRestartWithReset).toHaveBeenCalledWith(session, hwAccel, session.plan, 123)
      // Runtime should preserve the original ms after the actuator rounded
      expect(session.seekPositionMs).toBe(123_500)
    })
  })

  describe('changeAudioTrack', () => {
    it('rebuilds plan with new audio index and calls restartWithReset', async () => {
      const session = fakeSession({ seekPositionMs: 60_000 })
      const doRestartWithReset = vi.fn(async () => {})
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: vi.fn() as unknown as RestartFn,
        doRestartWithReset: doRestartWithReset as unknown as RestartWithResetFn,
      })

      const res = await runtime.changeAudioTrack(2)
      expect(res.ok).toBe(true)
      expect(session.plan.audioTrackIndex).toBe(2)
      // Used existing seekPositionMs (60s → seg 60 at 1s/seg). Plan passed has the new audio idx.
      expect(doRestartWithReset).toHaveBeenCalledWith(session, hwAccel, session.plan, 60)
    })
  })

  describe('changeProfile', () => {
    it('rebuilds plan with new profile and calls doRestart at startSegment when no positionMs', async () => {
      const session = fakeSession({ currentStartSegment: 42 })
      const doRestart = vi.fn(async () => {})
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: doRestart as unknown as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      const newProfile = { name: '720p', videoBitrate: 4000, audioBitrate: 160, width: 1280, height: 720 }
      const res = await runtime.changeProfile(newProfile)
      expect(res.ok).toBe(true)
      expect(session.plan.renditions).toEqual([{ profile: newProfile, videoCodec: 'avc1.640028' }])
      expect(doRestart).toHaveBeenCalledWith(session, hwAccel, session.plan, 42)
    })
  })

  describe('lifecycle', () => {
    it('initializeSeek seeds startSegment and seekPositionMs', () => {
      const session = fakeSession()
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: vi.fn() as unknown as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      runtime.initializeSeek(60_000)
      expect(session.seekPositionMs).toBe(60_000)
      expect(session.currentStartSegment).toBe(60)  // 60s / 1s/seg
      expect(runtime.startSegment()).toBe(60)
      expect(runtime.seekPositionMs()).toBe(60_000)
    })

    it('markDestroyed: subsequent transitions return destroyed', async () => {
      const session = fakeSession()
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: vi.fn() as unknown as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      runtime.markDestroyed()
      expect(runtime.state().kind).toBe('destroyed')

      const res = await runtime.applyRestart(500)
      expect(res).toEqual({ ok: false, reason: 'destroyed' })

      const res2 = await runtime.seekTo(60_000)
      expect(res2).toEqual({ ok: false, reason: 'destroyed' })
    })

    it('markDestroyed during in-flight restart leaves state destroyed after action settles', async () => {
      const session = fakeSession()
      const d = deferred()
      const runtime = createSessionRuntime({
        session, hwAccel,
        doRestart: (async () => d.promise) as RestartFn,
        doRestartWithReset: vi.fn() as unknown as RestartWithResetFn,
      })

      const pending = runtime.applyRestart(500)
      expect(runtime.state().kind).toBe('restarting')

      runtime.markDestroyed()
      d.resolve()
      await pending

      expect(runtime.state().kind).toBe('destroyed')
    })
  })
})
