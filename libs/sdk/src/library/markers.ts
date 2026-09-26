export type MarkerKind = 'intro' | 'credits' | 'recap'

/** Where a skippable part of a file starts and ends, as the server sends it. */
export interface Marker {
  kind: MarkerKind
  startMs: number
  endMs: number
}

/** The marker to offer a skip for at this position; the end is exclusive and credits are never offered. */
export function skippableAt(markers: Marker[], positionMs: number): Marker | null {
  return markers.find(m => m.kind !== 'credits' && positionMs >= m.startMs && positionMs < m.endMs) ?? null
}
