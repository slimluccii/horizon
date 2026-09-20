import type { Session } from '../../domain/types.ts'
import type { SessionManager } from '../../application/manager.ts'
import type { Config } from '../../../../platform/config/config.ts'
import type { HwAccel } from '../../domain/hwaccel.ts'
import type { Profile } from '../../domain/profiles.ts'
import type { SessionRuntime, TransitionResult } from '../../application/runtime.ts'
import { ErrorCodes } from '@horizon/sdk'
import { PROFILES } from '../../domain/profiles.ts'
import { pauseFfmpeg, resumeFfmpeg } from '../ffmpeg/ffmpeg.ts'
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

// ---------------------------------------------------------------------------
// Bandwidth demote — copy-video sessions (direct-stream / partial-transcode)
// have no rendition ladder, so when the measured bandwidth can't sustain the
// source bitrate the only fix is rebuilding the session's plan as a transcode
// sized to what the link can carry. hls.js handles switching WITHIN a
// transcode ladder on its own; this path only ever fires once per session.
// (direct-play sessions stream through <video src> and send no reports —
// their protection is the client's measured maxBitrate at session create.)
// ---------------------------------------------------------------------------

/** Consecutive under-bandwidth reports required before demoting. Reports ride
 *  segment loads (~every few seconds), so 3 ≈ 10–15 s of sustained shortfall —
 *  enough to skip transient dips without letting the buffer fully drain. */
export const DEMOTE_CONSECUTIVE_REPORTS = 3
/** Only demote when the buffer is actually at risk. A healthy buffer with a
 *  slow link just means the client is pacing its fetches. */
export const DEMOTE_BUFFER_SECONDS = 15
/** Floor for the demote target so pathological estimates still produce a
 *  playable stream (480p profile is 2000 kbps). */
export const MIN_DEMOTE_KBPS = 1500

interface DemoteState { lowCount: number; demoted: boolean }
const sessionDemoteState = new WeakMap<Session, DemoteState>()

/** Pure decision: should this report advance/trigger a demote? Exported for
 *  tests. Returns the updated state and whether to demote now. */
export function computeDemote(
  report: { kbps: number; bufferSeconds: number },
  sourceVideoKbps: number,
  state: DemoteState,
): { state: DemoteState; demote: boolean } {
  if (state.demoted) return { state, demote: false }
  const low = sourceVideoKbps > 0 &&
    report.kbps > 0 &&
    report.kbps < sourceVideoKbps * 1.1 &&
    report.bufferSeconds < DEMOTE_BUFFER_SECONDS
  const lowCount = low ? state.lowCount + 1 : 0
  if (lowCount >= DEMOTE_CONSECUTIVE_REPORTS) {
    return { state: { lowCount: 0, demoted: true }, demote: true }
  }
  return { state: { lowCount, demoted: false }, demote: false }
}

// Tracks whether a socket has completed the `hello` handshake. A freshly
// attached socket is unauthenticated and ONLY the `hello` handler runs; every
// other command (seek, quality-override, park, progress, …) is dropped until
// hello succeeds. This closes the window where an attacker who guessed the
// session id could drive playback or exfiltrate state before the legitimate
// client's hello arrives. Keyed on Session so it is GC'd with the session.
const wsAuthenticated = new WeakMap<Session, boolean>()

/** True once the socket has completed a successful `hello` handshake. */
export function isWsAuthenticated(session: Session): boolean {
  return wsAuthenticated.get(session) === true
}

