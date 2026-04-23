import type { Session } from '../session/types.ts'
import type { SessionManager } from '../session/manager.ts'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Profile } from '../transcode/profiles.ts'
import { PROFILES } from '../transcode/profiles.ts'
import { pauseFfmpeg, resumeFfmpeg, SEGMENT_DURATION_SEC } from '../transcode/ffmpeg.ts'
import { restartAtSegment, restartWithReset, withRestartLock } from '../transcode/restart.ts'
import { parseWsMessage, type WsMessage } from './messages.ts'

/** Convert a time in ms to the matching segment index (floor — start of seg). */
function msToSegment(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000 / SEGMENT_DURATION_SEC))
}

export interface AbrState {
  currentProfileIndex: number  // index into PROFILES global array
  lastChangeAt: number
  cooldownMs: number
  profiles: Profile[]          // must equal PROFILES for consistent indexing
}

export type AbrAction = 'up' | 'down' | 'emergency-down' | 'none'

interface BandwidthReport {
  kbps: number
  bufferSeconds: number
}

export function computeAbrAction(report: BandwidthReport, state: AbrState, now: number): AbrAction {
  const { kbps, bufferSeconds } = report
  const { currentProfileIndex, lastChangeAt, cooldownMs, profiles } = state
  const current = profiles[currentProfileIndex]
  const inCooldown = now - lastChangeAt < cooldownMs

  // Cooldown applies to ALL actions, including emergency-down. Without this, a
  // freshly-spawned ffmpeg run sees buffer=0 and immediately triggers another
  // restart, racing the still-warming first run and dropping segment writes.
  if (inCooldown) return 'none'
  if (bufferSeconds < 4) return 'emergency-down'
  if (bufferSeconds < 8) return 'down'
  if (kbps < current.videoBitrate * 1.2) return 'down'
  const nextUp = profiles[currentProfileIndex - 1]
  if (nextUp && kbps > nextUp.videoBitrate * 1.5 && bufferSeconds > 15) return 'up'
  return 'none'
}

function send(session: Session, msg: object): void {
  session.wsSocket?.send(JSON.stringify(msg))
}

function sendError(session: Session, code: string, message: string): void {
  send(session, { type: 'error', code, message })
}

/**
 * Restart ffmpeg with a new profile, resuming at `segNum` so the client
 * doesn't jump back to the beginning on a quality switch.
 */
async function restartWithProfile(
  session: Session,
  hwAccel: HwAccel,
  newProfile: Profile,
  segNum: number,
): Promise<boolean> {
  return withRestartLock(session, async () => {
    session.profiles = [newProfile]
    await restartAtSegment(session, hwAccel, session.profiles, segNum)
    send(session, { type: 'quality-changed', profile: newProfile, reason: 'user-override' })
  })
}

// WeakMap: auto-GC'd when session object is released from manager.
const sessionAbrState = new WeakMap<Session, AbrState>()

type Handler = (msg: WsMessage, ctx: Ctx) => void | Promise<void>

interface Ctx {
  session: Session
  sessions: SessionManager
  cfg: Config
  hwAccel: HwAccel
}

