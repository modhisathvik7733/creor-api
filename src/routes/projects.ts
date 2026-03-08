import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { projects } from "../db/schema.ts"
import { eq, and, isNull, sql } from "drizzle-orm"
import { requireAuth, type AuthContext } from "../middleware/auth.ts"
import { createId } from "../lib/id.ts"

export const projectRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

projectRoutes.use("*", requireAuth)

// ── List projects ──

projectRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  const result = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, auth.workspaceId), isNull(projects.timeDeleted)))
    .orderBy(sql`time_last_active DESC NULLS LAST`)

  return c.json(result)
})

// ── Create project ──

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().optional(),
  repoUrl: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
})

projectRoutes.post("/", zValidator("json", createProjectSchema), async (c) => {
  const auth = c.get("auth")
  const body = c.req.valid("json")

  const id = createId("proj")

  await db.insert(projects).values({
    id,
    workspaceId: auth.workspaceId,
    name: body.name,
    path: body.path,
    repoUrl: body.repoUrl,
    description: body.description,
    language: body.language,
  })

  const [created] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))

  return c.json(created, 201)
})

// ── Update project ──

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  branch: z.string().optional(),
  status: z.string().optional(),
})

projectRoutes.patch("/:id", zValidator("json", updateProjectSchema), async (c) => {
  const auth = c.get("auth")
  const projectId = c.req.param("id")
  const body = c.req.valid("json")

  await db
    .update(projects)
    .set({ ...body, timeUpdated: new Date() })
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, auth.workspaceId)),
    )

  return c.json({ success: true })
})

// ── Delete project (soft-delete) ──

projectRoutes.delete("/:id", async (c) => {
  const auth = c.get("auth")
  const projectId = c.req.param("id")

  await db
    .update(projects)
    .set({ timeDeleted: new Date() })
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, auth.workspaceId)),
    )

  return c.json({ success: true })
})

// ── Heartbeat (update activity) ──

const heartbeatSchema = z.object({
  branch: z.string().optional(),
})

projectRoutes.post("/:id/heartbeat", zValidator("json", heartbeatSchema), async (c) => {
  const auth = c.get("auth")
  const projectId = c.req.param("id")
  const body = c.req.valid("json")

  await db
    .update(projects)
    .set({
      timeLastActive: new Date(),
      sessionCount: sql`COALESCE(${projects.sessionCount}, 0) + 1`,
      ...(body.branch ? { branch: body.branch } : {}),
      timeUpdated: new Date(),
    })
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, auth.workspaceId)),
    )

  return c.json({ success: true })
})
