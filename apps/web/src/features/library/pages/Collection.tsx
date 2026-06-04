import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { CollectionSummary } from '@horizon/sdk'
import LargeTopNav from '../../../shared/ui/chrome/LargeTopNav.tsx'
import LargePoster from '../components/LargePoster.tsx'
import './Show.css'
import './Library.css'

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
    <div className="show show--error">
      <div className="show__err-title">Error loading collection</div>
      <div className="show__err-msg">{error}</div>
      <button className="show__err-back" onClick={() => navigate('/')}>Back</button>
    </div>
  )
  if (!collection) return <div className="show show--loading">Loading collection…</div>

  const backdrop = tmdbImageUrl(collection.backdropPath, 'w780')

  return (
    <div className="show">
      <LargeTopNav active="Movies" transparent={!!backdrop} back="/" />
      <section className="show__hero" style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined}>
        <div className="show__hero-scrim" />
        <div className="show__hero-content">
          <div className="show__hero-text">
            <div className="eyebrow">Collection</div>
            <h1 className="show__title">{collection.name}</h1>
            <div className="show__meta">{collection.movies.length} films</div>
          </div>
        </div>
      </section>
      <div className="show__body">
        <div className="lib__grid">
          {collection.movies.map(m => (
            <LargePoster key={m.id} item={m} width={180} showMeta onClick={() => navigate(`/play/${m.id}`)} />
          ))}
        </div>
      </div>
    </div>
  )
}
