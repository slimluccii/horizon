import { describe, it, expect } from 'vitest'
import { isRoleChangedError, isProgressNotFoundError } from '../src/client.ts'

describe('isRoleChangedError', () => {
  it('returns true for an error with code caller-forbidden', () => {
    const err = Object.assign(new Error('Only owner or admin can change roles'), {
      code: 'caller-forbidden',
    })
    expect(isRoleChangedError(err)).toBe(true)
  })

  it('returns false for an error with a different code', () => {
    const err = Object.assign(new Error('Not found'), { code: 'user-not-found' })
    expect(isRoleChangedError(err)).toBe(false)
  })

  it('returns false for a plain Error without code', () => {
    expect(isRoleChangedError(new Error('something went wrong'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isRoleChangedError(null)).toBe(false)
    expect(isRoleChangedError('string error')).toBe(false)
    expect(isRoleChangedError({ code: 'caller-forbidden' })).toBe(false)
  })
})

describe('isProgressNotFoundError', () => {
  it('returns true for an error with code progress-not-found', () => {
    const err = Object.assign(new Error('No watch progress for media'), {
      code: 'progress-not-found',
    })
    expect(isProgressNotFoundError(err)).toBe(true)
  })

  it('returns false for an error with a different code', () => {
    const err = Object.assign(new Error('Not found'), { code: 'media-not-found' })
    expect(isProgressNotFoundError(err)).toBe(false)
  })

  it('returns false for a plain Error without code', () => {
    expect(isProgressNotFoundError(new Error('something went wrong'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isProgressNotFoundError(null)).toBe(false)
    expect(isProgressNotFoundError('progress-not-found')).toBe(false)
    expect(isProgressNotFoundError({ code: 'progress-not-found' })).toBe(false)
  })
})
