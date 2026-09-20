import { describe, it, expect } from 'vitest'
import { movieId, showId, episodeId } from './identity.ts'

describe('movieId', () => {
  it('is the same for any title spelling when the tmdb tag matches', () => {
    const a = movieId({ externalIds: { tmdb: 872585 }, title: 'Oppenheimer', year: 2023 })
    const b = movieId({ externalIds: { tmdb: 872585 }, title: 'Oppenheimer IMAX', year: 2024 })
    expect(a).toBe(b)
  })

  it('prefers tmdb over imdb, and imdb over title and year', () => {
    const tmdb = movieId({ externalIds: { tmdb: 1, imdb: 'tt1' }, title: 'X', year: 2000 })
    const imdb = movieId({ externalIds: { imdb: 'tt1' }, title: 'X', year: 2000 })
    const plain = movieId({ externalIds: {}, title: 'X', year: 2000 })
    expect(tmdb).toBe(movieId({ externalIds: { tmdb: 1 }, title: 'Y', year: 1999 }))
    expect(imdb).toBe(movieId({ externalIds: { imdb: 'tt1' }, title: 'Y', year: 1999 }))
    expect(new Set([tmdb, imdb, plain]).size).toBe(3)
  })

  it('falls back to title and year, ignoring case, punctuation and accents', () => {
    const a = movieId({ externalIds: {}, title: 'Amélie: The Movie', year: 2001 })
    const b = movieId({ externalIds: {}, title: 'amelie the movie', year: 2001 })
    expect(a).toBe(b)
  })

  it('tells remakes apart by year', () => {
    const a = movieId({ externalIds: {}, title: 'Dune', year: 1984 })
    const b = movieId({ externalIds: {}, title: 'Dune', year: 2021 })
    expect(a).not.toBe(b)
  })
})

describe('showId', () => {
  it('prefers tvdb, then tmdb, then imdb, then the title', () => {
    const tvdb = showId({ externalIds: { tvdb: 5, tmdb: 6 }, title: 'X', year: null })
    expect(tvdb).toBe(showId({ externalIds: { tvdb: 5 }, title: 'Y', year: null }))
    const tmdb = showId({ externalIds: { tmdb: 6 }, title: 'X', year: null })
    expect(tmdb).not.toBe(tvdb)
    expect(showId({ externalIds: {}, title: 'Breaking Bad', year: null }))
      .toBe(showId({ externalIds: {}, title: 'breaking bad', year: null }))
  })

  it('tells reboots apart by year when the folder carries one', () => {
    const a = showId({ externalIds: {}, title: 'Doctor Who', year: 1963 })
    const b = showId({ externalIds: {}, title: 'Doctor Who', year: 2005 })
    expect(a).not.toBe(b)
  })

  it('never collides with a movie of the same tmdb id', () => {
    expect(showId({ externalIds: { tmdb: 1 }, title: 'X', year: null }))
      .not.toBe(movieId({ externalIds: { tmdb: 1 }, title: 'X', year: 2000 }))
  })
})

describe('episodeId', () => {
  it('depends only on the show, season and episode', () => {
    expect(episodeId('show1', 1, 2)).toBe(episodeId('show1', 1, 2))
    expect(episodeId('show1', 1, 2)).not.toBe(episodeId('show1', 2, 1))
    expect(episodeId('show1', 1, 2)).not.toBe(episodeId('show2', 1, 2))
    expect(episodeId('show1', 1, 12)).not.toBe(episodeId('show1', 11, 2))
  })
})
