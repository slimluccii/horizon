/**
 * Mock data scenarios. Used by:
 *   - `npm -w server run seed:mock -- --scenario=<name>`
 *   - dev-only HTTP route `POST /dev/seed/:scenario` (when HORIZON_DEV_SEED=1)
 *   - e2e tests
 *
 * Scenarios:
 *   empty             — wipes everything; tests empty-state UI
 *   tiny              — 1 movie, 1 show, 1 episode; smoke test
 *   default           — 24 movies, 10 shows w/ multi-season; full-screen browse
 *   huge              — 200 movies, 30 shows × 4 seasons × 12 eps; grid perf
 *   mixed-quality     — every codec/HDR/resolution combo; quality-badge testing
 *   collections-heavy — many overlapping collections; collection-rail testing
 *
 * All scenarios are deterministic — same input ⇒ same DB rows.
 */
import type { MediaRepo, CollectionsRepo } from '../../contexts/library/index.ts'
import type { MovieMetadata, ShowMetadata, EpisodeMetadata } from '../../contexts/metadata/index.ts'

export type ScenarioName = 'empty' | 'tiny' | 'default' | 'huge' | 'mixed-quality' | 'collections-heavy'

export const SCENARIO_NAMES: ScenarioName[] = [
  'empty', 'tiny', 'default', 'huge', 'mixed-quality', 'collections-heavy',
]

export function isScenarioName(s: string): s is ScenarioName {
  return (SCENARIO_NAMES as string[]).includes(s)
}

export interface SeedRepos {
  media: MediaRepo
  collections: CollectionsRepo
  /** Raw DB for the wipe step. Kept separate from the repo facades so we don't
   *  have to invent a `media.deleteAll` method that exists only for tests. */
  rawDb: { exec(sql: string): unknown }
}

export interface ApplyResult {
  scenario: ScenarioName
  movies: number
  shows: number
  episodes: number
  collections: number
}

export function applyScenario(name: ScenarioName, repos: SeedRepos): ApplyResult {
  // Always wipe first — scenarios describe the full intended state, not a delta.
  repos.rawDb.exec('DELETE FROM collection_items; DELETE FROM collections; DELETE FROM media_items;')

  if (name === 'empty') {
    return { scenario: 'empty', movies: 0, shows: 0, episodes: 0, collections: 0 }
  }

  const movies = pickMovies(name)
  const shows = pickShows(name)
  const collections = pickCollections(name, movies)

  const now = Date.now()
  for (const m of movies) {
    const item = repos.media.upsertMovie(buildMovie(m))
    repos.media.markMetadataFetched(item.id, null, now)
  }

  let episodeCount = 0
  for (const s of shows) {
    const item = repos.media.upsertShow(buildShow(s))
    repos.media.markMetadataFetched(item.id, null, now)
    for (const season of s.seasons) {
      for (let e = 0; e < season.episodes.length; e++) {
        const ep = repos.media.upsertEpisode(buildEpisode(s.slug, season.season, e + 1, season.episodes[e], s.title))
        repos.media.markMetadataFetched(ep.id, null, now)
        episodeCount++
      }
    }
  }

  if (collections.length > 0) {
    repos.collections.replaceAll(collections)
  }

  return {
    scenario: name,
    movies: movies.length,
    shows: shows.length,
    episodes: episodeCount,
    collections: collections.length,
  }
}

// ============================================================================
// Scenario selection
// ============================================================================

function pickMovies(scenario: ScenarioName): MovieSeed[] {
  switch (scenario) {
    case 'tiny': return [BASE_MOVIES[0]]
    case 'default': return BASE_MOVIES
    case 'huge': return expandMovies(BASE_MOVIES, 200)
    case 'mixed-quality': return MIXED_QUALITY_MOVIES
    case 'collections-heavy': return BASE_MOVIES
    case 'empty': return []
  }
}

function pickShows(scenario: ScenarioName): ShowSeed[] {
  switch (scenario) {
    case 'tiny': return [{
      ...BASE_SHOWS[0],
      seasons: [{ season: 1, episodes: [BASE_SHOWS[0].seasons[0].episodes[0]] }],
    }]
    case 'default': return BASE_SHOWS
    case 'huge': return expandShows(BASE_SHOWS, 30, 4, 12)
    case 'mixed-quality': return []
    case 'collections-heavy': return BASE_SHOWS.slice(0, 3)
    case 'empty': return []
  }
}

