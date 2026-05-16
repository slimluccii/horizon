export interface BandwidthSample {
  kbps: number
  segmentDownloadMs: number
  timestamp: number
}

export class BandwidthSampler {
  private samples: BandwidthSample[] = []
  private readonly windowSize = 5

  record(bytes: number, durationMs: number) {
    // skip uninformative samples — they would dilute the rolling estimate
    if (durationMs <= 0 || bytes <= 0) return
    const kbps = Math.round((bytes * 8) / durationMs)  // bytes * 8 bits / ms = kbps
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
