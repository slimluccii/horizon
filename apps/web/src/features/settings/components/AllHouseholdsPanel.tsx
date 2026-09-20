import { useEffect, useState, useCallback } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView, User } from '@horizon/sdk'
function inviteLink(code: string): string {
  return `${window.location.origin}/join?code=${code}`
}

export default function AllHouseholdsPanel() {
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
  // Keyed off the server ROLE present in the household (not the viewer), so the
  // guard is correct regardless of which admin is looking (matches the server's
  // hasServerOwner 409 guard).
  function isOwnerHousehold(h: HouseholdView): boolean {
    return h.members.some(m => (m as { role?: string }).role === 'owner')
  }

  return (
    <section>
      <p>All households</p>
      {error && <p>{error}</p>}

      {households.map(h => (
        <div key={h.id}>
          <div>
            <span>{h.name}</span>
            <button disabled={busy}
              onClick={() => run(async () => { const { code } = await horizon.invites.create({ kind: 'join', householdId: h.id }); setLink(inviteLink(code)) })}>
              Invite member
            </button>
            {!isOwnerHousehold(h) && (
              <button aria-label={`Delete ${h.name}`} onClick={() => setConfirmDelete(h)}>Delete</button>
            )}
          </div>
          <ul>
            {h.members.map(m => (
              <li key={m.id}>
                <span>{m.name}</span>
                {m.id !== h.ownerUserId && (
                  <button aria-label={`Remove ${m.name}`} disabled={busy}
                    onClick={() => run(() => horizon.users.delete(m.id))}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {link && (
        <div><code>{link}</code>
          <button onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
        </div>
      )}

      <p>Unassigned profiles</p>
      {orphans.length === 0 && <p>None.</p>}
      <ul>
        {orphans.map(o => (
          <li key={o.id}>
            <span>{o.name}</span>
            <select disabled={busy} defaultValue=""
              onChange={e => { const hid = e.target.value; if (hid) run(() => horizon.households.addMember(hid, o.id)) }}>
              <option value="" disabled>Move to…</option>
              {households.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <button disabled={busy} onClick={() => run(() => horizon.users.delete(o.id))}>Delete</button>
          </li>
        ))}
      </ul>

      {confirmDelete && (
        <div role="dialog">
          <p>Delete “{confirmDelete.name}”? It has {confirmDelete.members.length} member(s).</p>
          <button disabled={busy}
            onClick={() => { const h = confirmDelete; setConfirmDelete(null); run(() => horizon.households.remove(h.id, true)) }}>
            Delete household + members
          </button>
          <button disabled={busy}
            onClick={() => { const h = confirmDelete; setConfirmDelete(null); run(() => horizon.households.remove(h.id, false)) }}>
            Keep members (unassign)
          </button>
          <button onClick={() => setConfirmDelete(null)}>Cancel</button>
        </div>
      )}
    </section>
  )
}
