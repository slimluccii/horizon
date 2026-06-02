import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../components/chrome/HorizonMark.tsx'
import Icon from '../components/chrome/Icon.tsx'
import './Link.css'

/** Normalise the typed code to the server's `ABCD-1234` shape: upper-case,
 *  strip everything but A–Z/0–9, re-insert the dash after 4 chars. Lets the
 *  user paste with or without the dash and in any case. */
function formatCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned
}

/**
 * Device-link screen. An already-authenticated phone/web user types the
 * pairing code a TV is displaying and approves it via `auth.pairApprove`; the
 * TV (which is polling) then receives a session bound to this user. The code is
 * short-lived and single-use — an expired/consumed code surfaces a generic
 * "couldn't link" message.
 */
export default function Link() {
  const navigate = useNavigate()
  const { user } = useActiveUser()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function approve() {
    const trimmed = code.trim()
    if (trimmed.length < 8) { setError('Enter the full code shown on your TV.'); return }
    setBusy(true)
    setError(null)
    try {
      await horizon.auth.pairApprove(trimmed)
      setDone(true)
    } catch {
      setError('That code is invalid or has expired. Ask the TV to show a new code.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="link">
      <div className="link__bg" />
      <div className="link__content">
        <HorizonMark size={56} withText />

        <div className="link__card">
          {done ? (
            <>
              <div className="link__icon link__icon--ok">
                <Icon name="check" size={28} color="var(--accent)" />
              </div>
              <h1 className="link__title">Device linked</h1>
              <p className="link__subtitle">
                Your TV is signing in as {user?.name ?? 'you'}. You can close this page.
              </p>
              <button className="link__submit" onClick={() => navigate('/', { replace: true })}>
                Back to Horizon
              </button>
            </>
          ) : (
            <>
              <div className="link__icon">
                <Icon name="tv" size={28} color="var(--muted-hi)" />
              </div>
              <h1 className="link__title">Link a TV</h1>
              <p className="link__subtitle">
                Enter the code shown on your TV to sign it in as {user?.name ?? 'you'}.
              </p>

              <input
                className="link__input"
                value={code}
                onChange={e => setCode(formatCode(e.target.value))}
                placeholder="ABCD-1234"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                onKeyDown={e => e.key === 'Enter' && approve()}
              />

              {error && <div className="link__error">{error}</div>}

              <button
                className="link__submit"
                disabled={busy || code.replace('-', '').length < 8}
                onClick={approve}
              >
                {busy ? 'Linking…' : <>Link device <Icon name="chevron-right" size={14} color="#000" /></>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
