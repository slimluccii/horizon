import { useState } from 'react'
import { horizon } from '../../../shared/horizon.ts'

/**
 * Personal → Security: every user can change their own password (old + new) and
 * end sessions — "Sign out" (this device) and "Sign out everywhere" (all
 * sessions). Identity comes from the session, so there's no profile to clear
 * client-side beyond the hook's cached user.
 */
export default function SecurityPanel({
  onToast,
  onSignOut,
  logout,
  logoutAll,
}: {
  onToast: (msg: string) => void
  onSignOut: () => void
  logout: () => Promise<void>
  logoutAll: () => Promise<void>
}) {
  const [showChange, setShowChange] = useState(false)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function changePassword() {
    if (newPw.length < 8) { setErr('Use at least 8 characters.'); return }
    if (newPw !== confirmPw) { setErr('Passwords do not match.'); return }
    setBusy(true)
    setErr(null)
    try {
      await horizon.auth.setPassword({ oldPassword: oldPw, newPassword: newPw })
      setShowChange(false)
      setOldPw(''); setNewPw(''); setConfirmPw('')
      onToast('Password changed.')
    } catch (e) {
      const code = (e as { code?: string }).code
      setErr(code === 'invalid-credentials' ? 'Current password is incorrect.' : 'Could not change the password.')
    } finally {
      setBusy(false)
    }
  }

  async function doLogout(all: boolean) {
    setBusy(true)
    try {
      if (all) await logoutAll()
      else await logout()
      onSignOut()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p>Security</p>

      <div>
        <label>Password</label>
        {showChange ? (
          <div>
            <input
              type="password"
              placeholder="Current password"
              value={oldPw}
              autoComplete="current-password"
              onChange={e => setOldPw(e.target.value)}
            />
            <input
              type="password"
              placeholder="New password"
              value={newPw}
              autoComplete="new-password"
              onChange={e => setNewPw(e.target.value)}
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPw}
              autoComplete="new-password"
              onChange={e => setConfirmPw(e.target.value)}
            />
            <div>
              <button disabled={busy} onClick={changePassword}>
                {busy ? 'Saving…' : 'Save password'}
              </button>
              <button disabled={busy} onClick={() => { setShowChange(false); setErr(null) }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => { setShowChange(true); setErr(null) }}>
            Change password
          </button>
        )}
      </div>

      <div>
        <label>Sessions</label>
        <div>
          <button disabled={busy} onClick={() => doLogout(false)}>
            Sign out
          </button>
          <button disabled={busy} onClick={() => doLogout(true)}>
            Sign out everywhere
          </button>
        </div>
      </div>

      {err && <p>{err}</p>}
    </>
  )
}
