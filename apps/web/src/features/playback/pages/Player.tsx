// app/src/pages/Player.tsx
import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../../identity/hooks/useActiveUser.ts'
import VideoPlayer from '../components/VideoPlayer.tsx'
import QualityOverlay from '../components/QualityOverlay.tsx'
import TrackSelector from '../components/TrackSelector.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
import { pickInitialTracks, isImageSubtitle, preferredQualityMaxBitrate } from '@horizon/sdk'
import type { PlaybackSession, QualityProfile, MediaItem } from '@horizon/sdk'
/** Delay (ms) after a reloadKey bump before clearing resumeAtSec. Must outlast
 *  VideoPlayer applying the value to the fresh hls.js instance (which happens
 *  synchronously on the reload render) yet be short enough that a subsequent
 *  switch captures a fresh position rather than the stale one. */
const RESUME_CLEAR_MS = 150

export default function Player() {
  const { mediaId } = useParams<{ mediaId: string }>()
  const navigate = useNavigate()
  const { user, userId, loading: userLoading } = useActiveUser()
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

  // Next-episode auto-advance: fetched once the media loads (episodes only);
  // `postPlay` shows the up-next prompt after playback ends. The ref mirrors
  // the state for the onEnded callback, which closes over stale state.
  const [nextEpisode, setNextEpisode] = useState<MediaItem | null>(null)
  const [postPlay, setPostPlay] = useState(false)
  const nextEpisodeRef = useRef<MediaItem | null>(null)
  useEffect(() => { nextEpisodeRef.current = nextEpisode }, [nextEpisode])

  const sessionRef = useRef<PlaybackSession | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Bumped to tear down + recreate the whole session (not just hls.js). Needed
  // when an image subtitle is selected on a copy-based session: burn-in forces
  // the transcode path, which only a fresh session can advertise. The override
  // ref carries the tracks + position the recreated session should start from.
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const recreateRef = useRef<{ subtitleTrackIndex: number | null; audioTrackIndex: number; startPositionMs: number } | null>(null)

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

  // Load the media item (movie or episode) first — the session create needs
  // its track lists to apply preference-based track selection.
  useEffect(() => {
    if (!mediaId) return
    let cancelled = false
    setPostPlay(false)
    setNextEpisode(null)
    horizon.library.getMedia(mediaId)
      .then(m => {
        if (cancelled) return
        setMedia(m)
        if (m.kind === 'episode') {
          horizon.library.getNextEpisode(mediaId)
            .then(next => { if (!cancelled) setNextEpisode(next) })
            .catch(() => {/* up-next is an enhancement — ignore failures */})
        }
      })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [mediaId])

  useEffect(() => {
    if (!mediaId || !media || userLoading) return
    // Wait until the user has made a resume decision (or there's nothing to resume).
    if (decision === null || decision === 'pending') return

    let cancelled = false
    // Cold-start timing. t0 = navigation into the player page.
    const t0 = performance.now()
    const stamp = (label: string) => console.log(`[cold-start] ${label} +${Math.round(performance.now() - t0)}ms`)
    stamp('player mount')

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
      // A pending recreate (burn-in switch) dictates tracks + position; else
      // start from the profile's preferences.
      const recreate = recreateRef.current
      recreateRef.current = null
      const prefTracks = pickInitialTracks(media!, user?.preferences)
      const startPositionMs = recreate?.startPositionMs
        ?? (decision === 'resume' ? resume?.positionMs : undefined)
      const maxBitrate = preferredQualityMaxBitrate(user?.preferences.preferredQuality)
      horizon.play(mediaId!, {
        startPositionMs,
        audioTrackIndex: recreate?.audioTrackIndex ?? prefTracks.audioTrackIndex,
        subtitleTrackIndex: recreate?.subtitleTrackIndex ?? prefTracks.subtitleTrackIndex,
        capabilities: maxBitrate > 0 ? { maxBitrate } : undefined,
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
          // Server-initiated switches (bandwidth demote) arrive without the
          // client having captured a resume position — grab it now, before the
          // reload tears the video element's state down. User-initiated
          // switches already set resumeAtSec; overwriting with the current
          // time is equivalent (both were read moments apart).
          const posSec = videoRef.current?.currentTime ?? 0
          if (posSec > 0) setResumeAtSec(posSec)
          // Quality switches restart ffmpeg → reload HLS to pick up new init.mp4
          setReloadKey(k => k + 1)
        },
        onTrackChange: ({ audio, subtitle, restarted }) => {
          if (cancelled) return
          if (typeof audio === 'number') {
            setSelectedAudio(audio)
            // Audio change restarts ffmpeg with -map a:N → new init.mp4 → reload
            setReloadKey(k => k + 1)
          }
          if (subtitle !== undefined) {
            setSelectedSubtitle(subtitle)
            // Text/sidecar subtitle = separate VTT file, no reload. A burn-in
            // switch (image subtitle) restarted ffmpeg → reload the HLS source.
            if (restarted) setReloadKey(k => k + 1)
          }
        },
        onError: (err) => {
          if (cancelled) return
          setError(err.message)
        },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, decision, media, userLoading, sessionEpoch])

  if (error) return (
    <div>
      <div>Playback error</div>
      <div>{error}</div>
      <button onClick={() => navigate('/')}>Back to library</button>
    </div>
  )

  const subtitleTrack = (selectedSubtitle != null && media)
    ? media.subtitleTracks.find(t => t.index === selectedSubtitle) ?? null
    : null
  // Only text/sidecar tracks render as a client-side <track>; image subs are
  // burned into the video by the server.
  const textSubtitleTrack = subtitleTrack && subtitleTrack.embeddable ? subtitleTrack : null

  return (
    <div>
      <button
        onClick={() => { sessionRef.current?.disconnect(); navigate('/') }}
      >
        <Icon name="back" size={14} /> Library
      </button>

      {decision === 'pending' && resume && (
        <section aria-label="Resume playback">
          <h2>Continue</h2>
          <p>Resume from {fmtMs(resume.positionMs)}?</p>
          <button onClick={() => setDecision('resume')}>Resume</button>
          <button onClick={() => setDecision('start-over')}>Start over</button>
        </section>
      )}

      {!ready && (
        <p role="status">
          Starting playback…{media && <> {media.title}</>}
        </p>
      )}

      {postPlay && nextEpisode && (
        <PostPlayPrompt
          next={nextEpisode}
          onPlayNext={() => navigate(`/play/${nextEpisode.id}`)}
          onCancel={() => { setPostPlay(false); navigate('/') }}
        />
      )}

      {ready && session && (
        <VideoPlayer
          session={session}
          videoRef={videoRef}
          reloadKey={reloadKey}
          resumeAtSec={resumeAtSec}
          subtitle={textSubtitleTrack}
          onBufferUpdate={setBufferSeconds}
          onEnded={() => {
            // Episode with a follow-up → post-play prompt (auto-advance);
            // otherwise back to the library.
            if (nextEpisodeRef.current) setPostPlay(true)
            else navigate('/')
          }}
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
            const newTrack = idx != null ? media.subtitleTracks.find(t => t.index === idx) : undefined
            const leavingBurnIn = subtitleTrack != null && isImageSubtitle(subtitleTrack)
            const enteringBurnIn = !!newTrack && isImageSubtitle(newTrack)
            const posMs = Math.floor((videoRef.current?.currentTime ?? 0) * 1000)

            if (enteringBurnIn && session.method !== 'transcode') {
              // Copy-based session can't grow a burned-in subtitle — recreate
              // the session with the subtitle chosen at create.
              recreateRef.current = { subtitleTrackIndex: idx, audioTrackIndex: selectedAudio, startPositionMs: posMs }
              setReady(false)
              setSessionEpoch(k => k + 1)
              return
            }

            setSelectedSubtitle(idx)      // optimistic
            if (enteringBurnIn || leavingBurnIn) {
              // Burn-in switch restarts ffmpeg — resume from the current spot.
              setResumeAtSec(posMs / 1000)
              session.setSubtitleTrack(idx, posMs)
            } else {
              session.setSubtitleTrack(idx)
            }
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

const POST_PLAY_COUNTDOWN_SEC = 10

/** Up-next prompt shown when an episode finishes. Counts down and
 *  auto-advances; the user can start immediately or bail to the library. */
function PostPlayPrompt({ next, onPlayNext, onCancel }: {
  next: MediaItem
  onPlayNext: () => void
  onCancel: () => void
}) {
  const [remaining, setRemaining] = useState(POST_PLAY_COUNTDOWN_SEC)

  useEffect(() => {
    if (remaining <= 0) { onPlayNext(); return }
    const timer = setTimeout(() => setRemaining(r => r - 1), 1000)
    return () => clearTimeout(timer)
  }, [remaining, onPlayNext])

  const epLabel = next.season != null && next.episode != null
    ? `S${String(next.season).padStart(2, '0')}E${String(next.episode).padStart(2, '0')} · `
    : ''

  return (
    <section aria-label="Up next">
      <h2>Up next</h2>
      <p>{epLabel}{next.title}</p>
      <p role="status">Playing in {remaining}s…</p>
      <button autoFocus onClick={onPlayNext}>Play now</button>
      <button onClick={onCancel}>Back to library</button>
    </section>
  )
}
