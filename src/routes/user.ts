import { Hono } from "hono"
import { db } from "../db/client.ts"
import { users } from "../db/schema.ts"
import { eq } from "drizzle-orm"
import { requireAuth, type AuthContext } from "../middleware/auth.ts"

export const userRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

userRoutes.use("*", requireAuth)

// ── Get current user profile ──

userRoutes.get("/me", async (c) => {
  const auth = c.get("auth")
  const user = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      avatarUrl: users.avatarUrl,
      workspaceId: users.workspaceId,
      timeCreated: users.timeCreated,
    })
    .from(users)
    .where(eq(users.id, auth.userId))
    .then((rows) => rows[0])

  if (!user) return c.json({ error: "User not found" }, 404)
  return c.json(user)
})
