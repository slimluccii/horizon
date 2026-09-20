import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { ShowSummary, MediaItem, EpisodeMetadata } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
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
    <div>
      <div>Error loading show</div>
      <div>{error}</div>
      <button onClick={() => navigate('/?tab=shows')}>Back</button>
    </div>
  )

  if (!show) return <div>Loading show…</div>

  const meta = show.metadata
  const backdrop = tmdbImageUrl(meta?.backdropPath, 'w780')
  const poster = tmdbImageUrl(meta?.posterPath, 'w342')
  const year = meta?.firstAirDate?.slice(0, 4)
  const totalEps = show.seasons.reduce((a, s) => a + s.episodeCount, 0)

  return (
    <div>
      <LargeTopNav active="Series" transparent={!!backdrop} back="/?tab=shows" />

      <main>
        <section aria-label="Series details">
          {poster && (
            <img src={poster} alt={show.title} width={342} loading="lazy" />
          )}
          <p>Series</p>
          <h1>{meta?.title ?? show.title}</h1>
          {meta?.tagline && <p>{meta.tagline}</p>}
          <p>
            {year && <span>{year} · </span>}
            <span>{show.seasons.length} season{show.seasons.length === 1 ? '' : 's'}</span>
            <span> · {totalEps} episode{totalEps === 1 ? '' : 's'}</span>
            {meta?.status && <span> · {meta.status}</span>}
            {meta?.network && <span> · {meta.network}</span>}
            {meta?.rating && <span> · ★ {meta.rating.toFixed(1)}</span>}
          </p>
          {meta?.overview && <p>{meta.overview}</p>}
        </section>

        <section aria-label="Episodes">
          <nav aria-label="Seasons">
            {show.seasons.map(s => (
              <button
                key={s.number}
                aria-pressed={season === s.number}
                onClick={() => setSeason(s.number)}
              >
                Season {s.number} <span>· {s.episodeCount}</span>
              </button>
            ))}
          </nav>

          <ul>
            {episodes.length === 0 && <li>No episodes in this season.</li>}
            {episodes.map(ep => (
              <li key={ep.id}>
                <EpisodeRow episode={ep} onPlay={() => navigate(`/play/${ep.id}`)} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}

function EpisodeRow({ episode, onPlay }: { episode: MediaItem; onPlay: () => void }) {
  const epMeta = episode.metadata?.kind === 'episode' ? (episode.metadata as EpisodeMetadata) : null
  const still = tmdbImageUrl(epMeta?.stillPath, 'w342')
  const epNum = typeof episode.episode === 'number' ? `E${String(episode.episode).padStart(2, '0')}` : ''
  const mins = Math.round(episode.duration / 60)
  return (
    <button onClick={onPlay}>
      {still
        ? <img src={still} alt="" width={342} height={192} loading="lazy" />
        : <span>No still</span>}
      <Icon name="play" size={12} />
      <span>
        {epNum && <span>{epNum} </span>}
        <span>{episode.title}</span>
      </span>
      <span>
        <span>{mins}m</span>
        <span> · {episode.resolution}</span>
        {episode.hdr?.dv && <span> · Dolby Vision</span>}
        {episode.audioTracks?.[0] && <span> · {episode.audioTracks[0].codec.toUpperCase()}</span>}
        {epMeta?.airDate && <span> · {epMeta.airDate}</span>}
      </span>
      {epMeta?.overview && <span>{epMeta.overview}</span>}
    </button>
  )
}
