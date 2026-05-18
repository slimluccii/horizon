import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../horizon.ts'
import type { User } from '@horizon/sdk'

const STORAGE_KEY = 'horizonUser'

let cachedId: string | null = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
const listeners = new Set<(id: string | null) => void>()

function setGlobal(id: string | null) {
  cachedId = id
  if (id) localStorage.setItem(STORAGE_KEY, id)
  else localStorage.removeItem(STORAGE_KEY)
  horizon.setActiveUser(id)
  for (const fn of listeners) fn(id)
}

// Sync at module load so any request before the first hook mount has the header.
if (cachedId) horizon.setActiveUser(cachedId)

/**
 * Returns the current active-user state + setter. Subscribes to global
 * changes so `<ProfileBadge />`, `<Library />`, `<Player />` all stay in sync
 * without prop-drilling.
 */
export function useActiveUser(): {
  user: User | null
  userId: string | null
  setUserId: (id: string | null) => void
  loading: boolean
} {
  const [userId, setUserIdState] = useState<string | null>(cachedId)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(!!cachedId)

  useEffect(() => {
    const fn = (id: string | null) => setUserIdState(id)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!userId) {
      setUser(null)
      setLoading(false)
      document.documentElement.removeAttribute('data-theme')
      return
    }
    setLoading(true)
    horizon.users.get(userId)
      .then(u => {
        if (!cancelled) {
          setUser(u)
          document.documentElement.setAttribute(
            'data-theme',
            u.preferences.theme === 'light' ? 'light' : 'dark',
          )
        }
      })
      .catch(() => { if (!cancelled) { setGlobal(null); setUser(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userId])

  const setUserId = useCallback((id: string | null) => setGlobal(id), [])
  return { user, userId, setUserId, loading }
}
