import { describe, it, expect } from 'vitest'
import { pickInitialTracks, isImageSubtitle } from './trackSelection.ts'
import type { MediaItem } from '../library/mediaItem.ts'
import type { AudioTrack, SubtitleTrack } from './session.ts'

function audio(index: number, language: string): AudioTrack {
  return { index, codec: 'aac', channels: 2, language, title: '', default: index === 0 }
}

function sub(index: number, language: string, opts: Partial<SubtitleTrack> = {}): SubtitleTrack {
  return { index, codec: 'subrip', language, forced: false, embeddable: true, ...opts }
}

function media(audioTracks: AudioTrack[], subtitleTracks: SubtitleTrack[]): MediaItem {
  return { audioTracks, subtitleTracks } as MediaItem
}

describe('pickInitialTracks', () => {
  it('picks audio + subtitle by preferred language (happy path)', () => {
    const m = media(
      [audio(0, 'eng'), audio(1, 'nld')],
      [sub(0, 'eng'), sub(1, 'dut')],
    )
    const picked = pickInitialTracks(m, { audioLanguage: 'nl', subtitleLanguage: 'nl', subtitlesEnabled: true })
    expect(picked).toEqual({ audioTrackIndex: 1, subtitleTrackIndex: 1 })
  })

  it('defaults to track 0 audio and no subtitle without preferences (edge path)', () => {
    const m = media([audio(0, 'eng')], [sub(0, 'eng')])
    expect(pickInitialTracks(m, undefined)).toEqual({ audioTrackIndex: 0, subtitleTrackIndex: null })
    expect(pickInitialTracks(m, { subtitlesEnabled: false })).toEqual({ audioTrackIndex: 0, subtitleTrackIndex: null })
  })

  it('prefers a text track over an image track in the same language', () => {
    const m = media(
      [audio(0, 'eng')],
      [
        sub(0, 'eng', { codec: 'hdmv_pgs_subtitle', embeddable: false }),
        sub(1, 'eng'),
      ],
    )
    const picked = pickInitialTracks(m, { subtitlesEnabled: true, subtitleLanguage: 'en' })
    expect(picked.subtitleTrackIndex).toBe(1)
  })

  it('falls back to an image track when it is the only match', () => {
    const m = media(
      [audio(0, 'eng')],
      [sub(0, 'eng', { codec: 'hdmv_pgs_subtitle', embeddable: false })],
    )
    const picked = pickInitialTracks(m, { subtitlesEnabled: true, subtitleLanguage: 'en' })
    expect(picked.subtitleTrackIndex).toBe(0)
  })

  it('skips forced-only tracks when a full track exists', () => {
    const m = media(
      [audio(0, 'eng')],
      [sub(0, 'dut', { forced: true }), sub(1, 'dut')],
    )
    const picked = pickInitialTracks(m, { subtitlesEnabled: true, subtitleLanguage: 'nl' })
    expect(picked.subtitleTrackIndex).toBe(1)
  })

  it('subtitlesEnabled without a language picks the first reasonable track', () => {
    const m = media([audio(0, 'eng')], [sub(0, 'fre'), sub(1, 'eng')])
    const picked = pickInitialTracks(m, { subtitlesEnabled: true })
    expect(picked.subtitleTrackIndex).toBe(0)
  })
})

describe('isImageSubtitle', () => {
  it('classifies PGS as image, text and sidecars as not', () => {
    expect(isImageSubtitle(sub(0, 'eng', { codec: 'hdmv_pgs_subtitle', embeddable: false }))).toBe(true)
    expect(isImageSubtitle(sub(0, 'eng'))).toBe(false)
    expect(isImageSubtitle(sub(0, 'eng', { embeddable: true, external: true, externalFileName: 'a.srt' }))).toBe(false)
  })
})
