import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import Redeem from './Redeem'

const refresh = vi.fn().mockResolvedValue(undefined)
vi.mock('../hooks/useActiveUser.ts', () => ({ useActiveUser: () => ({ refresh }) }))

beforeEach(() => { vi.restoreAllMocks(); refresh.mockClear() })

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/join" element={<Redeem />} />
        <Route path="/" element={<div>LIBRARY</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Redeem', () => {
  it('prefills the code from ?code and redeems → navigates home', async () => {
    vi.spyOn(horizon.invites, 'redeem').mockResolvedValue({ token: 't', user: { id: 'u9' } } as any)
    renderAt('/join?code=ABCD-2345')
    expect((screen.getByLabelText(/code/i) as HTMLInputElement).value).toContain('ABCD-2345')
    await userEvent.type(screen.getByLabelText(/name/i), 'Friend')
    await userEvent.type(screen.getByLabelText(/^password/i), 'longenough12')
    await userEvent.click(screen.getByRole('button', { name: /create account|join/i }))
    await waitFor(() => expect(screen.getByText('LIBRARY')).toBeInTheDocument())
    expect(refresh).toHaveBeenCalled()
  })

  it('shows an expired message for an expired invite', async () => {
    vi.spyOn(horizon.invites, 'redeem').mockRejectedValue(Object.assign(new Error('x'), { code: 'invite-expired' }))
    renderAt('/join?code=ABCD-2345')
    await userEvent.type(screen.getByLabelText(/name/i), 'Friend')
    await userEvent.type(screen.getByLabelText(/^password/i), 'longenough12')
    await userEvent.click(screen.getByRole('button', { name: /create account|join/i }))
    expect(await screen.findByText(/expired/i)).toBeInTheDocument()
  })

  it('blocks a short password client-side', async () => {
    const spy = vi.spyOn(horizon.invites, 'redeem')
    renderAt('/join?code=ABCD-2345')
    await userEvent.type(screen.getByLabelText(/name/i), 'Friend')
    await userEvent.type(screen.getByLabelText(/^password/i), 'short')
    await userEvent.click(screen.getByRole('button', { name: /create account|join/i }))
    expect(await screen.findByText(/at least 8/i)).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })
})
