import { createMiddleware } from "hono/factory"

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

// ── Upstash REST client (zero dependencies, just fetch) ──

const UPSTASH_URL = () => process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN

async function redisCommand(...args: (string | number)[]): Promise<{ result: unknown }> {
  const res = await fetch(`${UPSTASH_URL()}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  })
  return res.json()
}

/** Fixed-window rate limit via INCR + EXPIRE on Upstash Redis REST API */
async function redisCheck(
  key: string,
  max: number,
  windowSec: number,
): Promise<{ success: boolean; remaining: number; reset: number }> {
  // Pipeline: INCR key, then EXPIRE key windowSec (NX = only if no TTL)
  const res = await fetch(`${UPSTASH_URL()}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, windowSec, "NX"],
    ]),
  })

  const results = (await res.json()) as Array<{ result: number }>
  const count = results[0]?.result ?? 1
  const remaining = Math.max(0, max - count)
  const reset = Math.ceil(Date.now() / 1000) + windowSec

  return { success: count <= max, remaining, reset }
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

/**
 * Distributed rate limiter using Upstash Redis REST API (fixed window).
 * Falls back to in-memory rate limiting when Redis is not configured.
 * Zero npm dependencies — uses plain fetch to Upstash REST endpoint.
 */
export function rateLimit(config: RateLimitConfig) {
  return createMiddleware(async (c, next) => {
    const key = config.keyFn
      ? config.keyFn(c)
      : c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown"

    const fullKey = `rl:${config.prefix}:${key}`
    const hasRedis = !!UPSTASH_URL() && !!UPSTASH_TOKEN()

    let result: { success: boolean; remaining: number; reset: number }

    if (hasRedis) {
      try {
        result = await redisCheck(fullKey, config.max, config.windowSec)
      } catch {
        // Redis unavailable — fall through to in-memory
        result = inMemoryCheck(fullKey, config.max, config.windowSec * 1000)
      }
    } else {
      result = inMemoryCheck(fullKey, config.max, config.windowSec * 1000)
    }

    c.header("X-RateLimit-Limit", String(config.max))
    c.header("X-RateLimit-Remaining", String(result.remaining))
    c.header("X-RateLimit-Reset", String(result.reset))

    if (!result.success) {
      return c.json({ error: "Too many requests. Please try again later." }, 429)
    }

    await next()
  })
}
