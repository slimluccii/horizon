import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Library from '../features/library/pages/Library.tsx'
import Player from '../features/playback/pages/Player.tsx'
import Show from '../features/library/pages/Show.tsx'
import Collection from '../features/library/pages/Collection.tsx'
import Search from '../features/library/pages/Search.tsx'
import Setup from '../features/identity/pages/Setup.tsx'
import Login from '../features/identity/pages/Login.tsx'
import Link from '../features/identity/pages/Link.tsx'
import Device from '../features/identity/pages/Device.tsx'
import Profiles from '../features/identity/pages/Profiles.tsx'
import Redeem from '../features/identity/pages/Redeem.tsx'
import Settings from '../features/settings/pages/Settings.tsx'
import { useActiveUser } from '../features/identity/hooks/useActiveUser.ts'
import { horizon } from './horizon.ts'

function Guard({ children }: { children: React.ReactNode }) {
  const { user, principal, needsProfilePick, loading } = useActiveUser()
  const [hasUsers, setHasUsers] = useState<boolean | null>(null)
  const location = useLocation()

  // All the server tells anyone before login is whether the first account still has to be made.
  useEffect(() => {
    horizon.auth.state().then(s => setHasUsers(!s.setupRequired)).catch(() => setHasUsers(true))
  }, [user])

  // Routes reachable without a session. `/join` lets an invited friend create
  // their account before they have any identity.
  const PUBLIC = ['/login', '/setup', '/join']

  if (loading || hasUsers === null) return null
  // No profiles at all → first-run wizard (which sets the owner password).
  if (!hasUsers && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  // Profiles exist but the caller has no session → log in.
  if (hasUsers && !user && !PUBLIC.includes(location.pathname)) {
    return <Navigate to="/login" replace />
  }
  // Authenticated but never set a password (migrated owner / admin-created member)
  // → forced set-password screen, served by /login.
  // This is about the person who logged in: a profile without a password is fine on a shared device.
  if (principal && !principal.hasPassword && !PUBLIC.includes(location.pathname)) {
    return <Navigate to="/login" replace />
  }
  if (user && needsProfilePick && !['/profiles', '/device'].includes(location.pathname)) {
    return <Navigate to="/profiles" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/join" element={<Redeem />} />
      <Route path="/device" element={<Guard><Device /></Guard>} />
      <Route path="/profiles" element={<Guard><Profiles /></Guard>} />
      <Route path="/link" element={<Guard><Link /></Guard>} />
      <Route path="/" element={<Guard><Library /></Guard>} />
      <Route path="/show/:showId" element={<Guard><Show /></Guard>} />
      <Route path="/collection/:collectionId" element={<Guard><Collection /></Guard>} />
      <Route path="/search" element={<Guard><Search /></Guard>} />
      <Route path="/play/:mediaId" element={<Guard><Player /></Guard>} />
      <Route path="/settings" element={<Guard><Settings /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
