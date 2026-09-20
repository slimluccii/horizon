import { describe, it, expect } from 'vitest'
import { runtimeMinutes } from './runtime'

describe('runtimeMinutes', () => {
  it('rounds the duration to whole minutes', () => {
    expect(runtimeMinutes({ durationSec: 7500 })).toBe(125)
    expect(runtimeMinutes({ durationSec: 89 })).toBe(1)
  })

  it('is null when the duration is unknown, so nothing is shown in place of a wrong number', () => {
    expect(runtimeMinutes({ durationSec: null })).toBeNull()
    expect(runtimeMinutes({ durationSec: 0 })).toBeNull()
  })
})
