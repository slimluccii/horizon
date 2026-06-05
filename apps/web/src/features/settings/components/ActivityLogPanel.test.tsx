import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ActivityLogPanel from './ActivityLogPanel'

describe('ActivityLogPanel', () => {
  it('shows the empty state when there are no lines (empty path)', () => {
    render(<ActivityLogPanel lines={[]} />)

    expect(screen.getByText('No activity yet.')).toBeInTheDocument()
    expect(screen.getByText('0 lines')).toBeInTheDocument()
    // No log rows rendered when empty.
    expect(document.querySelectorAll('.actlog__line')).toHaveLength(0)
  })

  it('renders one row per line and reports the count (happy path)', () => {
    const lines = ['scan: started', 'scan: probing media', 'scan: done']
    render(<ActivityLogPanel lines={lines} />)

    expect(screen.queryByText('No activity yet.')).not.toBeInTheDocument()
    expect(screen.getByText('3 lines')).toBeInTheDocument()
    expect(document.querySelectorAll('.actlog__line')).toHaveLength(3)
    expect(screen.getByText('scan: probing media')).toBeInTheDocument()
  })

  it('renders every line even for a very large log without dropping rows (edge path)', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`)
    render(<ActivityLogPanel lines={lines} />)

    expect(screen.getByText('600 lines')).toBeInTheDocument()
    expect(document.querySelectorAll('.actlog__line')).toHaveLength(600)
  })
})
