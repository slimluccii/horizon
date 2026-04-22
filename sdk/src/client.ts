// sdk/src/client.ts
import type { ClientCapabilities, MediaItem, SessionInfo } from './types.ts'
import { detectCapabilities } from './capabilities.ts'
import { PlaybackSession, type PlaybackSessionOptions } from './session.ts'

export interface HorizonClientOptions {
  baseUrl: string
}

export interface PlayOptions extends Omit<PlaybackSessionOptions, 'sessionInfo' | 'baseUrl' | 'capabilities'> {
  capabilities?: Partial<ClientCapabilities>
  audioTrackIndex?: number
  subtitleTrackIndex?: number | null
  autoCleanup?: boolean
}

export class HorizonClient {
  private baseUrl: string

  constructor(opts: HorizonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { code: body.code })
    }
    return res.json()
  }

  readonly library = {
    listMovies: () => this.fetch<MediaItem[]>('/library/movies'),
    listCollections: () => this.fetch<{ id: string; name: string; movies: MediaItem[] }[]>('/library/movies/collections'),
    listShows: () => this.fetch<{ id: string; title: string; seasonCount: number }[]>('/library/shows'),
    listSeasons: (showId: string) => this.fetch<{ number: number; episodeCount: number }[]>(`/library/shows/${showId}/seasons`),
    listEpisodes: (showId: string, season: number) => this.fetch<MediaItem[]>(`/library/shows/${showId}/seasons/${season}`),
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
