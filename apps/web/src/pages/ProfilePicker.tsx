import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../components/chrome/HorizonMark.tsx'
import Icon from '../components/chrome/Icon.tsx'
import type { User } from '@horizon/sdk'
import './ProfilePicker.css'

/** Deterministic per-user colour so picker tiles are visually distinct. */
function userColor(name: string): string {
  const palette = ['#0089FF', '#E34989', '#1FA47C', '#F5C518', '#9D5CFF', '#FA6A3C']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

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

  if (loading) {
    return (
      <div className="pp">
        <div className="pp__loading">Loading profiles…</div>
      </div>
    )
  }

  return (
    <div className="pp">
      <div className="pp__bg" />
      <div className="pp__content">
        <div className="pp__header">
          <HorizonMark size={44} />
          <h1 className="pp__title">Who&apos;s watching?</h1>
          <p className="pp__subtitle">Pick a profile to continue</p>
        </div>

        <div className="pp__grid">
          {users.map(u => {
            const color = userColor(u.name)
            const initial = u.avatar ?? u.name.charAt(0).toUpperCase()
            return (
              <button key={u.id} className="pp__profile" onClick={() => pick(u)}>
                <div
                  className="pp__avatar"
                  style={{ background: color, boxShadow: `0 24px 60px ${color}66` }}
                >
                  {initial}
                </div>
                <div className="pp__name">{u.name}</div>
              </button>
            )
          })}

          <button
            className="pp__add"
            onClick={() => setAdding(a => !a)}
            aria-label="Add profile"
          >
            <div className="pp__add-avatar">
              <Icon name="plus" size={36} color="var(--muted-hi)" />
            </div>
            <div className="pp__name pp__name--muted">Add profile</div>
          </button>
        </div>

        {adding && (
          <div className="pp__add-form">
            <input
              className="pp__input"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Profile name"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && addUser()}
            />
            <button className="pp__create" onClick={addUser}>Create</button>
          </div>
        )}
      </div>
    </div>
  )
}
