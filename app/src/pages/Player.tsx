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
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<PlaybackSession | null>(null)

  useEffect(() => {
    if (!mediaId) return

    horizon.library.listMovies()
      .then(movies => setMedia(movies.find(m => m.id === mediaId) ?? null))
      .catch(() => {})

    horizon.play(mediaId, {
      onReady: (info) => {
        setLoading(false)
        setCurrentProfile(info.profiles?.[0] ?? null)
      },
      onQualityChange: (profile, reason) => {
        setCurrentProfile(profile)
        setQualityLog(log => [...log, { profile, reason, time: new Date() }])
      },
      onError: (err) => {
        setError(err.message)
        setLoading(false)
      },
      onEnded: () => navigate('/'),
    }).then(s => {
      setSession(s)
      sessionRef.current = s
    }).catch(err => {
      setError(String(err.message ?? err))
      setLoading(false)
    })

    return () => { sessionRef.current?.disconnect() }
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

      {/* Loading */}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#888',
        }}>
          <div style={{ fontSize: 14 }}>Starting playback…</div>
          {media && <div style={{ fontSize: 12 }}>{media.title}</div>}
        </div>
      )}

      {/* Video */}
      {session && (
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
      {session && currentProfile && (
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
