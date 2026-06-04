/**
 * PlaybackOrchestrator — owns the create-Session flow end-to-end. Sits above
 * SessionManager (storage) and below the HTTP route (transport).
 *
 * Inputs: a StartPlaybackInput (mediaId + capabilities + options).
 * Output: { info, ready }. `info` is synchronous and includes the streamUrl;
 *         `ready` is a Promise that resolves after ffmpeg signals
 *         session-ready (or rejects on spawn failure, after the Session has
 *         already been destroyed).
 *
 * Validation errors surface as `Error & { code }`:
 *   - 'media-not-found' → 404
 *   - 'user-not-found'  → 400
 *   - 'max-sessions'    → 503
 *
 * The Spawner type is the seam for tests — production wires it to
 * `spawnFfmpeg`; tests inject a fake that resolves/rejects on cue.
 *
 * See CONTEXT.md → PlaybackOrchestrator / Spawner / ProbeView.
 */
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { MediaRepo, MediaItemRow, ProbeResult } from '../contexts/library/index.ts'
import type { UserRepo } from '../contexts/identity/index.ts'
import type { ServerSettings } from '../contexts/settings/index.ts'
import type { SessionManager } from './manager.ts'
import type { Session } from './types.ts'
import type { Profile } from '../transcode/profiles.ts'
import type { PlaybackPlan, ClientCapabilities, PlaybackMethod } from '../transcode/plan.ts'
import type { RenderContext } from '../transcode/render.ts'
import type { ToneMapConfig, ToneMapOperator } from '../transcode/tonemap.ts'
import { isToneMapOperator } from '../transcode/tonemap.ts'
import { ErrorCodes } from '@horizon/sdk'
import { buildPlan } from '../transcode/plan.ts'
import {
  createSessionDir,
  spawnFfmpeg as defaultSpawnFfmpeg,
} from '../transcode/ffmpeg.ts'
import { extractSubtitles as defaultExtractSubtitles } from '../transcode/subtitles.ts'
import { getFfmpegStderrTail } from '../transcode/ffmpeg.ts'
import { createSessionRuntime } from './runtime.ts'
import { TranscodeError } from './errors.ts'

export interface StartPlaybackInput {
  mediaId: string
  capabilities: ClientCapabilities
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
  userId?: string
  startPositionMs?: number
}

export interface PlaybackSessionInfo {
  sessionId: string
  method: PlaybackMethod
  streamUrl: string
  wsUrl: string
  profiles: Profile[]
  selectedAudioTrack: number
  selectedSubtitleTrack: number | null
  reconnectToken: string
}

export interface StartPlaybackResult {
  info: PlaybackSessionInfo
  /** Resolves when ffmpeg has produced enough output for the client to begin
   *  playback, or immediately for direct-play. Rejects on spawn failure
   *  (Session is already destroyed by the time this rejects). */
  ready: Promise<void>
}

export interface PlaybackOrchestrator {
  startPlayback(input: StartPlaybackInput): StartPlaybackResult
}

/** Spawn primitive — the injection seam. Real impl is `spawnFfmpeg`; tests
 *  pass a fake. */
export type Spawner = (
  session: Session,
  hwAccel: HwAccel,
  plan: PlaybackPlan,
  ctx: RenderContext,
) => Promise<void>

export type SubtitleExtractor = typeof defaultExtractSubtitles

export interface PlaybackOrchestratorDeps {
  cfg: Config
  hwAccel: HwAccel
  media: MediaRepo
  users: UserRepo
  sessions: SessionManager
  serverSettings: ServerSettings
  /** Injection point for tests. Defaults to the real `spawnFfmpeg`. */
  spawner?: Spawner
  /** Injection point for tests. Defaults to the real `extractSubtitles`. */
  extractSubtitles?: SubtitleExtractor
}

type PlaybackErrorCode =
  | typeof ErrorCodes.MEDIA_NOT_FOUND
  | typeof ErrorCodes.USER_NOT_FOUND
  | typeof ErrorCodes.MAX_SESSIONS
  | typeof ErrorCodes.AUDIO_TRACK_INVALID
  | typeof ErrorCodes.INVALID_INPUT

