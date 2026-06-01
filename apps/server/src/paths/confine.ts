import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve `candidate` and confirm it lives under (or equals) one of `bases`.
 *
 * Returns the canonical real path of the candidate iff it is contained by a
 * base, otherwise `null`. Containment is symlink-aware: both the base and the
 * candidate are resolved via `fs.realpathSync` so a symlink inside an allowed
 * base cannot be used to escape it. Sibling-prefix matches (e.g. `/media-evil`
 * against base `/media`) are rejected.
 */
export function resolveUnderBases(bases: string[], candidate: string): string | null {
  const resolvedCandidate = path.resolve(candidate);

  for (const base of bases) {
    const realBase = realPath(path.resolve(base));
    if (realBase === null) continue;

    // Reject path-traversal escapes before touching the filesystem so that a
    // non-existent candidate built from `..` segments never matches.
    const relative = path.relative(realBase, resolvedCandidate);
    if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      continue;
    }

    // Resolve symlinks on the candidate (falling back to the lexical path when
    // it does not yet exist) and re-check containment against the real base.
    const realCandidate = realPath(resolvedCandidate) ?? resolvedCandidate;
    if (isUnder(realBase, realCandidate)) {
      return realCandidate;
    }
  }

  return null;
}

function realPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isUnder(base: string, candidate: string): boolean {
  if (candidate === base) return true;
  const rel = path.relative(base, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
