import { Routes, Route, Navigate } from 'react-router-dom'
import Library from './pages/Library.tsx'
import Player from './pages/Player.tsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Library />} />
      <Route path="/play/:mediaId" element={<Player />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
