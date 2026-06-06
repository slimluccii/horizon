// sdk/src/client/client.ts
import type { SessionInfo } from '../playback/session.ts'
import type { ClientCapabilities } from '../playback/capabilities.ts'
import type { MediaItem, ShowSummary, SeasonSummary } from '../library/mediaItem.ts'
import type { User, AuthSession, SetPasswordResult, PairStartResult, PairPollResult } from '../identity/user.ts'
import type { HouseholdView, InviteKind, InviteResult } from '../identity/household.ts'
import type { WatchProgress, ContinueWatchingItem, ServerSettings, ServerSettingsPatch, BrowseResult, ScanStatusResponse } from '../shared/http.ts'
import type { Preferences } from '../identity/preferences.ts'
import type { CollectionSummary } from '../library/collections.ts'
import { ErrorCodes } from '../shared/errors.ts'
import { detectCapabilities } from '../playback/capabilities.ts'
import { PlaybackSession, type PlaybackSessionOptions } from '../playback/session.ts'

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
    (err as Error & { code?: string }).code === ErrorCodes.CALLER_FORBIDDEN
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
    (err as Error & { code?: string }).code === ErrorCodes.PROGRESS_NOT_FOUND
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
  /** Opaque session token for native clients (macOS, TV) sent as
   *  `Authorization: Bearer`. Null on the web, where identity rides the
   *  httpOnly `hz_session` cookie instead — set via `auth.login`. */
  private token: string | null = null

  constructor(opts: HorizonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
  }

  /** Store the bearer token issued by `auth.login` / `auth.pairPoll`. Native
   *  clients persist it (Keychain, etc.) and re-set it on the next launch; the
   *  web ignores it because the cookie carries identity. Pass null to clear. */
  setToken(token: string | null): void {
    this.token = token
  }

  getToken(): string | null {
    return this.token
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    // Only advertise a JSON body when one is actually sent. A bodyless POST
    // (logout, logout-all, pair/start) with `Content-Type: application/json`
    // makes Fastify try to parse an empty body and 400 — so set the header only
    // when there's a body.
    const hasBody = init?.body != null
    // All backend endpoints live under `/api` (server-side API/web split). Call
    // sites keep clean resource paths ('/library/movies'); the prefix is applied
    // here in one place.
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      // Always send credentials so the web's httpOnly hz_session cookie rides
      // every request (including cross-origin dev via the Vite proxy). Native
      // clients have no cookie and lean on the Authorization header instead.
      credentials: 'include',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...this.authHeaders(),
        ...(init?.headers ?? {}),
      },
      ...init,
    })
    if (!res.ok) {
      throw await buildHttpError(res)
    }
    if (res.status === 204) return undefined as T
    return res.json()
  }

  readonly library = {
    /**
     * Filesystem directory browser for picking library roots (owner/admin only).
     * No `path` → the filesystem root's subdirectories. With `path` → the
     * immediate subdirectories under it. `parent` is null at the filesystem root.
     */
    browse: (path?: string) =>
      this.fetch<BrowseResult>(
        path === undefined ? '/library/browse' : `/library/browse?path=${encodeURIComponent(path)}`,
      ),
    listMovies: () => this.fetch<MediaItem[]>('/library/movies'),
    listCollections: () => this.fetch<CollectionSummary[]>('/library/movies/collections'),
    getCollection: (id: string) => this.fetch<CollectionSummary>(`/library/movies/collections/${id}`),
    listShows: () => this.fetch<ShowSummary[]>('/library/shows'),
    getShow: (showId: string) => this.fetch<ShowSummary>(`/library/shows/${showId}`),
    listSeasons: (showId: string) => this.fetch<SeasonSummary[]>(`/library/shows/${showId}/seasons`),
    listEpisodes: (showId: string, season: number) => this.fetch<MediaItem[]>(`/library/shows/${showId}/seasons/${season}`),
    /** Combined scan + metadata-refresh health snapshot. Any authed user may
     *  read it; the web shows it only in the admin (owner/admin) Server tab. */
    scanStatus: () => this.fetch<ScanStatusResponse>('/library/scan-status'),
    /** Trigger a full library rescan (owner/admin). Fire-and-forget; poll
     *  scanStatus() to watch progress. */
    rescan: () => this.fetch<{ status: string }>('/library/rescan', { method: 'POST', body: JSON.stringify({}) }),
  }

  readonly users = {
    list: () => this.fetch<User[]>('/users'),
    get: (id: string) => this.fetch<User>(`/users/${id}`),
    /**
     * Create a profile. On first boot (empty household) this creates the
     * auto-elected owner AND the server issues a session: the web gets the
     * httpOnly cookie, and the response carries `{ token }` for native clients —
     * which we stash so the immediately-following `auth.setPassword` call is
     * authenticated. Authenticated creates (every later profile) just return User.
     */
    create: async (body: { name: string; avatar?: string | null }): Promise<User> => {
      const res = await this.fetch<User & { token?: string }>('/users', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (res.token) this.setToken(res.token)
      const { token: _drop, ...user } = res
      void _drop
      return user
    },
    update: (id: string, body: { name?: string; avatar?: string | null; preferences?: Partial<Preferences>; role?: 'owner' | 'admin' | 'member' }) =>
      this.fetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) =>
      this.fetch<void>(`/users/${id}`, { method: 'DELETE' }),
    /** Server owner/admin: profiles with no household (orphans). */
    orphans: () => this.fetch<User[]>('/users/orphans'),
  }

  readonly households = {
    /** The caller's household + its members. */
    me: () => this.fetch<HouseholdView>('/households/me'),
    /** Server owner/admin: every household with its members. */
    all: () => this.fetch<HouseholdView[]>('/households'),
    /** Rename a household (household owner or server owner/admin). */
    rename: (id: string, name: string) =>
      this.fetch<HouseholdView>(`/households/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    /** Server owner/admin: delete a household. `deleteMembers` true cascades
     *  the member profiles; false orphans them (household_id → null). */
    remove: (id: string, deleteMembers: boolean) =>
      this.fetch<void>(`/households/${id}`, { method: 'DELETE', body: JSON.stringify({ deleteMembers }) }),
    /** Server owner/admin: move a profile (incl. an orphan) into the household.
     *  The server returns only the household id + refreshed member list (not the
     *  full view), so the result is narrowed to match what's actually sent. */
    addMember: (householdId: string, userId: string) =>
      this.fetch<Pick<HouseholdView, 'id' | 'members'>>(`/households/${householdId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
  }

  readonly invites = {
    /** Mint a single-use invite. `new_household` is server owner/admin only;
     *  `join` is the household owner's (server re-checks). `householdId` targets
     *  another household for a `join` invite (server owner/admin only). */
    create: (body: { kind: InviteKind; householdId?: string }) =>
      this.fetch<InviteResult>('/invites', { method: 'POST', body: JSON.stringify(body) }),
    /** Redeem an invite to create the account + session. Unauthenticated. Stores
     *  the returned bearer token (native); the web also gets the hz_session cookie. */
    redeem: async (body: { code: string; name: string; password: string }): Promise<AuthSession> => {
      const res = await this.fetch<AuthSession>('/invites/redeem', { method: 'POST', body: JSON.stringify(body) })
      this.setToken(res.token)
      return res
    },
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

  readonly auth = {
    /**
     * Verify a username + password. On success the server sets the httpOnly
     * `hz_session` cookie (web) AND returns `{ token, user }`; we stash the
     * token via {@link setToken} so native clients send it as a bearer on
     * subsequent requests. The web ignores the token and rides the cookie.
     */
    login: async (name: string, password: string): Promise<AuthSession> => {
      const res = await this.fetch<AuthSession>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ name, password }),
      })
      this.setToken(res.token)
      return res
    },
    /** Revoke the current session and clear the stored bearer token + cookie. */
    logout: async (): Promise<void> => {
      await this.fetch<{ ok: true }>('/auth/logout', { method: 'POST' })
      this.setToken(null)
    },
    /** Revoke every session for the caller (all devices). Clears the local token. */
    logoutAll: async (): Promise<{ revoked: number }> => {
      const res = await this.fetch<{ revoked: number }>('/auth/logout-all', { method: 'POST' })
      this.setToken(null)
      return res
    },
    /** The SDK's identity source — resolves the caller from cookie/bearer. A
     *  401 here is the web's signal to redirect to /login. */
    me: () => this.fetch<User>('/auth/me'),
    /**
     * Set or change a password. Self-service supplies `oldPassword` once one is
     * set (omitted on first-boot / forced set). Owner/admin reset another user
     * via `userId` with no old password. A self-change re-issues a session and
     * returns `{ token, user }` (token re-stored); an admin reset returns `{}`.
     */
    setPassword: async (body: { userId?: string; oldPassword?: string; newPassword: string }): Promise<SetPasswordResult> => {
      const res = await this.fetch<SetPasswordResult>('/auth/set-password', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (res.token) this.setToken(res.token)
      return res
    },
    /** TV device-pairing: mint a short-lived code the TV displays, then polls. */
    pairStart: () => this.fetch<PairStartResult>('/auth/pair/start', { method: 'POST' }),
    /** Approve a pairing code from an already-authenticated phone/web client.
     *  `grant` is the set of profile ids the linked device may act as (a subset
     *  of the approver's household); omitted → the server grants the approver
     *  only (or, for a household owner, the whole household). */
    pairApprove: (code: string, grant?: string[]) =>
      this.fetch<{ ok: true }>('/auth/pair/approve', {
        method: 'POST',
        body: JSON.stringify(grant ? { code, grant } : { code }),
      }),
    /**
     * Poll a pairing code. Returns `{ status: 'pending' }` (HTTP 202) until the
     * code is approved, then `{ token, user }` once — the token is stored so the
     * TV is logged in. Rejects (410 `pairing-expired`) after expiry/consumption.
     */
    pairPoll: async (code: string): Promise<PairPollResult> => {
      const res = await this.fetch<PairPollResult>('/auth/pair/poll', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
      if ('token' in res) this.setToken(res.token)
      return res
    },
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
        startPositionMs: opts.startPositionMs,
      }),
    })

    return new PlaybackSession({
      sessionInfo,
      baseUrl: this.baseUrl,
      capabilities: caps,
      token: this.token ?? undefined,
      onReady: opts.onReady,
      onQualityChange: opts.onQualityChange,
      onTrackChange: opts.onTrackChange,
      onWarning: opts.onWarning,
      onEnded: opts.onEnded,
      onError: opts.onError,
    })
  }
}
