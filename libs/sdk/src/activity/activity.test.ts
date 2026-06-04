import { describe, it, expect } from 'vitest'
import { parseActivityFrame } from './activity.ts'

describe('parseActivityFrame', () => {
  it('parses a valid event frame', () => {
    const evt = parseActivityFrame('{"seq":1,"ts":2,"kind":"meta:start","message":"x"}')
    expect(evt).toMatchObject({ kind: 'meta:start', seq: 1, message: 'x' })
  })

  it('returns null for malformed JSON', () => {
    expect(parseActivityFrame('{not json')).toBeNull()
    expect(parseActivityFrame('')).toBeNull()
    expect(parseActivityFrame(': ping')).toBeNull()
  })

  it('returns null for JSON missing a string kind', () => {
    expect(parseActivityFrame('{"seq":1,"ts":2}')).toBeNull()
    expect(parseActivityFrame('42')).toBeNull()
    expect(parseActivityFrame('null')).toBeNull()
    expect(parseActivityFrame('"string"')).toBeNull()
  })
})
