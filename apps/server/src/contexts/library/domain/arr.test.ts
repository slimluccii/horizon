import { describe, it, expect } from 'vitest'
import { arrFolderFromEvent, resolveArrFolder } from './arr.ts'

describe('arrFolderFromEvent', () => {
  it.each([
    ['Download', { series: { path: '/data/tv/Frieren {tvdb-424536}' } }, 'shows', '/data/tv/Frieren {tvdb-424536}'],
    ['Rename', { series: { path: '/data/tv/Frieren' } }, 'shows', '/data/tv/Frieren'],
    ['EpisodeFileDelete', { series: { path: '/data/tv/Frieren' } }, 'shows', '/data/tv/Frieren'],
    ['SeriesDelete', { series: { path: '/data/tv/Frieren' } }, 'shows', '/data/tv/Frieren'],
    ['Download', { movie: { folderPath: '/data/movies/Dune (2021)' } }, 'movies', '/data/movies/Dune (2021)'],
    ['MovieFileDelete', { movie: { folderPath: '/data/movies/Dune (2021)' } }, 'movies', '/data/movies/Dune (2021)'],
    ['MovieDelete', { movie: { folderPath: '/data/movies/Dune (2021)/' } }, 'movies', '/data/movies/Dune (2021)'],
  ])('%s %j', (eventType, body, kind, folder) => {
    expect(arrFolderFromEvent({ eventType, ...body })).toEqual({ kind, folder })
  })

  it.each(['Test', 'Grab', 'Health', 'HealthRestored', 'ApplicationUpdate', 'SeriesAdd', 'MovieAdded', 'ManualInteractionRequired'])(
    'ignores %s, which changes nothing on disk',
    eventType => {
      expect(arrFolderFromEvent({ eventType, series: { path: '/data/tv/Frieren' } })).toBeNull()
    },
  )

  it('ignores a payload it does not understand', () => {
    expect(arrFolderFromEvent({ eventType: 'Download' })).toBeNull()
    expect(arrFolderFromEvent({ eventType: 'Download', movie: { folderPath: 42 } })).toBeNull()
    expect(arrFolderFromEvent(null)).toBeNull()
    expect(arrFolderFromEvent('Download')).toBeNull()
  })
})

describe('resolveArrFolder', () => {
  const known = (paths: string[]) => (p: string) => paths.includes(p)

  it('uses the folder as is when both containers mount the library at the same path', () => {
    expect(resolveArrFolder('/media/movies/Dune (2021)', ['/media/movies'], known([])))
      .toEqual(['/media/movies/Dune (2021)'])
  })

  it('maps a folder from the arr container onto the matching root', () => {
    expect(resolveArrFolder('/data/media/movies/Dune (2021)', ['/media/movies'], known(['/media/movies/Dune (2021)'])))
      .toEqual(['/media/movies/Dune (2021)'])
  })

  it('keeps category folders between the root and the show', () => {
    expect(resolveArrFolder('/data/tv/anime/Frieren', ['/media/tv'], known(['/media/tv/anime/Frieren'])))
      .toEqual(['/media/tv/anime/Frieren'])
  })

  it('returns every root that knows the folder, as with separate hd and uhd roots', () => {
    const roots = ['/media/movies', '/media/movies-uhd']
    expect(resolveArrFolder('/data/movies/Dune (2021)', roots, known(['/media/movies/Dune (2021)', '/media/movies-uhd/Dune (2021)'])))
      .toEqual(['/media/movies/Dune (2021)', '/media/movies-uhd/Dune (2021)'])
  })

  it('returns nothing when no root knows the folder', () => {
    expect(resolveArrFolder('/data/movies/Dune (2021)', ['/media/movies'], known([]))).toEqual([])
  })

  it('never resolves to a root itself or outside of it', () => {
    expect(resolveArrFolder('/media/movies', ['/media/movies'], known(['/media/movies']))).toEqual([])
    expect(resolveArrFolder('/data/../..', ['/media/movies'], known(['/media']))).toEqual([])
  })
})
