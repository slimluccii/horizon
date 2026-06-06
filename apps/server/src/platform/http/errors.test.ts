import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { ErrorCodes } from '@horizon/sdk'
import type { ServerErrorCode } from '@horizon/sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '../../..')

/**
 * Every error code the server is allowed to emit. This is the human-maintained
 * mirror of {@link ErrorCodes}: if a code is added/removed in the SDK without
 * updating this list, the "matches the SDK" test below fails — forcing a
 * deliberate decision rather than silent drift.
 */
const EXPECTED_CODES = [
  'account-locked',
  'audio-track-invalid',
  'caller-forbidden',
  'fetch-failed',
  'ffmpeg-spawn-failed',
  'grant-forbidden',
  'image-not-found',
  'invalid-credentials',
  'invalid-input',
  'invalid-path',
  'invalid-reconnect-token',
  'invalid-size',
  'invite-expired',
  'invite-not-found',
  'max-sessions',
  'media-not-found',
  'name-taken',
  'no-user',
  'not-found',
  'not-ready',
  'owner-exists',
  'owner-protected',
  'pairing-expired',
  'pairing-not-found',
  'password-required',
  'profile-not-granted',
  'progress-not-found',
  'rate-limited',
  'role-immutable',
  'seek-restart-failed',
  'session-not-found',
  'tmdb-disabled',
  'transcode-failed',
  'unauthorized',
  'unknown-scenario',
  'user-mismatch',
  'user-not-found',
  'weak-password',
] as const

describe('ErrorCodes (centralized error enum)', () => {
  it('exposes every expected error code', () => {
    const values = Object.values(ErrorCodes).sort()
    expect(values).toEqual([...EXPECTED_CODES].sort())
  })

  it('uses kebab-case string values', () => {
    for (const value of Object.values(ErrorCodes)) {
      expect(value).toMatch(/^[a-z]+(-[a-z]+)*$/)
    }
  })

  it('uses SCREAMING_SNAKE_CASE keys that match their kebab-case values', () => {
    for (const [key, value] of Object.entries(ErrorCodes)) {
      expect(key).toBe(value.toUpperCase().replace(/-/g, '_'))
    }
  })

  it('has no duplicate values', () => {
    const values = Object.values(ErrorCodes)
    expect(new Set(values).size).toBe(values.length)
  })

  it('is assignable to ServerErrorCode (compile-time contract)', () => {
    // If ServerErrorCode ever narrows away from ErrorCodes this stops compiling.
    const sample: ServerErrorCode = ErrorCodes.MEDIA_NOT_FOUND
    expect(sample).toBe('media-not-found')
  })
})

/** Recursively collect every .ts source file under src/. */
function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSources(full))
    // Co-located test files legitimately assert on raw error-code strings; this
    // guard targets production source only.
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('no raw error-code string literals remain in src/', () => {
  // Every code the server emits must go through ErrorCodes.X, not a bare
  // string literal. This guards against new code being added with a hardcoded
  // string that the SDK never learns about.
  const sources = collectSources(SRC_DIR)
  const codeValues = Object.values(ErrorCodes) as string[]

  it('emits each ErrorCode via the ErrorCodes constant, never a bare literal', () => {
    const offenders: string[] = []
    for (const file of sources) {
      // errors.ts is the SDK re-export point and may mention nothing here;
      // the SDK itself (types.ts) is the one allowed definition site.
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        // Skip comment lines — JSDoc and inline docs are allowed to mention
        // codes by name (e.g. "'media-not-found' → 404").
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
        for (const code of codeValues) {
          // A bare quoted literal of an error code in executable code.
          if (line.includes(`'${code}'`)) {
            offenders.push(`${path.relative(SRC_DIR, file)}:${i + 1}: '${code}'`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
