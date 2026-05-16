/**
 * Lightweight daily scheduler — fires once per day at the configured local-time
 * hour. Intentionally narrow: we don't need cron expressions, just "run at 03:00."
 */

export interface DailyScheduleHandle {
  stop(): void
  /** Returns the timestamp of the next planned firing (ms since epoch). */
  nextFireAt(): number
}

export interface DailyScheduleOptions {
  /** Hour of day [0..23] in local time. */
  hourLocal: number
  /** Optional minute offset [0..59]. Defaults to 0. */
  minuteLocal?: number
  /** Run synchronously on startup if last fire was more than this many ms ago.
   *  Set to 0 to disable startup catch-up. */
  catchUpIfOlderThanMs: number
  /** When did the schedule last fire? Used for catch-up; pass 0 if unknown. */
  lastFiredAt: number
  task: () => void | Promise<void>
}

/**
 * Compute the next firing time at-or-after `from`.
 * Always strictly *after* `from` if the time exactly matches now.
 */
export function nextDailyFireAt(from: Date, hour: number, minute: number): number {
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime()
}

export function startDailySchedule(opts: DailyScheduleOptions): DailyScheduleHandle {
  const minute = opts.minuteLocal ?? 0
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let plannedNext = nextDailyFireAt(new Date(), opts.hourLocal, minute)

  // Catch-up on boot: if we missed the most recent firing, run once immediately.
  if (opts.catchUpIfOlderThanMs > 0) {
    const now = Date.now()
    const lastWindowStart = nextDailyFireAt(new Date(now), opts.hourLocal, minute) - 86_400_000
    if (opts.lastFiredAt < lastWindowStart && lastWindowStart < now &&
        (now - opts.lastFiredAt) > opts.catchUpIfOlderThanMs) {
      Promise.resolve(opts.task()).catch(err => console.error('Scheduled task error (catch-up):', err))
    }
  }

  function arm(): void {
    if (stopped) return
    const delay = Math.max(1000, plannedNext - Date.now())
    // Cap setTimeout to ~24 d (Node max). For our 24 h cycle this never trips.
    timer = setTimeout(async () => {
      if (stopped) return
      try { await opts.task() }
      catch (err) { console.error('Scheduled task error:', err) }
      plannedNext = nextDailyFireAt(new Date(), opts.hourLocal, minute)
      arm()
    }, delay)
    // Allow process exit even with timer pending.
    if ((timer as NodeJS.Timeout).unref) (timer as NodeJS.Timeout).unref()
  }

  arm()

  return {
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
    nextFireAt: () => plannedNext,
  }
}
