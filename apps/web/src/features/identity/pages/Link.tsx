import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView } from '@horizon/sdk'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../../../shared/ui/chrome/HorizonMark.tsx'
import Icon from '../../../shared/ui/chrome/Icon.tsx'
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
  const [household, setHousehold] = useState<HouseholdView | null>(null)
  const [granted, setGranted] = useState<Set<string>>(new Set())

  // A household owner can choose which of their household's profiles the linked
  // TV may act as; a plain member just approves themselves (no grant — the
  // server grants self).
  const isHouseholdOwner = !!household && !!user && household.ownerUserId === user.id

  useEffect(() => {
    let live = true
    horizon.households.me()
      .then(h => { if (live) { setHousehold(h); setGranted(new Set(h.members.map(m => m.id))) } })
      .catch(() => { /* not fatal — fall back to a self-only approve */ })
    return () => { live = false }
  }, [])

  async function approve() {
    const trimmed = code.trim()
    if (trimmed.length < 8) { setError('Enter the full code shown on your TV.'); return }
    setBusy(true)
    setError(null)
    try {
      if (isHouseholdOwner) {
        const ids = [...granted]
        if (ids.length === 0) { setError('Select at least one profile for this TV.'); setBusy(false); return }
        await horizon.auth.pairApprove(trimmed, ids)
      } else {
        await horizon.auth.pairApprove(trimmed)
      }
      setDone(true)
    } catch {
      setError('That code is invalid or has expired. Ask the TV to show a new code.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <HorizonMark size={56} withText />

        <div>
          {done ? (
            <>
              <div>
                <Icon name="check" size={28} />
              </div>
              <h1>Device linked</h1>
              <p>
                Your TV is signing in as {user?.name ?? 'you'}. You can close this page.
              </p>
              <button onClick={() => navigate('/', { replace: true })}>
                Back to Horizon
              </button>
            </>
          ) : (
            <>
              <div>
                <Icon name="tv" size={28} />
              </div>
              <h1>Link a TV</h1>
              <p>
                Enter the code shown on your TV to sign it in as {user?.name ?? 'you'}.
              </p>

              <input
                value={code}
                onChange={e => setCode(formatCode(e.target.value))}
                placeholder="ABCD-1234"
                aria-label="Code"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                onKeyDown={e => e.key === 'Enter' && approve()}
              />

              {isHouseholdOwner && household && (
                <fieldset>
                  <legend>Which profiles can use this TV?</legend>
                  {household.members.map(m => (
                    <label key={m.id}>
                      <input
                        type="checkbox"
                        checked={granted.has(m.id)}
                        onChange={e => setGranted(prev => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(m.id); else next.delete(m.id)
                          return next
                        })}
                      />
                      {m.name}
                    </label>
                  ))}
                </fieldset>
              )}

              {error && <p role="alert">{error}</p>}

              <button
                disabled={busy || code.replace('-', '').length < 8}
                onClick={approve}
              >
                {busy ? 'Linking…' : <>Link device <Icon name="chevron-right" size={14} /></>}
              </button>
            </>
          )}
        </div>
    </main>
  )
}
