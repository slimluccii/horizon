import { useState } from 'react'
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import './Redeem.css'

const MIN_PASSWORD_LEN = 8

function formatCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

function messageFor(code: string | undefined): string {
  switch (code) {
    case 'invite-not-found': return 'That invite is invalid.'
    case 'invite-expired': return 'That invite has expired — ask for a new one.'
    case 'name-taken': return 'That name is taken — try another.'
    case 'weak-password': return 'Use at least 8 characters.'
    case 'rate-limited': return 'Too many attempts — wait a moment and retry.'
    default: return 'Could not redeem the invite.'
  }
}

export default function Redeem() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { refresh, user, loading } = useActiveUser()
  const [code, setCode] = useState(formatCode(params.get('code') ?? ''))
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (password.length < MIN_PASSWORD_LEN) { setError('Use at least 8 characters.'); return }
    if (!name.trim() || code.replace(/[^A-Z0-9]/g, '').length < 8) { setError('Enter the invite code and a name.'); return }
    setBusy(true); setError(null)
    try {
      await horizon.invites.redeem({ code, name: name.trim(), password })
      await refresh()
      navigate('/', { replace: true })
    } catch (e) {
      setError(messageFor((e as { code?: string }).code))
    } finally { setBusy(false) }
  }

  // Already signed in → don't let a redeem silently replace the active session
  // with a brand-new account. The redeemer must be a fresh (unauthenticated)
  // visitor; a logged-in user is sent home.
  if (!loading && user) return <Navigate to="/" replace />

  return (
    <div className="redeem">
      <div className="redeem__card">
        <h1>Join the server</h1>
        <label className="redeem__label">Invite code
          <input className="redeem__input" value={code} onChange={e => setCode(formatCode(e.target.value))} />
        </label>
        <label className="redeem__label">Your name
          <input className="redeem__input" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="redeem__label">Password
          <input className="redeem__input" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        <button className="redeem__submit" disabled={busy} onClick={submit}>Create account</button>
        {error && <p className="redeem__error">{error}</p>}
      </div>
    </div>
  )
}
