import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import type { User } from '@horizon/sdk'

export default function ProfilePicker() {
  const navigate = useNavigate()
  const { setUserId } = useActiveUser()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    horizon.users.list()
      .then(setUsers)
      .finally(() => setLoading(false))
  }, [])

  function pick(u: User) {
    setUserId(u.id)
    navigate('/', { replace: true })
  }

  async function addUser() {
    if (!newName.trim()) return
    const u = await horizon.users.create({ name: newName.trim(), avatar: null })
    setUsers([...users, u])
    setNewName('')
    setAdding(false)
  }

  if (loading) return <div style={{ color: '#888', padding: 40 }}>Loading profiles…</div>

  return (
    <div style={{ maxWidth: 800, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>Who's watching?</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 16 }}>
        {users.map(u => (
          <button key={u.id} onClick={() => pick(u)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
              background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 12,
              padding: 20, cursor: 'pointer', color: '#fff',
            }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#2a2a2a',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              {u.avatar ?? u.name.charAt(0).toUpperCase()}
            </div>
            <div style={{ fontWeight: 600 }}>{u.name}</div>
          </button>
        ))}
        <button onClick={() => setAdding(true)}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: '2px dashed #333', borderRadius: 12,
            padding: 20, cursor: 'pointer', color: '#888', minHeight: 150,
          }}>+ Add profile</button>
      </div>
      {adding && (
        <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Profile name"
            style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0a', color: '#fff', flex: 1 }} />
          <button onClick={addUser}
            style={{ padding: '10px 16px', borderRadius: 6, border: 'none', background: '#fff', color: '#000', cursor: 'pointer' }}>Create</button>
        </div>
      )}
    </div>
  )
}
