import { createMiddleware } from "hono/factory"
import { jwtVerify } from "jose"
import { db } from "../db/client.ts"
import { users, sessions, keys } from "../db/schema.ts"
import { eq, and, isNull, gt } from "drizzle-orm"

export type AuthContext = {
  userId: string
  workspaceId: string
  email: string
  role: "owner" | "admin" | "member"
}

// ── In-memory cache for API key auth ──
// Avoids two DB hits (keys + users) on every API key request.

const API_KEY_CACHE_MAX = 500
const API_KEY_CACHE_TTL_MS = 60_000 // 60 seconds

interface ApiKeyCacheEntry {
  auth: AuthContext
  expiresAt: number
}

const apiKeyCache = new Map<string, ApiKeyCacheEntry>()

function apiKeyCacheGet(key: string): AuthContext | undefined {
  const entry = apiKeyCache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    apiKeyCache.delete(key)
    return undefined
  }
  return entry.auth
}

function apiKeyCacheSet(key: string, auth: AuthContext) {
  if (apiKeyCache.size >= API_KEY_CACHE_MAX) {
    const firstKey = apiKeyCache.keys().next().value
    if (firstKey !== undefined) apiKeyCache.delete(firstKey)
  }
  apiKeyCache.set(key, { auth, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS })
}

// ── In-memory LRU cache for session validation ──
// Avoids a DB hit on every authenticated request.

const SESSION_CACHE_MAX = 1000
const SESSION_CACHE_TTL_MS = 60_000 // 60 seconds

interface CacheEntry {
  valid: boolean
  expiresAt: number // Date.now() + TTL
}

const sessionCache = new Map<string, CacheEntry>()

function sessionCacheGet(tokenHash: string): boolean | undefined {
  const entry = sessionCache.get(tokenHash)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    sessionCache.delete(tokenHash)
    return undefined
  }
  return entry.valid
}

function sessionCacheSet(tokenHash: string, valid: boolean) {
  // Evict oldest entries if at capacity
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const firstKey = sessionCache.keys().next().value
    if (firstKey !== undefined) sessionCache.delete(firstKey)
  }
  sessionCache.set(tokenHash, { valid, expiresAt: Date.now() + SESSION_CACHE_TTL_MS })
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * JWT auth middleware — verifies our JWT tokens and checks session validity.
 * Sets `c.set("auth", { userId, workspaceId, ... })` on successful auth.
 */
export const requireAuth = createMiddleware<{
  Variables: { auth: AuthContext }
}>(async (c, next) => {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401)
  }

  const token = header.slice(7)

  // ── API Key auth (crk_ prefix) ──
  if (token.startsWith("crk_")) {
    // Check cache first
    const cached = apiKeyCacheGet(token)
    if (cached) {
      c.set("auth", cached)
      await next()
      return
    }

    const apiKey = await db
      .select({
        id: keys.id,
        userId: keys.userId,
        workspaceId: keys.workspaceId,
      })
      .from(keys)
      .where(and(eq(keys.key, token), isNull(keys.timeDeleted)))
      .then((rows) => rows[0])

    if (!apiKey) {
      return c.json({ error: "Invalid API key" }, 401)
    }

    const user = await db
      .select({
        id: users.id,
        workspaceId: users.workspaceId,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(and(eq(users.id, apiKey.userId), isNull(users.timeDeleted)))
      .then((rows) => rows[0])

    if (!user) {
      return c.json({ error: "User not found" }, 401)
    }

    // Update last-used timestamp (fire-and-forget)
    db.update(keys).set({ timeUsed: new Date() }).where(eq(keys.id, apiKey.id)).catch(() => {})

    const authCtx: AuthContext = {
      userId: user.id,
      workspaceId: user.workspaceId,
      email: user.email,
      role: user.role as AuthContext["role"],
    }
    apiKeyCacheSet(token, authCtx)
    c.set("auth", authCtx)
    await next()
    return
  }

  // ── JWT auth ──
  let verified = false
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    const { payload } = await jwtVerify(token, secret)

    const userId = payload.sub as string
    if (!userId) {
      return c.json({ error: "Invalid token: missing subject" }, 401)
    }

    // Check session validity (revocation check)
    const tokenHash = await hashToken(token)
    const cached = sessionCacheGet(tokenHash)
    if (cached === false) {
      return c.json({ error: "Session revoked" }, 401)
    }
    if (cached === undefined) {
      // Cache miss — check DB
      const activeSession = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.timeRevoked),
            gt(sessions.timeExpires, new Date()),
          ),
        )
        .then((rows) => rows[0])

      const isValid = !!activeSession
      sessionCacheSet(tokenHash, isValid)
      if (!isValid) {
        return c.json({ error: "Session revoked" }, 401)
      }
    }

    // Look up user to get workspace and role
    const user = await db
      .select({
        id: users.id,
        workspaceId: users.workspaceId,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.timeDeleted)))
      .then((rows) => rows[0])

    if (!user) {
      return c.json({ error: "User not found" }, 401)
    }

    c.set("auth", {
      userId: user.id,
      workspaceId: user.workspaceId,
      email: user.email,
      role: user.role as AuthContext["role"],
    })
    verified = true
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401)
  }

  if (verified) {
    await next()
  }
})

/**
 * Require owner or admin role.
 */
export const requireAdmin = createMiddleware<{
  Variables: { auth: AuthContext }
}>(async (c, next) => {
  const auth = c.get("auth")
  if (!auth || (auth.role !== "owner" && auth.role !== "admin")) {
    return c.json({ error: "Insufficient permissions" }, 403)
  }
  await next()
})
