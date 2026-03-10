import { db } from "../../db/client.ts"
import { sql } from "drizzle-orm"
import type { GatewayAuth } from "./types.ts"

// ── In-memory cache for API key auth (same key used many times per session) ──
const authCache = new Map<string, { result: GatewayAuth; expires: number }>()
const AUTH_TTL = 30_000 // 30 seconds

/**
 * Check if an API key has a valid cached auth result.
 * Used by speculative execution to decide if we can start upstream early.
 */
export function getCachedAuth(apiKey: string): GatewayAuth | null {
  const cached = authCache.get(apiKey)
  if (cached && Date.now() < cached.expires) return cached.result
  return null
}

/**
 * Authenticate a gateway API key (crk_ prefix).
 * Returns the key owner's workspace info, or null if invalid.
 * Caches valid keys for 30s to avoid per-request DB lookups.
 * Uses raw SQL instead of Drizzle query builder for faster execution on Deno.
 */
export async function authenticateApiKey(apiKey: string): Promise<GatewayAuth | null> {
  const now = Date.now()
  const cached = authCache.get(apiKey)
  if (cached && now < cached.expires) {
    return cached.result
  }

  const rows = await db.execute(sql`
    SELECT id, workspace_id, user_id FROM keys
    WHERE key = ${apiKey} AND time_deleted IS NULL
    LIMIT 1
  `)

  const row = rows[0]
  if (!row) return null

  const result: GatewayAuth = {
    keyId: row.id as string,
    workspaceId: row.workspace_id as string,
    userId: row.user_id as string,
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
