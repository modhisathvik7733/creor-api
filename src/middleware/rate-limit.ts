import { createMiddleware } from "hono/factory"

interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number
  /** Max requests per window */
  max: number
  /** Custom key function to identify the requester */
  keyFn?: (c: any) => string
}

const counters = new Map<string, { count: number; resetAt: number }>()

// Cleanup stale entries every 60 seconds
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of counters) {
    if (val.resetAt < now) counters.delete(key)
  }
}, 60_000)

export function rateLimit(config: RateLimitConfig) {
  return createMiddleware(async (c, next) => {
    const key = config.keyFn
      ? config.keyFn(c)
      : c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown"

    const now = Date.now()
    let entry = counters.get(key)

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + config.windowMs }
      counters.set(key, entry)
    }

    entry.count++

    c.header("X-RateLimit-Limit", String(config.max))
    c.header("X-RateLimit-Remaining", String(Math.max(0, config.max - entry.count)))
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)))

    if (entry.count > config.max) {
      return c.json({ error: "Too many requests. Please try again later." }, 429)
    }

    await next()
  })
}