function pickCollections(scenario: ScenarioName, movies: MovieSeed[]): { id: string; name: string; tmdbId: number | null; posterPath: string | null; backdropPath: string | null; movieIds: string[] }[] {
  if (scenario === 'empty' || scenario === 'tiny') return []
  // Default: derive from MovieSeed.collection.
  const byName = new Map<string, string[]>()
  for (const m of movies) {
    if (!m.collection) continue
    const arr = byName.get(m.collection) ?? []
    arr.push(`mock:movie:${m.slug}`)
    byName.set(m.collection, arr)
  }
  if (scenario === 'collections-heavy') {
    // Group by genre too — same movie shows up in multiple collections.
    const byGenre = new Map<string, string[]>()
    for (const m of movies) {
      for (const g of m.genres) {
        const arr = byGenre.get(g) ?? []
        arr.push(`mock:movie:${m.slug}`)
        byGenre.set(g, arr)
      }
    }
    for (const [genre, ids] of byGenre) {
      if (ids.length < 2) continue
      byName.set(`${genre} essentials`, ids)
    }
    // Decade buckets.
    const byDecade = new Map<string, string[]>()
    for (const m of movies) {
      const decade = `${Math.floor(m.year / 10) * 10}s`
      const arr = byDecade.get(decade) ?? []
      arr.push(`mock:movie:${m.slug}`)
      byDecade.set(decade, arr)
    }
    for (const [d, ids] of byDecade) {
      if (ids.length < 2) continue
      byName.set(`From the ${d}`, ids)
    }
  }
  return [...byName.entries()].map(([name, ids]) => ({
    id: `mock-coll:${slugify(name)}`,
    name,
    tmdbId: null,
    posterPath: null,
    backdropPath: null,
    movieIds: ids,
  }))
}

// ============================================================================
// Seed types
// ============================================================================

interface MovieSeed {
  slug: string
  title: string
  year: number
  runtimeMin: number
  rating: number
  genres: string[]
  overview: string
  tagline?: string
  directors: string[]
  cast: { name: string; character: string }[]
  collection?: string
  resolution?: string
  videoCodec?: string
  hdr?: { dv: boolean; hdr10: boolean; hdr10plus: boolean }
}

interface ShowSeed {
  slug: string
  title: string
  year: number
  network: string
  status: string
  rating: number
  genres: string[]
  overview: string
  seasons: { season: number; episodes: EpisodeSeed[] }[]
}

interface EpisodeSeed {
  title: string
  overview: string
  airDate: string
  runtimeMin: number
}

// ============================================================================
// Builders (DB row shape)
// ============================================================================

