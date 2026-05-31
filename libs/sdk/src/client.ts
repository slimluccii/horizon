// sdk/src/client.ts
import type { ClientCapabilities, MediaItem, SessionInfo, ShowSummary, SeasonSummary, User, WatchProgress, ContinueWatchingItem, ServerSettings, ServerSettingsPatch } from './types.ts'
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

/**
 * Returns true when an error thrown by HorizonClient indicates the caller's
 * role was insufficient — typically because an admin demoted themselves and
 * then attempted a privileged mutation. The web client should use this to
 * redirect to the Personal tab and show "Your role changed."
 */
export function isRoleChangedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: string }).code === 'caller-forbidden'
  )
}

/**
 * Returns true when an error indicates the requested watch-progress record does
 * not exist (server replied 404 with code `progress-not-found`). `progress.get`
 * uses this to resolve to `null` rather than reject. Safe for any `unknown`
 * value — verifies `instanceof Error` before touching `.code`.
 */
export function isProgressNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: string }).code === 'progress-not-found'
  )
}

/** Cap on raw-response text included in an error message, to keep messages sane. */
const ERROR_TEXT_LIMIT = 200

/**
 * Build an Error for a non-ok HTTP response. Normal path is a JSON error body
 * (`{ error, code }`). When the body is not valid JSON (e.g. an nginx/proxy HTML
 * 502 page, or an unhandled server exception), fall back to `res.text()` and
 * include a truncated snippet so the failure is debuggable instead of a bare
 * `HTTP 502`. A `code` is attached only when the JSON body actually carried one.
 */
async function buildHttpError(res: Response): Promise<Error> {
  let body: { error?: string; code?: string } | null = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (body && typeof body === 'object') {
    const error = new Error(body.error ?? `HTTP ${res.status}`)
    if (typeof body.code === 'string') (error as Error & { code?: string }).code = body.code
    return error
  }
  // JSON parse failed — try to surface the raw response text for debugging.
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  const snippet = text.trim().slice(0, ERROR_TEXT_LIMIT)
  const suffix = snippet ? `: ${snippet}` : ''
  return new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${suffix}`)
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
      throw await buildHttpError(res)
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
    update: (id: string, body: { name?: string; avatar?: string | null; preferences?: Partial<Preferences>; role?: 'owner' | 'admin' | 'member' }) =>
      this.fetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      this.fetch<void>(`/users/${id}`, { method: 'DELETE' }),
  }

  readonly settings = {
    getServer: () => this.fetch<ServerSettings>('/settings/server'),
    patchServer: (patch: ServerSettingsPatch) =>
      this.fetch<ServerSettings>('/settings/server', { method: 'PATCH', body: JSON.stringify(patch) }),
  }

  readonly progress = {
    continueWatching: (userId: string) =>
      this.fetch<ContinueWatchingItem[]>(`/users/${userId}/continue-watching`),
    get: (userId: string, mediaId: string) =>
      this.fetch<WatchProgress>(`/users/${userId}/progress/${mediaId}`)
        .catch(err => isProgressNotFoundError(err) ? null : Promise.reject(err)),
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
