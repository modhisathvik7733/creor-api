import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { shares } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import { requireAuth } from "../middleware/auth.ts"

export const shareRoutes = new Hono()

// ── Create a share (requires auth) ──

const createShareSchema = z.object({
  data: z.array(z.any()).min(1),
})

shareRoutes.post("/", requireAuth, zValidator("json", createShareSchema), async (c) => {
  const { data } = c.req.valid("json")
  const auth = c.get("auth")
  const id = createId("shr")

  await db.insert(shares).values({
    id,
    workspaceId: auth.workspaceId,
    data,
  })

  return c.json({ id, url: `https://share.creor.dev/share/${id}` }, 201)
})

// ── Get share data (public — anyone with the link can view) ──

shareRoutes.get("/:id", async (c) => {
  const id = c.req.param("id")
  const result = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, id), isNull(shares.timeDeleted)))
    .then((rows) => rows[0])

  if (!result) return c.json({ error: "Share not found" }, 404)
  return c.json(result.data)
})

// ── Get share data (engine-compatible endpoint) ──

shareRoutes.get("/:id/data", async (c) => {
  const id = c.req.param("id")
  const result = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, id), isNull(shares.timeDeleted)))
    .then((rows) => rows[0])

  if (!result) return c.json({ error: "Share not found" }, 404)
  return c.json(result.data)
})

// ── Delete (unshare) — requires auth + ownership ──

shareRoutes.delete("/:id", requireAuth, async (c) => {
  const id = c.req.param("id")
  const auth = c.get("auth")

  // Verify ownership
  const share = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, id), isNull(shares.timeDeleted)))
    .then((rows) => rows[0])

  if (!share) return c.json({ error: "Share not found" }, 404)
  if (share.workspaceId && share.workspaceId !== auth.workspaceId) {
    return c.json({ error: "Forbidden" }, 403)
  }

  await db
    .update(shares)
    .set({ timeDeleted: new Date() })
    .where(eq(shares.id, id))

  return c.json({ success: true })
})
