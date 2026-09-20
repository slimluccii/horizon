import type { PlaybackMethod } from './plan.ts'

export function streamUrl(sessionId: string, method: PlaybackMethod): string {
  return method === 'direct-play'
    ? `/api/sessions/${sessionId}/direct`
    : `/api/sessions/${sessionId}/stream.m3u8`
}
