import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { ShowSummary, MediaItem, EpisodeMetadata } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
import './Show.css'

export default function Show() {
  const { showId } = useParams<{ showId: string }>()
  const navigate = useNavigate()
  const [show, setShow] = useState<ShowSummary | null>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [episodes, setEpisodes] = useState<MediaItem[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!showId) return
    let cancelled = false
    horizon.library.getShow(showId)
      .then(s => {
        if (cancelled) return
        setShow(s)
        if (s.seasons.length > 0) setSeason(s.seasons[0].number)
      })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [showId])

  useEffect(() => {
    if (!showId || season == null) return
    let cancelled = false
    horizon.library.listEpisodes(showId, season)
      .then(eps => { if (!cancelled) setEpisodes(eps) })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [showId, season])

  if (error) return (
    <div className="show show--error">
      <div className="show__err-title">Error loading show</div>
      <div className="show__err-msg">{error}</div>
      <button className="show__err-back" onClick={() => navigate('/?tab=shows')}>Back</button>
    </div>
  )

  if (!show) return <div className="show show--loading">Loading show…</div>

  const meta = show.metadata
  const backdrop = tmdbImageUrl(meta?.backdropPath, 'w780')
  const poster = tmdbImageUrl(meta?.posterPath, 'w342')
  const year = meta?.firstAirDate?.slice(0, 4)
  const totalEps = show.seasons.reduce((a, s) => a + s.episodeCount, 0)

  return (
    <div className="show">
      <LargeTopNav active="Series" transparent={!!backdrop} back="/?tab=shows" />

      <section className="show__hero" style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined}>
        <div className="show__hero-scrim" />
        <div className="show__hero-content">
          {poster && (
            <img className="show__poster" src={poster} alt={show.title} loading="lazy" />
          )}
          <div className="show__hero-text">
            <div className="eyebrow">Series</div>
            <h1 className="show__title">{meta?.title ?? show.title}</h1>
            {meta?.tagline && <div className="show__tagline">{meta.tagline}</div>}
            <div className="show__meta">
              {year && <span>{year}</span>}
              <span className="show__dot">·</span>
              <span>{show.seasons.length} season{show.seasons.length === 1 ? '' : 's'}</span>
              <span className="show__dot">·</span>
              <span>{totalEps} episode{totalEps === 1 ? '' : 's'}</span>
              {meta?.status && <><span className="show__dot">·</span><span>{meta.status}</span></>}
              {meta?.network && <><span className="show__dot">·</span><span>{meta.network}</span></>}
              {meta?.rating && <><span className="show__dot">·</span><span className="show__rating">★ {meta.rating.toFixed(1)}</span></>}
            </div>
            {meta?.overview && <p className="show__overview">{meta.overview}</p>}
          </div>
        </div>
      </section>

      <section className="show__body">
        <div className="show__seasons">
          {show.seasons.map(s => (
            <button
              key={s.number}
              className={`show__season ${season === s.number ? 'is-active' : ''}`}
              onClick={() => setSeason(s.number)}
            >
              Season {s.number} <span className="show__season-count">· {s.episodeCount}</span>
            </button>
          ))}
        </div>

        <div className="show__episodes">
          {episodes.length === 0 && <div className="show__empty">No episodes in this season.</div>}
          {episodes.map(ep => <EpisodeRow key={ep.id} episode={ep} onPlay={() => navigate(`/play/${ep.id}`)} />)}
        </div>
      </section>
    </div>
  )
}

function EpisodeRow({ episode, onPlay }: { episode: MediaItem; onPlay: () => void }) {
  const epMeta = episode.metadata?.kind === 'episode' ? (episode.metadata as EpisodeMetadata) : null
  const still = tmdbImageUrl(epMeta?.stillPath, 'w342')
  const epNum = typeof episode.episode === 'number' ? `E${String(episode.episode).padStart(2, '0')}` : ''
  const mins = Math.round(episode.duration / 60)
  return (
    <button className="ep" onClick={onPlay}>
      <div
        className="ep__still"
        style={still ? { backgroundImage: `url(${still})` } : undefined}
      >
        {!still && <div className="ep__still-fallback">No still</div>}
        <div className="ep__play-badge"><Icon name="play" size={12} color="#000" /></div>
      </div>
      <div className="ep__info">
        <div className="ep__head">
          {epNum && <span className="ep__num">{epNum}</span>}
          <span className="ep__title">{episode.title}</span>
        </div>
        <div className="ep__meta">
          <span>{mins}m</span>
          <span className="ep__dot">·</span>
          <span>{episode.resolution}</span>
          {episode.hdr?.dv && <><span className="ep__dot">·</span><span className="ep__dv">Dolby Vision</span></>}
          {episode.audioTracks?.[0] && <><span className="ep__dot">·</span><span>{episode.audioTracks[0].codec.toUpperCase()}</span></>}
          {epMeta?.airDate && <><span className="ep__dot">·</span><span>{epMeta.airDate}</span></>}
        </div>
        {epMeta?.overview && <p className="ep__overview">{epMeta.overview}</p>}
      </div>
    </button>
  )
}
