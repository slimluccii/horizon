import { useEffect, useState, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView } from '@horizon/sdk'
interface Props {
  viewerId: string
  viewerRole: 'owner' | 'admin' | 'member'
}

function inviteLink(code: string): string {
  return `${window.location.origin}/join?code=${code}`
}

export default function HouseholdPanel({ viewerId, viewerRole }: Props) {
  const [household, setHousehold] = useState<HouseholdView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setHousehold(await horizon.households.me()) }
    catch { setLoadError(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  const isHouseholdOwner = !!household && household.ownerUserId === viewerId
  const isServerAdmin = viewerRole === 'owner' || viewerRole === 'admin'

  async function rename() {
    if (!household || !nameDraft.trim()) return
    setBusy(true); setActionError(null)
    try {
      const updated = await horizon.households.rename(household.id, nameDraft.trim())
      setHousehold(updated); setRenaming(false)
    } catch { setActionError('Could not rename the household.') }
    finally { setBusy(false) }
  }

  async function remove(id: string) {
    setBusy(true); setActionError(null); setConfirmRemove(null)
    try {
      await horizon.users.delete(id)
      await load()
    } catch (e) {
      const code = (e as { code?: string }).code
      setActionError(code === 'owner-protected' ? 'The household owner cannot be removed.' : 'Not allowed to remove that member.')
    } finally { setBusy(false) }
  }

  async function generate(kind: 'join' | 'new_household') {
    setBusy(true); setActionError(null); setLink(null)
    try {
      const { code } = await horizon.invites.create({ kind })
      setLink(inviteLink(code))
    } catch { setActionError('Could not create an invite.') }
    finally { setBusy(false) }
  }

  if (loadError) return (
    <section>
      <p>Household</p>
      <p>Couldn’t load your household.</p>
    </section>
  )
  if (!household) return (
    <section>
      <p>Household</p>
      <p>Loading…</p>
    </section>
  )

  return (
    <section>
      <p>Household</p>

      <div>
        {renaming ? (
          <>
            <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} aria-label="Household name" />
            <button disabled={busy} onClick={rename}>Save</button>
            <button onClick={() => setRenaming(false)}>Cancel</button>
          </>
        ) : (
          <>
            <span>{household.name}</span>
            {isHouseholdOwner && (
              <button onClick={() => { setNameDraft(household.name); setRenaming(true) }}>Rename</button>
            )}
          </>
        )}
      </div>

      <ul>
        {household.members.map(m => {
          const removable = isHouseholdOwner && m.id !== viewerId && m.id !== household.ownerUserId
          return (
            <li key={m.id}>
              <span>{m.name}</span>
              <span>{m.role}</span>
              {removable && (
                confirmRemove === m.id ? (
                  <span>
                    <button disabled={busy} onClick={() => remove(m.id)}>Confirm</button>
                    <button onClick={() => setConfirmRemove(null)}>Cancel</button>
                  </span>
                ) : (
                  <button aria-label={`Remove ${m.name}`} onClick={() => flushSync(() => setConfirmRemove(m.id))}>Remove</button>
                )
              )}
            </li>
          )
        })}
      </ul>

      <div>
        {isHouseholdOwner && (
          <button disabled={busy} onClick={() => generate('join')}>Invite a member</button>
        )}
        {isServerAdmin && (
          <button disabled={busy} onClick={() => generate('new_household')}>Invite a new household</button>
        )}
        {link && (
          <div>
            <code>{link}</code>
            <button onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
            <span>Expires in 24h</span>
          </div>
        )}
      </div>

      {actionError && <p>{actionError}</p>}
    </section>
  )
}
