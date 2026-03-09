import { createMiddleware } from "hono/factory"
import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

interface RateLimitConfig {
  /** Prefix for the rate limit key (e.g. "global", "auth", "gateway") */
  prefix: string
  /** Max requests per window */
  max: number
  /** Time window in seconds */
  windowSec: number
  /** Custom key function to identify the requester */
  keyFn?: (c: any) => string
}

// ── Redis client (lazy-initialized) ──

let redis: Redis | null = null

function getRedis(): Redis | null {
  if (redis) return redis
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  redis = new Redis({ url, token })
  return redis
}

// ── In-memory fallback (for dev/local without Redis) ──

const counters = new Map<string, { count: number; resetAt: number }>()

setInterval(() => {
  const now = Date.now()
  for (const [key, val] of counters) {
    if (val.resetAt < now) counters.delete(key)
  }
}, 60_000)

function inMemoryCheck(key: string, max: number, windowMs: number): { success: boolean; remaining: number; reset: number } {
  const now = Date.now()
  let entry = counters.get(key)

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs }
    counters.set(key, entry)
  }

  entry.count++
  return {
    success: entry.count <= max,
    remaining: Math.max(0, max - entry.count),
    reset: Math.ceil(entry.resetAt / 1000),
  }
}

// ── Rate limit cache (avoids creating multiple Ratelimit instances) ──

const rateLimiters = new Map<string, Ratelimit>()

function getRateLimiter(config: RateLimitConfig): Ratelimit | null {
  const r = getRedis()
  if (!r) return null

  const cacheKey = `${config.prefix}:${config.max}:${config.windowSec}`
  let limiter = rateLimiters.get(cacheKey)
  if (!limiter) {
    limiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(config.max, `${config.windowSec} s`),
      prefix: `rl:${config.prefix}`,
    })
    rateLimiters.set(cacheKey, limiter)
  }
  return limiter
}

/**
 * Distributed rate limiter using Upstash Redis (sliding window).
 * Falls back to in-memory rate limiting when Redis is not configured.
 */
export function rateLimit(config: RateLimitConfig) {
  return createMiddleware(async (c, next) => {
    const key = config.keyFn
      ? config.keyFn(c)
      : c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown"

    const limiter = getRateLimiter(config)

    if (limiter) {
      // Distributed rate limiting via Upstash Redis
      const result = await limiter.limit(`${config.prefix}:${key}`)

      c.header("X-RateLimit-Limit", String(config.max))
      c.header("X-RateLimit-Remaining", String(result.remaining))
      c.header("X-RateLimit-Reset", String(Math.ceil(result.reset / 1000)))

      if (!result.success) {
        return c.json({ error: "Too many requests. Please try again later." }, 429)
      }
    } else {
      // Fallback: in-memory rate limiting (dev/local)
      const result = inMemoryCheck(key, config.max, config.windowSec * 1000)

      c.header("X-RateLimit-Limit", String(config.max))
      c.header("X-RateLimit-Remaining", String(result.remaining))
      c.header("X-RateLimit-Reset", String(result.reset))

      if (!result.success) {
        return c.json({ error: "Too many requests. Please try again later." }, 429)
      }
    }

    await next()
  })
}
