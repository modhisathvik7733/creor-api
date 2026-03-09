import { db } from "../../db/client.ts"
import { keys } from "../../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import type { GatewayAuth } from "./types.ts"

// ── In-memory cache for API key auth (same key used many times per session) ──
const authCache = new Map<string, { result: GatewayAuth; expires: number }>()
const AUTH_TTL = 30_000 // 30 seconds

/**
 * Authenticate a gateway API key (crk_ prefix).
 * Returns the key owner's workspace info, or null if invalid.
 * Caches valid keys for 30s to avoid per-request DB lookups.
 */
export async function authenticateApiKey(apiKey: string): Promise<GatewayAuth | null> {
  const now = Date.now()
  const cached = authCache.get(apiKey)
  if (cached && now < cached.expires) {
    return cached.result
  }

  const keyData = await db
    .select({
      id: keys.id,
      workspaceId: keys.workspaceId,
      userId: keys.userId,
    })
    .from(keys)
    .where(and(eq(keys.key, apiKey), isNull(keys.timeDeleted)))
    .then((rows) => rows[0])

  if (!keyData) return null

  const result: GatewayAuth = {
    keyId: keyData.id,
    workspaceId: keyData.workspaceId,
    userId: keyData.userId,
  }

  authCache.set(apiKey, { result, expires: now + AUTH_TTL })

  // Evict stale entries periodically (keep cache bounded)
  if (authCache.size > 100) {
    for (const [key, entry] of authCache) {
      if (now >= entry.expires) authCache.delete(key)
    }
  }

  return result
}
