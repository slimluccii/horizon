import { describe, it, expect } from 'vitest'
import { markersFromChapters, type Chapter } from './markers.ts'

function chapters(...list: [string, number, number][]): Chapter[] {
  return list.map(([title, startSec, endSec]) => ({ title, startSec, endSec }))
}

describe('markersFromChapters', () => {
  it('finds the intro and credits of a typical streaming release', () => {
    expect(markersFromChapters(chapters(
      ['Intro', 0, 45], ['Scene 1', 45, 308], ['Scene 2', 308, 850], ['Credits', 1323, 1364],
    ))).toEqual([
      { kind: 'intro', startMs: 0, endMs: 45_000 },
      { kind: 'credits', startMs: 1_323_000, endMs: 1_364_000 },
    ])
  })

  it('keeps an intro that follows a cold open at its own offset', () => {
    expect(markersFromChapters(chapters(['Scene 1', 0, 51], ['Intro', 51, 96], ['Scene 2', 96, 316])))
      .toEqual([{ kind: 'intro', startMs: 51_000, endMs: 96_000 }])
  })

  it('treats a recap as its own marker, not as the intro', () => {
    expect(markersFromChapters(chapters(
      ['Recap', 4, 89], ['Scene 1', 89, 93], ['Intro', 93, 117], ['Scene 2', 117, 2815], ['Credits', 2815, 3037],
    ))).toEqual([
      { kind: 'recap', startMs: 4_000, endMs: 89_000 },
      { kind: 'intro', startMs: 93_000, endMs: 117_000 },
      { kind: 'credits', startMs: 2_815_000, endMs: 3_037_000 },
    ])
  })

  it('reads "Opening Credits" as the intro and "End Credits" as the credits', () => {
    expect(markersFromChapters(chapters(['Opening Credits', 6, 30], ['Chapter 01', 30, 2577], ['End Credits', 2577, 2787])))
      .toEqual([
        { kind: 'intro', startMs: 6_000, endMs: 30_000 },
        { kind: 'credits', startMs: 2_577_000, endMs: 2_787_000 },
      ])
  })

  it('reads "Title Sequence" as the intro', () => {
    expect(markersFromChapters(chapters(['Amazon Original', 0, 5], ['Title Sequence', 5, 19], ['Scene 1', 19, 491])))
      .toEqual([{ kind: 'intro', startMs: 5_000, endMs: 19_000 }])
  })

  it('takes the first intro-like chapter when a release names more than one', () => {
    expect(markersFromChapters(chapters(
      ['Title Sequence', 560, 565], ['Gordon and Bullock meet major crimes, Opening Credits', 565, 684],
    ))).toEqual([{ kind: 'intro', startMs: 560_000, endMs: 565_000 }])
  })

  it('takes the last credits-like chapter when a release names more than one', () => {
    expect(markersFromChapters(chapters(['Credits', 100, 110], ['Scene 9', 110, 2000], ['Credits', 2000, 2100])))
      .toEqual([{ kind: 'credits', startMs: 2_000_000, endMs: 2_100_000 }])
  })

  it('does not read a prologue, a studio logo or a numbered chapter as a marker', () => {
    expect(markersFromChapters(chapters(
      ['Studio Logo', 0, 10], ['Prologue', 10, 194], ['Chapter 1', 194, 436], ['Part 01', 436, 2625],
    ))).toEqual([])
  })

  it('does not read "Amazon Original" as a marker', () => {
    expect(markersFromChapters(chapters(['Amazon Original', 0, 5], ['Scene 1', 5, 491]))).toEqual([])
  })

  it('does not read scene names that merely contain a marker word as markers', () => {
    expect(markersFromChapters(chapters(
      ['Opening Night', 0, 100], ['Theme Park', 100, 200], ['Introduction', 200, 300],
      ['The Pending Case', 300, 400], ['Happy Ending', 400, 500], ['Recapture', 500, 600],
    ))).toEqual([])
  })

  it('does not read an ending song as the intro', () => {
    expect(markersFromChapters(chapters(['Scene 1', 0, 1300], ['Ending Theme', 1300, 1390])))
      .toEqual([])
  })

  it('reads "Previously on" as the recap', () => {
    expect(markersFromChapters(chapters(['Previously on', 0, 40], ['Scene 1', 40, 900])))
      .toEqual([{ kind: 'recap', startMs: 0, endMs: 40_000 }])
  })

  it('ignores a chapter with no length', () => {
    expect(markersFromChapters(chapters(['Intro', 30, 30]))).toEqual([])
  })

  it('returns nothing for a file without chapters', () => {
    expect(markersFromChapters([])).toEqual([])
  })
})
