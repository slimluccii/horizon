import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import type { ContinueWatchingItem } from '@horizon/sdk'
import LargeRail from './LargeRail.tsx'
import LandscapeCard from './LandscapeCard.tsx'

/** Fetches /users/:id/continue-watching and renders a rail of landscape cards.
 *  Rail hides itself when the list is empty (new users, new library). */
export default function ContinueWatchingRail({ userId, padX = 48 }: { userId: string; padX?: number }) {
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
    <LargeRail title="Continue watching" padX={padX}>
      {items.map(item => (
        <LandscapeCard
          key={item.mediaId}
          item={item}
          width={300}
          onClick={() => navigate(`/play/${item.mediaId}`)}
        />
      ))}
    </LargeRail>
  )
}
