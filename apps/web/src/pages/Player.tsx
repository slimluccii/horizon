// app/src/pages/Player.tsx
import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import VideoPlayer from '../components/VideoPlayer.tsx'
import QualityOverlay from '../components/QualityOverlay.tsx'
import TrackSelector from '../components/TrackSelector.tsx'
import Icon from '../components/chrome/Icon.tsx'
import type { PlaybackSession, QualityProfile, MediaItem } from '@horizon/sdk'
import './Player.css'

/** Delay (ms) after a reloadKey bump before clearing resumeAtSec. Must outlast
 *  VideoPlayer applying the value to the fresh hls.js instance (which happens
 *  synchronously on the reload render) yet be short enough that a subsequent
 *  switch captures a fresh position rather than the stale one. */
const RESUME_CLEAR_MS = 150

export default function Player() {
  const { mediaId } = useParams<{ mediaId: string }>()
  const navigate = useNavigate()
  const { userId } = useActiveUser()
  const [session, setSession] = useState<PlaybackSession | null>(null)
  const [media, setMedia] = useState<MediaItem | null>(null)
  const [currentProfile, setCurrentProfile] = useState<QualityProfile | null>(null)
  const [bufferSeconds, setBufferSeconds] = useState(0)
  const [qualityLog, setQualityLog] = useState<{ profile: QualityProfile; reason: string; time: Date }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)   // true only after session-ready fires

  // Track selection state — server holds the source of truth, but UI mirrors it
  // for instant responsiveness. track-changed events sync it back.
  const [selectedAudio, setSelectedAudio] = useState<number>(0)
  const [selectedSubtitle, setSelectedSubtitle] = useState<number | null>(null)

  // Bump to force VideoPlayer to tear down + recreate hls.js. Required after
  // server restarts ffmpeg (audio track or quality switch) — new init.mp4 means
  // MSE rejects new segments otherwise.
  const [reloadKey, setReloadKey] = useState(0)
  // Position (seconds) to resume at after a reload. Captured BEFORE we trigger
  // the server restart so the client picks up where playback was instead of 0.
  const [resumeAtSec, setResumeAtSec] = useState(0)

  // Clear resumeAtSec shortly after a reload key bump so a stale position can't
  // leak into the *next* quality/audio switch. Flow: capture position → call
  // session method → server restarts ffmpeg → onQualityChange/onTrackChange
  // bumps reloadKey → VideoPlayer applies resumeAtSec once → this clears it.
  // The delay must outlast VideoPlayer's one-shot application of the value.
  useEffect(() => {
    if (reloadKey === 0) return
    const timer = setTimeout(() => setResumeAtSec(0), RESUME_CLEAR_MS)
    return () => clearTimeout(timer)
  }, [reloadKey])

  // Resume-toast state. `resume` holds the fetched progress; `decision` gates
  // session creation: null = not yet fetched, 'pending' = showing the toast,
  // 'resume' / 'start-over' = user has decided (or there was nothing to resume).
  const [resume, setResume] = useState<{ positionMs: number; durationMs: number } | null>(null)
  const [decision, setDecision] = useState<'pending' | 'resume' | 'start-over' | null>(null)

  const sessionRef = useRef<PlaybackSession | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Fetch saved progress; show resume toast if applicable.
  useEffect(() => {
    if (!mediaId || !userId) return
    let cancelled = false
    horizon.progress.get(userId, mediaId)
      .then(p => {
        if (cancelled) return
        if (p && p.positionMs > 5000 && !p.watched) {
          setResume({ positionMs: p.positionMs, durationMs: p.durationMs })
          setDecision('pending')
        } else {
          setDecision('start-over')
        }
      })
      .catch(() => { if (!cancelled) setDecision('start-over') })
    return () => { cancelled = true }
  }, [mediaId, userId])

  useEffect(() => {
    if (!mediaId) return
    // Wait until the user has made a resume decision (or there's nothing to resume).
    if (decision === null || decision === 'pending') return

    let cancelled = false
    // Cold-start timing. t0 = navigation into the player page.
    const t0 = performance.now()
    const stamp = (label: string) => console.log(`[cold-start] ${label} +${Math.round(performance.now() - t0)}ms`)
    stamp('player mount')

    horizon.library.listMovies()
      .then(movies => { if (!cancelled) setMedia(movies.find(m => m.id === mediaId) ?? null) })
      .catch(() => {})

    // Defer the actual session creation by a microtask so React StrictMode's
    // synchronous double-mount (mount → unmount → mount) no-ops on the first
    // pass: the cleanup runs before this microtask fires, setting cancelled=true
    // and skipping the POST /sessions entirely. Without this guard every /play
    // navigation spawns TWO ffmpeg processes and destroys one immediately.
    queueMicrotask(() => {
      if (cancelled) return
      startSession()
    })

    function startSession() {
      const startPositionMs = decision === 'resume' ? resume?.positionMs : undefined
      horizon.play(mediaId!, {
        startPositionMs,
        onReady: (info) => {
          if (cancelled) return
          stamp('session-ready')
          setCurrentProfile(info.profiles?.[0] ?? null)
          setSelectedAudio(info.selectedAudioTrack ?? 0)
          setSelectedSubtitle(info.selectedSubtitleTrack ?? null)
          setReady(true)
        },
        onQualityChange: (profile, reason) => {
          if (cancelled) return
          setCurrentProfile(profile)
          setQualityLog(log => [...log, { profile, reason, time: new Date() }])
          // Quality switches restart ffmpeg → reload HLS to pick up new init.mp4
          setReloadKey(k => k + 1)
        },
        onTrackChange: ({ audio, subtitle }) => {
          if (cancelled) return
          if (typeof audio === 'number') {
            setSelectedAudio(audio)
            // Audio change restarts ffmpeg with -map a:N → new init.mp4 → reload
            setReloadKey(k => k + 1)
          }
          if (subtitle !== undefined) {
            setSelectedSubtitle(subtitle)
            // Subtitle is a separate VTT file; no HLS reload needed
          }
        },
        onError: (err) => {
          if (cancelled) return
          setError(err.message)
        },
        onEnded: () => { if (!cancelled) navigate('/') },
      }).then(s => {
        stamp('session created (POST /sessions resolved)')
        if (cancelled) {
          s.disconnect()
          return
        }
        setSession(s)
        sessionRef.current = s
      }).catch(err => {
        if (cancelled) return
        setError(String(err.message ?? err))
      })
    }

    return () => {
      cancelled = true
      sessionRef.current?.disconnect()
      sessionRef.current = null
      setSession(null)
      setReady(false)
    }
  }, [mediaId, decision])

  if (error) return (
    <div className="player player--error">
      <div className="player__err-title">Playback error</div>
      <div className="player__err-msg">{error}</div>
      <button className="player__err-back" onClick={() => navigate('/')}>Back to library</button>
    </div>
  )

  const subtitleTrack = (selectedSubtitle != null && media)
    ? media.subtitleTracks.find(t => t.index === selectedSubtitle) ?? null
    : null

  return (
    <div className="player">
      <button
        className="player__back"
        onClick={() => { sessionRef.current?.disconnect(); navigate('/') }}
      >
        <Icon name="back" size={14} /> Library
      </button>

      {decision === 'pending' && resume && (
        <div className="player__toast">
          <div className="player__toast-text">
            <div className="eyebrow">Continue</div>
            <div className="player__toast-msg">Resume from {fmtMs(resume.positionMs)}?</div>
          </div>
          <button className="player__toast-primary" onClick={() => setDecision('resume')}>Resume</button>
          <button className="player__toast-ghost" onClick={() => setDecision('start-over')}>Start over</button>
        </div>
      )}

      {!ready && (
        <div className="player__loading">
          <div className="player__spinner" />
          <div className="player__loading-msg">Starting playback…</div>
          {media && <div className="player__loading-title">{media.title}</div>}
        </div>
      )}

      {ready && session && (
        <VideoPlayer
          session={session}
          videoRef={videoRef}
          reloadKey={reloadKey}
          resumeAtSec={resumeAtSec}
          subtitle={subtitleTrack}
          onBufferUpdate={setBufferSeconds}
          onQualityChange={(profile, reason) => {
            setCurrentProfile(profile)
            setQualityLog(log => [...log, { profile, reason, time: new Date() }])
          }}
        />
      )}

      {ready && session && currentProfile && (
        <QualityOverlay
          method={session.method}
          profile={currentProfile}
          bufferSeconds={bufferSeconds}
          qualityLog={qualityLog}
        />
      )}

      {ready && session && media && (
        <TrackSelector
          audioTracks={media.audioTracks}
          subtitleTracks={media.subtitleTracks}
          selectedAudio={selectedAudio}
          selectedSubtitle={selectedSubtitle}
          currentProfile={currentProfile}
          isTranscode={session.method !== 'direct-play'}
          onAudioChange={(idx) => {
            setSelectedAudio(idx)         // optimistic
            const posMs = Math.floor((videoRef.current?.currentTime ?? 0) * 1000)
            setResumeAtSec(posMs / 1000)
            session.setAudioTrack(idx, posMs)
          }}
          onSubtitleChange={(idx) => {
            setSelectedSubtitle(idx)      // optimistic
            session.setSubtitleTrack(idx)
          }}
          onQualityChange={(bitrate) => {
            // Capture playback position before the server kills the encoder.
            // The onQualityChange event fires after restart — too late by then.
            const posMs = Math.floor((videoRef.current?.currentTime ?? 0) * 1000)
            setResumeAtSec(posMs / 1000)
            session.setQuality(bitrate, posMs)
          }}
        />
      )}
    </div>
  )
}

/** Format milliseconds as m:ss or h:mm:ss for the resume toast. */
function fmtMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
