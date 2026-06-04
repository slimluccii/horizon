import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Architecture guard for the DDD layout. Enforces the cross-context dependency
 * rule mechanically so the structure can't silently erode:
 *
 *  1. A context may only import ANOTHER context through that context's public
 *     barrel (`contexts/<other>/index.ts`) — never its internals.
 *  2. No context may import the platform composition root (`platform/composition/*`);
 *     wiring flows one way, from the composition root into contexts.
 *
 * Pure file-system + import-specifier scan; no behaviour involved.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTEXTS_DIR = path.join(SRC, 'contexts')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** Which context (if any) an absolute path belongs to. */
function contextOf(absPath: string): string | null {
  const rel = path.relative(CONTEXTS_DIR, absPath)
  if (rel.startsWith('..')) return null
  return rel.split(path.sep)[0]
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) specs.push(m[1] ?? m[2])
  return specs
}

describe('DDD architecture rules', () => {
  const files = walk(CONTEXTS_DIR)

  it('has context source files to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('no file imports another context except through its index.ts barrel', () => {
    const violations: string[] = []
    for (const file of files) {
      const ownCtx = contextOf(file)
      const src = readFileSync(file, 'utf8')
      for (const spec of importSpecifiers(src)) {
        if (!spec.startsWith('.')) continue // package import, not cross-context
        const resolved = path.resolve(path.dirname(file), spec)
        const targetCtx = contextOf(resolved)
        if (!targetCtx || targetCtx === ownCtx) continue
        const barrel = path.join(CONTEXTS_DIR, targetCtx, 'index.ts')
        if (resolved !== barrel) {
          violations.push(`${path.relative(SRC, file)} → ${spec} (deep import into '${targetCtx}'; use its index.ts)`)
        }
      }
    }
    expect(violations, `cross-context deep imports:\n${violations.join('\n')}`).toEqual([])
  })

  it('no context imports the platform composition root', () => {
    const compositionDir = path.join(SRC, 'platform', 'composition')
    const violations: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      for (const spec of importSpecifiers(src)) {
        if (!spec.startsWith('.')) continue
        const resolved = path.resolve(path.dirname(file), spec)
        if (resolved.startsWith(compositionDir)) {
          violations.push(`${path.relative(SRC, file)} → ${spec} (contexts must not import the composition root)`)
        }
      }
    }
    expect(violations, `composition-root imports:\n${violations.join('\n')}`).toEqual([])
  })
})
