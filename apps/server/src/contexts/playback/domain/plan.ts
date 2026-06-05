/**
 * PlaybackPlan — the answer to "what would we encode this as" for a single
 * Session. Built once at session create from (probe, capabilities, hwAccel,
 * config); rebuilt when the user picks a new profile or audio track. Stays
 * stable across seeks + segment-driven restarts (those just change the
 * RenderContext, not the plan).
 *
 * This module absorbs the old `decision.ts` + the orchestrator's inline
 * `selectProfilesForPlayback` + the per-method profile selection from
 * `profiles.ts`. `decidePlayback` is now private; the public surface is
 * `buildPlan` + the `PlaybackPlan` type.
 *
 * The Renderer (`transcode/render.ts`) consumes a PlaybackPlan + a
 * RenderContext and emits ffmpeg args. The plan never knows about file
 * paths, session dirs, or segment numbers — those are runtime context.
 *
 * See CONTEXT.md → PlaybackPlan / TranscodePolicy.
 */
import type { ProbeResult } from '../../library/index.ts'
import type { HwAccel } from './hwaccel.ts'
import type { ToneMapConfig } from './tonemap.ts'
import {
  PROFILES,
  type Profile,
} from './profiles.ts'

export type PlaybackMethod = 'direct-play' | 'direct-stream' | 'partial-transcode' | 'transcode'

export interface ClientCapabilities {
  videoCodecs: string[]
  audioCodecs: string[]
  hdr: string[]
  maxBitrate: number
  container: string[]
}

export interface Rendition {
  profile: Profile
  /** Codec string for the HLS master playlist EXT-X-STREAM-INF (e.g. `avc1.640028`).
   *  Pinned to H.264 High@4.0 today — see render.ts for the rationale. */
  videoCodec: string
}

export interface PlaybackPlan {
  method: PlaybackMethod
  needsToneMap: boolean
  /** Tone-map configuration stamped at plan creation so config changes don't
   *  affect an in-flight encode mid-restart. */
  toneMap: ToneMapConfig
  /** Empty for direct-play. One entry for direct-stream / partial-transcode.
   *  Multi-rendition ABR ladder for full transcode (capped to 1 when
   *  tonemapping). */
  renditions: Rendition[]
  /** Which audio track from the source to use. */
  audioTrackIndex: number
  audioStrategy: 'copy' | 'aac'
  videoStrategy: 'copy' | 'transcode'
}

export interface PlanInput {
  probe: ProbeResult
  capabilities: ClientCapabilities
  hwAccel: HwAccel
  audioTrackIndex: number
  maxRenditions: number
  toneMap: ToneMapConfig
}

/** Build the PlaybackPlan from inputs. Pure function — same inputs always
 *  yield the same plan. Drives every spawn for this session until the user
 *  overrides profile or audio track. */
export function buildPlan(input: PlanInput): PlaybackPlan {
  const { probe, capabilities: caps, audioTrackIndex, maxRenditions, toneMap } = input

  const decision = decidePlayback(probe, caps)

  // Direct-play emits no ffmpeg — renditions are irrelevant.
  if (decision.method === 'direct-play') {
    return {
      method: 'direct-play',
      needsToneMap: false,
      toneMap,
      renditions: [],
      audioTrackIndex,
      audioStrategy: 'copy',
      videoStrategy: 'copy',
    }
  }

  const [srcW] = (probe.resolution ?? '1920x1080').split('x').map(s => parseInt(s, 10))
  let topProfile = selectInitialProfile(caps.maxBitrate, srcW)
  if (decision.needsToneMap && topProfile.width > 1280) {
    // Cap tonemap path to 720p — see selectInitialProfile docstring.
    topProfile = TONEMAP_CAP_720P
  }

  const ladder = decision.method === 'transcode' && !decision.needsToneMap
    ? selectRenditionLadder(topProfile, maxRenditions, srcW)
    : [topProfile]

  const renditions: Rendition[] = ladder.map(profile => ({
    profile,
    // Pinned: hevc_videotoolbox can't carry per-stream -sc_threshold / -bufsize
    // in var_stream_map mode, breaking fMP4 on macOS. H.264 High@4.0 is
    // universal and avc1.640028 matches that on the wire.
    videoCodec: 'avc1.640028',
  }))

  return {
    method: decision.method,
    needsToneMap: decision.needsToneMap,
    toneMap,
    renditions,
    audioTrackIndex,
    audioStrategy: decision.method === 'direct-stream' ? 'copy' : 'aac',
    videoStrategy: decision.method === 'transcode' ? 'transcode' : 'copy',
  }
}

