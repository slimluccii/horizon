import { readMetaCache, writeMetaCache } from './cache.ts'
import type { MovieMetadata, ShowMetadata, EpisodeMetadata, Person } from './types.ts'

const TMDB_BASE = 'https://api.themoviedb.org/3'
const NS = 'tmdb'
/** Cap concurrent in-flight requests so a fresh library scan can't burst past
 *  TMDB's 50 req/sec ceiling. */
const MAX_CONCURRENT = 4

interface TmdbConfig {
  token: string
  cacheDir: string
}

export interface TmdbProvider {
  movieByTmdbId(id: number): Promise<MovieMetadata | null>
  movieByImdbId(id: string): Promise<MovieMetadata | null>
  searchMovie(title: string, year?: number): Promise<MovieMetadata | null>
  showByTmdbId(id: number): Promise<ShowMetadata | null>
  showByTvdbId(id: number): Promise<ShowMetadata | null>
  searchShow(title: string): Promise<ShowMetadata | null>
  episode(tmdbShowId: number, season: number, episode: number): Promise<EpisodeMetadata | null>
}

/** Returns null if no token configured — every consumer must handle that case
 *  gracefully so the server still works without a TMDB key. */
export function createTmdbProvider(token: string | undefined, cacheDir: string): TmdbProvider | null {
  if (!token) return null
  return new Provider({ token, cacheDir })
}

class Provider implements TmdbProvider {
  private cfg: TmdbConfig
  private inFlight = 0
  private queue: (() => void)[] = []

  constructor(cfg: TmdbConfig) { this.cfg = cfg }

