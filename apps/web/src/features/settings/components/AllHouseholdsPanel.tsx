import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView, User } from '@horizon/sdk'
import './AllHouseholdsPanel.css'

function inviteLink(code: string): string {
  return `${window.location.origin}/join?code=${code}`
}

export default function AllHouseholdsPanel({ ownerUserId }: { ownerUserId: string }) {
  const [households, setHouseholds] = useState<HouseholdView[]>([])
  const [orphans, setOrphans] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<HouseholdView | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [hs, orph] = await Promise.all([horizon.households.all(), horizon.users.orphans()])
      setHouseholds(hs); setOrphans(orph)
    } catch { setError('Couldn’t load households.') }
  }, [])
  useEffect(() => { void load() }, [load])

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await fn(); await load() }
    catch { setError('Action failed.') }
    finally { setBusy(false) }
  }

  // True for the household that contains the server owner — never deletable.
  function isOwnerHousehold(h: HouseholdView): boolean {
    return h.members.some(m => m.id === ownerUserId)
  }

  return (
    <section className="settings__section">
      <p className="settings__section-title">All households</p>
      {error && <p className="settings__profile-error">{error}</p>}

      {households.map(h => (
        <div key={h.id} className="ahh__card">
          <div className="ahh__head">
            <span className="ahh__name">{h.name}</span>
            <button className="settings__token-replace" disabled={busy}
              onClick={() => run(async () => { const { code } = await horizon.invites.create({ kind: 'join', householdId: h.id }); setLink(inviteLink(code)) })}>
              Invite member
            </button>
            {!isOwnerHousehold(h) && (
              <button className="settings__token-cancel" aria-label={`Delete ${h.name}`} onClick={() => setConfirmDelete(h)}>Delete</button>
            )}
          </div>
          <ul className="ahh__members">
            {h.members.map(m => (
              <li key={m.id} className="ahh__member">
                <span>{m.name}</span>
                {m.id !== h.ownerUserId && (
                  <button className="settings__token-cancel" aria-label={`Remove ${m.name}`} disabled={busy}
                    onClick={() => run(() => horizon.users.delete(m.id))}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {link && (
        <div className="ahh__link"><code>{link}</code>
          <button className="settings__token-replace" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
        </div>
      )}

      <p className="settings__section-title">Unassigned profiles</p>
      {orphans.length === 0 && <p className="ahh__muted">None.</p>}
      <ul className="ahh__members">
        {orphans.map(o => (
          <li key={o.id} className="ahh__member">
            <span>{o.name}</span>
            <select className="settings__input" disabled={busy} defaultValue=""
              onChange={e => { const hid = e.target.value; if (hid) run(() => horizon.households.addMember(hid, o.id)) }}>
              <option value="" disabled>Move to…</option>
              {households.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <button className="settings__token-cancel" disabled={busy} onClick={() => run(() => horizon.users.delete(o.id))}>Delete</button>
          </li>
        ))}
      </ul>

      {confirmDelete && (
        <div className="ahh__dialog" role="dialog">
          <p>Delete “{confirmDelete.name}”? It has {confirmDelete.members.length} member(s).</p>
          <button className="settings__token-replace" disabled={busy}
            onClick={() => { const h = confirmDelete; setConfirmDelete(null); run(() => horizon.households.remove(h.id, true)) }}>
            Delete household + members
          </button>
          <button className="settings__token-replace" disabled={busy}
            onClick={() => { const h = confirmDelete; setConfirmDelete(null); run(() => horizon.households.remove(h.id, false)) }}>
            Keep members (unassign)
          </button>
          <button className="settings__token-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
        </div>
      )}
    </section>
  )
}
