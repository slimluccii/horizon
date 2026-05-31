// app/src/components/VideoPlayer.tsx
import { useEffect, useRef, type RefObject } from 'react'
import Hls from 'hls.js'
import type { PlaybackSession, QualityProfile, SubtitleTrack } from '@horizon/sdk'

interface Props {
  session: PlaybackSession
  /** Bumped by parent to force HLS source reload after server restarts ffmpeg
   *  (audio-track switch, quality override). New init.mp4 → MSE rejects old buffer
   *  → must tear down hls.js and re-attach. */
  reloadKey?: number
  /** Resume position (seconds) for hls.js after a reloadKey bump. Parent captures
   *  the player's currentTime before triggering the restart so the client picks
   *  up playback where it left off instead of seeking to zero. Applied exactly
   *  once per reloadKey bump; does not re-apply on subsequent renders. */
  resumeAtSec?: number
  /** Selected subtitle track from media.subtitleTracks; null = off. */
  subtitle: SubtitleTrack | null
  /** Ref forwarded to the underlying <video> so the parent can read currentTime. */
  videoRef?: RefObject<HTMLVideoElement>
  onBufferUpdate?: (seconds: number) => void
  onQualityChange?: (profile: QualityProfile, reason: string) => void
}

export default function VideoPlayer({
  session, reloadKey = 0, resumeAtSec = 0, subtitle, videoRef: externalRef, onBufferUpdate,
}: Props) {
  const internalRef = useRef<HTMLVideoElement>(null)
  const videoRef = externalRef ?? internalRef
  const hlsRef = useRef<Hls | null>(null)
  // Track which reloadKey has had its resumeAtSec applied. Prevents re-applying
  // a stale position if the init effect ever re-runs for the same reloadKey.
  const appliedReloadKeyRef = useRef<number>(-1)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (session.method === 'direct-play') {
      video.src = session.streamUrl
      return
    }

    if (!Hls.isSupported()) {
      video.src = session.streamUrl
      return
    }

    // Apply resumeAtSec exactly once per reloadKey bump. If this effect re-runs
    // for a reloadKey we've already handled, fall back to -1 so we never re-seek
    // to a stale position the user has since moved past.
    const isFreshReload = reloadKey !== appliedReloadKeyRef.current
    const startPosition = isFreshReload && resumeAtSec > 0 ? resumeAtSec : -1
    appliedReloadKeyRef.current = reloadKey

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      // On reload (quality/audio switch) resume at the position captured before
      // restart so MSE begins fetching the segment the user was watching.
      startPosition,
    })
    hlsRef.current = hls

    // Cold-start instrumentation: log the moment the browser actually paints
    // a frame, which is the only timing the user sees. `playing` fires once
    // decoding is underway; `loadedmetadata` is earlier but pre-decode.
    const t0 = performance.now()
    const onPlaying = () => {
      console.log(`[cold-start] first frame playing +${Math.round(performance.now() - t0)}ms from hls attach`)
      video.removeEventListener('playing', onPlaying)
    }
    video.addEventListener('playing', onPlaying)

    hls.loadSource(session.streamUrl)
    hls.attachMedia(video)

    hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      const bytes = data.frag.stats.total
      const durationMs = data.frag.stats.loading.end - data.frag.stats.loading.start
      const bufferSeconds = hls.mainForwardBufferInfo?.len ?? 0
      session.reportSegment(bytes, durationMs, bufferSeconds)
      onBufferUpdate?.(bufferSeconds)
    })

    // Diagnostic: log any hls.js errors (fatal or not). Without this, buffer
    // append errors silently stall playback with readyState=0.
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      console.warn('[hls error]', data.type, data.details, data.fatal ? '(fatal)' : '', data.error?.message ?? '')
    })

    video.play().catch(() => {})

    return () => {
      hls.destroy()
      hlsRef.current = null
    }
    // reloadKey is intentional: bumping it tears down + recreates hls.js so the
    // new ffmpeg run's init.mp4 is fetched fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reloadKey])

  // Progress reporter — sends reportProgress every 5s while playing, on pause,
  // on seeked, and on beforeunload so the server persists the watch position.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const send = () => {
      if (video.paused) return
      if (!video.duration || !isFinite(video.duration)) return
      session.reportProgress(Math.floor(video.currentTime * 1000), Math.floor(video.duration * 1000))
    }
    const interval = setInterval(send, 5000)
    const onPause = () => {
      if (!video.duration || !isFinite(video.duration)) return
      session.reportProgress(Math.floor(video.currentTime * 1000), Math.floor(video.duration * 1000))
    }
    const onSeeked = () => {
      if (!video.duration || !isFinite(video.duration)) return
      session.reportProgress(Math.floor(video.currentTime * 1000), Math.floor(video.duration * 1000))
    }
    const onBeforeUnload = () => {
      if (!video.duration || !isFinite(video.duration)) return
      session.reportProgress(Math.floor(video.currentTime * 1000), Math.floor(video.duration * 1000))
    }
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      clearInterval(interval)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [session])

  // keyboard controls
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handler = (e: KeyboardEvent) => {
      // Ignore when focus is in a form input — selectors etc.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.tagName === 'SELECT')) return
      switch (e.code) {
        case 'Space': e.preventDefault(); video.paused ? video.play() : video.pause(); break
        case 'ArrowLeft': video.currentTime -= 10; break
        case 'ArrowRight': video.currentTime += 10; break
        case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.1); break
        case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.1); break
        case 'KeyF': document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen(); break
        case 'KeyM': video.muted = !video.muted; break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Toggle native subtitle text-track visibility based on `subtitle` prop.
  // The <track> element is rendered declaratively below; here we just flip mode.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i]
      tt.mode = subtitle && tt.id === `sub-${subtitle.index}` ? 'showing' : 'disabled'
    }
  }, [subtitle, reloadKey])

  return (
    <video
      ref={videoRef}
      controls
      crossOrigin="anonymous"
      style={{ width: '100%', height: '100%', background: '#000' }}
      playsInline
    >
      {subtitle && (
        <track
          key={`${subtitle.index}-${reloadKey}`}
          id={`sub-${subtitle.index}`}
          kind="subtitles"
          src={session.subtitleUrl(subtitle.index)}
          srcLang={subtitle.language || 'und'}
          label={subtitle.language ? subtitle.language.toUpperCase() : 'Subtitle'}
          default
        />
      )}
    </video>
  )
}
