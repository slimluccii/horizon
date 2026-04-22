// sdk/src/session.ts
import type {
  ClientCapabilities, PlaybackMethod, QualityProfile,
  HorizonError, HorizonWarning, SessionInfo,
} from './types.ts'
import { BandwidthSampler } from './bandwidth.ts'

export type SessionState = 'attaching' | 'active' | 'detached' | 'destroyed'

export interface PlaybackSessionOptions {
  sessionInfo: SessionInfo
  baseUrl: string
  capabilities: ClientCapabilities
  onReady?: (info: SessionInfo) => void
  onQualityChange?: (profile: QualityProfile, reason: string) => void
  onTrackChange?: (info: { audio?: number; subtitle?: number | null }) => void
  onWarning?: (w: HorizonWarning) => void
  onEnded?: () => void
  onError?: (err: HorizonError) => void
}

const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_BASE_MS = 1000

export class PlaybackSession {
  readonly sessionId: string
  readonly method: PlaybackMethod
  readonly streamUrl: string
  readonly wsUrl: string

  private _profile: QualityProfile
  private _state: SessionState = 'attaching'
  private _ws: WebSocket | null = null
  private _reconnectToken: string | null = null
  private _reconnectAttempts = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _sampler = new BandwidthSampler()
  private _opts: PlaybackSessionOptions
  private _destroyed = false

  constructor(opts: PlaybackSessionOptions) {
    this._opts = opts
    this.sessionId = opts.sessionInfo.sessionId
    this.method = opts.sessionInfo.method
    this.streamUrl = `${opts.baseUrl}${opts.sessionInfo.streamUrl}`
    this.wsUrl = `${opts.baseUrl.replace(/^http/, 'ws')}${opts.sessionInfo.wsUrl}`
    this._profile = opts.sessionInfo.profiles?.[0] as QualityProfile
    this._connect()
    this._registerUnloadCleanup()
  }

  get state(): SessionState { return this._state }
  get profile(): QualityProfile { return this._profile }

  private _connect() {
    if (this._destroyed) return
    this._ws = new WebSocket(this.wsUrl)

    this._ws.onopen = () => {
      this._reconnectAttempts = 0
      if (this._reconnectToken) {
        this._send({ type: 'hello', reconnectToken: this._reconnectToken })
      }
    }

    this._ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        this._handleMessage(msg)
      } catch { /* ignore */ }
    }

    this._ws.onclose = () => {
      if (this._destroyed) return
      this._state = 'detached'
      this._scheduleReconnect()
    }

    this._ws.onerror = () => {
      // close event will fire next; handled there
    }
  }

  private _scheduleReconnect() {
    if (this._destroyed || this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._opts.onError?.({
        code: 'session-destroyed',
        message: 'WebSocket reconnect failed — session expired',
        fatal: true,
      })
      this._state = 'destroyed'
      return
    }
    const delay = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts)
    this._reconnectAttempts++
    this._reconnectTimer = setTimeout(() => this._connect(), delay)
  }

  private _handleMessage(msg: any) {
    switch (msg.type) {
      case 'session-ready':
        this._reconnectToken = msg.reconnectToken ?? null
        this._profile = msg.profile
        this._state = 'active'
        this._opts.onReady?.(this._opts.sessionInfo)
        break
      case 'quality-changed':
        this._profile = msg.profile
        this._opts.onQualityChange?.(msg.profile, msg.reason)
        break
      case 'track-changed':
        this._opts.onTrackChange?.({ audio: msg.audioTrackIndex, subtitle: msg.subtitleTrackIndex })
        break
      case 'warning':
        this._opts.onWarning?.({ code: msg.code, message: msg.message })
        break
      case 'error':
        this._opts.onError?.({ code: msg.code, message: msg.message, fatal: msg.fatal ?? true })
        if (msg.fatal) { this._state = 'destroyed'; this._destroyed = true }
        break
      case 'ended':
        this._opts.onEnded?.()
        break
      case 'seek-ready':
        // client may reload HLS source here
        break
    }
  }

  private _send(msg: object) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  /** Call with hls.js fragment-loaded stats */
  reportSegment(bytes: number, durationMs: number, bufferSeconds: number) {
    this._sampler.record(bytes, durationMs)
    this._send({
      type: 'bandwidth-report',
      kbps: this._sampler.estimate(),
      bufferSeconds,
      segmentDownloadMs: durationMs,
    })
  }

  seek(positionMs: number) {
    this._send({ type: 'seek', positionMs })
  }

  setQuality(bitrateKbps: number | 'auto') {
    this._send({ type: 'quality-override', bitrate: bitrateKbps === 'auto' ? 0 : bitrateKbps })
  }

  setAudioTrack(index: number) {
    this._send({ type: 'audio-track', index })
  }

  setSubtitleTrack(index: number | null) {
    this._send({ type: 'subtitle-track', index })
  }

  park() { this._send({ type: 'park' }) }
  resume() { this._send({ type: 'resume' }) }

  disconnect() {
    this._destroyed = true
    this._state = 'destroyed'
    clearTimeout(this._reconnectTimer ?? undefined)
    this._ws?.close()
    // fire and forget DELETE
    fetch(`${this._opts.baseUrl}/sessions/${this.sessionId}`, { method: 'DELETE' }).catch(() => {})
  }

  private _registerUnloadCleanup() {
    if (typeof window === 'undefined') return
    const handler = () => this.disconnect()
    window.addEventListener('beforeunload', handler)
    window.addEventListener('pagehide', handler)
  }
}
