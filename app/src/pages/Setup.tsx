import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🚀', '🎮', '🎬', '🎨', '👤']

export default function Setup() {
  const navigate = useNavigate()
  const { setUserId } = useActiveUser()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) { setError('Name required'); return }
    setBusy(true); setError(null)
    try {
      const u = await horizon.users.create({ name: name.trim(), avatar })
      setUserId(u.id)
      navigate('/', { replace: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'name-taken' ? 'Profile name already in use' : String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: '32px 24px', background: '#1a1a1a', borderRadius: 12, border: '1px solid #2a2a2a' }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Welcome to Horizon</h1>
      <p style={{ color: '#888', marginBottom: 24 }}>Create your first profile to get started.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, color: '#bbb' }}>Name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={40}
            style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid #333', background: '#0a0a0a', color: '#fff' }}
          />
        </label>
        <div>
          <div style={{ fontSize: 13, color: '#bbb', marginBottom: 8 }}>Avatar</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {AVATARS.map(a => (
              <button key={a} onClick={() => setAvatar(a === avatar ? null : a)}
                style={{
                  width: 42, height: 42, fontSize: 22, borderRadius: 8,
                  border: avatar === a ? '2px solid #fff' : '1px solid #333',
                  background: '#0a0a0a', color: '#fff', cursor: 'pointer',
                }}>{a}</button>
            ))}
          </div>
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}
        <button disabled={busy || !name.trim()} onClick={submit}
          style={{ padding: '10px 16px', borderRadius: 6, border: 'none', background: '#fff', color: '#000', cursor: 'pointer', fontWeight: 600 }}>
          {busy ? 'Creating…' : 'Get started'}
        </button>
      </div>
    </div>
  )
}
