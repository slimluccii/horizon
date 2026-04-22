// app/src/components/VideoPlayer.tsx
import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import type { PlaybackSession, QualityProfile } from '@horizon/sdk'

interface Props {
  session: PlaybackSession
  onBufferUpdate?: (seconds: number) => void
  onQualityChange?: (profile: QualityProfile, reason: string) => void
}

export default function VideoPlayer({ session, onBufferUpdate, onQualityChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)

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

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
    })
    hlsRef.current = hls
    hls.loadSource(session.streamUrl)
    hls.attachMedia(video)

    hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      const bytes = data.frag.stats.total
      const durationMs = data.frag.stats.loading.end - data.frag.stats.loading.start
      const bufferSeconds = hls.mainForwardBufferInfo?.len ?? 0
      session.reportSegment(bytes, durationMs, bufferSeconds)
      onBufferUpdate?.(bufferSeconds)
    })

    video.play().catch(() => {})

    return () => {
      hls.destroy()
      hlsRef.current = null
    }
  }, [session])

  // keyboard controls
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'Space': e.preventDefault(); video.paused ? video.play() : video.pause(); break
        case 'ArrowLeft': video.currentTime -= 10; break
        case 'ArrowRight': video.currentTime += 10; break
        case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.1); break
        case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.1); break
        case 'KeyF': document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen(); break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <video
      ref={videoRef}
      controls
      style={{ width: '100%', height: '100%', background: '#000' }}
      playsInline
    />
  )
}
