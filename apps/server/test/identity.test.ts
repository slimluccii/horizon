import { describe, it, expect } from 'vitest'
import os from 'node:os'
import { openDatabase } from '../src/db/index.ts'
import { migrate } from '../src/db/migrations.ts'
import { loadIdentity } from '../src/identity.ts'

function db() {
  const d = openDatabase(':memory:')
  migrate(d)
  return d
}

describe('loadIdentity', () => {
  it('generates a stable instanceId persisted across calls', () => {
    const d = db()
    const a = loadIdentity(d, { serverName: undefined })
    const b = loadIdentity(d, { serverName: undefined })
    expect(a.instanceId).toMatch(/[0-9a-f-]{36}/)
    expect(b.instanceId).toBe(a.instanceId)
  })

  it('uses serverName when set, hostname otherwise', () => {
    expect(loadIdentity(db(), { serverName: 'Den' }).serverName).toBe('Den')
    expect(loadIdentity(db(), { serverName: undefined }).serverName).toBe(os.hostname())
  })

  it('exposes the server version', () => {
    expect(loadIdentity(db(), { serverName: undefined }).version).toMatch(/\d+\.\d+\.\d+/)
  })
})
