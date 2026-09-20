import type { MediaItem } from '@horizon/sdk'

export function runtimeMinutes(item: Pick<MediaItem, 'durationSec'>): number | null {
  return item.durationSec ? Math.round(item.durationSec / 60) : null
}
