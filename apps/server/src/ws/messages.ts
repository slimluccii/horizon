/**
 * WebSocket message types — wire format between client SDK and server WS handler.
 * The server validates incoming messages against this union; unknown / malformed
 * messages are dropped silently (logged at debug).
 */

export interface HelloMessage {
  type: 'hello'
  reconnectToken?: string
}

export interface BandwidthReportMessage {
  type: 'bandwidth-report'
  kbps: number
  bufferSeconds: number
  segmentDownloadMs?: number
}

export interface SeekMessage {
  type: 'seek'
  positionMs: number
}

export interface QualityOverrideMessage {
  type: 'quality-override'
  /** kbps; 0 = auto / clear override */
  bitrate: number
  /** Playback position in ms to resume at. Omit to keep current run's start. */
  positionMs?: number
}

export interface AudioTrackMessage {
  type: 'audio-track'
  index: number
  /** Playback position in ms to resume at. Omit to keep current seek offset. */
  positionMs?: number
}

export interface SubtitleTrackMessage {
  type: 'subtitle-track'
  /** null = subtitles off */
  index: number | null
}

export interface ParkMessage { type: 'park' }
export interface ResumeMessage { type: 'resume' }

export interface ProgressMessage {
  type: 'progress'
  positionMs: number
  durationMs: number
}

export type WsMessage =
  | HelloMessage
  | BandwidthReportMessage
  | SeekMessage
  | QualityOverrideMessage
  | AudioTrackMessage
  | SubtitleTrackMessage
  | ParkMessage
  | ResumeMessage
  | ProgressMessage

/**
 * Cheap structural validation — JSON.parse already gave us an object; we
 * verify discriminator + the field types each handler will read. Unknown
 * `type` returns null. Returning a typed value lets the dispatch site rely
 * on the union without unsafe casts.
 */
export function parseWsMessage(raw: unknown): WsMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'hello':
      return { type: 'hello', reconnectToken: typeof m.reconnectToken === 'string' ? m.reconnectToken : undefined }
    case 'bandwidth-report':
      if (typeof m.kbps !== 'number' || typeof m.bufferSeconds !== 'number') return null
      return {
        type: 'bandwidth-report',
        kbps: m.kbps,
        bufferSeconds: m.bufferSeconds,
        segmentDownloadMs: typeof m.segmentDownloadMs === 'number' ? m.segmentDownloadMs : undefined,
      }
    case 'seek':
      if (typeof m.positionMs !== 'number' || m.positionMs < 0) return null
      return { type: 'seek', positionMs: m.positionMs }
    case 'quality-override': {
      if (typeof m.bitrate !== 'number' || m.bitrate < 0) return null
      const positionMs = typeof m.positionMs === 'number' && m.positionMs >= 0 ? m.positionMs : undefined
      return { type: 'quality-override', bitrate: m.bitrate, positionMs }
    }
    case 'audio-track': {
      if (typeof m.index !== 'number' || m.index < 0) return null
      const positionMs = typeof m.positionMs === 'number' && m.positionMs >= 0 ? m.positionMs : undefined
      return { type: 'audio-track', index: m.index, positionMs }
    }
    case 'subtitle-track':
      if (m.index !== null && (typeof m.index !== 'number' || m.index < 0)) return null
      return { type: 'subtitle-track', index: m.index as number | null }
    case 'park': return { type: 'park' }
    case 'resume': return { type: 'resume' }
    case 'progress': {
      if (typeof m.positionMs !== 'number' || m.positionMs < 0) return null
      if (typeof m.durationMs !== 'number' || m.durationMs <= 0) return null
      return { type: 'progress', positionMs: m.positionMs, durationMs: m.durationMs }
    }
    default: return null
  }
}
