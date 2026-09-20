import { describe, it, expect } from 'vitest'
import {
  createTranscodeThrottle,
  PAUSE_WHEN_AHEAD_SEGMENTS,
  RESUME_WHEN_AHEAD_SEGMENTS,
  THROTTLE_CHECK_INTERVAL_MS,
  KEEP_BEHIND_SEGMENTS,
} from './throttle.ts'
import type { Session } from '../domain/types.ts'

function setup(overrides: Partial<Session> = {}) {
  const calls: string[] = []
  const evicted: number[] = []
  const state = { head: 0 as number | null, now: 0 }
  const session = { id: 's1', state: 'active', ffmpegProcess: { pid: 1 }, ...overrides } as unknown as Session
  const throttle = createTranscodeThrottle({
    session,
    headSegment: () => state.head,
    pause: () => { calls.push('pause') },
    resume: () => { calls.push('resume') },
    evictBelow: (_s, segNum) => { evicted.push(segNum) },
    now: () => state.now,
  })
  const request = (segNum: number, head: number | null) => {
    state.head = head
    state.now += THROTTLE_CHECK_INTERVAL_MS
    throttle.onSegmentRequested(segNum)
  }
  return { session, throttle, calls, evicted, state, request }
}

describe('transcode throttle', () => {
  it('lets the encoder run while it is less than the pause threshold ahead of the player', () => {
    const { calls, request } = setup()
    request(10, 10 + PAUSE_WHEN_AHEAD_SEGMENTS - 1)
    expect(calls).toEqual([])
  })

  it('pauses the encoder once it is far enough ahead of what the player asks for', () => {
    const { calls, request } = setup()
    request(10, 10 + PAUSE_WHEN_AHEAD_SEGMENTS)
    expect(calls).toEqual(['pause'])
  })

  it('stays paused until the player has caught up to the resume threshold', () => {
    const { calls, request } = setup()
    const head = 10 + PAUSE_WHEN_AHEAD_SEGMENTS
    request(10, head)
    request(head - RESUME_WHEN_AHEAD_SEGMENTS - 1, head)
    expect(calls).toEqual(['pause'])
    request(head - RESUME_WHEN_AHEAD_SEGMENTS, head)
    expect(calls).toEqual(['pause', 'resume'])
  })

  it('resumes at once when the player asks for a segment the encoder has not written', () => {
    const { calls, state, throttle, request } = setup()
    const head = 10 + PAUSE_WHEN_AHEAD_SEGMENTS
    request(10, head)
    state.now += 1
    throttle.onSegmentRequested(head + 1)
    expect(calls).toEqual(['pause', 'resume'])
  })

  it('reads the encoder head at most once per check interval', () => {
    let reads = 0
    const session = { id: 's1', state: 'active', ffmpegProcess: { pid: 1 } } as unknown as Session
    const throttle = createTranscodeThrottle({
      session, headSegment: () => { reads++; return 500 }, pause: () => {}, resume: () => {}, evictBelow: () => {}, now: () => 0,
    })
    for (let seg = 0; seg < 20; seg++) throttle.onSegmentRequested(seg)
    expect(reads).toBe(1)
  })

  it('treats a replacement encoder as running, since a restart spawns it unpaused', () => {
    const { session, calls, request } = setup()
    request(10, 10 + PAUSE_WHEN_AHEAD_SEGMENTS)
    ;(session as any).ffmpegProcess = { pid: 2 }
    request(300, 300 + PAUSE_WHEN_AHEAD_SEGMENTS)
    expect(calls).toEqual(['pause', 'pause'])
  })

  it('leaves a parked session alone, the client paused that one itself', () => {
    const { calls, request } = setup({ state: 'parked' } as Partial<Session>)
    request(10, 10 + PAUSE_WHEN_AHEAD_SEGMENTS)
    expect(calls).toEqual([])
  })

  it('does nothing for a session without an encoder', () => {
    const { calls, request } = setup({ ffmpegProcess: undefined } as Partial<Session>)
    request(10, 10 + PAUSE_WHEN_AHEAD_SEGMENTS)
    expect(calls).toEqual([])
  })
})

describe('segment eviction by the throttle', () => {
  it('drops segments the player has left far enough behind', () => {
    const { evicted, request } = setup()
    request(KEEP_BEHIND_SEGMENTS + 40, 500)
    expect(evicted).toEqual([40])
  })

  it('keeps everything while the player is still within the keep window of the run start', () => {
    const { evicted, request } = setup({ currentStartSegment: 100 } as Partial<Session>)
    request(100 + KEEP_BEHIND_SEGMENTS, 500)
    expect(evicted).toEqual([])
  })

  it('does not evict again for a request further back than the last eviction', () => {
    const { evicted, request } = setup()
    request(KEEP_BEHIND_SEGMENTS + 40, 500)
    request(KEEP_BEHIND_SEGMENTS + 10, 500)
    expect(evicted).toEqual([40])
  })
})