  /** Tiny semaphore: queue requests beyond MAX_CONCURRENT. */
  private async acquire(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT) { this.inFlight++; return }
    await new Promise<void>(resolve => this.queue.push(resolve))
    this.inFlight++
  }

  private release(): void {
    this.inFlight--
    const next = this.queue.shift()
    if (next) next()
  }

  /** Cached fetch wrapper — disk cache hit short-circuits the network entirely. */
  private async cachedFetch<T>(parts: (string | number)[], path: string): Promise<T | null> {
    const cached = await readMetaCache<T>(this.cfg.cacheDir, NS, parts)
    if (cached) return cached

    await this.acquire()
    try {
      const res = await fetch(`${TMDB_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/json',
        },
      })
      if (res.status === 404) return null
      if (!res.ok) {
        // Non-fatal: log and return null so enrichment falls back to file metadata.
        console.warn(`TMDB ${res.status} ${path}`)
        return null
      }
      const data = await res.json() as T
      await writeMetaCache(this.cfg.cacheDir, NS, parts, data)
      return data
    } catch (err) {
      console.warn(`TMDB fetch failed ${path}: ${(err as Error).message}`)
      return null
    } finally {
      this.release()
    }
  }

  async movieByTmdbId(id: number): Promise<MovieMetadata | null> {
    const raw = await this.cachedFetch<TmdbMovie>(
      ['movie', id], `/movie/${id}?append_to_response=credits`,
    )
    return raw ? mapMovie(raw) : null
  }

  async movieByImdbId(id: string): Promise<MovieMetadata | null> {
    const raw = await this.cachedFetch<TmdbFindResponse>(
      ['find', id], `/find/${id}?external_source=imdb_id`,
    )
    const tmdbId = raw?.movie_results?.[0]?.id
    return tmdbId ? this.movieByTmdbId(tmdbId) : null
  }

  async searchMovie(title: string, year?: number): Promise<MovieMetadata | null> {
    const q = encodeURIComponent(title)
    const yq = year ? `&year=${year}` : ''
    const raw = await this.cachedFetch<TmdbSearchMovieResponse>(
      ['search-movie', title, year ?? ''],
      `/search/movie?query=${q}${yq}`,
    )
    const tmdbId = raw?.results?.[0]?.id
    return tmdbId ? this.movieByTmdbId(tmdbId) : null
  }

  async showByTmdbId(id: number): Promise<ShowMetadata | null> {
    const raw = await this.cachedFetch<TmdbShow>(
      ['tv', id], `/tv/${id}`,
    )
    return raw ? mapShow(raw) : null
  }

  async showByTvdbId(id: number): Promise<ShowMetadata | null> {
    const raw = await this.cachedFetch<TmdbFindResponse>(
      ['find', `tvdb-${id}`], `/find/${id}?external_source=tvdb_id`,
    )
    const tmdbId = raw?.tv_results?.[0]?.id
    return tmdbId ? this.showByTmdbId(tmdbId) : null
  }

  async searchShow(title: string): Promise<ShowMetadata | null> {
    const q = encodeURIComponent(title)
    const raw = await this.cachedFetch<TmdbSearchShowResponse>(
      ['search-tv', title], `/search/tv?query=${q}`,
    )
    const tmdbId = raw?.results?.[0]?.id
    return tmdbId ? this.showByTmdbId(tmdbId) : null
  }

  async episode(tmdbShowId: number, season: number, episode: number): Promise<EpisodeMetadata | null> {
    const raw = await this.cachedFetch<TmdbEpisode>(
      ['episode', tmdbShowId, season, episode],
      `/tv/${tmdbShowId}/season/${season}/episode/${episode}`,
    )
    return raw ? mapEpisode(raw, tmdbShowId, season, episode) : null
  }
}

// — TMDB wire types (subset used) —

interface TmdbCastEntry { name: string; character?: string; profile_path?: string | null }
interface TmdbCrewEntry { name: string; job?: string; profile_path?: string | null }
interface TmdbCredits { cast?: TmdbCastEntry[]; crew?: TmdbCrewEntry[] }
interface TmdbGenre { name: string }

interface TmdbMovie {
  id: number
  imdb_id?: string
  title: string
  original_title?: string
  tagline?: string
  overview?: string
  release_date?: string
  runtime?: number
  vote_average?: number
  vote_count?: number
  genres?: TmdbGenre[]
  poster_path?: string | null
  backdrop_path?: string | null
  credits?: TmdbCredits
}

interface TmdbShow {
  id: number
  name: string
  original_name?: string
  tagline?: string
  overview?: string
  first_air_date?: string
  status?: string
  vote_average?: number
  vote_count?: number
  genres?: TmdbGenre[]
  poster_path?: string | null
  backdrop_path?: string | null
  networks?: { name: string }[]
}

interface TmdbEpisode {
  id: number
  name?: string
  overview?: string
  air_date?: string
  vote_average?: number
  vote_count?: number
  runtime?: number
  still_path?: string | null
}

interface TmdbFindResponse {
  movie_results?: { id: number }[]
  tv_results?: { id: number }[]
}

interface TmdbSearchMovieResponse { results?: { id: number }[] }
interface TmdbSearchShowResponse { results?: { id: number }[] }

// — mappers (TMDB → normalized) —

function mapPerson(p: TmdbCastEntry): Person {
  return { name: p.name, role: p.character, profilePath: p.profile_path ?? null }
}

function mapCrew(p: TmdbCrewEntry): Person {
  return { name: p.name, role: p.job, profilePath: p.profile_path ?? null }
}

function mapMovie(m: TmdbMovie): MovieMetadata {
  const cast = (m.credits?.cast ?? []).slice(0, 12).map(mapPerson)
  const directors = (m.credits?.crew ?? [])
    .filter(c => c.job === 'Director')
    .map(mapCrew)
  return {
    kind: 'movie',
    tmdbId: m.id,
    imdbId: m.imdb_id,
    title: m.title,
    originalTitle: m.original_title,
    tagline: m.tagline || undefined,
    overview: m.overview || undefined,
    releaseDate: m.release_date,
    runtimeMinutes: m.runtime,
    rating: m.vote_average,
    ratingCount: m.vote_count,
    genres: m.genres?.map(g => g.name),
    posterPath: m.poster_path,
    backdropPath: m.backdrop_path,
    cast,
    directors,
  }
}

function mapShow(s: TmdbShow): ShowMetadata {
  return {
    kind: 'show',
    tmdbId: s.id,
    title: s.name,
    originalTitle: s.original_name,
    tagline: s.tagline || undefined,
    overview: s.overview || undefined,
    firstAirDate: s.first_air_date,
    status: s.status,
    rating: s.vote_average,
    ratingCount: s.vote_count,
    genres: s.genres?.map(g => g.name),
    posterPath: s.poster_path,
    backdropPath: s.backdrop_path,
    network: s.networks?.[0]?.name,
  }
}

function mapEpisode(e: TmdbEpisode, showTmdbId: number, season: number, episode: number): EpisodeMetadata {
  return {
    kind: 'episode',
    tmdbId: e.id,
    showTmdbId,
    season,
    episode,
    title: e.name,
    overview: e.overview || undefined,
    airDate: e.air_date,
    rating: e.vote_average,
    ratingCount: e.vote_count,
    runtimeMinutes: e.runtime,
    stillPath: e.still_path,
  }
}
