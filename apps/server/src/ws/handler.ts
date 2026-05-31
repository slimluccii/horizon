import type { Session } from '../session/types.ts'
import type { SessionManager } from '../session/manager.ts'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Profile } from '../transcode/profiles.ts'
import type { SessionRuntime, TransitionResult } from '../session/runtime.ts'
import { PROFILES } from '../transcode/profiles.ts'
import { pauseFfmpeg, resumeFfmpeg } from '../transcode/ffmpeg.ts'
import { parseWsMessage, type WsMessage } from './messages.ts'

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

/** Translate a runtime TransitionResult into a WS reply. On `ok`, fires the
 *  caller-provided success message; on busy/destroyed, fires an error frame. */
function handleTransition(
  session: Session,
  res: TransitionResult,
  opName: string,
  onOk: () => void,
): void {
  if (res.ok) { onOk(); return }
  if (res.reason === 'busy') {
    sendError(session, 'restart-busy', `${opName} rejected: restart in progress`)
    return
  }
  if (res.reason === 'destroyed') {
    sendError(session, `${opName}-failed`, 'session destroyed')
    return
  }
  console.error(`Session ${session.id}: ${opName} failed`, res.error)
  sendError(session, `${opName}-failed`, String(res.error))
}

// WeakMap: auto-GC'd when session object is released from manager.
const sessionAbrState = new WeakMap<Session, AbrState>()

type Handler = (msg: WsMessage, ctx: Ctx) => void | Promise<void>

interface Ctx {
  session: Session
  sessions: SessionManager
  cfg: Config
  hwAccel: HwAccel
  runtime: SessionRuntime | undefined
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
      method: session.plan.method,
      streamUrl: session.plan.method === 'direct-play'
        ? `/sessions/${session.id}/direct`
        : `/sessions/${session.id}/stream.m3u8`,
      profile: session.plan.renditions[0].profile,
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

  seek(msg, { session, runtime }) {
    if (msg.type !== 'seek') return
    // With the static VOD playlist the client (hls.js) seeks autonomously via
    // HTTP segment requests; the segment route handles ffmpeg restart. This WS
    // path remains as an explicit hint for clients that want to pre-warm the
    // encoder before issuing segment requests.
    if (session.plan.method === 'direct-play') {
      session.seekPositionMs = msg.positionMs
      return
    }
    if (!runtime) return
    runtime.seekTo(msg.positionMs).then(res =>
      handleTransition(session, res, 'seek', () =>
        send(session, { type: 'seek-ready', positionMs: msg.positionMs }),
      ),
    )
  },

  'quality-override'(msg, { session, runtime }) {
    if (msg.type !== 'quality-override') return
    if (session.plan.method !== 'transcode') return
    if (msg.bitrate === 0) {
      sessionAbrState.delete(session)
      return
    }
    const profile = PROFILES.find(p => p.videoBitrate <= msg.bitrate)
    if (!profile) return
    const idx = PROFILES.indexOf(profile)
    const abrState = sessionAbrState.get(session)
    if (abrState) abrState.currentProfileIndex = idx
    if (!runtime) return
    runtime.changeProfile(profile, msg.positionMs).then(res =>
      handleTransition(session, res, 'quality-override', () =>
        send(session, { type: 'quality-changed', profile, reason: 'user-override' }),
      ),
    )
  },

  'audio-track'(msg, { session, runtime }) {
    if (msg.type !== 'audio-track') return
    // Bounds-check against the source's audio-track count (stamped at create).
    // An out-of-range index would otherwise reach ffmpeg and crash the run —
    // a trivial mid-session DoS. Reject and leave the session untouched.
    if (msg.index < 0 || msg.index >= session.audioTrackCount) {
      sendError(session, 'audio-track-invalid', 'Audio track index out of range')
      return
    }
    if (session.plan.method === 'direct-play') {
      // Direct-play doesn't restart; just update the plan in-place so the WS
      // notify reflects the new track. (Direct-play actually streams the
      // source as-is; this is best-effort metadata for the client.)
      session.plan = { ...session.plan, audioTrackIndex: msg.index }
      send(session, { type: 'track-changed', audioTrackIndex: msg.index })
      return
    }
    if (!runtime) return
    runtime.changeAudioTrack(msg.index, msg.positionMs).then(res =>
      handleTransition(session, res, 'audio-track', () =>
        send(session, { type: 'track-changed', audioTrackIndex: msg.index }),
      ),
    )
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
  const runtime = sessions.getRuntime(session.id)
  void handler(msg, { session, sessions, cfg, hwAccel, runtime })
}
