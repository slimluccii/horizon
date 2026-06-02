import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../components/chrome/HorizonMark.tsx'
import Icon from '../components/chrome/Icon.tsx'
import type { User } from '@horizon/sdk'
import './Login.css'

/** Deterministic per-user colour so picker tiles are visually distinct.
 *  Mirrors ProfileBadgeButton so the same name always maps to the same accent
 *  across the app. */
function userColor(name: string): string {
  const palette = ['#0089FF', '#E34989', '#1FA47C', '#F5C518', '#9D5CFF', '#FA6A3C']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

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
      <div className="login">
        <div className="login__loading">Loading…</div>
      </div>
    )
  }

  if (forceSetPassword && user) {
    return (
      <div className="login">
        <div className="login__bg" />
        <div className="login__content">
          <ForcedSetPassword
            user={user}
            onDone={async () => { await refresh(); navigate('/', { replace: true }) }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="login">
      <div className="login__bg" />
      <div className="login__content">
        <div className="login__header">
          <HorizonMark size={44} />
          <h1 className="login__title">Welcome back</h1>
          <p className="login__subtitle">
            {selected ? `Enter ${selected.name}'s password` : 'Choose a profile to sign in'}
          </p>
        </div>

        {!selected ? (
          <div className="login__grid">
            {users.map(u => {
              const color = userColor(u.name)
              const initial = u.avatar ?? u.name.charAt(0).toUpperCase()
              return (
                <button
                  key={u.id}
                  className="login__profile"
                  onClick={() => { setSelected(u); setPassword(''); setError(null) }}
                >
                  <div
                    className="login__avatar"
                    style={{ background: color, boxShadow: `0 24px 60px ${color}66` }}
                  >
                    {initial}
                  </div>
                  <div className="login__name">{u.name}</div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="login__form">
            <div
              className="login__avatar login__avatar--sm"
              style={{ background: userColor(selected.name) }}
            >
              {selected.avatar ?? selected.name.charAt(0).toUpperCase()}
            </div>
            <input
              className="login__input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              autoComplete="current-password"
              onKeyDown={e => e.key === 'Enter' && login()}
            />
            {error && <div className="login__error">{error}</div>}
            <button className="login__submit" disabled={busy || !password} onClick={login}>
              {busy ? 'Signing in…' : <>Sign in <Icon name="chevron-right" size={14} color="#000" /></>}
            </button>
            <button
              className="login__back"
              type="button"
              disabled={busy}
              onClick={() => { setSelected(null); setPassword(''); setError(null) }}
            >
              Choose a different profile
            </button>
          </div>
        )}
      </div>
    </div>
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
    <div className="login__form">
      <div className="login__header">
        <HorizonMark size={44} />
        <h1 className="login__title">Set a password</h1>
        <p className="login__subtitle">
          {user.name}, secure your profile before continuing.
        </p>
      </div>
      <input
        className="login__input"
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="New password"
        autoFocus
        autoComplete="new-password"
      />
      <input
        className="login__input"
        type="password"
        value={confirm}
        onChange={e => setConfirm(e.target.value)}
        placeholder="Confirm password"
        autoComplete="new-password"
        onKeyDown={e => e.key === 'Enter' && submit()}
      />
      {error && <div className="login__error">{error}</div>}
      <button className="login__submit" disabled={busy} onClick={submit}>
        {busy ? 'Saving…' : <>Continue <Icon name="chevron-right" size={14} color="#000" /></>}
      </button>
    </div>
  )
}
