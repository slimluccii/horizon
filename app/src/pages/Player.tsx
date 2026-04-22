// app/src/pages/Player.tsx
import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import VideoPlayer from '../components/VideoPlayer.tsx'
import QualityOverlay from '../components/QualityOverlay.tsx'
import type { PlaybackSession, QualityProfile, MediaItem } from '@horizon/sdk'

export default function Player() {
  const { mediaId } = useParams<{ mediaId: string }>()
  const navigate = useNavigate()
  const [session, setSession] = useState<PlaybackSession | null>(null)
  const [media, setMedia] = useState<MediaItem | null>(null)
  const [currentProfile, setCurrentProfile] = useState<QualityProfile | null>(null)
  const [bufferSeconds, setBufferSeconds] = useState(0)
  const [qualityLog, setQualityLog] = useState<{ profile: QualityProfile; reason: string; time: Date }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)   // true only after session-ready fires
  const sessionRef = useRef<PlaybackSession | null>(null)

  useEffect(() => {
    if (!mediaId) return

    // cancelled flag: guards against React StrictMode double-invocation —
    // the first effect run is cleaned up before the second; without this flag
    // both POST /sessions calls survive and two FFmpeg processes start.
    let cancelled = false

    horizon.library.listMovies()
      .then(movies => { if (!cancelled) setMedia(movies.find(m => m.id === mediaId) ?? null) })
      .catch(() => {})

    horizon.play(mediaId, {
      onReady: (info) => {
        if (cancelled) return
        // Only mount VideoPlayer AFTER session-ready: rendition playlists don't
        // exist until FFmpeg has produced ≥3 segments. Mounting hls.js before
        // session-ready causes immediate 404s that put hls.js in error state.
        setCurrentProfile(info.profiles?.[0] ?? null)
        setReady(true)
      },
      onQualityChange: (profile, reason) => {
        if (cancelled) return
        setCurrentProfile(profile)
        setQualityLog(log => [...log, { profile, reason, time: new Date() }])
      },
      onError: (err) => {
        if (cancelled) return
        setError(err.message)
      },
      onEnded: () => { if (!cancelled) navigate('/') },
    }).then(s => {
      if (cancelled) {
        s.disconnect()   // StrictMode cleanup already ran; kill the orphan session
        return
      }
      setSession(s)
      sessionRef.current = s
    }).catch(err => {
      if (cancelled) return
      setError(String(err.message ?? err))
    })

    return () => {
      cancelled = true
      sessionRef.current?.disconnect()
      sessionRef.current = null
      setSession(null)
      setReady(false)
    }
  }, [mediaId])

  if (error) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16 }}>
      <div style={{ color: '#ef4444', fontSize: 18 }}>Playback error</div>
      <div style={{ color: '#888' }}>{error}</div>
      <button onClick={() => navigate('/')} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fff', color: '#000' }}>← Back</button>
    </div>
  )

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }}>
      {/* Back button */}
      <button
        onClick={() => { sessionRef.current?.disconnect(); navigate('/') }}
        style={{
          position: 'absolute', top: 16, left: 16, zIndex: 10,
          background: 'rgba(0,0,0,0.7)', border: '1px solid #444',
          color: '#fff', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
        }}
      >
        ← Library
      </button>

      {/* Loading — shown until session-ready */}
      {!ready && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#888',
          zIndex: 5,
        }}>
          <div style={{ fontSize: 14 }}>Starting playback…</div>
          {media && <div style={{ fontSize: 12 }}>{media.title}</div>}
        </div>
      )}

      {/* Video — only mount after session-ready so hls.js never sees a 404 rendition */}
      {ready && session && (
        <VideoPlayer
          session={session}
          onBufferUpdate={setBufferSeconds}
          onQualityChange={(profile, reason) => {
            setCurrentProfile(profile)
            setQualityLog(log => [...log, { profile, reason, time: new Date() }])
          }}
        />
      )}

      {/* Overlay */}
      {ready && session && currentProfile && (
        <QualityOverlay
          method={session.method}
          profile={currentProfile}
          bufferSeconds={bufferSeconds}
          qualityLog={qualityLog}
        />
      )}
    </div>
  )
}
