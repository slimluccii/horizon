import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ProfileSummary } from '@horizon/sdk'
import { useActiveUser } from '../hooks/useActiveUser.ts'

/** The picker of a shared device: pick a profile and go. */
export default function Profiles() {
  const navigate = useNavigate()
  const { profiles, pickProfile } = useActiveUser()
  const [asking, setAsking] = useState<ProfileSummary | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function pick(...args: Parameters<typeof pickProfile>) {
    await pickProfile(...args)
    navigate('/', { replace: true })
  }

  function choose(profile: ProfileSummary) {
    setPin('')
    setError(null)
    if (profile.hasPin) setAsking(profile)
    else void pick(profile.id)
  }

  async function enterPin(e: FormEvent) {
    e.preventDefault()
    if (!asking) return
    setError(null)
    try {
      await pick(asking.id, pin)
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(
        code === 'pin-locked' ? 'Too many wrong PINs. Try again in a few minutes.'
        : code === 'invalid-pin' ? 'Wrong PIN.'
        : 'That did not work. Please try again.',
      )
    }
  }

  return (
    <main>
      <h1>Who's watching?</h1>
      <ul>
        {profiles.map(p => (
          <li key={p.id}>
            <button type="button" onClick={() => choose(p)}>
              <span aria-hidden="true">{p.avatar ?? p.name.charAt(0).toUpperCase()}</span>
              <span>{p.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {asking && (
        <form onSubmit={enterPin}>
          <p>
            <label htmlFor="profile-pin">PIN for {asking.name}</label>
            <input
              id="profile-pin"
              type="password"
              inputMode="numeric"
              pattern="\d{4,8}"
              autoComplete="off"
              autoFocus
              required
              value={pin}
              onChange={e => setPin(e.target.value)}
            />
          </p>
          {error && <p role="alert">{error}</p>}
          <button type="submit">Continue</button>
        </form>
      )}
    </main>
  )
}