function buildMovie(m: MovieSeed) {
  const meta: MovieMetadata = {
    kind: 'movie',
    title: m.title,
    originalTitle: m.title,
    overview: m.overview,
    tagline: m.tagline,
    releaseDate: `${m.year}-${pad(((m.title.length) % 11) + 1)}-${pad(((m.title.length * 3) % 27) + 1)}`,
    runtimeMinutes: m.runtimeMin,
    rating: m.rating,
    ratingCount: 500 + (m.title.length * 137) % 12000,
    genres: m.genres,
    posterPath: `/mock/poster/${m.slug}.jpg`,
    backdropPath: `/mock/backdrop/${m.slug}.jpg`,
    cast: m.cast.map(c => ({ name: c.name, role: c.character, profilePath: `/mock/poster/cast-${slugify(c.name)}.jpg` })),
    directors: m.directors.map(d => ({ name: d, role: 'Director', profilePath: `/mock/poster/cast-${slugify(d)}.jpg` })),
  }
  return {
    id: `mock:movie:${m.slug}`,
    filePath: `/mock/movies/${m.title} (${m.year}).mkv`,
    title: m.title,
    sortYear: m.year,
    durationSec: m.runtimeMin * 60,
    resolution: m.resolution ?? '1920x1080',
    videoCodec: m.videoCodec ?? 'hevc',
    container: 'mkv',
    hdr: m.hdr ?? { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [
      { index: 0, codec: 'eac3', channels: 6, language: 'eng', title: 'English 5.1', default: true },
      { index: 1, codec: 'aac', channels: 2, language: 'eng', title: 'Commentary', default: false },
    ],
    subtitleTracks: [
      { index: 2, codec: 'subrip', language: 'eng', forced: false, embeddable: true },
      { index: 3, codec: 'subrip', language: 'spa', forced: false, embeddable: true },
    ],
    mtimeMs: Date.now() - (m.title.length * 86_400_000),
    sizeBytes: m.runtimeMin * 60 * 1_400_000,
    externalIds: { imdb: `tt-mock-${m.slug}` },
    metadata: meta,
  }
}

function buildShow(s: ShowSeed) {
  const meta: ShowMetadata = {
    kind: 'show',
    title: s.title,
    originalTitle: s.title,
    overview: s.overview,
    firstAirDate: `${s.year}-01-15`,
    status: s.status,
    rating: s.rating,
    ratingCount: 2_000 + (s.title.length * 211) % 30_000,
    genres: s.genres,
    posterPath: `/mock/poster/${s.slug}.jpg`,
    backdropPath: `/mock/backdrop/${s.slug}.jpg`,
    network: s.network,
  }
  return {
    id: `mock:show:${s.slug}`,
    title: s.title,
    sortYear: s.year,
    externalIds: { imdb: `tt-mock-${s.slug}` },
    metadata: meta,
  }
}

function buildEpisode(showSlug: string, season: number, ep: number, info: EpisodeSeed, showTitle: string) {
  const meta: EpisodeMetadata = {
    kind: 'episode',
    season,
    episode: ep,
    title: info.title,
    overview: info.overview,
    airDate: info.airDate,
    rating: 7 + ((season + ep) % 20) / 10,
    ratingCount: 200 + (info.title.length * 73) % 4000,
    runtimeMinutes: info.runtimeMin,
    stillPath: `/mock/still/${showSlug}-s${season}e${ep}.jpg`,
  }
  return {
    id: `mock:ep:${showSlug}:s${season}e${ep}`,
    parentId: `mock:show:${showSlug}`,
    title: info.title,
    season,
    episode: ep,
    filePath: `/mock/shows/${showTitle}/Season ${pad(season)}/${showTitle} - S${pad(season)}E${pad(ep)}.mkv`,
    durationSec: info.runtimeMin * 60,
    resolution: '1920x1080',
    videoCodec: 'hevc',
    container: 'mkv',
    hdr: { dv: false, hdr10: false, hdr10plus: false },
    audioTracks: [{ index: 0, codec: 'eac3', channels: 6, language: 'eng', title: 'English 5.1', default: true }],
    subtitleTracks: [{ index: 1, codec: 'subrip', language: 'eng', forced: false, embeddable: true }],
    mtimeMs: Date.now() - ((season * 30 + ep) * 86_400_000),
    sizeBytes: info.runtimeMin * 60 * 700_000,
    externalIds: { imdb: `tt-mock-${showSlug}-s${season}e${ep}` },
    metadata: meta,
  }
}

// ============================================================================
// Procedural expansion (huge scenario)
// ============================================================================

function expandMovies(base: MovieSeed[], target: number): MovieSeed[] {
  const out: MovieSeed[] = [...base]
  let i = 0
  while (out.length < target) {
    const src = base[i % base.length]
    const n = Math.floor(i / base.length) + 1
    out.push({
      ...src,
      slug: `${src.slug}-${n}`,
      title: `${src.title} ${toRoman(n + 1)}`,
      year: src.year + n,
      rating: clampRating(src.rating + ((i % 7) - 3) * 0.1),
    })
    i++
  }
  return out
}

function expandShows(base: ShowSeed[], targetShows: number, seasonsEach: number, epsPerSeason: number): ShowSeed[] {
  const out: ShowSeed[] = []
  for (let i = 0; i < targetShows; i++) {
    const src = base[i % base.length]
    const n = Math.floor(i / base.length)
    const slug = n === 0 ? src.slug : `${src.slug}-${n + 1}`
    const title = n === 0 ? src.title : `${src.title}: ${toRoman(n + 1)}`
    out.push({
      ...src,
      slug,
      title,
      year: src.year + n,
      seasons: makeSeasons(seasonsEach, epsPerSeason, title),
    })
  }
  return out
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  let s = ''
  for (const [v, sym] of table) {
    while (n >= v) { s += sym; n -= v }
  }
  return s || 'I'
}

function clampRating(r: number): number {
  if (r < 0) return 0
  if (r > 10) return 10
  return Math.round(r * 10) / 10
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0') }
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ============================================================================
// Episode synthesis
// ============================================================================

const EPISODE_BEATS = [
  'A reluctant favor goes sideways, then sideways again.',
  'Old debts come due during what was supposed to be a quiet evening.',
  'Someone arrives unannounced and stays one day longer than welcome.',
  'A long-standing rule is broken on a technicality.',
  'A handwritten letter rearranges the week.',
  'A confidence is kept exactly long enough to do damage.',
  'A locked drawer turns out to be unlocked.',
  "Two people who shouldn't share a cab share a cab.",
]
const EPISODE_TITLES = [
  'Cold Open', 'Bright Static', 'Half-Truth', 'Salt and Iron', 'Threadbare', 'Foxhole', 'The Long Way',
  'Borrowed Light', 'Knot Theory', 'Tin Ear', 'Soft Embargo', 'Inheritance', 'Hairline', 'Rough Cut',
]
function episodeTitle(s: number, e: number): string {
  return EPISODE_TITLES[(s * 13 + e * 7) % EPISODE_TITLES.length]
}
function airDate(s: number, e: number): string {
  const year = 2020 + (s - 1)
  const month = String(((e - 1) % 12) + 1).padStart(2, '0')
  const day = String(((e * 3) % 27) + 1).padStart(2, '0')
  return `${year}-${month}-${day}`
}
function makeSeasons(seasonCount: number, episodesPerSeason: number, showTitle: string): ShowSeed['seasons'] {
  const seasons: ShowSeed['seasons'] = []
  for (let s = 1; s <= seasonCount; s++) {
    const episodes: EpisodeSeed[] = []
    for (let e = 1; e <= episodesPerSeason; e++) {
      episodes.push({
        title: episodeTitle(s, e),
        overview: `Season ${s}, episode ${e} of ${showTitle}. ${EPISODE_BEATS[(s * 7 + e) % EPISODE_BEATS.length]}`,
        airDate: airDate(s, e),
        runtimeMin: 42 + ((s + e) % 4) * 3,
      })
    }
    seasons.push({ season: s, episodes })
  }
  return seasons
}

// ============================================================================
// Base fixture data
// ============================================================================

const BASE_MOVIES: MovieSeed[] = [
  { slug: 'neon-horizon', title: 'Neon Horizon', year: 2021, runtimeMin: 128, rating: 7.8, genres: ['Sci-Fi', 'Thriller'],
    overview: 'A neuroengineer wakes up in a city where every billboard knows her secrets. She has six hours to find out why.',
    tagline: 'Every light a memory.', directors: ['Ana Reyes'],
    cast: [{ name: 'Ines Park', character: 'Dr. Liang' }, { name: 'Marcus Vega', character: 'Detective Orr' }, { name: 'Yuna Sato', character: 'The Curator' }],
    collection: 'Reyes Trilogy', resolution: '3840x2160', videoCodec: 'hevc', hdr: { dv: true, hdr10: true, hdr10plus: false } },
  { slug: 'salt-river', title: 'Salt River', year: 2019, runtimeMin: 112, rating: 7.2, genres: ['Drama', 'Western'],
    overview: 'Two estranged brothers drive a herd across a drying basin and confront the bargain they made twenty years ago.',
    tagline: 'The river remembers.', directors: ['Tomás Avilar'],
    cast: [{ name: 'Eli Hart', character: 'Sam' }, { name: 'Olivia Cain', character: 'Ruth' }] },
  { slug: 'tides-of-vega', title: 'Tides of Vega', year: 2022, runtimeMin: 141, rating: 8.1, genres: ['Sci-Fi', 'Adventure'],
    overview: 'A generation ship arrives at its destination to find another vessel already there — and it has been waiting.',
    tagline: 'We were not the first.', directors: ['Ana Reyes'],
    cast: [{ name: 'Ines Park', character: 'Captain Liang' }, { name: 'Hideo Mori', character: 'First Officer Tan' }, { name: 'Priya Anand', character: 'Engineer Kade' }],
    collection: 'Reyes Trilogy', resolution: '3840x2160', videoCodec: 'av1', hdr: { dv: true, hdr10: true, hdr10plus: false } },
  { slug: 'last-light-of-may', title: 'The Last Light of May', year: 2018, runtimeMin: 98, rating: 7.6, genres: ['Romance', 'Drama'],
    overview: 'A retired lighthouse keeper rents a room to a stranger who claims to be writing a book about her late husband.',
    directors: ['Hana Voss'],
    cast: [{ name: 'Marion Cole', character: 'May' }, { name: 'Theo Brandt', character: 'The Writer' }] },
  { slug: 'iron-pilgrim', title: 'Iron Pilgrim', year: 2023, runtimeMin: 134, rating: 7.4, genres: ['Action', 'Sci-Fi'],
    overview: 'Long after the war, a decommissioned mech wakes up in a temple and is told it has one last duty.',
    tagline: 'Walk while you can.', directors: ['Kenji Aoki'],
    cast: [{ name: 'Ren Mochizuki', character: 'Voice of P-9' }, { name: 'Aisha Boateng', character: 'The Abbess' }],
    resolution: '3840x2160', videoCodec: 'hevc', hdr: { dv: false, hdr10: true, hdr10plus: true } },
  { slug: 'paper-cities', title: 'Paper Cities', year: 2020, runtimeMin: 105, rating: 7.0, genres: ['Drama', 'Indie'],
    overview: 'Three roommates in a city that re-zones itself every night try to keep their apartment lease alive.',
    directors: ['Sofia Marchetti'],
    cast: [{ name: 'Lev Asad', character: 'Bo' }, { name: 'Naima Idris', character: 'Pao' }, { name: 'Camille Roux', character: 'Quinn' }] },
  { slug: 'glass-meridian', title: 'Glass Meridian', year: 2024, runtimeMin: 152, rating: 8.3, genres: ['Sci-Fi', 'Mystery'],
    overview: 'A cartographer discovers that the meridian she has been mapping for twenty years has been rotating without anyone noticing.',
    tagline: 'North is a verb now.', directors: ['Ana Reyes'],
    cast: [{ name: 'Ines Park', character: 'Liang' }, { name: 'Dario Lung', character: 'Cartwright' }],
    collection: 'Reyes Trilogy', resolution: '3840x2160', videoCodec: 'av1', hdr: { dv: true, hdr10: true, hdr10plus: true } },
  { slug: 'fox-and-spire', title: 'Fox and Spire', year: 2017, runtimeMin: 89, rating: 6.9, genres: ['Animation', 'Family'],
    overview: 'A fox kit climbs a cathedral spire to retrieve a stolen lantern and meets the gargoyles who run the night shift.',
    directors: ['Mira Pelletier'],
    cast: [{ name: 'Voice cast', character: 'Various' }] },
  { slug: 'low-orbit', title: 'Low Orbit', year: 2016, runtimeMin: 119, rating: 7.5, genres: ['Sci-Fi', 'Thriller'],
    overview: 'Three astronauts on a decaying station realize their ground controllers have been lying for the last forty-one days.',
    tagline: 'Two minutes of delay.', directors: ['Bjorn Nyhus'],
    cast: [{ name: 'Carla Vinter', character: 'Commander Joss' }, { name: 'Esteban Pyne', character: 'Specialist Rao' }] },
  { slug: 'the-quiet-quarter', title: 'The Quiet Quarter', year: 2015, runtimeMin: 124, rating: 7.7, genres: ['Crime', 'Drama'],
    overview: 'A municipal noise inspector starts to suspect a cluster of impossibly silent apartments hides something organized.',
    directors: ['Linnea Holm'],
    cast: [{ name: 'Joonas Pakkanen', character: 'Inspector Reijo' }, { name: 'Aino Salmi', character: 'The Tenant' }] },
  { slug: 'gravel-and-gold', title: 'Gravel and Gold', year: 2013, runtimeMin: 108, rating: 7.1, genres: ['Adventure', 'Comedy'],
    overview: 'Two retired prospectors get talked into one more expedition by a teenager with a hand-drawn map.',
    directors: ['Tomás Avilar'],
    cast: [{ name: 'Eli Hart', character: 'Wes' }, { name: 'Dale Okonkwo', character: 'Reggie' }, { name: 'Nora Kemp', character: 'Frankie' }] },
  { slug: 'second-rain', title: 'Second Rain', year: 2012, runtimeMin: 116, rating: 7.9, genres: ['Drama', 'Music'],
    overview: "A weather forecaster who can predict rain ninety seconds before it falls becomes the city's most reluctant celebrity.",
    tagline: 'Bring a coat.', directors: ['Hana Voss'],
    cast: [{ name: 'Marion Cole', character: 'Ines' }, { name: 'Bram Vogel', character: 'Jakob' }] },
  { slug: 'wax-engines', title: 'Wax Engines', year: 2010, runtimeMin: 132, rating: 7.3, genres: ['Sci-Fi', 'Drama'],
    overview: 'In a country where every machine must be hand-cast in wax, an engineer dares to design one in steel.',
    directors: ['Kenji Aoki'],
    cast: [{ name: 'Ren Mochizuki', character: 'Hashir' }] },
  { slug: 'midnight-archivist', title: 'The Midnight Archivist', year: 2008, runtimeMin: 102, rating: 7.0, genres: ['Mystery'],
    overview: 'A night librarian discovers that one shelf reorders itself between 3:14 and 3:16 every morning.',
    directors: ['Linnea Holm'],
    cast: [{ name: 'Aino Salmi', character: 'Lior' }] },
  { slug: 'no-room-for-thunder', title: 'No Room for Thunder', year: 2007, runtimeMin: 144, rating: 8.0, genres: ['Drama', 'War'],
    overview: 'A field surgeon documents three days of a siege she was told she would not survive.',
    directors: ['Bjorn Nyhus'],
    cast: [{ name: 'Carla Vinter', character: 'Dr. Vehrs' }] },
  { slug: 'orchids-for-mona', title: 'Orchids for Mona', year: 2014, runtimeMin: 96, rating: 6.8, genres: ['Romance', 'Comedy'],
    overview: 'A botanist allergic to her own greenhouse falls for the woman who keeps showing up to buy the same orchid.',
    directors: ['Sofia Marchetti'],
    cast: [{ name: 'Camille Roux', character: 'Mona' }, { name: 'Lev Asad', character: 'Theo' }] },
  { slug: 'the-cartographers-dog', title: "The Cartographer's Dog", year: 2019, runtimeMin: 87, rating: 7.4, genres: ['Animation', 'Adventure'],
    overview: 'A border collie inherits an unfinished atlas and decides to complete it by paw.',
    directors: ['Mira Pelletier'],
    cast: [{ name: 'Voice cast', character: 'Various' }] },
  { slug: 'mantis-bay', title: 'Mantis Bay', year: 2022, runtimeMin: 121, rating: 7.6, genres: ['Thriller'],
    overview: 'A marine biologist studying mantis shrimp is recruited by a foreign intelligence service that wants to recruit them too.',
    directors: ['Linnea Holm'],
    cast: [{ name: 'Joonas Pakkanen', character: 'Asger' }, { name: 'Nora Kemp', character: 'Officer Vail' }] },
  { slug: 'the-borrowed-sky', title: 'The Borrowed Sky', year: 2011, runtimeMin: 138, rating: 7.8, genres: ['Drama', 'Family'],
    overview: "Three siblings return to their grandmother's observatory to settle her estate and find she's left them more than telescopes.",
    directors: ['Hana Voss'],
    cast: [{ name: 'Marion Cole', character: 'Eldest' }, { name: 'Theo Brandt', character: 'Middle' }, { name: 'Aisha Boateng', character: 'Youngest' }] },
  { slug: 'concrete-canary', title: 'Concrete Canary', year: 2023, runtimeMin: 99, rating: 7.2, genres: ['Crime', 'Comedy'],
    overview: 'A demolition crew finds a fully-functional jazz club inside a building they were paid to flatten.',
    directors: ['Tomás Avilar'],
    cast: [{ name: 'Dale Okonkwo', character: 'Foreman Reggie' }] },
  { slug: 'azimuth', title: 'Azimuth', year: 2020, runtimeMin: 127, rating: 8.0, genres: ['Sci-Fi', 'Thriller'],
    overview: 'A solo sailor crossing the Pacific receives a distress call from a vessel that, by every chart, cannot exist.',
    tagline: 'Bearings are a suggestion.', directors: ['Bjorn Nyhus'],
    cast: [{ name: 'Carla Vinter', character: 'Skipper Nyx' }],
    resolution: '3840x2160', videoCodec: 'hevc', hdr: { dv: false, hdr10: true, hdr10plus: false } },
  { slug: 'the-jeweler-of-prague', title: 'The Jeweler of Prague', year: 2009, runtimeMin: 154, rating: 8.2, genres: ['Drama', 'History'],
    overview: 'An apprentice jeweler in 1880s Prague is tasked with copying a stone nobody is supposed to see.',
    directors: ['Hana Voss'],
    cast: [{ name: 'Bram Vogel', character: 'Tomas' }] },
  { slug: 'highway-lullaby', title: 'Highway Lullaby', year: 2018, runtimeMin: 92, rating: 6.7, genres: ['Music', 'Drama'],
    overview: "A trucker drives the same route for fifteen years until she starts hearing a song she's never heard at every overpass.",
    directors: ['Sofia Marchetti'],
    cast: [{ name: 'Naima Idris', character: 'Wren' }] },
  { slug: 'the-tin-saint', title: 'The Tin Saint', year: 2025, runtimeMin: 137, rating: 8.4, genres: ['Sci-Fi', 'Drama'],
    overview: "A worker on a deep-orbit refinery is told the company's new chaplain is a machine — and that confession is now mandatory.",
    tagline: 'Bless the assembly line.', directors: ['Kenji Aoki'],
    cast: [{ name: 'Ren Mochizuki', character: 'Hashir' }, { name: 'Priya Anand', character: 'The Chaplain' }],
    resolution: '3840x2160', videoCodec: 'av1', hdr: { dv: true, hdr10: true, hdr10plus: true } },
]

const BASE_SHOWS: ShowSeed[] = [
  { slug: 'orbital-mail', title: 'Orbital Mail', year: 2021, network: 'Northbeam', status: 'Returning Series', rating: 8.2,
    genres: ['Sci-Fi', 'Comedy'],
    overview: 'A postal carrier for the outer asteroid belt delivers more than packages — every parcel comes with a story.',
    seasons: makeSeasons(2, 8, 'Orbital Mail') },
  { slug: 'kingfisher-county', title: 'Kingfisher County', year: 2019, network: 'Marrow', status: 'Ended', rating: 8.6,
    genres: ['Crime', 'Drama'],
    overview: 'A rural sheriff balances three open cases, two adult children, and one cousin who keeps showing up with a metal detector.',
    seasons: makeSeasons(3, 10, 'Kingfisher County') },
  { slug: 'the-archivists', title: 'The Archivists', year: 2023, network: 'Lambda+', status: 'Returning Series', rating: 7.9,
    genres: ['Mystery', 'Drama'],
    overview: 'Five librarians at a perpetually under-funded municipal archive find that someone keeps adding documents that should not exist.',
    seasons: makeSeasons(2, 6, 'The Archivists') },
  { slug: 'low-stakes-empire', title: 'Low Stakes Empire', year: 2022, network: 'Northbeam', status: 'Returning Series', rating: 8.0,
    genres: ['Comedy'],
    overview: "Two siblings inherit their grandfather's board game café and immediately start losing to the regulars.",
    seasons: makeSeasons(3, 8, 'Low Stakes Empire') },
  { slug: 'glassblower', title: 'Glassblower', year: 2020, network: 'Marrow', status: 'Ended', rating: 8.4,
    genres: ['Drama'],
    overview: "A master glassblower mentors three apprentices in a workshop she's being forced to sell.",
    seasons: makeSeasons(4, 8, 'Glassblower') },
  { slug: 'tide-pool', title: 'Tide Pool', year: 2024, network: 'Lambda+', status: 'Returning Series', rating: 8.1,
    genres: ['Drama', 'Family'],
    overview: "A widowed marine biologist moves her two teenagers to a coastal town where the locals know things they shouldn't.",
    seasons: makeSeasons(1, 8, 'Tide Pool') },
  { slug: 'redline-republic', title: 'Redline Republic', year: 2018, network: 'Cinder', status: 'Ended', rating: 7.6,
    genres: ['Action', 'Thriller'],
    overview: 'A motorcycle courier in a near-future city-state runs deliveries that turn into political insurgencies one envelope at a time.',
    seasons: makeSeasons(2, 10, 'Redline Republic') },
  { slug: 'kettle-and-key', title: 'Kettle & Key', year: 2025, network: 'Northbeam', status: 'Returning Series', rating: 8.5,
    genres: ['Romance', 'Comedy'],
    overview: 'A locksmith and a tea importer keep accidentally booking the same coworking desk, and resent it more than is reasonable.',
    seasons: makeSeasons(1, 6, 'Kettle & Key') },
  { slug: 'the-nightline', title: 'The Nightline', year: 2017, network: 'Marrow', status: 'Ended', rating: 8.7,
    genres: ['Drama'],
    overview: 'An overnight radio host running a call-in show realizes one caller has been calling every night for eleven years.',
    seasons: makeSeasons(3, 8, 'The Nightline') },
  { slug: 'cloudsmith', title: 'Cloudsmith', year: 2022, network: 'Lambda+', status: 'Returning Series', rating: 7.8,
    genres: ['Fantasy', 'Adventure'],
    overview: 'In a kingdom where weather is forged, an apprentice cloudsmith is assigned to a storm nobody has been able to finish.',
    seasons: makeSeasons(2, 8, 'Cloudsmith') },
]

// Exercises every quality badge the UI can render.
const MIXED_QUALITY_MOVIES: MovieSeed[] = [
  { slug: 'mq-sdr-1080-h264', title: 'SDR 1080p H.264', year: 2010, runtimeMin: 100, rating: 7.0, genres: ['Test'],
    overview: 'Baseline 1080p H.264 SDR.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '1920x1080', videoCodec: 'h264', hdr: { dv: false, hdr10: false, hdr10plus: false } },
  { slug: 'mq-sdr-1080-hevc', title: 'SDR 1080p HEVC', year: 2014, runtimeMin: 100, rating: 7.0, genres: ['Test'],
    overview: 'Baseline 1080p HEVC SDR.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '1920x1080', videoCodec: 'hevc', hdr: { dv: false, hdr10: false, hdr10plus: false } },
  { slug: 'mq-hdr10-4k-hevc', title: 'HDR10 4K HEVC', year: 2018, runtimeMin: 100, rating: 7.5, genres: ['Test'],
    overview: '4K HDR10 HEVC.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '3840x2160', videoCodec: 'hevc', hdr: { dv: false, hdr10: true, hdr10plus: false } },
  { slug: 'mq-hdr10plus-4k-hevc', title: 'HDR10+ 4K HEVC', year: 2020, runtimeMin: 100, rating: 7.8, genres: ['Test'],
    overview: '4K HDR10+ HEVC.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '3840x2160', videoCodec: 'hevc', hdr: { dv: false, hdr10: true, hdr10plus: true } },
  { slug: 'mq-dv-4k-hevc', title: 'Dolby Vision 4K HEVC', year: 2021, runtimeMin: 100, rating: 8.0, genres: ['Test'],
    overview: '4K Dolby Vision HEVC.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '3840x2160', videoCodec: 'hevc', hdr: { dv: true, hdr10: true, hdr10plus: false } },
  { slug: 'mq-dv-4k-av1', title: 'Dolby Vision 4K AV1', year: 2024, runtimeMin: 100, rating: 8.2, genres: ['Test'],
    overview: '4K Dolby Vision AV1.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '3840x2160', videoCodec: 'av1', hdr: { dv: true, hdr10: true, hdr10plus: true } },
  { slug: 'mq-sdr-480-h264', title: 'SDR 480p H.264', year: 2002, runtimeMin: 90, rating: 6.0, genres: ['Test'],
    overview: 'Low-res baseline.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '854x480', videoCodec: 'h264', hdr: { dv: false, hdr10: false, hdr10plus: false } },
  { slug: 'mq-sdr-720-h264', title: 'SDR 720p H.264', year: 2008, runtimeMin: 95, rating: 6.5, genres: ['Test'],
    overview: '720p baseline.', directors: ['Test'], cast: [{ name: 'Test', character: 'Test' }],
    resolution: '1280x720', videoCodec: 'h264', hdr: { dv: false, hdr10: false, hdr10plus: false } },
]
