import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../../../shared/ui/chrome/HorizonMark.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
import type { User } from '@horizon/sdk'
/** Generic, non-enumerating message for any login failure (wrong password,
 *  unknown user, lockout). The server is deliberately vague; the UI matches. */
const LOGIN_ERROR = 'Incorrect password, or the account is temporarily locked. Try again shortly.'

/**
 * Login screen. Two phases:
 *
 *  1. Profile picker — pick a profile, then enter its password → `auth.login`,
 *     which sets the httpOnly `hz_session` cookie and lands you home.
 *  2. Forced set-password — if `auth.me()` already resolves a user who has never
 *     set a password (a migrated owner or an admin-created member), we render a
 *     set-password form instead. Completing it re-issues the session and enters
 *     the app.
 *
 * Replaces the old localStorage profile picker: identity now lives in the
 * server session, not an `X-Horizon-User` header.
 */
export default function Login() {
  const navigate = useNavigate()
  const { user, loading: meLoading, refresh } = useActiveUser()

  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<User | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    horizon.users.list()
      .then(setUsers)
      .catch(() => setError('Could not load profiles. Is the server reachable?'))
      .finally(() => setLoading(false))
  }, [])

  // An authenticated user who has never set a password is forced through the
  // set-password screen below — don't show the picker.
  const forceSetPassword = !!user && !user.hasPassword

  async function login() {
    if (!selected || !password) return
    setBusy(true)
    setError(null)
    try {
      await horizon.auth.login(selected.name, password)
      await refresh()
      navigate('/', { replace: true })
    } catch {
      // Never distinguish wrong-user from wrong-password from lockout.
      setError(LOGIN_ERROR)
      setBusy(false)
    }
  }

  if (loading || meLoading) {
    return (
      <div>
        <div>Loading…</div>
      </div>
    )
  }

  if (forceSetPassword && user) {
    return (
      <main>
        <ForcedSetPassword
          user={user}
          onDone={async () => { await refresh(); navigate('/', { replace: true }) }}
        />
      </main>
    )
  }

  return (
    <main>
      <HorizonMark size={44} />
      <h1>Welcome back</h1>
      <p>
        {selected ? `Enter ${selected.name}'s password` : 'Choose a profile to sign in'}
      </p>

      {!selected ? (
        <ul>
          {users.map(u => {
            const initial = u.avatar ?? u.name.charAt(0).toUpperCase()
            return (
              <li key={u.id}>
                <button
                  onClick={() => { setSelected(u); setPassword(''); setError(null) }}
                >
                  <span aria-hidden="true">{initial}</span>
                  <span>{u.name}</span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div>
          <span aria-hidden="true">
            {selected.avatar ?? selected.name.charAt(0).toUpperCase()}
          </span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              autoComplete="current-password"
              onKeyDown={e => e.key === 'Enter' && login()}
            />
            {error && <p role="alert">{error}</p>}
            <button disabled={busy || !password} onClick={login}>
              {busy ? 'Signing in…' : <>Sign in <Icon name="chevron-right" size={14} /></>}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setSelected(null); setPassword(''); setError(null) }}
            >
              Choose a different profile
            </button>
        </div>
      )}
    </main>
  )
}

/** Forced first-password form for an authenticated user whose password was
 *  never set. No old password is required — the session already proves
 *  identity. */
function ForcedSetPassword({ user, onDone }: { user: User; onDone: () => void | Promise<void> }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (password.length < 8) { setError('Use at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    setError(null)
    try {
      await horizon.auth.setPassword({ newPassword: password })
      await onDone()
    } catch {
      setError('Could not set the password. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div>
      <div>
        <HorizonMark size={44} />
        <h1>Set a password</h1>
        <p>
          {user.name}, secure your profile before continuing.
        </p>
      </div>
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="New password"
        autoFocus
        autoComplete="new-password"
      />
      <input
        type="password"
        value={confirm}
        onChange={e => setConfirm(e.target.value)}
        placeholder="Confirm password"
        autoComplete="new-password"
        onKeyDown={e => e.key === 'Enter' && submit()}
      />
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={submit}>
        {busy ? 'Saving…' : <>Continue <Icon name="chevron-right" size={14} /></>}
      </button>
    </div>
  )
}
