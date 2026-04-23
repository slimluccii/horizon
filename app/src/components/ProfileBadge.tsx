import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { horizon } from '../horizon.ts'

export default function ProfileBadge() {
  const { user, setUserId } = useActiveUser()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  if (!user) return null

  async function deleteProfile() {
    if (!user || !confirm(`Delete profile "${user.name}"? Watch history is lost.`)) return
    await horizon.users.delete(user.id)
    setUserId(null)
    navigate('/profiles')
  }

  return (
    <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(0,0,0,0.7)', border: '1px solid #444', borderRadius: 20,
          padding: '4px 12px 4px 4px', cursor: 'pointer', color: '#fff',
        }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#2a2a2a',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>
          {user.avatar ?? user.name.charAt(0).toUpperCase()}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, marginTop: 6,
                      background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
                      minWidth: 160, padding: 4 }}>
          <button onClick={() => navigate('/profiles')}
            style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: '#fff', textAlign: 'left', cursor: 'pointer', fontSize: 13 }}>
            Switch profile
          </button>
          <button onClick={deleteProfile}
            style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: '#ef4444', textAlign: 'left', cursor: 'pointer', fontSize: 13 }}>
            Delete profile
          </button>
        </div>
      )}
    </div>
  )
}
