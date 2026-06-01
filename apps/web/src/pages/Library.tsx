import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { MediaItem, ShowSummary, MovieMetadata } from '@horizon/sdk'
import LargeTopNav from '../components/chrome/LargeTopNav.tsx'
import ContinueWatchingRail from '../components/ContinueWatchingRail.tsx'
import LargePoster from '../components/LargePoster.tsx'
import Icon from '../components/chrome/Icon.tsx'
import './Library.css'

type Tab = 'movies' | 'shows' | 'collections'

/** Pick a hero title for the top of the page — prefer something with a
 *  backdrop since the hero is a full-bleed image treatment. */
function pickHero(movies: MediaItem[]): MediaItem | null {
  const withBackdrop = movies.find(m => {
    const meta = m.metadata?.kind === 'movie' ? (m.metadata as MovieMetadata) : null
    return meta?.backdropPath
  })
  return withBackdrop ?? movies[0] ?? null
}

export default function Library() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user, userId } = useActiveUser()
  const canManage = user?.role === 'owner' || user?.role === 'admin'

  const tabFromUrl = (params.get('tab') as Tab | null) ?? 'movies'
  const [tab, setTab] = useState<Tab>(tabFromUrl)
  useEffect(() => { setTab(tabFromUrl) }, [tabFromUrl])

  const [movies, setMovies] = useState<MediaItem[]>([])
  const [shows, setShows] = useState<ShowSummary[]>([])
  const [collections, setCollections] = useState<{ id: string; name: string; movies: MediaItem[] }[]>([])
  const [loading, setLoading] = useState(true)
  const [noRoots, setNoRoots] = useState(false)

  useEffect(() => {
    Promise.all([
      horizon.library.listMovies().then(setMovies),
      horizon.library.listShows().then(setShows),
      horizon.library.listCollections().then(setCollections),
    ]).finally(() => setLoading(false))
  }, [])

  // Surface the "add folders" banner only to owner/admin, who can act on it.
  useEffect(() => {
    if (!canManage) { setNoRoots(false); return }
    let cancelled = false
    horizon.settings.getServer()
      .then(s => { if (!cancelled) setNoRoots(s.moviesRoots.length === 0 && s.showsRoots.length === 0) })
      .catch(() => { if (!cancelled) setNoRoots(false) })
    return () => { cancelled = true }
  }, [canManage])

  const hero = useMemo(() => pickHero(movies), [movies])
  const heroMeta = hero?.metadata?.kind === 'movie' ? (hero.metadata as MovieMetadata) : null
  const heroBackdrop = tmdbImageUrl(heroMeta?.backdropPath, 'w780')

  const activeTab = tab === 'shows' ? 'Series' : tab === 'collections' ? 'Collections' : 'Movies'
  const sizeByKind = tab === 'shows' ? `${shows.length} titles` : tab === 'collections' ? `${collections.length} sets` : `${movies.length} titles`

  return (
    <div className="lib">
      <LargeTopNav active={activeTab} transparent={!!heroBackdrop} />

      {heroBackdrop && hero && (
        <section className="lib__hero" style={{ backgroundImage: `url(${heroBackdrop})` }}>
          <div className="lib__hero-scrim-v" />
          <div className="lib__hero-scrim-h" />
          <div className="lib__hero-content">
            <div className="eyebrow">Featured · Just added</div>
            <h1 className="lib__hero-title">{hero.title}</h1>
            <div className="lib__hero-meta">
              {hero.year && <span>{hero.year}</span>}
              {hero.year && <Dot />}
              <span>{Math.round(hero.duration / 60)} min</span>
              {hero.resolution && <><Dot /><span>{hero.resolution.split('x')[1] ? `${hero.resolution.split('x')[1]}p` : hero.resolution}</span></>}
              {hero.hdr?.dv && <><Dot /><span className="lib__hero-badge">Dolby Vision</span></>}
              {hero.videoCodec && <><Dot /><span>{hero.videoCodec.toUpperCase()}</span></>}
            </div>
            {heroMeta?.overview && (
              <p className="lib__hero-overview">{heroMeta.overview}</p>
            )}
            <div className="lib__hero-actions">
              <button className="lib__cta-play" onClick={() => navigate(`/play/${hero.id}`)}>
                <Icon name="play" size={14} color="#000" /> Play
              </button>
              <button className="lib__cta-info" onClick={() => navigate(`/play/${hero.id}`)}>
                <Icon name="info" size={14} color="#fff" /> More info
              </button>
            </div>
          </div>
        </section>
      )}

      <div className={`lib__body ${heroBackdrop ? 'lib__body--with-hero' : ''}`}>
        {noRoots && (
          <div className="lib__banner" role="status">
            <span className="lib__banner-text">No library folders configured yet.</span>
            <button className="lib__banner-cta" onClick={() => navigate('/settings')}>
              Add library folders → Settings
            </button>
          </div>
        )}
        {userId && <ContinueWatchingRail userId={userId} padX={48} />}

        <div className="lib__section">
          <div className="lib__section-head">
            <h2 className="lib__section-title">
              {tab === 'movies' ? 'Movies' : tab === 'shows' ? 'Series' : 'Collections'}
            </h2>
            <div className="lib__section-sub">{sizeByKind} · last scan moments ago</div>
          </div>

          <div className="lib__tabs">
            {(['movies', 'shows', 'collections'] as Tab[]).map(t => (
              <button
                key={t}
                className={`lib__pill ${tab === t ? 'is-active' : ''}`}
                onClick={() => {
                  setTab(t)
                  navigate(`/?tab=${t}`, { replace: true })
                }}
              >
                {t === 'movies' ? 'Movies' : t === 'shows' ? 'Series' : 'Collections'}
              </button>
            ))}
          </div>

          {loading && <div className="lib__loading">Loading library…</div>}

          {!loading && tab === 'movies' && (
            <div className="lib__grid">
              {movies.map(m => <LargePoster key={m.id} item={m} width={180} showMeta onClick={() => navigate(`/play/${m.id}`)} />)}
              {movies.length === 0 && <div className="lib__empty">No movies found.</div>}
            </div>
          )}

          {!loading && tab === 'shows' && (
            <div className="lib__grid">
              {shows.map(s => <LargePoster key={s.id} item={s} width={180} showMeta onClick={() => navigate(`/show/${s.id}`)} />)}
              {shows.length === 0 && <div className="lib__empty">No shows found.</div>}
            </div>
          )}

          {!loading && tab === 'collections' && (
            <div className="lib__collections">
              {collections.map(col => (
                <div key={col.id} className="lib__collection">
                  <h3 className="lib__collection-title">{col.name}</h3>
                  <div className="lib__grid">
                    {col.movies.map(m => (
                      <LargePoster key={m.id} item={m} width={170} showMeta onClick={() => navigate(`/play/${m.id}`)} />
                    ))}
                  </div>
                </div>
              ))}
              {collections.length === 0 && <div className="lib__empty">No collections detected.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Dot() {
  return <span className="lib__dot">·</span>
}
