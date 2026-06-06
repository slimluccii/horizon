import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import Link from './Link'

const HOME = {
  id: 'h1', name: 'Home', ownerUserId: 'owner',
  members: [
    { id: 'owner', name: 'Owner', avatar: null, role: 'owner' },
    { id: 'partner', name: 'Partner', avatar: null, role: 'member' },
  ],
}

vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({ user: (globalThis as any).__viewer, userId: (globalThis as any).__viewer?.id, loading: false, refresh: vi.fn() }),
}))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(horizon.households, 'me').mockResolvedValue(HOME as any)
  vi.spyOn(horizon.auth, 'pairApprove').mockResolvedValue({ ok: true } as any)
})

function renderLink() {
  return render(<MemoryRouter><Link /></MemoryRouter>)
}

describe('Link grant selection', () => {
  it('owner: renders a member checklist (all checked) and sends selected ids as grant', async () => {
    ;(globalThis as any).__viewer = { id: 'owner', role: 'member', householdId: 'h1' }
    renderLink()
    await screen.findByText('Partner')
    await userEvent.type(screen.getByLabelText(/code/i), 'ABCD1234')
    await userEvent.click(screen.getByRole('button', { name: /link/i }))
    await waitFor(() => expect(horizon.auth.pairApprove).toHaveBeenCalledWith('ABCD-1234', expect.arrayContaining(['owner', 'partner'])))
  })

  it('member: no checklist, approves without a grant', async () => {
    ;(globalThis as any).__viewer = { id: 'partner', role: 'member', householdId: 'h1' }
    renderLink()
    await userEvent.type(screen.getByLabelText(/code/i), 'ABCD1234')
    await userEvent.click(screen.getByRole('button', { name: /link/i }))
    await waitFor(() => expect(horizon.auth.pairApprove).toHaveBeenCalledWith('ABCD-1234'))
  })
})
