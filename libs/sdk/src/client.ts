// sdk/src/client.ts
import type { ClientCapabilities, MediaItem, SessionInfo, ShowSummary, SeasonSummary, User, WatchProgress, ContinueWatchingItem } from './types.ts'
import type { Preferences } from './preferences.ts'
import { detectCapabilities } from './capabilities.ts'
import { PlaybackSession, type PlaybackSessionOptions } from './session.ts'

export interface HorizonClientOptions {
  baseUrl: string
}

export interface PlayOptions extends Omit<PlaybackSessionOptions, 'sessionInfo' | 'baseUrl' | 'capabilities'> {
  capabilities?: Partial<ClientCapabilities>
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
  startPositionMs?: number
  autoCleanup?: boolean
}

export class HorizonClient {
  private baseUrl: string
  private activeUserId: string | null = null

  constructor(opts: HorizonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
  }

  setActiveUser(id: string | null): void {
    this.activeUserId = id
  }

  getActiveUser(): string | null {
    return this.activeUserId
  }

  private userHeaders(): Record<string, string> {
    return this.activeUserId ? { 'X-Horizon-User': this.activeUserId } : {}
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...this.userHeaders(), ...(init?.headers ?? {}) },
      ...init,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { code: body.code })
    }
    if (res.status === 204) return undefined as T
    return res.json()
  }

  readonly library = {
    listMovies: () => this.fetch<MediaItem[]>('/library/movies'),
    listCollections: () => this.fetch<{ id: string; name: string; movies: MediaItem[] }[]>('/library/movies/collections'),
    listShows: () => this.fetch<ShowSummary[]>('/library/shows'),
    getShow: (showId: string) => this.fetch<ShowSummary>(`/library/shows/${showId}`),
    listSeasons: (showId: string) => this.fetch<SeasonSummary[]>(`/library/shows/${showId}/seasons`),
    listEpisodes: (showId: string, season: number) => this.fetch<MediaItem[]>(`/library/shows/${showId}/seasons/${season}`),
  }

  readonly users = {
    list: () => this.fetch<User[]>('/users'),
    get: (id: string) => this.fetch<User>(`/users/${id}`),
    create: (body: { name: string; avatar?: string | null }) =>
      this.fetch<User>('/users', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: { name?: string; avatar?: string | null; preferences?: Partial<Preferences> }) =>
      this.fetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      this.fetch<void>(`/users/${id}`, { method: 'DELETE' }),
  }

  readonly progress = {
    continueWatching: (userId: string) =>
      this.fetch<ContinueWatchingItem[]>(`/users/${userId}/continue-watching`),
    get: (userId: string, mediaId: string) =>
      this.fetch<WatchProgress>(`/users/${userId}/progress/${mediaId}`)
        .catch(err => err.code === 'progress-not-found' ? null : Promise.reject(err)),
    markWatched: (userId: string, mediaId: string, watched: boolean) =>
      this.fetch<WatchProgress>(
        `/users/${userId}/progress/${mediaId}`,
        { method: 'PATCH', body: JSON.stringify({ watched }) },
      ),
    clear: (userId: string, mediaId: string) =>
      this.fetch<void>(`/users/${userId}/progress/${mediaId}`, { method: 'DELETE' }),
  }

  async play(mediaId: string, opts: PlayOptions): Promise<PlaybackSession> {
    const caps = detectCapabilities(opts.capabilities)
    const sessionInfo = await this.fetch<SessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        mediaId,
        capabilities: caps,
        audioTrackIndex: opts.audioTrackIndex ?? 0,
        subtitleTrackIndex: opts.subtitleTrackIndex ?? null,
        userId: this.activeUserId ?? undefined,
        startPositionMs: opts.startPositionMs,
      }),
    })

    return new PlaybackSession({
      sessionInfo,
      baseUrl: this.baseUrl,
      capabilities: caps,
      onReady: opts.onReady,
      onQualityChange: opts.onQualityChange,
      onTrackChange: opts.onTrackChange,
      onWarning: opts.onWarning,
      onEnded: opts.onEnded,
      onError: opts.onError,
    })
  }
}
