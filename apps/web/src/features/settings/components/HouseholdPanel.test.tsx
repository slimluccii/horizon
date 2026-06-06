import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { horizon } from '../../../shared/horizon.ts'
import HouseholdPanel from './HouseholdPanel'

const HOME = {
  id: 'h1', name: 'Home', ownerUserId: 'owner',
  members: [
    { id: 'owner', name: 'Owner', avatar: null, role: 'owner' },
    { id: 'partner', name: 'Partner', avatar: null, role: 'member' },
  ],
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(horizon.households, 'me').mockResolvedValue(HOME as any)
})

describe('HouseholdPanel', () => {
  it('renders the household name and members', async () => {
    render(<HouseholdPanel viewerId="partner" viewerRole="member" />)
    expect(await screen.findByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Partner')).toBeInTheDocument()
    expect(screen.getByText('Owner')).toBeInTheDocument()
  })

  it('hides owner controls from a non-owner member', async () => {
    render(<HouseholdPanel viewerId="partner" viewerRole="member" />)
    await screen.findByText('Home')
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /invite a member/i })).toBeNull()
  })

  it('shows owner controls to the household owner', async () => {
    render(<HouseholdPanel viewerId="owner" viewerRole="member" />)
    await screen.findByText('Home')
    expect(screen.getByRole('button', { name: /rename/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /invite a member/i })).toBeInTheDocument()
  })

  it('generates a join invite and shows a shareable link', async () => {
    vi.spyOn(horizon.invites, 'create').mockResolvedValue({ code: 'ABCD-2345', expiresAt: Date.now() + 86400000 })
    render(<HouseholdPanel viewerId="owner" viewerRole="member" />)
    await screen.findByText('Home')
    screen.getByRole('button', { name: /invite a member/i }).click()
    expect(await screen.findByText(/\/join\?code=ABCD-2345/)).toBeInTheDocument()
    expect(horizon.invites.create).toHaveBeenCalledWith({ kind: 'join' })
  })

  it('surfaces a forbidden error when removing a member fails', async () => {
    vi.spyOn(horizon.users, 'delete').mockRejectedValue(Object.assign(new Error('x'), { code: 'caller-forbidden' }))
    render(<HouseholdPanel viewerId="owner" viewerRole="member" />)
    await screen.findByText('Home')
    // remove the non-owner member, confirm, expect an inline error and the row remaining
    screen.getByRole('button', { name: /remove partner/i }).click()
    screen.getByRole('button', { name: /^confirm$/i }).click()
    expect(await screen.findByText(/not allowed/i)).toBeInTheDocument()
    expect(screen.getByText('Partner')).toBeInTheDocument()
  })
})
