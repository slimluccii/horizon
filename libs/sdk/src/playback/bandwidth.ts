export interface BandwidthSample {
  kbps: number
  segmentDownloadMs: number
  timestamp: number
}

const STORAGE_KEY = 'horizon:lastBandwidthKbps'
/** Ignore stored estimates older than this — networks change. */
const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Fraction of the measured bandwidth we admit as a ceiling — headroom for
 *  audio, container overhead, and estimate noise. */
export const BANDWIDTH_SAFETY_FACTOR = 0.8

/** Persist a bandwidth estimate so the NEXT session can start at a sensible
 *  quality instead of blindly direct-playing an 80 Mbps remux over a 20 Mbps
 *  link. No-op outside the browser. */
export function storeBandwidthEstimate(kbps: number): void {
  if (typeof localStorage === 'undefined' || kbps <= 0) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kbps, at: Date.now() }))
  } catch {/* storage full / privacy mode — best-effort */}
}

/** Last stored estimate (kbps), or 0 when unknown/stale. */
export function loadBandwidthEstimate(): number {
  if (typeof localStorage === 'undefined') return 0
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return 0
    const { kbps, at } = JSON.parse(raw) as { kbps?: number; at?: number }
    if (typeof kbps !== 'number' || typeof at !== 'number') return 0
    if (Date.now() - at > STORAGE_MAX_AGE_MS) return 0
    return kbps > 0 ? kbps : 0
  } catch {
    return 0
  }
}

/** Effective maxBitrate for session create: combine an explicit preference cap
 *  with the stored measured estimate (with safety headroom). 0 = unlimited. */
export function effectiveMaxBitrate(preferenceCapKbps: number): number {
  const measured = Math.floor(loadBandwidthEstimate() * BANDWIDTH_SAFETY_FACTOR)
  if (preferenceCapKbps > 0 && measured > 0) return Math.min(preferenceCapKbps, measured)
  return preferenceCapKbps > 0 ? preferenceCapKbps : measured
}

export class BandwidthSampler {
  private samples: BandwidthSample[] = []
  private readonly windowSize = 5

  record(bytes: number, durationMs: number) {
    // skip uninformative samples — they would dilute the rolling estimate
    if (durationMs <= 0 || bytes <= 0) return
    // kbps = kilobits per second. bits = bytes*8; rate = bits / (durationMs/1000) bits/s;
    // kbps = rate/1000 = (bytes*8)/durationMs. (1 kbps == 1 bit/ms, so the /1000 and *1000 cancel.)
    const kbps = Math.round((bytes * 8) / durationMs)
    this.samples.push({ kbps, segmentDownloadMs: durationMs, timestamp: Date.now() })
    if (this.samples.length > this.windowSize) this.samples.shift()
  }

  estimate(): number {
    if (this.samples.length === 0) return 0
    // weighted average: more recent samples weighted higher
    let weightedSum = 0
    let totalWeight = 0
    this.samples.forEach((s, i) => {
      const weight = i + 1
      weightedSum += s.kbps * weight
      totalWeight += weight
    })
    return Math.round(weightedSum / totalWeight)
  }

  lastSample(): BandwidthSample | undefined {
    // return a shallow copy — caller must not mutate internal state
    const last = this.samples[this.samples.length - 1]
    return last ? { ...last } : undefined
  }

  reset(): void {
    this.samples = []
  }
}