const handlers: { [K in WsMessage['type']]: Handler } = {
  hello(msg, { session }) {
    if (msg.type !== 'hello') return
    if (msg.reconnectToken && msg.reconnectToken !== session.reconnectToken) {
      session.wsSocket?.close(4401, 'invalid-reconnect-token')
      return
    }
    clearTimeout(session.graceTimer)
    session.state = 'active'
    send(session, {
      type: 'session-ready',
      method: session.method,
      streamUrl: session.method === 'direct-play'
        ? `/sessions/${session.id}/direct`
        : `/sessions/${session.id}/stream.m3u8`,
      profile: session.profiles[0],
      reconnectToken: session.reconnectToken,
    })
  },

  'bandwidth-report'() {
    // Server-driven ABR is currently disabled. Each ABR-triggered restart
    // rewrites init.mp4 with a new codec config; MSE has already cached the
    // first init's bytes and rejects new segments with VTDecompression errors.
    // Re-enable when we either:
    //   • generate a stable init shared across qualities, or
    //   • run multi-rendition encodes so the client can switch via HLS.
    // The reports themselves are still useful as telemetry for the future
    // implementation; we just don't act on them.
  },

  seek(msg, { session, hwAccel }) {
    if (msg.type !== 'seek') return
    // With the static VOD playlist the client (hls.js) seeks autonomously via
    // HTTP segment requests; the segment route handles ffmpeg restart. This WS
    // path remains as an explicit hint for clients that want to pre-warm the
    // encoder before issuing segment requests.
    session.seekPositionMs = msg.positionMs
    if (session.method === 'direct-play') return
    const segNum = msToSegment(msg.positionMs)
    void withRestartLock(session, async () => {
      await restartWithReset(session, hwAccel, session.profiles, session.selectedAudioTrack, segNum)
      send(session, { type: 'seek-ready', positionMs: msg.positionMs })
    }).then(started => {
      if (!started) sendError(session, 'restart-busy', 'seek rejected: restart in progress')
    }).catch(err => {
      console.error(`Session ${session.id}: seek failed`, err)
      sendError(session, 'seek-failed', String(err))
    })
  },

  'quality-override'(msg, { session, hwAccel }) {
    if (msg.type !== 'quality-override') return
    if (session.method !== 'transcode') return
    if (msg.bitrate === 0) {
      sessionAbrState.delete(session)
      return
    }
    const profile = PROFILES.find(p => p.videoBitrate <= msg.bitrate)
    if (!profile) return
    const idx = PROFILES.indexOf(profile)
    const abrState = sessionAbrState.get(session)
    if (abrState) abrState.currentProfileIndex = idx
    // Resume at the caller-provided playback position; fall back to the current
    // run's start segment if the client didn't report one.
    const segNum = msg.positionMs !== undefined
      ? msToSegment(msg.positionMs)
      : session.currentStartSegment
    restartWithProfile(session, hwAccel, profile, segNum).then(started => {
      if (!started) sendError(session, 'restart-busy', 'quality-override rejected: restart in progress')
    }).catch(err => {
      console.error(`Session ${session.id}: quality-override failed`, err)
      sendError(session, 'quality-failed', String(err))
    })
  },

  'audio-track'(msg, { session, hwAccel }) {
    if (msg.type !== 'audio-track') return
    session.selectedAudioTrack = msg.index
    if (session.method === 'direct-play') {
      send(session, { type: 'track-changed', audioTrackIndex: msg.index })
      return
    }
    // Prefer client-reported playback position; fall back to last seek offset.
    const segNum = msg.positionMs !== undefined
      ? msToSegment(msg.positionMs)
      : msToSegment(session.seekPositionMs)
    void withRestartLock(session, async () => {
      await restartWithReset(session, hwAccel, session.profiles, msg.index, segNum)
      send(session, { type: 'track-changed', audioTrackIndex: msg.index })
    }).then(started => {
      if (!started) sendError(session, 'restart-busy', 'audio-track rejected: restart in progress')
    }).catch(err => {
      console.error(`Session ${session.id}: audio-track failed`, err)
      sendError(session, 'audio-track-failed', String(err))
    })
  },

  'subtitle-track'(msg, { session }) {
    if (msg.type !== 'subtitle-track') return
    session.selectedSubtitleTrack = msg.index
    send(session, { type: 'track-changed', subtitleTrackIndex: msg.index })
  },

  park(_msg, { session }) {
    session.state = 'parked'
    pauseFfmpeg(session)
  },

  resume(_msg, { session }) {
    session.state = 'active'
    resumeFfmpeg(session)
  },

  progress(msg, { session }) {
    if (msg.type !== 'progress') return
    session._flusher?.record(msg.positionMs, msg.durationMs)
  },
}

export function handleWsMessage(
  raw: unknown,
  session: Session,
  sessions: SessionManager,
  cfg: Config,
  hwAccel: HwAccel,
): void {
  const msg = parseWsMessage(raw)
  if (!msg) return // unknown / malformed → silently drop (telemetry could log here)
  const handler = handlers[msg.type]
  void handler(msg, { session, sessions, cfg, hwAccel })
}
