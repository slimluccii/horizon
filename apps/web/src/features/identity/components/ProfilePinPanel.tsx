import { useEffect, useState, type FormEvent } from 'react'
import type { User } from '@horizon/sdk'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'

type Editing = { profile: User; action: 'set' | 'remove' }

/** Settings → Profile PIN: the optional PIN a shared device asks for before a profile can be picked. */
export default function ProfilePinPanel() {
  const { user, shared, canShare } = useActiveUser()
  const [people, setPeople] = useState<User[]>(user ? [user] : [])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [pin, setPin] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only the head of a household sets a PIN for someone else, so only they need the list.
  useEffect(() => {
    if (shared || !canShare) return
    let stale = false
    horizon.users.list().then(list => { if (!stale) setPeople(list) }).catch(() => {})
    return () => { stale = true }
  }, [shared, canShare])

  if (shared || !user) return null

  function edit(next: Editing | null) {
    setEditing(next)
    setPin('')
    setPassword('')
    setError(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    setBusy(true)
    setError(null)
    try {
      const { hasPin } = await horizon.auth.setProfilePin({
        userId: editing.profile.id,
        pin: editing.action === 'set' ? pin : null,
        password,
      })
      setPeople(list => list.map(p => (p.id === editing.profile.id ? { ...p, hasPin } : p)))
      edit(null)
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'invalid-credentials' ? 'Your password is incorrect.' : 'Could not save the PIN.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="profile-pin-heading">
      <h2 id="profile-pin-heading">Profile PIN</h2>
      <p>Optional. A shared device asks for it before the profile can be picked. Your own devices never ask.</p>
      <ul>
        {people.map(p => (
          <li key={p.id}>
            <span>{p.name}</span> <span>{p.hasPin ? 'Has a PIN' : 'No PIN'}</span>{' '}
            <button type="button" onClick={() => edit({ profile: p, action: 'set' })}>
              {p.hasPin ? 'Change the PIN' : 'Set a PIN'}
            </button>
            {p.hasPin && (
              <button type="button" onClick={() => edit({ profile: p, action: 'remove' })}>Remove the PIN</button>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <form onSubmit={save}>
          <p>{editing.action === 'set' ? `PIN for ${editing.profile.name}` : `Remove the PIN of ${editing.profile.name}`}</p>
          {editing.action === 'set' && (
            <p>
              <label htmlFor="profile-pin-new">New PIN</label>
              <input
                id="profile-pin-new"
                type="password"
                inputMode="numeric"
                pattern="\d{4,8}"
                title="4 to 8 digits"
                autoComplete="off"
                required
                value={pin}
                onChange={e => setPin(e.target.value)}
              />
            </p>
          )}
          <p>
            <label htmlFor="profile-pin-password">Your password</label>
            <input
              id="profile-pin-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{editing.action === 'set' ? 'Save' : 'Remove'}</button>
          <button type="button" onClick={() => edit(null)}>Cancel</button>
        </form>
      )}
    </section>
  )
}
