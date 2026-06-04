import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'

describe('Button', () => {
  it('renders its label and fires onClick when clicked (happy path)', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save changes</Button>)

    const btn = screen.getByRole('button', { name: 'Save changes' })
    expect(btn).toBeInTheDocument()
    // Defaults to type="button" so it never submits a surrounding form.
    expect(btn).toHaveAttribute('type', 'button')

    await userEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not fire onClick while disabled (unhappy path)', async () => {
    const onClick = vi.fn()
    render(<Button disabled onClick={onClick}>Nope</Button>)

    const btn = screen.getByRole('button', { name: 'Nope' })
    expect(btn).toBeDisabled()

    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })
})
