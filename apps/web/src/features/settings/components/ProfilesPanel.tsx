import { useEffect, useState } from 'react'
import { horizon } from '../../../shared/horizon.ts'
import { isRoleChangedError } from '@horizon/sdk'
import type { User } from '@horizon/sdk'

export default function ProfilesPanel({
  viewerId,
  viewerRole,
  onRoleChanged,
  onToast,
}: {
  viewerId: string
  viewerRole: 'owner' | 'admin' | 'member'
  onRoleChanged: () => void
  onToast: (msg: string) => void
}) {
  void viewerRole
  const [rows, setRows] = useState<User[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Which member's password is being reset (their id), and the pending value.
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [resetPw, setResetPw] = useState('')

  useEffect(() => {
    horizon.users.list().then(setRows)
  }, [])

  async function handleRoleChange(id: string, role: 'admin' | 'member') {
    setBusy(true)
    setErr(null)
    try {
      await horizon.users.update(id, { role })
      // Self-demote: the viewer just dropped their own role to member, losing
      // access to this tab. Detect it directly off the request rather than
      // waiting for a follow-up call to 403 — GET /users is unauthenticated
      // (profile picker), so it would NOT fail for a freshly-demoted member.
      if (id === viewerId && role === 'member') {
        onRoleChanged()
        return
      }
      const updated = await horizon.users.list()
      setRows(updated)
    } catch (e) {
      // Belt-and-suspenders: a privileged follow-up call that 403s (role changed
      // out from under the session) still routes the viewer back to Personal.
      if (isRoleChangedError(e)) {
        onRoleChanged()
        return
      }
      setErr((e as { message?: string }).message ?? 'Failed to update role')
    } finally {
      setBusy(false)
    }
  }

  // Owner/admin reset of another user — no old password required (the server
  // gates this on the caller's role). Invalidates that user's other sessions.
  async function handleResetPassword(id: string) {
    if (resetPw.length < 8) { setErr('Use at least 8 characters.'); return }
    setBusy(true)
    setErr(null)
    try {
      await horizon.auth.setPassword({ userId: id, newPassword: resetPw })
      setResetFor(null)
      setResetPw('')
      onToast('Password reset. The member must sign in again.')
      const updated = await horizon.users.list()
      setRows(updated)
    } catch (e) {
      setErr((e as { message?: string }).message ?? 'Failed to reset password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Profiles">
      <h3>Profiles</h3>
      <ul>
      {rows.map(row => {
        const initial = row.avatar ?? row.name.charAt(0).toUpperCase()
        const isSelf = row.id === viewerId
        // Owner/admin may reset any non-owner, non-self member. The owner resets
        // their own password via the Personal → Security "Change password".
        const canReset = !isSelf && row.role !== 'owner'
        return (
          <li key={row.id}>
            <span aria-hidden="true">{initial}</span>
            <span>{row.name}</span>
            {row.role === 'owner' ? (
              <span>Owner</span>
            ) : (
              <select
                value={row.role}
                disabled={busy}
                onChange={e => handleRoleChange(row.id, e.target.value as 'admin' | 'member')}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
            {canReset && (
              resetFor === row.id ? (
                <div>
                  <input
                    type="password"
                    placeholder="New password"
                    value={resetPw}
                    autoComplete="new-password"
                    onChange={e => setResetPw(e.target.value)}
                  />
                  <button disabled={busy} onClick={() => handleResetPassword(row.id)}>
                    Save
                  </button>
                  <button disabled={busy} onClick={() => { setResetFor(null); setResetPw('') }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => { setResetFor(row.id); setResetPw(''); setErr(null) }}
                >
                  Reset password
                </button>
              )
            )}
          </li>
        )
      })}
      </ul>
      {err && <p>{err}</p>}
    </section>
  )
}
