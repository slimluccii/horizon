import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useActiveUser } from '../../hooks/useActiveUser.ts'
import { horizon } from '../../horizon.ts'
import './ProfileBadgeButton.css'

/** Derive a stable accent color per user by hashing their name. Keeps each
 *  profile visually distinct without storing an extra field. */
function userColor(name: string): string {
  const palette = ['#0089FF', '#E34989', '#1FA47C', '#F5C518', '#9D5CFF', '#FA6A3C']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

/** Top-nav profile control. Circular coloured initial; dropdown on click with
 *  switch / delete. Hidden when no active user — Guard redirects to /profiles
 *  before any screen that shows this chrome mounts. */
export default function ProfileBadgeButton() {
  const { user, setUserId } = useActiveUser()
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

  const color = userColor(user.name)
  const initial = user.avatar ?? user.name.charAt(0).toUpperCase()

  async function deleteProfile() {
    if (!user || !window.confirm(`Delete profile "${user.name}"? Watch history will be lost.`)) return
    await horizon.users.delete(user.id)
    setUserId(null)
    navigate('/profiles')
  }

  return (
    <div ref={ref} className="pb-badge">
      <button
        className="pb-badge__btn"
        style={{ background: color, boxShadow: `0 6px 18px ${color}66` }}
        onClick={() => setOpen(o => !o)}
        aria-label={user.name}
      >
        {initial}
      </button>
      {open && (
        <div className="pb-badge__menu">
          <div className="pb-badge__header">
            <div className="pb-badge__avatar" style={{ background: color }}>{initial}</div>
            <div>
              <div className="pb-badge__name">{user.name}</div>
              <div className="pb-badge__role">Active profile</div>
            </div>
          </div>
          <button className="pb-badge__item" onClick={() => { setOpen(false); navigate('/profiles') }}>
            Switch profile
          </button>
          <button className="pb-badge__item" onClick={() => { setOpen(false); navigate('/settings') }}>
            Settings
          </button>
          <button className="pb-badge__item pb-badge__item--danger" onClick={deleteProfile}>
            Delete profile
          </button>
        </div>
      )}
    </div>
  )
}
