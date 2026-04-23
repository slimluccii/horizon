import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { tmdbImageUrl } from '@horizon/sdk'
import type { ContinueWatchingItem, MovieMetadata, EpisodeMetadata, ShowMetadataInfo } from '@horizon/sdk'

export default function ContinueWatchingRail({ userId }: { userId: string }) {
  const [items, setItems] = useState<ContinueWatchingItem[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    horizon.progress.continueWatching(userId)
      .then(list => { if (!cancelled) setItems(list) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [userId])

  if (items.length === 0) return null

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12, color: '#ccc' }}>Continue watching</h2>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
        {items.map(item => <Card key={item.mediaId} item={item} onOpen={() => navigate(`/play/${item.mediaId}`)} />)}
      </div>
    </div>
  )
}

function Card({ item, onOpen }: { item: ContinueWatchingItem; onOpen: () => void }) {
  const epMeta = item.media.metadata as EpisodeMetadata | null
  const showMeta = item.show?.metadata as ShowMetadataInfo | null | undefined
  const movieMeta = item.media.metadata as MovieMetadata | null
  const img = item.kind === 'episode'
    ? tmdbImageUrl(epMeta?.stillPath, 'w342') ?? tmdbImageUrl(showMeta?.backdropPath, 'w342')
    : tmdbImageUrl(movieMeta?.backdropPath, 'w342') ?? tmdbImageUrl(movieMeta?.posterPath, 'w342')
  const remainingMin = Math.max(0, Math.round((item.durationMs - item.positionMs) / 60_000))
  const title = item.kind === 'episode'
    ? `${item.show?.title ?? ''}  ·  S${String(epMeta?.season ?? 0).padStart(2,'0')}E${String(epMeta?.episode ?? 0).padStart(2,'0')} ${item.media.title}`
    : item.media.title

  return (
    <div onClick={onOpen} style={{ flex: '0 0 260px', background: '#1a1a1a', borderRadius: 8, cursor: 'pointer', overflow: 'hidden', border: '1px solid #2a2a2a' }}>
      <div style={{ aspectRatio: '16 / 9', background: '#0a0a0a', position: 'relative' }}>
        {img && <img src={img} alt={title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: '#333' }}>
          <div style={{ height: '100%', width: `${item.percent}%`, background: '#ef4444' }} />
        </div>
      </div>
      <div style={{ padding: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 11, color: '#888' }}>{remainingMin}m left</div>
      </div>
    </div>
  )
}