class PlaybackError extends Error {
  constructor(public code: PlaybackErrorCode, message: string) {
    super(message)
  }
}

export function createPlaybackOrchestrator(deps: PlaybackOrchestratorDeps): PlaybackOrchestrator {
  const { cfg, hwAccel, media, users, sessions, serverSettings } = deps
  const spawner: Spawner = deps.spawner ?? defaultSpawnFfmpeg
  const extractSubtitles: SubtitleExtractor = deps.extractSubtitles ?? defaultExtractSubtitles

  return {
    startPlayback(input) {
      // Orchestrator needs filePath for ffmpeg spawn — use getInternalRow.
      // Routes never see this row; they fetch via getById which returns
      // the domain projection.
      const mediaItem = media.getInternalRow(input.mediaId)
      if (!mediaItem) throw new PlaybackError(ErrorCodes.MEDIA_NOT_FOUND, 'Media not found')

      if (input.userId !== undefined && !users.get(input.userId)) {
        throw new PlaybackError(ErrorCodes.USER_NOT_FOUND, 'User not found')
      }

      // Validate the requested audio track up-front so we fail fast at session
      // creation rather than during ffmpeg spawn. A client that omits
      // audioTrackIndex defaults to 0, so a file with zero audio tracks also
      // rejects here (you cannot select an audio track that doesn't exist).
      const requestedAudioTrack = input.audioTrackIndex ?? 0
      const audioTrackCount = mediaItem.audioTracks?.length ?? 0
      if (requestedAudioTrack < 0 || requestedAudioTrack >= audioTrackCount) {
        throw new PlaybackError(ErrorCodes.AUDIO_TRACK_INVALID, 'Audio track index out of bounds')
      }

      // Subtitle track: -1 (or null) means "no subtitles". Any other value must
      // index an existing track.
      const requestedSubtitle = input.subtitleTrackIndex
      if (
        requestedSubtitle !== undefined && requestedSubtitle !== null && requestedSubtitle !== -1 &&
        requestedSubtitle >= (mediaItem.subtitleTracks?.length ?? 0)
      ) {
        throw new PlaybackError(ErrorCodes.INVALID_INPUT, 'Subtitle track index out of bounds')
      }

      // Seek position cannot exceed the media duration.
      if (
        input.startPositionMs !== undefined &&
        input.startPositionMs > (mediaItem.durationSec ?? 0) * 1000
      ) {
        throw new PlaybackError(ErrorCodes.INVALID_INPUT, 'Start position exceeds media duration')
      }

      // Read playback knobs live from serverSettings so changes take effect
      // on the next session create without a server restart.
      const liveSettings = serverSettings.get()

      if (sessions.size() >= liveSettings.maxSessions) {
        throw new PlaybackError(ErrorCodes.MAX_SESSIONS, 'Server at session capacity')
      }

      const audioTrackIndex = requestedAudioTrack
      const subtitleTrackIndex = input.subtitleTrackIndex ?? null

      const plan = buildPlan({
        probe: mediaItemToProbeView(mediaItem),
        capabilities: input.capabilities,
        hwAccel,
        audioTrackIndex,
        maxRenditions: liveSettings.maxRenditions,
        toneMap: settingsToToneMap(liveSettings),
      })

      const session = sessions.create({
        mediaId: input.mediaId,
        filePath: mediaItem.filePath!,
        plan,
        selectedSubtitleTrack: subtitleTrackIndex,
        audioTrackCount,
        subtitleTrackCount: mediaItem.subtitleTracks?.length ?? 0,
        renditionCodecs: [],
        sessionDir: '',
        sessionReady: false,
        durationSec: mediaItem.durationSec ?? 0,
        userId: input.userId ?? undefined,
      })

      const profiles = plan.renditions.map(r => r.profile)
      const initialProfile = profiles[0] ?? { name: 'direct', videoBitrate: 0, audioBitrate: 0, width: 0, height: 0 }

      const info: PlaybackSessionInfo = {
        sessionId: session.id,
        method: plan.method,
        streamUrl: plan.method === 'direct-play'
          ? `/api/sessions/${session.id}/direct`
          : `/api/sessions/${session.id}/stream.m3u8`,
        wsUrl: `/api/sessions/${session.id}/ws`,
        profiles: profiles.length > 0 ? profiles : [initialProfile],
        selectedAudioTrack: audioTrackIndex,
        selectedSubtitleTrack: subtitleTrackIndex,
        reconnectToken: session.reconnectToken,
      }

      const runtime = createSessionRuntime({ session, hwAccel })
      sessions.attachRuntime(session.id, runtime)

      const ready = (async () => {
        session.sessionDir = await createSessionDir(session.id)

        // Seek-on-create: prepare ffmpeg to begin output at the requested
        // segment so the client can resume mid-stream without a separate
        // restart roundtrip. Direct-play has no segmenter, so skip.
        if (
          input.startPositionMs && input.startPositionMs > 0 &&
          plan.method !== 'direct-play'
        ) {
          runtime.initializeSeek(input.startPositionMs)
        }

        if (plan.method === 'direct-play') {
          session.sessionReady = true
          session.state = 'active'
          return
        }

        const ctx: RenderContext = {
          sourceFilePath: session.filePath,
          sessionDir: session.sessionDir,
          startSegment: session.currentStartSegment,
          seekPositionMs: session.seekPositionMs,
        }

        try {
          await spawner(session, hwAccel, plan, ctx)
        } catch (err) {
          // Capture the stderr tail (if ffmpeg got far enough to spawn) so the
          // failure can be diagnosed from a single log line.
          const stderrTail = session.ffmpegProcess
            ? getFfmpegStderrTail(session.ffmpegProcess)
            : ''
          const message = err instanceof Error ? err.message : String(err)
          const transcodeError = new TranscodeError(
            ErrorCodes.FFMPEG_SPAWN_FAILED,
            message,
            stderrTail,
          )
          console.error(
            `Session ${session.id}: spawn failed (media ${input.mediaId}, code ${transcodeError.code}): ${message}` +
            (stderrTail ? `\n=== ffmpeg stderr tail ===\n${stderrTail}\n=== end ===` : ''),
          )
          // Reap the half-created session so callers don't have to. destroy()
          // is bulletproof (each cleanup step is isolated), so this never
          // throws over the original spawn failure.
          await sessions.destroy(session.id).catch(() => {/* already gone */})
          throw transcodeError
        }

        session.sessionReady = true
        session.state = 'active'

        extractSubtitles(
          mediaItem.filePath!,
          mediaItem.subtitleTracks ?? [],
          session.sessionDir,
          session,
        ).catch(err => console.error(`Session ${session.id}: subtitle extraction error`, err))
      })()

      return { info, ready }
    },
  }
}