/** Reset auth state — called by the attach handler when a new socket binds. */
export function resetWsAuth(session: Session): void {
  wsAuthenticated.delete(session)
}

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
      session.wsSocket?.close(4401, ErrorCodes.INVALID_RECONNECT_TOKEN)
      return
    }
    // Handshake accepted — mark the socket authenticated so subsequent
    // commands are processed. (A present-but-wrong token was rejected above;
    // a tokenless hello is the legitimate initial-attach path.)
    wsAuthenticated.set(session, true)
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

  'bandwidth-report'(msg, { session, runtime }) {
    if (msg.type !== 'bandwidth-report') return
    // Within a transcode ladder, hls.js switches renditions client-side — the
    // per-quality server restart approach is dead (each restart rewrites
    // init.mp4 and MSE rejects the new segments). The server acts only on
    // copy-video HLS sessions: sustained bandwidth below the source bitrate
    // demotes the whole session to a transcode sized to the measured link.
    const method = session.plan.method
    if (method !== 'direct-stream' && method !== 'partial-transcode') return
    if (!session.rebuildPlanForBitrate || !runtime) return

    const prev = sessionDemoteState.get(session) ?? { lowCount: 0, demoted: false }
    const { state, demote } = computeDemote(
      { kbps: msg.kbps, bufferSeconds: msg.bufferSeconds },
      session.sourceVideoKbps ?? 0,
      prev,
    )
    sessionDemoteState.set(session, state)
    if (!demote) return

    const targetKbps = Math.max(Math.floor(msg.kbps * 0.8), MIN_DEMOTE_KBPS)
    const newPlan = session.rebuildPlanForBitrate(targetKbps)
    if (newPlan.method !== 'transcode' || newPlan.renditions.length === 0) return

    const posMs = session.lastProgress?.positionMs ?? session.seekPositionMs
    console.log(
      `Session ${session.id}: bandwidth demote — measured ${msg.kbps} kbps < source ` +
      `${session.sourceVideoKbps} kbps, rebuilding as transcode @ ${newPlan.renditions[0].profile.name}`,
    )
    runtime.applyPlanSwap(newPlan, posMs).then(res =>
      handleTransition(session, res, 'bandwidth-demote', () =>
        send(session, {
          type: 'quality-changed',
          profile: newPlan.renditions[0].profile,
          reason: 'bandwidth',
        }),
      ),
    )
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
      sendError(session, ErrorCodes.AUDIO_TRACK_INVALID, 'Audio track index out of range')
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

  'subtitle-track'(msg, { session, runtime }) {
    if (msg.type !== 'subtitle-track') return
    if (msg.index != null && (msg.index < 0 || msg.index >= session.subtitleTrackCount)) {
      sendError(session, ErrorCodes.INVALID_INPUT, 'Subtitle track index out of range')
      return
    }
    session.selectedSubtitleTrack = msg.index

    // Image-based tracks (PGS/VobSub) are burned into the video, so switching
    // to/away from one changes the filter graph and needs an ffmpeg restart.
    // Text/sidecar tracks are client-side VTT swaps — no restart.
    const wantsBurnIn = msg.index != null && (session.imageSubtitleIndexes ?? []).includes(msg.index)
    const hasBurnIn = session.plan.burnInSubtitleIndex != null
    if (session.plan.method === 'transcode' && runtime && (wantsBurnIn || hasBurnIn)) {
      const newBurnIn = wantsBurnIn ? msg.index : null
      runtime.changeBurnInSubtitle(newBurnIn, msg.positionMs).then(res =>
        handleTransition(session, res, 'subtitle-track', () =>
          send(session, { type: 'track-changed', subtitleTrackIndex: msg.index, restarted: true }),
        ),
      )
      return
    }
    if (wantsBurnIn) {
      // Copy-based session: the advertised stream can't grow a burned-in sub
      // mid-flight. The client recreates the session with the subtitle chosen
      // at create (the web player does exactly that); reply as a plain change
      // so an out-of-date client at least keeps a consistent selection.
      console.warn(`Session ${session.id}: image subtitle selected on ${session.plan.method} session — needs session recreate`)
    }
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
  // Until the socket has completed the `hello` handshake it is unauthenticated:
  // only `hello` may run. Every other command is dropped. This prevents an
  // attacker who guessed the session id from driving playback or reading state
  // before the legitimate client authenticates.
  if (msg.type !== 'hello' && !isWsAuthenticated(session)) return
  const handler = handlers[msg.type]
  const runtime = sessions.getRuntime(session.id)
  void handler(msg, { session, sessions, cfg, hwAccel, runtime })
}
