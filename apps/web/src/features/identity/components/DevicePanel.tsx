import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'

/** Settings → This device: switch between a personal device and one for the whole household. */
export default function DevicePanel() {
  const navigate = useNavigate()
  const { shared, canShare, refresh } = useActiveUser()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canShare) return null

  async function change(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { mode } = await horizon.auth.setDeviceMode(shared ? 'personal' : 'shared', password)
      await refresh()
      if (mode === 'shared') navigate('/profiles', { replace: true })
      setPassword('')
    } catch {
      setError('That did not work. Check your password and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="device-heading">
      <h2 id="device-heading">This device</h2>
      <p>
        {shared
          ? 'Your household uses this device. Everyone picks their profile when it opens, and nobody can change server or household settings from it.'
          : 'Only you use this device.'}
      </p>
      <form onSubmit={change}>
        <p>
          <label htmlFor="device-password">Your password</label>
          <input id="device-password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {shared ? 'Only I use it' : 'Use it for my household'}
        </button>
      </form>
    </section>
  )
}
