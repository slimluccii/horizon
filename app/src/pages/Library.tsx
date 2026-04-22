import { useEffect, useState } from 'react'
import { horizon } from '../horizon.ts'
import MediaCard from '../components/MediaCard.tsx'
import type { MediaItem } from '@horizon/sdk'

type Tab = 'movies' | 'shows' | 'collections'

export default function Library() {
  const [tab, setTab] = useState<Tab>('movies')
  const [movies, setMovies] = useState<MediaItem[]>([])
  const [shows, setShows] = useState<{ id: string; title: string; seasonCount?: number }[]>([])
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
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Horizon</h1>
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
          {shows.map(s => (
            <div key={s.id} style={{ background: '#1a1a1a', borderRadius: 8, padding: 16, border: '1px solid #2a2a2a' }}>
              <div style={{ fontWeight: 600 }}>{s.title}</div>
            </div>
          ))}
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: '#666', gridColumn: '1/-1' }}>{children}</p>
}
