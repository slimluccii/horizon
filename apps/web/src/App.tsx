import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Library from './pages/Library.tsx'
import Player from './pages/Player.tsx'
import Show from './pages/Show.tsx'
import Setup from './pages/Setup.tsx'
import ProfilePicker from './pages/ProfilePicker.tsx'
import Settings from './pages/Settings.tsx'
import { useActiveUser } from './hooks/useActiveUser.ts'
import { horizon } from './horizon.ts'

function Guard({ children }: { children: React.ReactNode }) {
  const { userId, loading } = useActiveUser()
  const [hasUsers, setHasUsers] = useState<boolean | null>(null)
  const location = useLocation()

  useEffect(() => {
    horizon.users.list().then(list => setHasUsers(list.length > 0))
  }, [userId])

  if (loading || hasUsers === null) return null
  if (!hasUsers && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  if (hasUsers && !userId && location.pathname !== '/profiles' && location.pathname !== '/setup') {
    return <Navigate to="/profiles" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/profiles" element={<ProfilePicker />} />
      <Route path="/" element={<Guard><Library /></Guard>} />
      <Route path="/show/:showId" element={<Guard><Show /></Guard>} />
      <Route path="/play/:mediaId" element={<Guard><Player /></Guard>} />
      <Route path="/settings" element={<Guard><Settings /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
