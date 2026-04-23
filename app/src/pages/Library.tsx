import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import MediaCard from '../components/MediaCard.tsx'
import ContinueWatchingRail from '../components/ContinueWatchingRail.tsx'
import ProfileBadge from '../components/ProfileBadge.tsx'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { MediaItem, ShowSummary } from '@horizon/sdk'

type Tab = 'movies' | 'shows' | 'collections'

export default function Library() {
  const navigate = useNavigate()
  const { userId } = useActiveUser()
  const [tab, setTab] = useState<Tab>('movies')
  const [movies, setMovies] = useState<MediaItem[]>([])
  const [shows, setShows] = useState<ShowSummary[]>([])
  const [collections, setCollections] = useState<{ id: string; name: string; movies: MediaItem[] }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      horizon.library.listMovies().then(setMovies),
      horizon.library.listShows().then(setShows),
      horizon.library.listCollections().then(setCollections),
    ]).finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 16px', position: 'relative' }}>
      <ProfileBadge />
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Horizon</h1>
      {userId && <ContinueWatchingRail userId={userId} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {(['movies', 'shows', 'collections'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: tab === t ? '#fff' : '#222', color: tab === t ? '#000' : '#fff',
              fontWeight: 600, textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: '#666' }}>Loading library…</p>}

      {!loading && tab === 'movies' && (
        <Grid>
          {movies.map(m => <MediaCard key={m.id} item={m} />)}
          {movies.length === 0 && <Empty>No movies found. Check HORIZON_MOVIES_ROOT.</Empty>}
        </Grid>
      )}

      {!loading && tab === 'shows' && (
        <Grid>
          {shows.map(s => <ShowCard key={s.id} show={s} onOpen={() => navigate(`/show/${s.id}`)} />)}
          {shows.length === 0 && <Empty>No shows found. Check HORIZON_SHOWS_ROOT.</Empty>}
        </Grid>
      )}

      {!loading && tab === 'collections' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {collections.map(col => (
            <div key={col.id}>
              <h2 style={{ fontSize: 18, marginBottom: 12 }}>{col.name}</h2>
              <Grid>
                {col.movies.map((m, i) => <MediaCard key={m.id} item={m} subtitle={`Part ${i + 1}`} />)}
              </Grid>
            </div>
          ))}
          {collections.length === 0 && <Empty>No collections detected.</Empty>}
        </div>
      )}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: '#666', gridColumn: '1/-1' }}>{children}</p>
}

function ShowCard({ show, onOpen }: { show: ShowSummary; onOpen: () => void }) {
  const epCount = show.seasons.reduce((acc, x) => acc + x.episodeCount, 0)
  const posterUrl = tmdbImageUrl(show.metadata?.posterPath, 'w342')
  const year = show.metadata?.firstAirDate?.slice(0, 4)
  return (
    <div
      onClick={onOpen}
      style={{
        cursor: 'pointer', background: '#1a1a1a', borderRadius: 8,
        border: '1px solid #2a2a2a', transition: 'border-color 0.15s, transform 0.15s',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = '#555'
        e.currentTarget.style.transform = 'translateY(-2px)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = '#2a2a2a'
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '2 / 3', background: '#0a0a0a' }}>
        {posterUrl
          ? <img src={posterUrl} alt={show.title} loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 12 }}>No poster</div>}
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {show.title}{year ? <span style={{ color: '#888', fontWeight: 400 }}> ({year})</span> : ''}
        </div>
        <div style={{ fontSize: 12, color: '#888' }}>
          {show.seasons.length} season{show.seasons.length === 1 ? '' : 's'} · {epCount} episode{epCount === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  )
}
