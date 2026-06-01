import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveUnderBases } from '../src/paths/confine.ts';

describe('resolveUnderBases', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'confine-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the real path for a directory directly under a base', () => {
    const base = path.join(tmp, 'media');
    const child = path.join(base, 'movies');
    fs.mkdirSync(child, { recursive: true });
    expect(resolveUnderBases([base], child)).toBe(child);
  });

  it('returns the base itself when candidate equals the base', () => {
    const base = path.join(tmp, 'media');
    fs.mkdirSync(base, { recursive: true });
    expect(resolveUnderBases([base], base)).toBe(base);
  });

  it('returns the path for a deeply nested candidate', () => {
    const base = path.join(tmp, 'media');
    const deep = path.join(base, 'shows', 'series', 's01');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveUnderBases([base], deep)).toBe(deep);
  });

  it('rejects a candidate outside the base', () => {
    const base = path.join(tmp, 'media');
    const outside = path.join(tmp, 'other');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    expect(resolveUnderBases([base], outside)).toBeNull();
  });

  it('rejects sibling-prefix paths (/media-evil vs /media)', () => {
    const base = path.join(tmp, 'media');
    const evil = path.join(tmp, 'media-evil');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    expect(resolveUnderBases([base], evil)).toBeNull();
    expect(resolveUnderBases([base], path.join(evil, 'movies'))).toBeNull();
  });

  it("rejects '..' traversal escapes", () => {
    const base = path.join(tmp, 'media');
    fs.mkdirSync(base, { recursive: true });
    expect(resolveUnderBases([base], path.join(base, '..', 'secret'))).toBeNull();
    expect(resolveUnderBases([base], path.join(base, 'a', '..', '..', 'secret'))).toBeNull();
  });

  it('normalizes redundant segments that stay within the base', () => {
    const base = path.join(tmp, 'media');
    const child = path.join(base, 'movies');
    fs.mkdirSync(child, { recursive: true });
    const messy = path.join(base, 'shows', '..', 'movies');
    expect(resolveUnderBases([base], messy)).toBe(child);
  });

  it('defeats symlink escape: a symlink inside the base pointing outside is rejected', () => {
    const base = path.join(tmp, 'media');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(base, 'escape');
    fs.symlinkSync(outside, link);
    expect(resolveUnderBases([base], link)).toBeNull();
  });

  it('resolves a symlink that stays within the base to its real target', () => {
    const base = path.join(tmp, 'media');
    const real = path.join(base, 'real');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    expect(resolveUnderBases([base], link)).toBe(real);
  });

  it('matches against any of multiple bases', () => {
    const base1 = path.join(tmp, 'a');
    const base2 = path.join(tmp, 'b');
    fs.mkdirSync(base1, { recursive: true });
    const child = path.join(base2, 'shows');
    fs.mkdirSync(child, { recursive: true });
    expect(resolveUnderBases([base1, base2], child)).toBe(child);
  });

  it('returns null when no bases are provided', () => {
    const dir = path.join(tmp, 'x');
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveUnderBases([], dir)).toBeNull();
  });

  it('rejects a candidate under a non-existent base', () => {
    const base = path.join(tmp, 'missing');
    const candidate = path.join(base, 'movies');
    expect(resolveUnderBases([base], candidate)).toBeNull();
  });

  it('accepts a not-yet-existing candidate that is lexically under an existing base', () => {
    const base = path.join(tmp, 'media');
    fs.mkdirSync(base, { recursive: true });
    const future = path.join(base, 'new-library');
    expect(resolveUnderBases([base], future)).toBe(future);
  });
});
