import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { keys } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { requireAuth, type AuthContext } from "../middleware/auth.ts"
import { createId } from "../lib/id.ts"
import { logAudit } from "../lib/audit.ts"

export const keyRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

keyRoutes.use("*", requireAuth)

// ── List API keys ──

keyRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  const result = await db
    .select({
      id: keys.id,
      name: keys.name,
      keyPrefix: keys.key, // will mask below
      timeUsed: keys.timeUsed,
      timeCreated: keys.timeCreated,
    })
    .from(keys)
    .where(and(eq(keys.workspaceId, auth.workspaceId), isNull(keys.timeDeleted)))

  // Mask keys — only show prefix
  const masked = result.map((k) => ({
    ...k,
    keyPrefix: k.keyPrefix.slice(0, 8) + "..." + k.keyPrefix.slice(-4),
  }))

  return c.json(masked)
})

// ── Create API key ──

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
})

keyRoutes.post("/", zValidator("json", createKeySchema), async (c) => {
  const auth = c.get("auth")
  const { name } = c.req.valid("json")

  const id = createId("key")
  const key = `crk_${crypto.randomUUID().replace(/-/g, "")}`

  await db.insert(keys).values({
    id,
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    name,
    key,
  })

  void logAudit({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    action: "key.created",
    resourceType: "key",
    resourceId: id,
    metadata: { name },
  })

  // Return full key only on creation
  return c.json({ id, name, key }, 201)
})

// ── Delete (revoke) API key ──

keyRoutes.delete("/:id", async (c) => {
  const auth = c.get("auth")
  const keyId = c.req.param("id")

  await db
    .update(keys)
    .set({ timeDeleted: new Date() })
    .where(and(eq(keys.id, keyId), eq(keys.workspaceId, auth.workspaceId)))

  void logAudit({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    action: "key.deleted",
    resourceType: "key",
    resourceId: keyId,
  })

  return c.json({ success: true })
})
