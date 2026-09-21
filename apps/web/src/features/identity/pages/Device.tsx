import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DeviceMode } from '@horizon/sdk'
import { horizon } from '../../../shared/horizon.ts'
import { useActiveUser } from '../hooks/useActiveUser.ts'
import { markDeviceAsked } from '../device.ts'

/** Asked once per device, right after the head of a household logs in on it. */
export default function Device() {
  const navigate = useNavigate()
  const { refresh } = useActiveUser()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(mode: DeviceMode) {
    setBusy(true)
    setError(null)
    try {
      await horizon.auth.setDeviceMode(mode)
      markDeviceAsked()
      await refresh()
      navigate(mode === 'shared' ? '/profiles' : '/', { replace: true })
    } catch {
      setError('Could not save that. Please try again.')
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Who uses this device?</h1>
      <p>You can change this later under Settings.</p>
      <ul>
        <li>
          <button type="button" disabled={busy} onClick={() => choose('personal')}>Just me</button>
          <p>Your phone or laptop. Opens straight into your library.</p>
        </li>
        <li>
          <button type="button" disabled={busy} onClick={() => choose('shared')}>My household</button>
          <p>The family TV or a shared tablet. Everyone picks their profile, no password needed.</p>
        </li>
      </ul>
      {error && <p role="alert">{error}</p>}
    </main>
  )
}
