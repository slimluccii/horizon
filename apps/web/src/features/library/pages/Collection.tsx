import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { CollectionSummary } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'
import LargePoster from '../components/LargePoster.tsx'
export default function Collection() {
  const { collectionId } = useParams<{ collectionId: string }>()
  const navigate = useNavigate()
  const [collection, setCollection] = useState<CollectionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!collectionId) return
    let cancelled = false
    horizon.library.getCollection(collectionId)
      .then(c => { if (!cancelled) setCollection(c) })
      .catch(err => { if (!cancelled) setError(String(err.message ?? err)) })
    return () => { cancelled = true }
  }, [collectionId])

  if (error) return (
    <div>
      <div>Error loading collection</div>
      <div>{error}</div>
      <button onClick={() => navigate('/')}>Back</button>
    </div>
  )
  if (!collection) return <div>Loading collection…</div>

  const backdrop = tmdbImageUrl(collection.backdropPath, 'w780')

  return (
    <div>
      <LargeTopNav active="Movies" transparent={!!backdrop} back="/" />
      <main>
        <section aria-label="Collection details">
          <p>Collection</p>
          <h1>{collection.name}</h1>
          <p>{collection.movies.length} films</p>
        </section>
        <ul>
          {collection.movies.map(m => (
            <li key={m.id}>
              <LargePoster item={m} showMeta onClick={() => navigate(`/play/${m.id}`)} />
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
