import { createMiddleware } from "hono/factory"
import { jwtVerify } from "jose"
import { db } from "../db/client.ts"
import { users } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"

export type AuthContext = {
  userId: string
  workspaceId: string
  email: string
  role: "owner" | "admin" | "member"
}

/**
 * JWT auth middleware — verifies Supabase JWT or our own JWT tokens.
 * Sets `c.set("auth", { userId, workspaceId, ... })` on successful auth.
 */
export const requireAuth = createMiddleware<{
  Variables: { auth: AuthContext }
}>(async (c, next) => {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401)
  }

  const token = header.slice(7)
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    const { payload } = await jwtVerify(token, secret)

    const userId = payload.sub as string
    if (!userId) {
      return c.json({ error: "Invalid token: missing subject" }, 401)
    }

    // Look up user to get workspace and role
    const user = await db
      .select({
        id: users.id,
        workspaceId: users.workspaceId,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.timeDeleted)))
      .then((rows) => rows[0])

    if (!user) {
      return c.json({ error: "User not found" }, 401)
    }

    c.set("auth", {
      userId: user.id,
      workspaceId: user.workspaceId,
      email: user.email,
      role: user.role as AuthContext["role"],
    })

    await next()
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401)
  }
})

/**
 * Require owner or admin role.
 */
export const requireAdmin = createMiddleware<{
  Variables: { auth: AuthContext }
}>(async (c, next) => {
  const auth = c.get("auth")
  if (!auth || (auth.role !== "owner" && auth.role !== "admin")) {
    return c.json({ error: "Insufficient permissions" }, 403)
  }
  await next()
})
