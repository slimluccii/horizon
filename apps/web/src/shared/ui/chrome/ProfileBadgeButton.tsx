import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveUser } from '../../../features/identity/hooks/useActiveUser.ts'
import { horizon } from '../../horizon.ts'
/** Top-nav profile control. Circular coloured initial; dropdown on click with
 *  sign-out / delete. Hidden when no active user — the Guard redirects to /login
 *  before any screen that shows this chrome mounts. */
export default function ProfileBadgeButton() {
  const { user, shared, logout } = useActiveUser()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!user) return null

  const initial = user.avatar ?? user.name.charAt(0).toUpperCase()

  // Sign out → revoke the session, then land on the login screen (the profile
  // picker). Replaces the old "switch profile" since identity is a session now.
  async function signOut() {
    setOpen(false)
    await logout()
    navigate('/login', { replace: true })
  }

  // Delete the current profile (non-owner only), then sign out — the session is
  // dead with the user gone, so route to login.
  async function deleteProfile() {
    if (!user || !window.confirm(`Delete profile "${user.name}"? Watch history will be lost.`)) return
    setOpen(false)
    await horizon.users.delete(user.id)
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={user.name}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {initial}
      </button>
      {open && (
        <div role="menu" aria-label="Profile menu">
          <p>
            <span aria-hidden="true">{initial}</span>
            {' '}
            <span>{user.name}</span>
            {' · Active profile'}
          </p>
          <button onClick={() => { setOpen(false); navigate('/settings') }}>
            Settings
          </button>
          {shared && (
            <button onClick={() => { setOpen(false); navigate('/profiles') }}>
              Switch profile
            </button>
          )}
          <button onClick={signOut}>
            Sign out
          </button>
          {user.role !== 'owner' && !shared && (
            <button onClick={deleteProfile}>
              Delete profile
            </button>
          )}
        </div>
      )}
    </div>
  )
}
