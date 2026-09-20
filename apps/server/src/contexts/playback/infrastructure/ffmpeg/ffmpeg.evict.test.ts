import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { evictSegmentsBelow, headSegment } from './ffmpeg.ts'
import { segmentName } from '../../domain/segments.ts'
import type { Session } from '../../domain/types.ts'

describe('segment eviction', () => {
  let dir: string
  const session = () => ({ id: 's1', sessionDir: dir }) as unknown as Session
  const fill = async (rendition: number, segs: number[]) => {
    await mkdir(path.join(dir, `r${rendition}`), { recursive: true })
    await writeFile(path.join(dir, `r${rendition}`, 'init.mp4'), 'x')
    for (const n of segs) await writeFile(path.join(dir, `r${rendition}`, segmentName(n)), 'x')
  }

  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'horizon-evict-')) })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('removes the segments below the given number from every rendition and keeps the rest', async () => {
    await fill(0, [0, 1, 2, 3, 4])
    await fill(1, [0, 1, 2, 3])
    const removed = await evictSegmentsBelow(session(), 3)
    expect(removed).toBe(6)
    expect((await readdir(path.join(dir, 'r0'))).sort()).toEqual(['init.mp4', segmentName(3), segmentName(4)])
    expect((await readdir(path.join(dir, 'r1'))).sort()).toEqual(['init.mp4', segmentName(3)])
  })

  it('does nothing for a session directory that is already gone', async () => {
    await rm(dir, { recursive: true, force: true })
    expect(await evictSegmentsBelow(session(), 100)).toBe(0)
  })

  it('reads the head of the rendition it is asked about', async () => {
    await fill(0, [0, 1, 2, 3, 4])
    await fill(1, [0, 1])
    expect(headSegment(session())).toBe(4)
    expect(headSegment(session(), 1)).toBe(1)
  })
})
