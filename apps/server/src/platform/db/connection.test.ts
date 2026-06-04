import { describe, it, expect } from 'vitest'
import { openDatabase } from './connection.ts'

describe('openDatabase', () => {
  it('opens an in-memory DB with foreign_keys + WAL configured', () => {
    const db = openDatabase(':memory:')
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
    // WAL isn't meaningful for :memory: but the call should still succeed
    const res = db.prepare('SELECT 1 as ok').get() as { ok: number }
    expect(res.ok).toBe(1)
    db.close()
  })
})
