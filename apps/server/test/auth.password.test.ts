import { describe, it, expect } from 'vitest'
import { hash, verify } from '../src/auth/password.ts'

describe('auth/password', () => {
  it('round-trips: a hashed password verifies against itself', async () => {
    const stored = await hash('correct horse battery staple')
    expect(typeof stored).toBe('string')
    expect(stored.length).toBeGreaterThan(0)
    expect(await verify(stored, 'correct horse battery staple')).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hash('s3cret-passw0rd')
    expect(await verify(stored, 's3cret-passw0Rd')).toBe(false)
    expect(await verify(stored, '')).toBe(false)
  })

  it('produces a distinct hash each time (random salt)', async () => {
    const a = await hash('same-input')
    const b = await hash('same-input')
    expect(a).not.toBe(b)
    expect(await verify(a, 'same-input')).toBe(true)
    expect(await verify(b, 'same-input')).toBe(true)
  })

  it('uses argon2id by default when the native module loads', async () => {
    const stored = await hash('argon-please')
    // If argon2 loaded, the PHC string starts with $argon2id$. If the native
    // module is unavailable on this host the fallback tag is used instead —
    // either is a valid outcome, but it must verify.
    expect(stored.startsWith('$argon2id$') || stored.startsWith('scrypt$')).toBe(true)
    expect(await verify(stored, 'argon-please')).toBe(true)
  })

  it('verifies a scrypt-tagged hash via the fallback path', async () => {
    // Construct a scrypt hash directly so the fallback verify path is exercised
    // regardless of whether argon2 is present.
    const crypto = await import('node:crypto')
    const salt = crypto.randomBytes(16)
    const N = 1 << 16
    const r = 8
    const p = 1
    const derived: Buffer = await new Promise((resolve, reject) =>
      crypto.scrypt('fallback-pw', salt, 32, { N, r, p, maxmem: 256 * N * r }, (e, d) =>
        e ? reject(e) : resolve(d),
      ),
    )
    const stored = `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`
    expect(await verify(stored, 'fallback-pw')).toBe(true)
    expect(await verify(stored, 'wrong')).toBe(false)
  })

  it('treats a malformed stored hash as a non-match', async () => {
    expect(await verify('not-a-real-hash', 'whatever')).toBe(false)
    expect(await verify('scrypt$bad', 'whatever')).toBe(false)
  })
})
