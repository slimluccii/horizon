import type { Session } from '../session/types.ts'
import type { SessionManager } from '../session/manager.ts'
import type { Config } from '../config.ts'
import type { HwAccel } from '../transcode/hwaccel.ts'
import type { Profile } from '../transcode/profiles.ts'
import { PROFILES } from '../transcode/profiles.ts'
import {
  killFfmpeg, spawnFfmpeg, pauseFfmpeg, resumeFfmpeg, restartAtSegment, SEGMENT_DURATION_SEC,
} from '../transcode/ffmpeg.ts'
import { rm } from 'node:fs/promises'
import path from 'node:path'

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

function send(session: Session, msg: object) {
  session.wsSocket?.send(JSON.stringify(msg))
}

/**
 * Serialize ffmpeg restart paths. The kill → rm → spawn sequence is not safe
 * to run concurrently: SIGTERM is delivered synchronously but the process may
 * live up to 2s, and a second spawn would race it on shared r{N}/ paths.
 * Callers drop the request if another restart is in flight (client will retry).
 */
async function withRestartLock(session: Session, fn: () => Promise<void>): Promise<boolean> {
  if (session.ffmpegRestartInFlight) return false
  session.ffmpegRestartInFlight = true
  try {
    await fn()
    return true
  } finally {
    session.ffmpegRestartInFlight = false
  }
}

async function restartFfmpegAtPosition(
  session: Session,
  hwAccel: HwAccel,
  newProfile: Profile,
): Promise<boolean> {
  return withRestartLock(session, async () => {
    session.profiles = [newProfile]
    // Resume at the current run's start segment — we don't track exact playback
    // position, but restarting from where this run began means the client's
    // already-buffered segments through that point are still valid.
    await restartAtSegment(session, hwAccel, session.profiles, session.currentStartSegment)
    send(session, {
      type: 'quality-changed',
      profile: newProfile,
      reason: 'abr-restart',
    })
  })
}

// WeakMap: auto-GC'd when session object is released from manager
const sessionAbrState = new WeakMap<Session, AbrState>()

export function handleWsMessage(
  msg: any,
  session: Session,
  sessions: SessionManager,
  cfg: Config,
  hwAccel: HwAccel,
) {
  switch (msg.type) {
    case 'hello': {
      // reconnect: verify token
      if (msg.reconnectToken && msg.reconnectToken !== session.reconnectToken) {
        session.wsSocket?.close(4401, 'invalid-reconnect-token')
        return
      }
      clearTimeout(session.graceTimer)
      session.state = 'active'
      // re-send session-ready
      send(session, {
        type: 'session-ready',
        method: session.method,
        streamUrl: session.method === 'direct-play'
          ? `/sessions/${session.id}/direct`
          : `/sessions/${session.id}/stream.m3u8`,
        profile: session.profiles[0],
        reconnectToken: session.reconnectToken,
      })
      break
    }

    case 'bandwidth-report': {
      // Server-driven ABR is currently disabled. Each ABR-triggered restart
      // rewrites init.mp4 with a new codec config; MSE has already cached the
      // first init's bytes and rejects the new segments with VTDecompression
      // errors. Re-enable when we either:
      //   • generate a stable init shared across qualities, or
      //   • run multi-rendition encodes so the client can switch via HLS.
      // The reports themselves are still useful as telemetry for the future
      // implementation; we just don't act on them.
      void msg
      break
    }

    case 'seek': {
      // Note: with the static VOD playlist the client (hls.js) seeks
      // autonomously via HTTP segment requests; the segment route handles
      // ffmpeg restart. This WS path remains as an explicit hint for clients
      // that want to pre-warm the encoder before issuing segment requests.
      const posMs = typeof msg.positionMs === 'number' ? msg.positionMs : 0
      session.seekPositionMs = posMs
      if (session.method === 'direct-play') break // client seeks natively
      const segNum = msToSegment(posMs)
      withRestartLock(session, async () => {
        killFfmpeg(session)
        await Promise.all(session.profiles.map((_, r) =>
          rm(path.join(session.sessionDir, `r${r}`), { recursive: true, force: true })
        ))
        session.currentStartSegment = segNum
        await spawnFfmpeg(session, hwAccel, session.profiles, session.selectedAudioTrack)
        send(session, { type: 'seek-ready', positionMs: posMs })
      }).then(started => {
        if (!started) send(session, { type: 'error', code: 'restart-busy', message: 'seek rejected: restart in progress' })
      }).catch(err => {
        console.error(`Session ${session.id}: seek failed`, err)
        send(session, { type: 'error', code: 'seek-failed', message: String(err) })
      })
      break
    }

    case 'quality-override': {
      if (session.method !== 'transcode') break
      if (msg.bitrate === 0) {
        // resume ABR: remove state so next report recomputes
        sessionAbrState.delete(session)
        break
      }
      const profile = PROFILES.find(p => p.videoBitrate <= msg.bitrate)
      if (!profile) break
      const idx = PROFILES.indexOf(profile)
      const abrState = sessionAbrState.get(session)
      if (abrState) abrState.currentProfileIndex = idx
      restartFfmpegAtPosition(session, hwAccel, profile).catch(console.error)
      send(session, { type: 'quality-changed', profile, reason: 'user-override' })
      break
    }

    case 'audio-track': {
      if (typeof msg.index !== 'number') break
      session.selectedAudioTrack = msg.index
      if (session.method === 'direct-play') {
        send(session, { type: 'track-changed', audioTrackIndex: msg.index })
        break
      }
      withRestartLock(session, async () => {
        killFfmpeg(session)
        await Promise.all(session.profiles.map((_, r) =>
          rm(path.join(session.sessionDir, `r${r}`), { recursive: true, force: true })
        ))
        // Resume from current playback position (best estimate = last seek offset).
        session.currentStartSegment = msToSegment(session.seekPositionMs)
        await spawnFfmpeg(session, hwAccel, session.profiles, session.selectedAudioTrack)
        send(session, { type: 'track-changed', audioTrackIndex: msg.index })
      }).then(started => {
        if (!started) send(session, { type: 'error', code: 'restart-busy', message: 'audio-track rejected: restart in progress' })
      }).catch(err => {
        console.error(`Session ${session.id}: audio-track failed`, err)
        send(session, { type: 'error', code: 'audio-track-failed', message: String(err) })
      })
      break
    }

    case 'subtitle-track': {
      session.selectedSubtitleTrack = typeof msg.index === 'number' ? msg.index : null
      send(session, { type: 'track-changed', subtitleTrackIndex: session.selectedSubtitleTrack })
      break
    }

    case 'park': {
      session.state = 'parked'
      pauseFfmpeg(session)
      break
    }

    case 'resume': {
      session.state = 'active'
      resumeFfmpeg(session)
      break
    }
  }
}
