import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from '@horizon/sdk'
import { horizon } from '../../../shared/horizon.ts'
import ProfilePinPanel from './ProfilePinPanel'

const person = (id: string, name: string, hasPin = false) => ({ id, name, hasPin }) as User
let device: { user: User; shared: boolean; canShare: boolean }
vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => device,
}))

beforeEach(() => { vi.restoreAllMocks() })

describe('Settings → Profile PIN', () => {
  it('lets anyone give their own profile a pin, with their password', async () => {
    device = { user: person('partner', 'Partner'), shared: false, canShare: false }
    const list = vi.spyOn(horizon.users, 'list')
    const set = vi.spyOn(horizon.auth, 'setProfilePin').mockResolvedValue({ hasPin: true })
    render(<ProfilePinPanel />)
    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('Partner')
    expect(row).toHaveTextContent('No PIN')

    await userEvent.click(within(row).getByRole('button', { name: 'Set a PIN' }))
    await userEvent.type(screen.getByLabelText('New PIN'), '4321')
    await userEvent.type(screen.getByLabelText('Your password'), 'partner password')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(set).toHaveBeenCalledWith({ userId: 'partner', pin: '4321', password: 'partner password' }))
    expect(await screen.findByText('Has a PIN')).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
  })

  it('lets the head of a household set and remove the pin of everyone in it', async () => {
    device = { user: person('luuk', 'Luuk'), shared: false, canShare: true }
    vi.spyOn(horizon.users, 'list').mockResolvedValue([person('luuk', 'Luuk'), person('kid', 'Kid', true)])
    const set = vi.spyOn(horizon.auth, 'setProfilePin').mockResolvedValue({ hasPin: false })
    render(<ProfilePinPanel />)
    const kid = (await screen.findByText('Kid')).closest('li')!
    expect(kid).toHaveTextContent('Has a PIN')

    await userEvent.click(within(kid).getByRole('button', { name: 'Remove the PIN' }))
    await userEvent.type(screen.getByLabelText('Your password'), 'luuk password')
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(set).toHaveBeenCalledWith({ userId: 'kid', pin: null, password: 'luuk password' }))
    await waitFor(() => expect(kid).toHaveTextContent('No PIN'))
  })

  it('says so when the password is wrong', async () => {
    device = { user: person('partner', 'Partner'), shared: false, canShare: false }
    vi.spyOn(horizon.auth, 'setProfilePin').mockRejectedValue({ code: 'invalid-credentials' })
    render(<ProfilePinPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'Set a PIN' }))
    await userEvent.type(screen.getByLabelText('New PIN'), '4321')
    await userEvent.type(screen.getByLabelText('Your password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/password is incorrect/i)
    expect(screen.getByRole('listitem')).toHaveTextContent('No PIN')
  })

  it('is not there on a shared device', () => {
    device = { user: person('luuk', 'Luuk'), shared: true, canShare: true }
    const { container } = render(<ProfilePinPanel />)
    expect(container).toBeEmptyDOMElement()
  })
})
