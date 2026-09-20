import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import type { ContinueWatchingItem } from '@horizon/sdk'
import LargeRail from './LargeRail.tsx'
import LandscapeCard from './LandscapeCard.tsx'

/** Fetches /users/:id/continue-watching and renders a rail of landscape cards.
 *  Rail hides itself when the list is empty (new users, new library). */
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
    <LargeRail title="Continue watching">
      {items.map(item => (
        <li key={item.mediaId}>
          <LandscapeCard
            item={item}
            onClick={() => navigate(`/play/${item.mediaId}`)}
          />
        </li>
      ))}
    </LargeRail>
  )
}
