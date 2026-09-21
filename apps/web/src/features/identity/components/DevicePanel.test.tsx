import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import DevicePanel from './DevicePanel'

const refresh = vi.fn(async () => {})
let device: { shared: boolean; canShare: boolean }
vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({ ...device, refresh }),
}))

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<DevicePanel />} />
        <Route path="/profiles" element={<p>who is watching</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  refresh.mockClear()
})

describe('Settings → This device', () => {
  it('lets the head of a household share a personal device, after typing the password', async () => {
    device = { shared: false, canShare: true }
    const set = vi.spyOn(horizon.auth, 'setDeviceMode').mockResolvedValue({ mode: 'shared' })
    renderPanel()
    expect(screen.getByText(/only you use this device/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Your password'), 'luuk password')
    await userEvent.click(screen.getByRole('button', { name: /use it for my household/i }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('shared', 'luuk password'))
    expect(await screen.findByText('who is watching')).toBeInTheDocument()
  })

  it('turns a shared device back into a personal one', async () => {
    device = { shared: true, canShare: true }
    const set = vi.spyOn(horizon.auth, 'setDeviceMode').mockResolvedValue({ mode: 'personal' })
    renderPanel()
    expect(screen.getByText(/your household uses this device/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Your password'), 'luuk password')
    await userEvent.click(screen.getByRole('button', { name: /only i use it/i }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('personal', 'luuk password'))
    expect(refresh).toHaveBeenCalled()
  })

  it('says so when the password is wrong', async () => {
    device = { shared: false, canShare: true }
    vi.spyOn(horizon.auth, 'setDeviceMode').mockRejectedValue(new Error('401'))
    renderPanel()
    await userEvent.type(screen.getByLabelText('Your password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: /use it for my household/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/password/i)
  })

  it('shows nothing to someone who cannot share a device', () => {
    device = { shared: false, canShare: false }
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })
})
