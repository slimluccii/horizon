/**
 * Minimal in-memory, per-IP fixed-window rate limiter. Used to throttle the
 * destructive dev-seed endpoint so a leaked/abused HORIZON_DEV_SEED=1
 * deployment can't be wiped in a tight loop. In-memory + per-process is
 * sufficient: dev/staging are single-process and the seed flag must never be
 * set in production anyway.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { errorReply, ErrorCodes } from './errors.ts'

interface Window {
  count: number
  resetAt: number
}

export class IpRateLimiter {
  private readonly windows = new Map<string, Window>()
  private readonly intervalMs: number

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs
  }

  /** Records a hit for `ip` and returns true if it is within the allowed
   *  `maxPerInterval` for the current window; false if the limit is exceeded. */
  allow(ip: string, maxPerInterval: number): boolean {
    const now = Date.now()
    const w = this.windows.get(ip)
    if (!w || now >= w.resetAt) {
      this.windows.set(ip, { count: 1, resetAt: now + this.intervalMs })
      return true
    }
    if (w.count >= maxPerInterval) return false
    w.count += 1
    return true
  }
}

/** Fastify preHandler that 429s (rate-limited code) when the caller's IP has
 *  exceeded `maxPerInterval` requests in the limiter's window. */
export function rateLimit(limiter: IpRateLimiter, maxPerInterval: number): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    if (!limiter.allow(req.ip, maxPerInterval)) {
      errorReply(reply, 429, ErrorCodes.RATE_LIMITED, 'Too many requests')
      return
    }
    done()
  }
}
