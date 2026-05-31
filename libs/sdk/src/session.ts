// sdk/src/session.ts
import type {
  ClientCapabilities, PlaybackMethod, QualityProfile,
  HorizonError, HorizonWarning, SessionInfo,
} from './types.ts'
import { BandwidthSampler } from './bandwidth.ts'
import { parseServerMessage } from './ws-messages.ts'

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
  private _unloadHandler: (() => void) | null = null

  constructor(opts: PlaybackSessionOptions) {
    this._opts = opts
    this.sessionId = opts.sessionInfo.sessionId
    this.method = opts.sessionInfo.method
    this.streamUrl = `${opts.baseUrl}${opts.sessionInfo.streamUrl}`
    // When baseUrl is empty (same-origin via Vite proxy), derive the WS origin
    // from window.location — WebSocket constructor rejects relative URLs.
    const wsOrigin = opts.baseUrl
      ? opts.baseUrl.replace(/^http/, 'ws')
      : (typeof window !== 'undefined'
        ? `${window.location.protocol.replace('http', 'ws')}//${window.location.host}`
        : '')
    this.wsUrl = `${wsOrigin}${opts.sessionInfo.wsUrl}`
    // direct-play sessions arrive with profiles=[] — synthesize a sentinel so
    // _profile is never undefined; consumers should check method first anyway.
    this._profile = opts.sessionInfo.profiles[0] ?? {
      videoBitrate: 0, audioBitrate: 0,
    }
    // Defer WS creation by one microtask so the caller can call disconnect()
    // synchronously (React StrictMode cleanup) before the socket is opened.
    // _connect() checks _destroyed and bails if disconnect() already ran.
    queueMicrotask(() => this._connect())
    this._registerUnloadCleanup()
  }

  get state(): SessionState { return this._state }
  get profile(): QualityProfile { return this._profile }

  /** The session's reconnect token, assigned by the server on `session-ready`.
   *  Doubles as a proof-of-knowledge credential the player must echo back on
   *  every playlist/segment HTTP request via the `X-Reconnect-Token` header
   *  (see apps/server/src/routes/segments.ts). Null until the handshake
   *  completes; consumers should read it only after `onReady` has fired. */
  get reconnectToken(): string | null { return this._reconnectToken }

  private _connect() {
    if (this._destroyed) return
    this._ws = new WebSocket(this.wsUrl)

    this._ws.onopen = () => {
      this._reconnectAttempts = 0
      // Always send hello so the server can complete the handshake from this
      // frame (it replies session-ready). reconnectToken is optional — included
      // only on reconnect; the server guard tolerates its absence.
      this._send({
        type: 'hello',
        ...(this._reconnectToken ? { reconnectToken: this._reconnectToken } : {}),
      })
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

  private _handleMessage(raw: unknown) {
    // Validate against the server-to-client schema before mutating any state or
    // firing callbacks. Invalid / MITM-injected frames fail closed: silently
    // dropped, no state change. (See ws-messages.ts.)
    const msg = parseServerMessage(raw)
    if (!msg) return
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
        this._opts.onError?.({ code: msg.code as HorizonError['code'], message: msg.message, fatal: msg.fatal ?? true })
        if (msg.fatal) {
          // halt any pending reconnect — session is gone server-side
          if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
          this._reconnectTimer = null
          this._state = 'destroyed'
          this._destroyed = true
          this._removeUnloadCleanup()
        }
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

  reportProgress(positionMs: number, durationMs: number): void {
    this._send({ type: 'progress', positionMs, durationMs })
  }

  /** Switch quality, optionally resuming at `positionMs` playback position. */
  setQuality(bitrateKbps: number | 'auto', positionMs?: number) {
    this._send({
      type: 'quality-override',
      bitrate: bitrateKbps === 'auto' ? 0 : bitrateKbps,
      ...(positionMs !== undefined ? { positionMs } : {}),
    })
  }

  /** Switch audio track, optionally resuming at `positionMs` playback position. */
  setAudioTrack(index: number, positionMs?: number) {
    this._send({
      type: 'audio-track',
      index,
      ...(positionMs !== undefined ? { positionMs } : {}),
    })
  }

  setSubtitleTrack(index: number | null) {
    this._send({ type: 'subtitle-track', index })
  }

  /** URL for an extracted text subtitle track (WebVTT). Server lazily extracts
   *  embeddable text subs after ffmpeg starts; URL may 404 briefly while the
   *  extraction process is still running. */
  subtitleUrl(index: number): string {
    return `${this._opts.baseUrl}/sessions/${this.sessionId}/subtitles/${index}.vtt`
  }

  park() { this._send({ type: 'park' }) }
  resume() { this._send({ type: 'resume' }) }

  disconnect() {
    if (this._destroyed) return // idempotent — multiple calls are safe
    this._destroyed = true
    this._state = 'destroyed'
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._removeUnloadCleanup()
    this._ws?.close()
    // fire and forget DELETE
    fetch(`${this._opts.baseUrl}/sessions/${this.sessionId}`, { method: 'DELETE' }).catch(() => {})
  }

  private _registerUnloadCleanup() {
    if (typeof window === 'undefined') return
    this._unloadHandler = () => this.disconnect()
    window.addEventListener('beforeunload', this._unloadHandler)
    window.addEventListener('pagehide', this._unloadHandler)
  }

  private _removeUnloadCleanup() {
    if (typeof window === 'undefined' || !this._unloadHandler) return
    window.removeEventListener('beforeunload', this._unloadHandler)
    window.removeEventListener('pagehide', this._unloadHandler)
    this._unloadHandler = null
  }
}
