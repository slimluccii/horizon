import { describe, it, expect, vi } from 'vitest'
import {
  createPlaybackOrchestrator,
  type Spawner,
  type SubtitleExtractor,
} from '../src/session/playback.ts'
import { createSessionManager, type SessionManager } from '../src/session/manager.ts'
import { TranscodeError } from '../src/session/errors.ts'
import type { Config } from '../src/config.ts'
import type { HwAccel } from '../src/transcode/hwaccel.ts'
import type { MediaRepo, MediaItemRow } from '../src/repos/media.ts'
import type { UserRepo } from '../src/repos/users.ts'
import type { ClientCapabilities } from '../src/transcode/plan.ts'
import type { ServerSettings, ServerSettingsRow } from '../src/repos/serverSettings.ts'

const browserCaps: ClientCapabilities = {
  videoCodecs: ['h264'],
  audioCodecs: ['aac'],
  hdr: [],
  maxBitrate: 8000,
  container: ['mp4'],
}

function fakeMedia(items: Record<string, Partial<MediaItemRow>> = {}): MediaRepo {
  return {
    // Orchestrator uses getInternalRow (needs filePath for ffmpeg spawn).
    getInternalRow: (id: string) => (items[id] ? { ...items[id], id } as MediaItemRow : null),
  } as MediaRepo
}

function fakeUsers(known: Set<string>): UserRepo {
  return { get: (id: string) => (known.has(id) ? { id } as never : null) } as UserRepo
}

function baseCfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 7777,
    corsOrigins: ['*'],
    cacheDir: '/tmp/horizon-test',
    dbPath: ':memory:',
    watchedThresholdPct: 90,
    maxSessions: 4,
    wsGraceMs: 1_000, wsAttachMs: 1_000, maxRenditions: 3,
    forceEncoder: undefined, tmdbToken: undefined,
    toneMap: { operator: 'hable', postCorrection: true },
    scanConcurrency: 4, scanCronHour: 3, watchFs: false, watchDebounceMs: 5000,
    metadataBatchSize: 50,
    metadataMaxAgeMovieMs: 0, metadataMaxAgeShowMs: 0, metadataMaxAgeEpisodeMs: 0,
    devSeedEnabled: false,
    nodeEnv: 'development',
    webDir: undefined,
    serveWeb: false,
    ...overrides,
  }
}

function fakeServerSettings(overrides: Partial<ServerSettingsRow> = {}): ServerSettings {
  const base: ServerSettingsRow = {
    watchedThresholdPct: 90,
    scanCronHour: 3,
    scanConcurrency: 4,
    watchFs: false,
    watchDebounceMs: 5000,
    moviesRoots: [],
    showsRoots: [],
    tmdbToken: null,
    metadataBatchSize: 50,
    metadataMaxAgeMovieDays: 30,
    metadataMaxAgeShowDays: 7,
    metadataMaxAgeEpDays: 60,
    maxSessions: 4,
    maxRenditions: 3,
    wsGraceMs: 1_000,
    wsAttachMs: 1_000,
    forceEncoder: null,
    tonemapOperator: 'hable',
    tonemapParam: null,
    tonemapDesat: null,
    seededFromEnv: false,
    updatedAt: 0,
    ...overrides,
  }
  return {
    get: () => ({ ...base }),
    update: (patch) => { Object.assign(base, patch); return { ...base } },
    bootstrapFromEnv: () => { /* no-op in tests */ },
    on: () => ({} as ServerSettings),
    off: () => ({} as ServerSettings),
  }
}

const hwAccel = { name: 'cpu' } as unknown as HwAccel

const sampleMovie: Partial<MediaItemRow> = {
  filePath: '/movies/Sample (2024).mkv',
  title: 'Sample',
  kind: 'movie',
  durationSec: 3600,
  resolution: '1920x1080',
  videoCodec: 'h264',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  audioTracks: [{ index: 0, codec: 'aac', channels: 2, language: 'eng', title: '', default: true }],
  subtitleTracks: [],
  hdr: { dv: false, hdr10: false, hdr10plus: false },
}

interface Harness {
  cfg: Config
  sessions: SessionManager
  serverSettings: ServerSettings
  spawner: ReturnType<typeof makeSpawner>
  extractSubtitles: ReturnType<typeof vi.fn<Parameters<SubtitleExtractor>, ReturnType<SubtitleExtractor>>>
}

