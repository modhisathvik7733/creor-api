import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { shares } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import crypto from "node:crypto"

const SHARE_BASE_URL = process.env.SHARE_BASE_URL ?? "https://creor.ai/share"

export const shareRoutes = new Hono()

// ── Create share (called by engine with { sessionID }) ──

const createShareSchema = z.object({
  sessionID: z.string().min(1),
})

shareRoutes.post("/", zValidator("json", createShareSchema), async (c) => {
  const { sessionID } = c.req.valid("json")
  const id = createId("shr")
  const secret = crypto.randomBytes(32).toString("hex")

  await db.insert(shares).values({
    id,
    secret,
    data: [], // empty — engine will sync data via /sync endpoint
  })

  const url = `${SHARE_BASE_URL}/${id}`
  return c.json({ id, url, secret }, 201)
})

// ── Sync share data (engine pushes incremental updates) ──

const syncShareSchema = z.object({
  secret: z.string().min(1),
  data: z.array(z.any()).min(1),
})

shareRoutes.post("/:id/sync", zValidator("json", syncShareSchema), async (c) => {
  const id = c.req.param("id")
  const { secret, data } = c.req.valid("json")

  // Verify ownership via secret
  const share = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, id), isNull(shares.timeDeleted)))
    .then((rows) => rows[0])

  if (!share) return c.json({ error: "Share not found" }, 404)
  if (share.secret !== secret) return c.json({ error: "Forbidden" }, 403)

  // Merge new data into existing data array
  const existing = (share.data as any[]) ?? []
  const merged = [...existing, ...data]

  await db
    .update(shares)
    .set({ data: merged })
    .where(eq(shares.id, id))

  return c.json({ success: true })
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

// ── Get share data (engine-compatible /data endpoint) ──

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

// ── Delete share (engine sends secret in body) ──

shareRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")

  let secret: string | undefined
  try {
    const body = await c.req.json()
    secret = body?.secret
  } catch {
    // No body — fall through
  }

  const share = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, id), isNull(shares.timeDeleted)))
    .then((rows) => rows[0])

  if (!share) return c.json({ error: "Share not found" }, 404)
  if (share.secret && share.secret !== secret) {
    return c.json({ error: "Forbidden" }, 403)
  }

  await db
    .update(shares)
    .set({ timeDeleted: new Date() })
    .where(eq(shares.id, id))

  return c.json({ success: true })
})
