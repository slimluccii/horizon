import type { ActivityEvent, ActivityEventInput } from '@horizon/sdk'

export interface ActivityBus {
  emit(evt: ActivityEventInput): void
  subscribe(fn: (evt: ActivityEvent) => void): () => void
  recent(): ActivityEvent[]
}

export function createActivityBus(opts?: { bufferSize?: number; now?: () => number }): ActivityBus {
  const bufferSize = opts?.bufferSize ?? 500
  const now = opts?.now ?? Date.now
  const buffer: ActivityEvent[] = []
  const subs = new Set<(evt: ActivityEvent) => void>()
  let seq = 0

  return {
    emit(input) {
      const evt = { ...input, seq: seq++, ts: now() } as ActivityEvent
      buffer.push(evt)
      if (buffer.length > bufferSize) buffer.shift()
      for (const fn of [...subs]) {
        try { fn(evt) } catch { subs.delete(fn) }
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
    recent() {
      return [...buffer]
    },
  }
}
