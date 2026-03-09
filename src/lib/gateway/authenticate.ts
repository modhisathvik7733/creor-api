import { db } from "../../db/client.ts"
import { keys } from "../../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import type { GatewayAuth } from "./types.ts"

/**
 * Authenticate a gateway API key (crk_ prefix).
 * Returns the key owner's workspace info, or null if invalid.
 */
export async function authenticateApiKey(apiKey: string): Promise<GatewayAuth | null> {
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

  return {
    keyId: keyData.id,
    workspaceId: keyData.workspaceId,
    userId: keyData.userId,
  }
}
