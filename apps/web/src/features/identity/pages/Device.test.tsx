import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import Device from './Device'

const refresh = vi.fn(async () => {})
vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({ user: { id: 'luuk', name: 'Luuk' }, loading: false, refresh }),
}))

function renderDevice() {
  return render(
    <MemoryRouter initialEntries={['/device']}>
      <Routes>
        <Route path="/device" element={<Device />} />
        <Route path="/" element={<p>library</p>} />
        <Route path="/profiles" element={<p>who is watching</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  refresh.mockClear()
  localStorage.clear()
})

describe('Who uses this device?', () => {
  it('keeps a personal device to the person who logged in', async () => {
    const set = vi.spyOn(horizon.auth, 'setDeviceMode').mockResolvedValue({ mode: 'personal' })
    renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /just me/i }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('personal'))
    expect(await screen.findByText('library')).toBeInTheDocument()
    expect(localStorage.getItem('horizon.deviceAsked')).toBe('1')
  })

  it('sets a shared device up for the household and goes to the picker', async () => {
    const set = vi.spyOn(horizon.auth, 'setDeviceMode').mockResolvedValue({ mode: 'shared' })
    renderDevice()
    await userEvent.click(screen.getByRole('button', { name: /my household/i }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('shared'))
    expect(await screen.findByText('who is watching')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })
})
