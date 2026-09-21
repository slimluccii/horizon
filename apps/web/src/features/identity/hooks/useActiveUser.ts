import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { DeviceSession, ProfileSummary, User } from '@horizon/sdk'
import { pickedProfile, rememberPickedProfile } from '../device.ts'

/**
 * Identity is owned by the server session. The web rides the httpOnly
 * `hz_session` cookie (set by `auth.login`), and `auth.session()` says who
 * logged in on this device, which profile is in use and which can be picked.
 * `user` is the profile in use, carrying the role the session really has, so a
 * shared device never shows admin screens.
 *
 * A single module-level cache + listener set keeps every consumer
 * (`<ProfileBadgeButton />`, `<Library />`, `<Player />`, settings) in sync
 * without prop-drilling. The session is read once at module load so the first
 * paint can already have an identity in flight; a 401 leaves `cachedUser` null
 * and `loading` false, which is the Guard's signal to redirect to /login.
 */

let cachedUser: User | null = null
let cachedSession: DeviceSession | null = null
let loaded = false               // has the initial session read settled at least once?
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

function apply(session: DeviceSession | null) {
  cachedSession = session
  cachedUser = session ? { ...session.profile, role: session.role } : null
  applyTheme(cachedUser)
}

async function loadSession(): Promise<DeviceSession> {
  horizon.setProfile(pickedProfile())
  try {
    return await horizon.auth.session()
  } catch (err) {
    // The remembered profile may have left the household; fall back to the person who logged in.
    if (!pickedProfile()) throw err
    rememberPickedProfile(null)
    horizon.setProfile(null)
    return horizon.auth.session()
  }
}

/**
 * Resolve the caller from the session cookie/bearer. A 401 (or any failure)
 * clears the cached user — the Guard then redirects to /login. De-duplicated so
 * concurrent mounts share one request.
 */
function refreshGlobal(): Promise<void> {
  if (inflight) return inflight
  inflight = loadSession()
    .then(apply)
    .catch(() => apply(null))
    .finally(() => { loaded = true; inflight = null; emit() })
  return inflight
}

// Kick the first resolve at module load so a request is in flight before the
// first hook mounts.
void refreshGlobal()

/**
 * Active-user state sourced from `auth.session()`. `userId`/`user`/`loading`
 * keep their previous shape so existing consumers are unchanged.
 */
export function useActiveUser(): {
  user: User | null
  userId: string | null
  /** Who logged in on this device; on a shared device not necessarily the profile in use. */
  principal: User | null
  shared: boolean
  canShare: boolean
  /** Every profile that can be picked on this device. */
  profiles: ProfileSummary[]
  /** True on a shared device until someone has picked a profile in this tab. */
  needsProfilePick: boolean
  pickProfile: (id: string) => Promise<void>
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
      rememberPickedProfile(null)
      horizon.setProfile(null)
      apply(null)
      emit()
    }
  }, [])

  const logoutAll = useCallback(async () => {
    try {
      await horizon.auth.logoutAll()
    } finally {
      rememberPickedProfile(null)
      horizon.setProfile(null)
      apply(null)
      emit()
    }
  }, [])

  const pickProfile = useCallback(async (id: string) => {
    rememberPickedProfile(id)
    await refreshGlobal()
  }, [])

  const setUserId = useCallback((id: string | null) => {
    if (id === null) void logout()
    else void refreshGlobal()
  }, [logout])

  return {
    user: cachedUser,
    userId: cachedUser?.id ?? null,
    principal: cachedSession?.principal ?? null,
    shared: cachedSession?.shared ?? false,
    canShare: cachedSession?.canShare ?? false,
    profiles: cachedSession?.profiles ?? [],
    needsProfilePick: !!cachedSession?.shared && !pickedProfile(),
    pickProfile,
    loading: !loaded,
    refresh,
    logout,
    logoutAll,
    setUserId,
  }
}
