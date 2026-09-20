import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../../identity/hooks/useActiveUser.ts'
import { tmdbImageUrl, mergeMoviesAndCollections } from '@horizon/sdk'
import type { MediaItem, ShowSummary, MovieMetadata, CollectionSummary } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'
import ContinueWatchingRail from '../components/ContinueWatchingRail.tsx'
import LargePoster from '../components/LargePoster.tsx'
import CollectionPoster from '../components/CollectionPoster.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
type Tab = 'movies' | 'shows'

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

  const raw = params.get('tab')
  const tabFromUrl: Tab = raw === 'shows' ? 'shows' : 'movies'
  const [tab, setTab] = useState<Tab>(tabFromUrl)
  useEffect(() => { setTab(tabFromUrl) }, [tabFromUrl])

  const [movies, setMovies] = useState<MediaItem[]>([])
  const [shows, setShows] = useState<ShowSummary[]>([])
  const [collections, setCollections] = useState<CollectionSummary[]>([])
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

  const collapse = user?.preferences.collapseMovieCollections ?? true
  const movieGrid = useMemo(
    () => mergeMoviesAndCollections(movies, collections, collapse),
    [movies, collections, collapse],
  )

  const activeTab = tab === 'shows' ? 'Series' : 'Movies'
  const sizeByKind = tab === 'shows' ? `${shows.length} titles` : `${movieGrid.length} items`

  return (
    <div>
      <LargeTopNav active={activeTab} transparent={!!heroBackdrop} />

      {heroBackdrop && hero && (
        <section aria-label="Featured title">
          <p>Featured · Just added</p>
          <h1>{hero.title}</h1>
          <p>
            {hero.year && <span>{hero.year} · </span>}
            <span>{Math.round(hero.duration / 60)} min</span>
            {hero.resolution && <span> · {hero.resolution.split('x')[1] ? `${hero.resolution.split('x')[1]}p` : hero.resolution}</span>}
            {hero.hdr?.dv && <span> · Dolby Vision</span>}
            {hero.videoCodec && <span> · {hero.videoCodec.toUpperCase()}</span>}
          </p>
          {heroMeta?.overview && (
            <p>{heroMeta.overview}</p>
          )}
          <p>
            <button onClick={() => navigate(`/play/${hero.id}`)}>
              <Icon name="play" size={14} /> Play
            </button>
            <button onClick={() => navigate(`/play/${hero.id}`)}>
              <Icon name="info" size={14} /> More info
            </button>
          </p>
        </section>
      )}

      <main>
        {noRoots && (
          <p role="status">
            <span>No library folders configured yet.</span>
            <button onClick={() => navigate('/settings')}>
              Add library folders → Settings
            </button>
          </p>
        )}
        {userId && <ContinueWatchingRail userId={userId} />}

        <section aria-label="Library">
          <h2>
            {tab === 'movies' ? 'Movies' : 'Series'}
          </h2>
          <p>{sizeByKind}</p>

          <nav aria-label="Library kind">
            {(['movies', 'shows'] as Tab[]).map(t => (
              <button
                key={t}
                aria-pressed={tab === t}
                onClick={() => { setTab(t); navigate(`/?tab=${t}`, { replace: true }) }}
              >
                {t === 'movies' ? 'Movies' : 'Series'}
              </button>
            ))}
          </nav>

          {loading && <p>Loading library…</p>}

          {!loading && tab === 'movies' && (
            <ul>
              {movieGrid.map(entry =>
                entry.kind === 'collection'
                  ? <li key={`c-${entry.collection.id}`}><CollectionPoster collection={entry.collection}
                      onClick={() => navigate(`/collection/${entry.collection.id}`)} /></li>
                  : <li key={entry.movie.id}><LargePoster item={entry.movie} showMeta
                      onClick={() => navigate(`/play/${entry.movie.id}`)} /></li>,
              )}
              {movieGrid.length === 0 && <li>No movies found.</li>}
            </ul>
          )}

          {!loading && tab === 'shows' && (
            <ul>
              {shows.map(s => <li key={s.id}><LargePoster item={s} showMeta onClick={() => navigate(`/show/${s.id}`)} /></li>)}
              {shows.length === 0 && <li>No shows found.</li>}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