/** Rebuild a plan for a profile override. Caller picked `profile` (e.g. user
 *  hit "force 720p"); we keep everything else the same but produce a single-
 *  rendition ladder at that profile. Tonemap path is preserved. */
export function planWithProfile(prev: PlaybackPlan, profile: Profile): PlaybackPlan {
  return {
    ...prev,
    renditions: [{ profile, videoCodec: 'avc1.640028' }],
  }
}

/** Rebuild a plan for an audio-track change. Source index → new -map target. */
export function planWithAudioTrack(prev: PlaybackPlan, audioTrackIndex: number): PlaybackPlan {
  return { ...prev, audioTrackIndex }
}

// ============================================================================
// Decision (folded from decision.ts)
// ============================================================================

interface InternalDecision {
  method: PlaybackMethod
  needsToneMap: boolean
}

const CONTAINER_MAP: Record<string, string[]> = {
  'matroska,webm': ['matroska', 'webm', 'mkv'],
  'mov,mp4,m4a,3gp,3g2,mj2': ['mp4', 'mov', 'm4a'],
}

function containerSupported(ffContainer: string, clientContainers: string[]): boolean {
  const aliases = CONTAINER_MAP[ffContainer] ?? [ffContainer]
  return aliases.some(a => clientContainers.includes(a))
}

function hdrSupported(hdr: ProbeResult['hdr'], clientHdr: string[]): boolean {
  if (hdr.dv && !clientHdr.includes('dv')) return false
  if ((hdr.hdr10 || hdr.hdr10plus) && !clientHdr.includes('hdr10') && !clientHdr.includes('dv')) return false
  return true
}

function decidePlayback(probe: ProbeResult, caps: ClientCapabilities): InternalDecision {
  const sourceBitrateKbps = Math.round(probe.videoBitrate / 1000)
  const bitrateOk = caps.maxBitrate === 0 || sourceBitrateKbps <= caps.maxBitrate

  const videoCodecOk = caps.videoCodecs.includes(probe.videoCodec)
  const hdrOk = hdrSupported(probe.hdr, caps.hdr)
  const containerOk = containerSupported(probe.container, caps.container)
  const defaultAudio = probe.audioTracks.find(t => t.default) ?? probe.audioTracks[0]
  const audioOk = defaultAudio ? caps.audioCodecs.includes(defaultAudio.codec) : true

  const needsToneMap = (probe.hdr.dv || probe.hdr.hdr10 || probe.hdr.hdr10plus) && !hdrOk

  if (videoCodecOk && hdrOk && audioOk && containerOk && bitrateOk) {
    return { method: 'direct-play', needsToneMap: false }
  }
  if (videoCodecOk && hdrOk && audioOk && !containerOk && bitrateOk) {
    return { method: 'direct-stream', needsToneMap: false }
  }
  if (videoCodecOk && hdrOk && !audioOk && bitrateOk) {
    return { method: 'partial-transcode', needsToneMap: false }
  }
  return { method: 'transcode', needsToneMap }
}

// ============================================================================
// Profile selection (folded from profiles.ts; PROFILES const stays as data)
// ============================================================================

const TONEMAP_CAP_720P: Profile = {
  name: '720p', videoBitrate: 4000, audioBitrate: 160, width: 1280, height: 720,
}

/** Highest-quality profile within (a) client's bitrate ceiling and (b) source
 *  resolution. maxBitrate=0 means "unlimited" (e.g. native client on local LAN). */
function selectInitialProfile(maxBitrate: number, sourceWidth: number): Profile {
  const ceiling = maxBitrate === 0 ? Infinity : maxBitrate
  const eligible = PROFILES.filter(p => p.videoBitrate <= ceiling && p.width <= sourceWidth)
  return eligible[0] ?? PROFILES[PROFILES.length - 1]
}

/** Pick up to N profiles starting at `topProfile`, descending the PROFILES
 *  ladder. Used for full-transcode ABR. Tonemap path caps to 1 upstream. */
function selectRenditionLadder(
  topProfile: Profile, maxRenditions: number, sourceWidth: number,
): Profile[] {
  const topIdx = Math.max(0, PROFILES.indexOf(topProfile))
  const ladder = PROFILES
    .slice(topIdx, topIdx + maxRenditions)
    .filter(p => p.width <= sourceWidth)
  return ladder.length > 0 ? ladder : [PROFILES[PROFILES.length - 1]]
}
