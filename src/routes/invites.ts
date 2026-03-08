import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { invites, users } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createId } from "../lib/id.ts"

export const inviteRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

inviteRoutes.use("*", requireAuth)

// ── List pending invites ──

inviteRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  const result = await db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      invitedBy: invites.invitedBy,
      timeCreated: invites.timeCreated,
    })
    .from(invites)
    .where(
      and(
        eq(invites.workspaceId, auth.workspaceId),
        isNull(invites.timeAccepted),
        isNull(invites.timeDeleted),
      ),
    )

  return c.json(result)
})

// ── Create invite ──

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
})

inviteRoutes.post("/", requireAdmin, zValidator("json", createInviteSchema), async (c) => {
  const auth = c.get("auth")
  const { email, role } = c.req.valid("json")

  // Check if email is already a member of this workspace
  const existingMember = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.workspaceId, auth.workspaceId),
        eq(users.email, email),
        isNull(users.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  if (existingMember) {
    return c.json({ error: "This email is already a member of the workspace" }, 409)
  }

  // Check if there's already a pending invite for this email
  const existingInvite = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.workspaceId, auth.workspaceId),
        eq(invites.email, email),
        isNull(invites.timeAccepted),
        isNull(invites.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  if (existingInvite) {
    return c.json({ error: "An invite has already been sent to this email" }, 409)
  }

  const id = createId("inv")
  const now = new Date()

  await db.insert(invites).values({
    id,
    workspaceId: auth.workspaceId,
    email,
    role,
    invitedBy: auth.userId,
  })

  return c.json({ id, email, role, timeCreated: now.toISOString() }, 201)
})

// ── Delete (cancel) invite ──

inviteRoutes.delete("/:id", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const inviteId = c.req.param("id")

  await db
    .update(invites)
    .set({ timeDeleted: new Date() })
    .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, auth.workspaceId)))

  return c.json({ success: true })
})
