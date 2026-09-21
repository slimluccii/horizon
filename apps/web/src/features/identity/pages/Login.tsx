import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../../../shared/ui/chrome/HorizonMark.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
import type { User } from '@horizon/sdk'
import { wasDeviceAsked } from '../device.ts'

/** One message for every failure: unknown name, wrong password or lockout. The server is as vague on purpose. */
const LOGIN_ERROR = 'Incorrect name or password, or the account is temporarily locked.'

/**
 * Login screen. Nobody is listed before login: you type your name and password.
 * A user who is logged in but never set a password gets the set-password form.
 */
export default function Login() {
  const navigate = useNavigate()
  const { principal, loading, refresh } = useActiveUser()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function login(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { canShareDevice } = await horizon.auth.login(name.trim(), password)
      await refresh()
      navigate(canShareDevice && !wasDeviceAsked() ? '/device' : '/', { replace: true })
    } catch {
      setError(LOGIN_ERROR)
      setBusy(false)
    }
  }

  if (loading) return <p>Loading…</p>

  if (principal && !principal.hasPassword) {
    return (
      <main>
        <ForcedSetPassword
          user={principal}
          onDone={async () => { await refresh(); navigate('/', { replace: true }) }}
        />
      </main>
    )
  }

  return (
    <main>
      <HorizonMark size={44} />
      <h1>Welcome back</h1>
      <form onSubmit={login}>
        <p>
          <label htmlFor="login-name">Name</label>
          <input id="login-name" value={name} onChange={e => setName(e.target.value)} autoComplete="username" autoFocus required />
        </p>
        <p>
          <label htmlFor="login-password">Password</label>
          <input id="login-password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : <>Sign in <Icon name="chevron-right" size={14} /></>}
        </button>
      </form>
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
