import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Profiles from './Profiles'

const pickProfile = vi.fn(async (_id: string, _pin?: string) => {})
vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({
    user: { id: 'luuk', name: 'Luuk' },
    loading: false,
    profiles: [{ id: 'luuk', name: 'Luuk', avatar: null, hasPin: true }, { id: 'kid', name: 'Kid', avatar: '🦊', hasPin: false }],
    pickProfile,
  }),
}))

beforeEach(() => { pickProfile.mockReset() })

function renderPicker() {
  return render(
    <MemoryRouter initialEntries={['/profiles']}>
      <Routes>
        <Route path="/profiles" element={<Profiles />} />
        <Route path="/" element={<p>library</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("Who's watching?", () => {
  it('shows every profile of the device and enters the library as the one picked', async () => {
    renderPicker()
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['LLuuk', '🦊Kid'])
    await userEvent.click(screen.getByRole('button', { name: /kid/i }))
    expect(pickProfile).toHaveBeenCalledWith('kid')
    expect(await screen.findByText('library')).toBeInTheDocument()
  })

  it('asks for the pin of a profile that has one, and only enters the library with the right one', async () => {
    pickProfile.mockRejectedValueOnce({ code: 'invalid-pin' })
    renderPicker()
    await userEvent.click(screen.getByRole('button', { name: /luuk/i }))
    expect(pickProfile).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('PIN for Luuk'), '0000')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong pin/i)
    expect(screen.queryByText('library')).not.toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText('PIN for Luuk'))
    await userEvent.type(screen.getByLabelText('PIN for Luuk'), '1234')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(pickProfile).toHaveBeenLastCalledWith('luuk', '1234')
    expect(await screen.findByText('library')).toBeInTheDocument()
  })

  it('says so when the device has to wait after too many wrong pins', async () => {
    pickProfile.mockRejectedValueOnce({ code: 'pin-locked' })
    renderPicker()
    await userEvent.click(screen.getByRole('button', { name: /luuk/i }))
    await userEvent.type(screen.getByLabelText('PIN for Luuk'), '0000')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i)
  })
})
