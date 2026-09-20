import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { headSegment } from './ffmpeg.ts'
import { segmentName } from '../../domain/segments.ts'
import type { Session } from '../../domain/types.ts'

describe('headSegment', () => {
  let dir: string
  const session = () => ({ id: 's1', sessionDir: dir }) as unknown as Session

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'horizon-head-'))
    await mkdir(path.join(dir, 'r0'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('is the highest segment number in the first rendition', async () => {
    for (const n of [0, 1, 2, 41]) await writeFile(path.join(dir, 'r0', segmentName(n)), 'x')
    await writeFile(path.join(dir, 'r0', 'init.mp4'), 'x')
    expect(headSegment(session())).toBe(41)
  })

  it('is null before the first segment, or when the directory is gone', async () => {
    expect(headSegment(session())).toBeNull()
    await rm(dir, { recursive: true, force: true })
    expect(headSegment(session())).toBeNull()
  })
})
