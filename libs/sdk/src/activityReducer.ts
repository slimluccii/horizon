import type { ActivityEvent, MediaKind, MetaStep } from './activity.ts'

export interface ActivityState {
  phase: 'idle' | 'scanning' | 'metadata'
  counts: { movies: number; shows: number; episodes: number }
  progress: { processed: number; total: number } | null
  current: { step: MetaStep; mediaKind: MediaKind; title: string; tmdbId?: number } | null
  rawLines: string[]
}

export const initialActivityState: ActivityState = {
  phase: 'idle',
  counts: { movies: 0, shows: 0, episodes: 0 },
  progress: null,
  current: null,
  rawLines: [],
}

const MAX_LINES = 500

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function activityReducer(state: ActivityState, evt: ActivityEvent): ActivityState {
  const line = `[${fmtTime(evt.ts)}] ${evt.message}`
  const rawLines = [...state.rawLines, line]
  if (rawLines.length > MAX_LINES) rawLines.splice(0, rawLines.length - MAX_LINES)
  const next: ActivityState = { ...state, rawLines }

  switch (evt.kind) {
    case 'scan:start':
      return { ...next, phase: 'scanning', counts: { movies: 0, shows: 0, episodes: 0 }, progress: null }
    case 'scan:detected':
      return {
        ...next,
        counts: {
          movies: next.counts.movies + (evt.mediaKind === 'movie' ? 1 : 0),
          shows: next.counts.shows + (evt.mediaKind === 'show' ? 1 : 0),
          episodes: next.counts.episodes + (evt.mediaKind === 'episode' ? 1 : 0),
        },
      }
    case 'scan:progress':
      return { ...next, progress: { processed: evt.processed, total: evt.total } }
    case 'scan:done':
      return { ...next, counts: { movies: evt.movies, shows: evt.shows, episodes: next.counts.episodes }, progress: null, phase: 'idle' }
    case 'meta:start':
      return { ...next, phase: 'metadata' }
    case 'meta:item':
      return { ...next, current: { step: evt.step, mediaKind: evt.mediaKind, title: evt.title, tmdbId: evt.tmdbId } }
    case 'meta:done':
      return { ...next, phase: 'idle', current: null }
    case 'error':
      return next
    default:
      return next
  }
}
