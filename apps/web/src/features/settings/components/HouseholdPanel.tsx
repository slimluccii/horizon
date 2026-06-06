import { useEffect, useState, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { horizon } from '../../../shared/horizon.ts'
import type { HouseholdView } from '@horizon/sdk'
import './HouseholdPanel.css'

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
    <section className="settings__section">
      <p className="settings__section-title">Household</p>
      <p className="settings__profile-error">Couldn’t load your household.</p>
    </section>
  )
  if (!household) return (
    <section className="settings__section">
      <p className="settings__section-title">Household</p>
      <p className="hh__muted">Loading…</p>
    </section>
  )

  return (
    <section className="settings__section">
      <p className="settings__section-title">Household</p>

      <div className="hh__name-row">
        {renaming ? (
          <>
            <input className="settings__input" value={nameDraft} onChange={e => setNameDraft(e.target.value)} aria-label="Household name" />
            <button className="settings__token-replace" disabled={busy} onClick={rename}>Save</button>
            <button className="settings__token-cancel" onClick={() => setRenaming(false)}>Cancel</button>
          </>
        ) : (
          <>
            <span className="hh__name">{household.name}</span>
            {isHouseholdOwner && (
              <button className="settings__token-replace" onClick={() => { setNameDraft(household.name); setRenaming(true) }}>Rename</button>
            )}
          </>
        )}
      </div>

      <ul className="hh__members">
        {household.members.map(m => {
          const removable = isHouseholdOwner && m.id !== viewerId && m.id !== household.ownerUserId
          return (
            <li key={m.id} className="hh__member">
              <span className="hh__member-name">{m.name}</span>
              <span className="hh__member-role">{m.role}</span>
              {removable && (
                confirmRemove === m.id ? (
                  <span className="hh__confirm">
                    <button className="settings__token-replace" disabled={busy} onClick={() => remove(m.id)}>Confirm</button>
                    <button className="settings__token-cancel" onClick={() => setConfirmRemove(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="settings__token-cancel" aria-label={`Remove ${m.name}`} onClick={() => flushSync(() => setConfirmRemove(m.id))}>Remove</button>
                )
              )}
            </li>
          )
        })}
      </ul>

      <div className="hh__invites">
        {isHouseholdOwner && (
          <button className="settings__token-replace" disabled={busy} onClick={() => generate('join')}>Invite a member</button>
        )}
        {isServerAdmin && (
          <button className="settings__token-replace" disabled={busy} onClick={() => generate('new_household')}>Invite a new household</button>
        )}
        {link && (
          <div className="hh__link">
            <code>{link}</code>
            <button className="settings__token-replace" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
            <span className="hh__muted">Expires in 24h</span>
          </div>
        )}
      </div>

      {actionError && <p className="settings__profile-error">{actionError}</p>}
    </section>
  )
}
