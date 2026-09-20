import crypto from 'node:crypto'
import type { ExternalIds } from './ids.ts'

export interface TitleIdentity {
  externalIds: ExternalIds
  title: string
  year: number | null
}

function hashId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function titleKey({ title, year }: TitleIdentity): string {
  return `title:${normalizeTitle(title)}:${year ?? ''}`
}

export function movieId(identity: TitleIdentity): string {
  const { tmdb, imdb } = identity.externalIds
  if (tmdb) return hashId(`movie:tmdb:${tmdb}`)
  if (imdb) return hashId(`movie:imdb:${imdb}`)
  return hashId(`movie:${titleKey(identity)}`)
}

export function showId(identity: TitleIdentity): string {
  const { tvdb, tmdb, imdb } = identity.externalIds
  if (tvdb) return hashId(`show:tvdb:${tvdb}`)
  if (tmdb) return hashId(`show:tmdb:${tmdb}`)
  if (imdb) return hashId(`show:imdb:${imdb}`)
  return hashId(`show:${titleKey(identity)}`)
}

export function episodeId(show: string, season: number, episode: number): string {
  return hashId(`episode:${show}:s${season}e${episode}`)
}
