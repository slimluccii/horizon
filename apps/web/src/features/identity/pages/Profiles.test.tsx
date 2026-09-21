import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Profiles from './Profiles'

const pickProfile = vi.fn(async () => {})
vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({
    user: { id: 'luuk', name: 'Luuk' },
    loading: false,
    profiles: [{ id: 'luuk', name: 'Luuk', avatar: null }, { id: 'kid', name: 'Kid', avatar: '🦊' }],
    pickProfile,
  }),
}))

beforeEach(() => { pickProfile.mockClear() })

describe("Who's watching?", () => {
  it('shows every profile of the device and enters the library as the one picked', async () => {
    render(
      <MemoryRouter initialEntries={['/profiles']}>
        <Routes>
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/" element={<p>library</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['LLuuk', '🦊Kid'])
    await userEvent.click(screen.getByRole('button', { name: /kid/i }))
    expect(pickProfile).toHaveBeenCalledWith('kid')
    expect(await screen.findByText('library')).toBeInTheDocument()
  })
})
