import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { horizon } from '../../../shared/horizon.ts'
import AllHouseholdsPanel from './AllHouseholdsPanel'

const HOUSEHOLDS = [
  { id: 'home', name: 'Home', ownerUserId: 'owner', members: [{ id: 'owner', name: 'Owner', role: 'owner' }] },
  { id: 'friend', name: 'Friend', ownerUserId: 'f1', members: [{ id: 'f1', name: 'Friend1', role: 'member' }] },
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(horizon.households, 'all').mockResolvedValue(HOUSEHOLDS as any)
  vi.spyOn(horizon.users, 'orphans').mockResolvedValue([{ id: 'orph', name: 'Lonely' }] as any)
})

describe('AllHouseholdsPanel', () => {
  it('lists all households + members and the orphans section', async () => {
    render(<AllHouseholdsPanel ownerUserId="owner" />)
    // Household names render as a card heading (a <span>) AND as <option>s in the
    // orphan "Move to…" dropdown, so the bare name is ambiguous — assert each
    // card via its unique per-household Delete control and members/orphan by name.
    expect(await screen.findByRole('button', { name: /delete Friend/i })).toBeInTheDocument()
    expect(screen.getByText('Friend1')).toBeInTheDocument()
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('Lonely')).toBeInTheDocument()
  })

  it('deleting a household offers cascade vs orphan and calls remove with the flag', async () => {
    vi.spyOn(horizon.households, 'remove').mockResolvedValue(undefined as any)
    render(<AllHouseholdsPanel ownerUserId="owner" />)
    await screen.findByRole('button', { name: /delete Friend/i })
    // open the delete dialog for the Friend household
    fireEvent.click(screen.getByRole('button', { name: /delete Friend/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete household \+ members/i }))
    await waitFor(() => expect(horizon.households.remove).toHaveBeenCalledWith('friend', true))
  })

  it('does not offer delete for the server-owner household', async () => {
    render(<AllHouseholdsPanel ownerUserId="owner" />)
    await screen.findByRole('button', { name: /delete Friend/i })
    expect(screen.queryByRole('button', { name: /delete Home/i })).toBeNull()
  })
})
