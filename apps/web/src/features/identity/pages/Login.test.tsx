import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { horizon } from '../../../shared/horizon.ts'
import Login from './Login'

vi.mock('../hooks/useActiveUser.ts', () => ({
  useActiveUser: () => ({ user: null, principal: null, loading: false, refresh: vi.fn(async () => {}) }),
}))

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/device" element={<p>device question</p>} />
        <Route path="/" element={<p>library</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function signIn() {
  await userEvent.type(screen.getByLabelText('Name'), 'Luuk')
  await userEvent.type(screen.getByLabelText('Password'), 'luuk password')
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Login', () => {
  it('lists nobody and signs in with a typed name and password', async () => {
    const list = vi.spyOn(horizon.users, 'list')
    vi.spyOn(horizon.auth, 'login').mockResolvedValue({ token: 't', user: {} as never, canShareDevice: false })
    renderLogin()
    await signIn()
    await waitFor(() => expect(horizon.auth.login).toHaveBeenCalledWith('Luuk', 'luuk password'))
    expect(await screen.findByText('library')).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
  })

  it('asks the head of a household who uses this device, the first time on it', async () => {
    vi.spyOn(horizon.auth, 'login').mockResolvedValue({ token: 't', user: {} as never, canShareDevice: true })
    renderLogin()
    await signIn()
    expect(await screen.findByText('device question')).toBeInTheDocument()
  })

  it('does not ask again on a device that was already set up', async () => {
    localStorage.setItem('horizon.deviceAsked', '1')
    vi.spyOn(horizon.auth, 'login').mockResolvedValue({ token: 't', user: {} as never, canShareDevice: true })
    renderLogin()
    await signIn()
    expect(await screen.findByText('library')).toBeInTheDocument()
  })

  it('shows one generic message when signing in fails', async () => {
    vi.spyOn(horizon.auth, 'login').mockRejectedValue(new Error('nope'))
    renderLogin()
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect name or password/i)
  })
})
