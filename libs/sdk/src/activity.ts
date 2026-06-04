export type MediaKind = 'movie' | 'show' | 'episode'

export type MetaStep =
  | 'detected'
  | 'resolving-show'
  | 'searching'
  | 'matched'
  | 'fetching'
  | 'fetched'
  | 'stored'
  | 'failed'

interface Base { seq: number; ts: number; message: string }

export type ActivityEvent =
  | (Base & { kind: 'scan:start'; trigger: string; scope: string })
  | (Base & { kind: 'scan:progress'; processed: number; total: number })
  | (Base & { kind: 'scan:detected'; mediaKind: MediaKind; title: string })
  | (Base & { kind: 'scan:done'; movies: number; shows: number; added: number; removed: number; failed: number; durationMs: number })
  | (Base & { kind: 'meta:start' })
  | (Base & { kind: 'meta:item'; step: MetaStep; mediaKind: MediaKind; title: string; tmdbId?: number; reason?: string; cached?: boolean })
  | (Base & { kind: 'meta:done'; refreshed: number; failed: number; durationMs: number })
  | (Base & { kind: 'error'; code: string })

/** An event before the bus stamps seq + ts. */
export type ActivityEventInput =
  ActivityEvent extends infer E
    ? E extends ActivityEvent ? Omit<E, 'seq' | 'ts'> : never
    : never

export const ACTIVITY_STREAM_PATH = '/api/library/activity/stream'