function makeSpawner() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((r, rej) => { resolve = r; reject = rej })
  // Pre-attach a no-op handler so the raw promise is never flagged as
  // unhandled when the orchestrator hasn't awaited it yet (e.g. during
  // createSessionDir). The orchestrator's await still receives the rejection.
  promise.catch(() => {})
  const fn: Spawner = vi.fn(() => promise)
  return Object.assign(fn, { resolve, reject })
}

function harness(settingsOverrides: Partial<ServerSettingsRow> = {}): Harness {
  const cfg = baseCfg()
  const serverSettings = fakeServerSettings(settingsOverrides)
  const sessions = createSessionManager(serverSettings)
  const spawner = makeSpawner()
  const extractSubtitles = vi.fn(() => Promise.resolve()) as unknown as Harness['extractSubtitles']
  return { cfg, sessions, serverSettings, spawner, extractSubtitles }
}

describe('PlaybackOrchestrator', () => {
  it('throws media-not-found when MediaItem is missing', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({}),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'nope', capabilities: browserCaps })
    ).toThrow(expect.objectContaining({ code: 'media-not-found' }))
  })

  it('throws user-not-found when userId is given but unknown', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set(['u1'])),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, userId: 'u-ghost' })
    ).toThrow(expect.objectContaining({ code: 'user-not-found' }))
  })

  it('throws max-sessions when capacity is reached', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness({ maxSessions: 1 })
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps })

    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps })
    ).toThrow(expect.objectContaining({ code: 'max-sessions' }))
  })

  it('throws audio-track-invalid when audioTrackIndex >= available tracks', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }), // sampleMovie has 1 audio track (index 0)
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, audioTrackIndex: 1 })
    ).toThrow(expect.objectContaining({ code: 'audio-track-invalid' }))
  })

  it('throws audio-track-invalid when audioTrackIndex < 0', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, audioTrackIndex: -1 })
    ).toThrow(expect.objectContaining({ code: 'audio-track-invalid' }))
  })

  it('throws audio-track-invalid for media with no audio tracks (default index 0)', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: { ...sampleMovie, audioTracks: [] } }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps })
    ).toThrow(expect.objectContaining({ code: 'audio-track-invalid' }))
  })

  it('throws invalid-input when subtitleTrackIndex is out of bounds', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      // sampleMovie has subtitleTracks: []
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, subtitleTrackIndex: 0 })
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }))
  })

  it('throws invalid-input when subtitleTrackIndex exceeds available subtitle tracks', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const twoSubs: Partial<MediaItemRow> = {
      ...sampleMovie,
      subtitleTracks: [
        { index: 0, codec: 'subrip', language: 'eng', forced: false, embeddable: true },
        { index: 1, codec: 'subrip', language: 'nld', forced: false, embeddable: true },
      ],
    }
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: twoSubs }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, subtitleTrackIndex: 5 })
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }))
  })

  it('accepts subtitleTrackIndex of -1 (no subtitles)', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, subtitleTrackIndex: -1 })
    ).not.toThrow()
  })

  it('throws invalid-input when startPositionMs exceeds media duration', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      // sampleMovie durationSec = 3600 → 3_600_000 ms
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, startPositionMs: 9_999_999 })
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }))
  })

  it('accepts startPositionMs of 0 (boundary)', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, startPositionMs: 0 })
    ).not.toThrow()
  })

  it('accepts startPositionMs exactly at media duration (boundary)', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      // durationSec 3600 → exactly 3_600_000 ms is allowed; only strictly > rejects.
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, startPositionMs: 3_600_000 })
    ).not.toThrow()
  })

  it('accepts a valid audioTrackIndex', () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })
    expect(() =>
      orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps, audioTrackIndex: 0 })
    ).not.toThrow()
  })

  it('returns sessionInfo synchronously and resolves ready after spawn', async () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    // Capabilities mismatch on container forces direct-stream (still spawns ffmpeg).
    const transcodeCaps: ClientCapabilities = { ...browserCaps, container: ['mkv'] }
    const { info, ready } = orch.startPlayback({ mediaId: 'm1', capabilities: transcodeCaps })

    expect(info.sessionId).toMatch(/[0-9a-f-]+/)
    expect(info.method).not.toBe('direct-play')
    expect(info.streamUrl).toMatch(/^\/sessions\/.+\/stream\.m3u8$/)
    expect(info.wsUrl).toMatch(/^\/sessions\/.+\/ws$/)
    expect(info.profiles.length).toBeGreaterThan(0)

    const session = sessions.get(info.sessionId)
    expect(session?.sessionReady).toBe(false)

    spawner.resolve()
    await ready

    expect(sessions.get(info.sessionId)?.sessionReady).toBe(true)
    expect(sessions.get(info.sessionId)?.state).toBe('active')
    expect(extractSubtitles).toHaveBeenCalledTimes(1)
  })

  it('destroys session and rejects ready when spawn fails', async () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    const transcodeCaps: ClientCapabilities = { ...browserCaps, container: ['mkv'] }
    const { info, ready } = orch.startPlayback({ mediaId: 'm1', capabilities: transcodeCaps })

    // Attach rejection handler BEFORE triggering the rejection so Node never
    // sees a window where `ready` has no handler.
    const rejectionCheck = expect(ready).rejects.toThrow(/ffmpeg exploded/)
    spawner.reject(new Error('ffmpeg exploded'))
    await rejectionCheck

    expect(sessions.get(info.sessionId)).toBeUndefined()
    expect(extractSubtitles).not.toHaveBeenCalled()
  })

  it('spawn error rejection is a TranscodeError with code and stderrTail', async () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    const transcodeCaps: ClientCapabilities = { ...browserCaps, container: ['mkv'] }
    const { info, ready } = orch.startPlayback({ mediaId: 'm1', capabilities: transcodeCaps })

    const caught = ready.then(
      () => { throw new Error('expected rejection') },
      (err) => err,
    )
    spawner.reject(new Error('ffmpeg exploded'))
    const err = await caught

    expect(err).toBeInstanceOf(TranscodeError)
    expect((err as TranscodeError).code).toBe('ffmpeg-spawn-failed')
    expect((err as TranscodeError).message).toMatch(/ffmpeg exploded/)
    // No ffmpeg process attached by the fake spawner → stderrTail empty string.
    expect(typeof (err as TranscodeError).stderrTail).toBe('string')
    expect(sessions.get(info.sessionId)).toBeUndefined()
  })

  it('session is destroyed even if a cleanup step throws', async () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    const transcodeCaps: ClientCapabilities = { ...browserCaps, container: ['mkv'] }
    const { info, ready } = orch.startPlayback({ mediaId: 'm1', capabilities: transcodeCaps })

    // Make a cleanup step (the runtime's markDestroyed) throw. destroy() must
    // isolate it and still remove the session from the map.
    const runtime = sessions.getRuntime(info.sessionId)!
    const originalMark = runtime.markDestroyed.bind(runtime)
    runtime.markDestroyed = () => { originalMark(); throw new Error('cleanup boom') }

    const caught = ready.then(() => { throw new Error('expected rejection') }, (e) => e)
    spawner.reject(new Error('ffmpeg exploded'))
    const err = await caught

    // The original spawn failure is what surfaces — the cleanup throw is swallowed.
    expect(err).toBeInstanceOf(TranscodeError)
    expect((err as TranscodeError).message).toMatch(/ffmpeg exploded/)
    // Session is gone despite the cleanup-step failure.
    expect(sessions.get(info.sessionId)).toBeUndefined()
    expect(sessions.size()).toBe(0)
  })

  it('skips ffmpeg spawn for direct-play and resolves ready immediately', async () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      // h264/aac/mp4 → direct-play under browserCaps
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    const { info, ready } = orch.startPlayback({ mediaId: 'm1', capabilities: browserCaps })
    await ready

    expect(info.method).toBe('direct-play')
    expect(info.streamUrl).toMatch(/\/direct$/)
    expect(spawner).not.toHaveBeenCalled()
    // Subtitle extraction is a transcode-pipeline artifact, not relevant for direct-play.
    expect(extractSubtitles).not.toHaveBeenCalled()
    expect(sessions.get(info.sessionId)?.state).toBe('active')
  })

  it('seeds seek state when startPositionMs is provided on transcode path', async () => {
    const { cfg, sessions, serverSettings, spawner, extractSubtitles } = harness()
    const orch = createPlaybackOrchestrator({
      cfg, hwAccel,
      media: fakeMedia({ m1: sampleMovie }),
      users: fakeUsers(new Set()),
      sessions, serverSettings, spawner, extractSubtitles,
    })

    const transcodeCaps: ClientCapabilities = { ...browserCaps, container: ['mkv'] }
    const { info, ready } = orch.startPlayback({
      mediaId: 'm1', capabilities: transcodeCaps, startPositionMs: 60_000,
    })

    spawner.resolve()
    await ready

    const s = sessions.get(info.sessionId)!
    expect(s.seekPositionMs).toBe(60_000)
    expect(s.currentStartSegment).toBeGreaterThan(0)
  })
})
