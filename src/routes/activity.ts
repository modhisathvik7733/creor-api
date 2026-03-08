import { Hono } from "hono"
import { db } from "../db/client.ts"
import { auditLog, users } from "../db/schema.ts"
import { eq, desc } from "drizzle-orm"
import { requireAuth, type AuthContext } from "../middleware/auth.ts"

export const activityRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

activityRoutes.use("*", requireAuth)

// ── List activity (audit log) ──

activityRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  const page = Math.max(1, Number(c.req.query("page") ?? "1"))
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 100)
  const offset = (page - 1) * limit

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      metadata: auditLog.metadata,
      ipAddress: auditLog.ipAddress,
      timeCreated: auditLog.timeCreated,
      actorName: users.name,
      actorEmail: users.email,
      actorAvatarUrl: users.avatarUrl,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .where(eq(auditLog.workspaceId, auth.workspaceId))
    .orderBy(desc(auditLog.timeCreated))
    .limit(limit)
    .offset(offset)

  return c.json({
    activities: rows.map((r) => ({
      id: r.id,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      timeCreated: r.timeCreated.toISOString(),
      actor: {
        name: r.actorName,
        email: r.actorEmail,
        avatarUrl: r.actorAvatarUrl,
      },
    })),
    page,
    limit,
  })
})
