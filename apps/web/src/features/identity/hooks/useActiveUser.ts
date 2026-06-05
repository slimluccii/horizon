import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { User } from '@horizon/sdk'

/**
 * Identity is now owned by the server session, not the client. The web rides
 * the httpOnly `hz_session` cookie (set by `auth.login`), so the active user is
 * whatever `auth.me()` resolves — there is no `X-Horizon-User` id to stash.
 *
 * A single module-level cache + listener set keeps every consumer
 * (`<ProfileBadgeButton />`, `<Library />`, `<Player />`, settings) in sync
 * without prop-drilling, mirroring the previous hook's fan-out. `me()` runs once
 * at module load so the first paint can already have an identity in flight; a
 * 401 leaves `cachedUser` null and `loading` false, which is the Guard's signal
 * to redirect to /login.
 */

let cachedUser: User | null = null
let loaded = false               // has the initial me() settled at least once?
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

function applyTheme(user: User | null) {
  if (typeof document === 'undefined') return
  if (user) {
    document.documentElement.setAttribute(
      'data-theme',
      user.preferences.theme === 'light' ? 'light' : 'dark',
    )
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

/**
 * Resolve the caller from the session cookie/bearer. A 401 (or any failure)
 * clears the cached user — the Guard then redirects to /login. De-duplicated so
 * concurrent mounts share one request.
 */
function refreshGlobal(): Promise<void> {
  if (inflight) return inflight
  inflight = horizon.auth.me()
    .then(u => { cachedUser = u; applyTheme(u) })
    .catch(() => { cachedUser = null; applyTheme(null) })
    .finally(() => { loaded = true; inflight = null; emit() })
  return inflight
}

// Kick the first resolve at module load so a request is in flight before the
// first hook mounts.
void refreshGlobal()

/**
 * Active-user state sourced from `auth.me()`. `userId`/`user`/`loading` keep
 * their previous shape so existing consumers are unchanged; identity now flows
 * from the server session rather than localStorage.
 */
export function useActiveUser(): {
  user: User | null
  userId: string | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
  logoutAll: () => Promise<void>
  /** Deprecated. Identity is owned by the session now — kept as a thin shim so
   *  legacy callers compile. `null` logs out; a non-null id just re-resolves. */
  setUserId: (id: string | null) => void
} {
  const [, force] = useState(0)

  useEffect(() => {
    const fn = () => force(n => n + 1)
    listeners.add(fn)
    // If the initial resolve raced ahead of this mount, sync immediately.
    if (loaded) fn()
    return () => { listeners.delete(fn) }
  }, [])

  const refresh = useCallback(() => refreshGlobal(), [])

  const logout = useCallback(async () => {
    try {
      await horizon.auth.logout()
    } finally {
      cachedUser = null
      applyTheme(null)
      emit()
    }
  }, [])

  const logoutAll = useCallback(async () => {
    try {
      await horizon.auth.logoutAll()
    } finally {
      cachedUser = null
      applyTheme(null)
      emit()
    }
  }, [])

  const setUserId = useCallback((id: string | null) => {
    if (id === null) void logout()
    else void refreshGlobal()
  }, [logout])

  return {
    user: cachedUser,
    userId: cachedUser?.id ?? null,
    loading: !loaded,
    refresh,
    logout,
    logoutAll,
    setUserId,
  }
}
