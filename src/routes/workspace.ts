import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { workspaces, users, billing } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { logAudit } from "../lib/audit.ts"

export const workspaceRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

// All workspace routes require auth
workspaceRoutes.use("*", requireAuth)

// ── Get current workspace ──

workspaceRoutes.get("/current", async (c) => {
  const auth = c.get("auth")
  const workspace = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, auth.workspaceId))
    .then((rows) => rows[0])

  if (!workspace) return c.json({ error: "Workspace not found" }, 404)
  return c.json(workspace)
})

// ── Update workspace ──

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
})

workspaceRoutes.patch("/current", requireAdmin, zValidator("json", updateSchema), async (c) => {
  const auth = c.get("auth")
  const body = c.req.valid("json")

  await db
    .update(workspaces)
    .set({ ...body, timeUpdated: new Date() })
    .where(eq(workspaces.id, auth.workspaceId))

  void logAudit({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    action: "settings.updated",
    resourceType: "workspace",
    resourceId: auth.workspaceId,
    metadata: body,
  })

  return c.json({ success: true })
})

// ── List workspace members ──

workspaceRoutes.get("/members", async (c) => {
  const auth = c.get("auth")
  const members = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarUrl: users.avatarUrl,
      timeCreated: users.timeCreated,
    })
    .from(users)
    .where(and(eq(users.workspaceId, auth.workspaceId), isNull(users.timeDeleted)))

  return c.json(members)
})
