import crypto from 'node:crypto'

/**
 * Password hashing for built-in authentication.
 *
 * Primary algorithm is Argon2id via `@node-rs/argon2` (prebuilt binaries, no
 * compile). If the native module fails to load — e.g. the prebuilt binary is
 * missing for the host arch in a container — we fall back to `crypto.scrypt`
 * with OWASP-recommended cost. The fallback is logged once at first use.
 *
 * The stored string is self-describing so `verify` can route to the right
 * algorithm regardless of which one produced the hash:
 *   - Argon2 emits its own PHC string, prefixed `$argon2id$...`.
 *   - The scrypt fallback is tagged `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`.
 *
 * Verify is deliberately ~100ms — do not "optimise" the cost parameters down.
 */

// scrypt parameters (OWASP): N=2^16, r=8, p=1, 32-byte derived key.
const SCRYPT_N = 1 << 16
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
const SCRYPT_SALT_BYTES = 16
// scrypt needs maxmem >= 128 * N * r; give headroom over the default 32 MiB.
const SCRYPT_MAXMEM = 256 * SCRYPT_N * SCRYPT_R

interface Argon2Module {
  hash(password: string, options?: unknown): Promise<string>
  verify(hashed: string, password: string, options?: unknown): Promise<boolean>
  Algorithm?: { Argon2id: number }
}

// Lazily resolved native module; null once we've decided to use the fallback.
let argon2Promise: Promise<Argon2Module | null> | undefined
let warnedFallback = false

/** Load `@node-rs/argon2` once; resolve to null (and warn) if it cannot load. */
function loadArgon2(): Promise<Argon2Module | null> {
  if (!argon2Promise) {
    argon2Promise = import('@node-rs/argon2')
      .then(mod => mod as unknown as Argon2Module)
      .catch((err: unknown) => {
        if (!warnedFallback) {
          warnedFallback = true
          console.warn(
            `auth/password: @node-rs/argon2 unavailable, falling back to crypto.scrypt: ${String(
              (err as Error)?.message ?? err,
            )}`,
          )
        }
        return null
      })
  }
  return argon2Promise
}

function scryptHash(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES)
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, derived) => {
        if (err) return reject(err)
        resolve(
          `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`,
        )
      },
    )
  })
}

function scryptVerify(stored: string, password: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = stored.split('$')
    // scrypt $ N $ r $ p $ salt $ hash
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false)
    const n = Number(parts[1])
    const r = Number(parts[2])
    const p = Number(parts[3])
    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return resolve(false)
    crypto.scrypt(
      password,
      salt,
      expected.length,
      { N: n, r, p, maxmem: 256 * n * r },
      (err, derived) => {
        if (err) return reject(err)
        // Constant-time compare; timingSafeEqual throws on length mismatch.
        if (derived.length !== expected.length) return resolve(false)
        resolve(crypto.timingSafeEqual(derived, expected))
      },
    )
  })
}

/** Hash a plaintext password. Uses Argon2id when available, else scrypt. */
export async function hash(password: string): Promise<string> {
  const argon2 = await loadArgon2()
  if (argon2) {
    return argon2.hash(password)
  }
  return scryptHash(password)
}

/**
 * Verify a plaintext password against a stored hash. Routes by the stored
 * string's tag so an Argon2 hash still verifies after a fallback to scrypt and
 * vice versa.
 */
export async function verify(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith('scrypt$')) {
    return scryptVerify(stored, password)
  }
  const argon2 = await loadArgon2()
  if (argon2) {
    try {
      return await argon2.verify(stored, password)
    } catch {
      // Malformed/foreign hash — treat as a non-match rather than throwing.
      return false
    }
  }
  // Argon2 hash but native module gone — cannot verify.
  return false
}
