import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import HorizonMark from '../components/chrome/HorizonMark.tsx'
import Icon from '../components/chrome/Icon.tsx'
import './Setup.css'

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🚀', '🎮', '🎬', '🎨', '👤']

export default function Setup() {
  const navigate = useNavigate()
  const { setUserId } = useActiveUser()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) { setError('Name required'); return }
    setBusy(true); setError(null)
    try {
      const u = await horizon.users.create({ name: name.trim(), avatar })
      setUserId(u.id)
      navigate('/', { replace: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'name-taken' ? 'That name is already in use' : String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup">
      <div className="setup__bg" />
      <div className="setup__content">
        <HorizonMark size={56} withText />
        <div className="setup__card">
          <div className="eyebrow">First run · new library</div>
          <h1 className="setup__title">Welcome to Horizon</h1>
          <p className="setup__subtitle">Create a profile to start watching.</p>
          <p className="setup__subtitle">You'll be the household owner — the account that can never be removed.</p>

          <label className="setup__field">
            <span className="setup__label">Name</span>
            <input
              className="setup__input"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={40}
              placeholder="Luuk"
              autoFocus
            />
          </label>

          <div className="setup__field">
            <span className="setup__label">Avatar</span>
            <div className="setup__avatars">
              {AVATARS.map(a => (
                <button
                  key={a}
                  className={`setup__avatar ${avatar === a ? 'is-selected' : ''}`}
                  onClick={() => setAvatar(a === avatar ? null : a)}
                  type="button"
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="setup__error">{error}</div>}

          <button
            className="setup__submit"
            disabled={busy || !name.trim()}
            onClick={submit}
          >
            {busy ? 'Creating…' : <>Get started <Icon name="chevron-right" size={14} color="#000" /></>}
          </button>
        </div>

        <div className="setup__footer">horizon.local · self-hosted media</div>
      </div>
    </div>
  )
}
