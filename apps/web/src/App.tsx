import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Library from './pages/Library.tsx'
import Player from './pages/Player.tsx'
import Show from './pages/Show.tsx'
import Setup from './pages/Setup.tsx'
import Login from './pages/Login.tsx'
import Link from './pages/Link.tsx'
import Settings from './pages/Settings.tsx'
import { useActiveUser } from './hooks/useActiveUser.ts'
import { horizon } from './horizon.ts'

function Guard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useActiveUser()
  const [hasUsers, setHasUsers] = useState<boolean | null>(null)
  const location = useLocation()

  // The user list drives the first-run /setup gate. It's an unauthenticated
  // allowlisted read on the server, so it resolves even before login.
  useEffect(() => {
    horizon.users.list().then(list => setHasUsers(list.length > 0)).catch(() => setHasUsers(false))
  }, [user])

  if (loading || hasUsers === null) return null
  // No profiles at all → first-run wizard (which sets the owner password).
  if (!hasUsers && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  // Profiles exist but the caller has no session → log in.
  if (hasUsers && !user && location.pathname !== '/login' && location.pathname !== '/setup') {
    return <Navigate to="/login" replace />
  }
  // Authenticated but never set a password (migrated owner / admin-created member)
  // → forced set-password screen, served by /login.
  if (user && !user.hasPassword && location.pathname !== '/login' && location.pathname !== '/setup') {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/link" element={<Guard><Link /></Guard>} />
      <Route path="/" element={<Guard><Library /></Guard>} />
      <Route path="/show/:showId" element={<Guard><Show /></Guard>} />
      <Route path="/play/:mediaId" element={<Guard><Player /></Guard>} />
      <Route path="/settings" element={<Guard><Settings /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
