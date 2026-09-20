import { describe, it, expect } from 'vitest'
import { parseMovieFile, parseEpisodeFile, isExtra } from './naming.ts'

describe('parseMovieFile', () => {
  it.each([
    ['/m/Oppenheimer (2023) {tmdb-872585}/Oppenheimer (2023) {tmdb-872585} [Bluray-2160p][DV HDR10][TrueHD 7.1][HEVC]-GRP.mkv', 'Oppenheimer', 2023],
    ['/m/Blade Runner 2049 (2017).mkv', 'Blade Runner 2049', 2017],
    ['/m/2001 A Space Odyssey (1968)/2001 A Space Odyssey (1968) Bluray-1080p.mkv', '2001 A Space Odyssey', 1968],
    ['/m/Dune (2021) {edition-Extended}/Dune (2021) {edition-Extended} WEBDL-1080p.mkv', 'Dune', 2021],
    ['/m/Tenet (2020)/tenet.1080p.bluray.x264.mkv', 'Tenet', 2020],
  ])('%s', (file, title, year) => {
    expect(parseMovieFile(file)).toEqual({ title, year })
  })

  it('returns null when neither the file nor its folder has a year', () => {
    expect(parseMovieFile('/m/holiday-video.mkv')).toBeNull()
  })
})

describe('parseEpisodeFile', () => {
  it.each([
    ['Breaking Bad - S01E01 - Pilot WEBDL-1080p.mkv', 1, 1, 1, 'Pilot'],
    ['A Knight (2026) - S01E01 - Pilot [WEB].mkv', 1, 1, 1, 'Pilot'],
    ['One Piece - S21E1000 - Overwhelming Strength.mkv', 21, 1000, 1000, 'Overwhelming Strength'],
    ['Show - S01E100.mkv', 1, 100, 100, null],
    ['show.s1e5.720p.mkv', 1, 5, 5, null],
    ['Show - 1x05 - Title.mkv', 1, 5, 5, 'Title'],
    ['Show - S00E03 - Christmas Special.mkv', 0, 3, 3, 'Christmas Special'],
    ['Show - S01E01-E02 - Two Parter.mkv', 1, 1, 2, 'Two Parter'],
    ['Show - S01E01E02 - Two Parter.mkv', 1, 1, 2, 'Two Parter'],
    ['Show - S01E01-02 - Two Parter.mkv', 1, 1, 2, 'Two Parter'],
    ['Frieren - S01E05 - 005 - Phantoms of the Dead [Bluray-1080p].mkv', 1, 5, 5, 'Phantoms of the Dead'],
  ])('%s', (name, season, episode, episodeEnd, title) => {
    expect(parseEpisodeFile(name)).toEqual({ season, episode, episodeEnd, title })
  })

  it('does not read a resolution or a year as an episode number', () => {
    expect(parseEpisodeFile('Show 1920x1080 sample.mkv')).toBeNull()
    expect(parseEpisodeFile('Show - 2024-05-01 - Daily Episode.mkv')).toBeNull()
  })
})

describe('isExtra', () => {
  it.each([
    '/m/Dune (2021)/Dune (2021)-trailer.mkv',
    '/m/Dune (2021)/Dune (2021)-featurette.mkv',
    '/m/Dune (2021)/Dune (2021)-behindthescenes.mkv',
    '/m/Dune (2021)/Dune (2021)-deleted.mkv',
    '/m/Dune (2021)/sample.mkv',
    '/m/Dune (2021)/Dune (2021)-sample.mkv',
    '/m/Dune (2021)/Extras/Making Of (2021).mkv',
    '/m/Dune (2021)/Featurettes/Sandworms.mkv',
    '/m/Dune (2021)/Trailers/Trailer 1.mkv',
    '/s/Show/Season 01/Behind The Scenes/S01E01 commentary.mkv',
  ])('%s', file => {
    expect(isExtra(file)).toBe(true)
  })

  it.each([
    '/m/Dune (2021)/Dune (2021).mkv',
    '/m/The Sample (2019)/The Sample (2019).mkv',
    '/m/Trailer Park Boys The Movie (2006)/Trailer Park Boys The Movie (2006).mkv',
    '/s/Extras {tvdb-75663}/Season 01/Extras - S01E01.mkv',
  ])('keeps %s', file => {
    expect(isExtra(file)).toBe(false)
  })
})