/** Project a MediaItemRow into the ProbeResult shape `buildPlan` consumes.
 *  videoBitrate isn't stored in media_items — default 0 so the bitrate check
 *  is permissive. */
function mediaItemToProbeView(item: MediaItemRow): ProbeResult {
  return {
    duration: item.durationSec ?? 0,
    resolution: item.resolution ?? '1920x1080',
    videoCodec: item.videoCodec ?? '',
    videoBitrate: 0,
    hdr: item.hdr ?? { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: item.audioTracks ?? [],
    subtitleTracks: item.subtitleTracks ?? [],
    container: item.container ?? '',
  }
}

/** Build a ToneMapConfig from the live ServerSettings row.
 *  Falls back to 'hable' when the stored operator is unrecognised
 *  (guards against stale DB values after a downgrade). peak and
 *  postCorrection are not stored — use in-code defaults instead. */
function settingsToToneMap(s: ReturnType<ServerSettings['get']>): ToneMapConfig {
  const operator: ToneMapOperator = isToneMapOperator(s.tonemapOperator)
    ? (s.tonemapOperator as ToneMapOperator)
    : 'hable'
  return {
    operator,
    param: s.tonemapParam ?? undefined,
    desat: s.tonemapDesat ?? undefined,
    // peak and postCorrection are not UI-editable in v1 — keep in-code defaults.
    postCorrection: true,
  }
}
