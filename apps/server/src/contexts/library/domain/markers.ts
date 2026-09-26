import type { Marker, MarkerKind } from '@horizon/sdk'

export interface Chapter {
  title: string
  startSec: number
  endSec: number
}

const INTRO = /\bintro\b|\bopening credits\b|\btitle sequence\b/i
const CREDITS = /\bcredits\b/i
const RECAP = /\brecap\b|\bpreviously on\b/i

function toMarker(kind: MarkerKind, c: Chapter): Marker {
  return { kind, startMs: Math.round(c.startSec * 1000), endMs: Math.round(c.endSec * 1000) }
}

// Only the first intro and last credits chapter count, since some releases name a scene after the credits it holds.
export function markersFromChapters(chapters: Chapter[]): Marker[] {
  const usable = chapters.filter(c => c.endSec > c.startSec)
  const recap = usable.find(c => RECAP.test(c.title))
  const intro = usable.find(c => INTRO.test(c.title))
  const credits = [...usable].reverse().find(c => CREDITS.test(c.title) && !INTRO.test(c.title))
  const found: Marker[] = []
  if (recap) found.push(toMarker('recap', recap))
  if (intro) found.push(toMarker('intro', intro))
  if (credits) found.push(toMarker('credits', credits))
  return found.sort((a, b) => a.startMs - b.startMs)
}
