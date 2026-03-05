import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client"
import { shares } from "../db/schema"
import { eq, and, isNull } from "drizzle-orm"
import { createId } from "../lib/id"

export const shareRoutes = new Hono()

// ── Create a share (public, no auth required from engine) ──

const createShareSchema = z.object({
  data: z.array(z.any()).min(1),
})

shareRoutes.post("/", zValidator("json", createShareSchema), async (c) => {
  const { data } = c.req.valid("json")
  const id = createId("shr")

  await db.insert(shares).values({
    id,
    data,
  })

  return c.json({ id, url: `https://share.creor.dev/share/${id}` }, 201)
})

// ── Get share data ──

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

// ── Delete (unshare) ──

shareRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  await db
    .update(shares)
    .set({ timeDeleted: new Date() })
    .where(eq(shares.id, id))

  return c.json({ success: true })
})
