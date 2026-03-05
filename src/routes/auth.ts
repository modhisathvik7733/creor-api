import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { SignJWT } from "jose"
import { db } from "../db/client.ts"
import { users, workspaces, billing, deviceCodes } from "../db/schema.ts"
import { eq, and } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import { requireAuth } from "../middleware/auth.ts"

export const authRoutes = new Hono()

// ── GitHub OAuth callback ──

const githubCallbackSchema = z.object({
  code: z.string(),
  redirect_uri: z.string().optional(),
})

authRoutes.post("/github/callback", zValidator("json", githubCallbackSchema), async (c) => {
  const { code, redirect_uri } = c.req.valid("json")

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      ...(redirect_uri && { redirect_uri }),
    }),
  })

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string }
  if (!tokenData.access_token) {
    console.error("GitHub OAuth token exchange failed:", JSON.stringify(tokenData))
    return c.json({ error: tokenData.error_description ?? tokenData.error ?? "GitHub OAuth failed" }, 400)
  }

  // Get user info from GitHub
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const githubUser = (await userRes.json()) as {
    id: number
    login: string
    email: string | null
    name: string | null
    avatar_url: string
  }

  // Get primary email — try profile first, then /user/emails, then fallback
  let email = githubUser.email
  if (!email) {
    try {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      const emailsData = await emailRes.json()
      const emails = Array.isArray(emailsData) ? emailsData as Array<{ email: string; primary: boolean; verified: boolean }> : []
      email = emails.find((e) => e.primary && e.verified)?.email
        ?? emails.find((e) => e.primary)?.email
        ?? emails.find((e) => e.verified)?.email
        ?? emails[0]?.email
        ?? null
    } catch {
      // emails endpoint failed, continue with fallback
    }
  }

  if (!email) {
    // Last resort: use noreply email GitHub provides
    email = `${githubUser.id}+${githubUser.login}@users.noreply.github.com`
  }

  // Find or create user
  const existingUser = await db
    .select()
    .from(users)
    .where(and(eq(users.authProvider, "github"), eq(users.authProviderId, String(githubUser.id))))
    .then((rows) => rows[0])

  let userId: string
  let workspaceId: string

  if (existingUser) {
    userId = existingUser.id
    workspaceId = existingUser.workspaceId
  } else {
    // Create workspace + user + billing
    workspaceId = createId("ws")
    userId = createId("usr")

    await db.insert(workspaces).values({
      id: workspaceId,
      name: githubUser.name ?? githubUser.login,
      slug: await uniqueSlug(githubUser.login.toLowerCase()),
    })

    await db.insert(users).values({
      id: userId,
      workspaceId,
      email,
      name: githubUser.name ?? githubUser.login,
      role: "owner",
      authProvider: "github",
      authProviderId: String(githubUser.id),
      avatarUrl: githubUser.avatar_url,
    })

    await db.insert(billing).values({
      id: createId("bill"),
      workspaceId,
    })
  }

  // Generate JWT
  const token = await createJWT(userId, workspaceId)

  return c.json({ token, userId, workspaceId })
})

// ── Google OAuth callback ──

const googleCallbackSchema = z.object({
  code: z.string(),
  redirect_uri: z.string(),
})

authRoutes.post("/google/callback", zValidator("json", googleCallbackSchema), async (c) => {
  const { code, redirect_uri } = c.req.valid("json")

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri,
      grant_type: "authorization_code",
    }),
  })

  const tokenData = (await tokenRes.json()) as { access_token?: string; id_token?: string; error?: string; error_description?: string }
  if (!tokenData.access_token) {
    console.error("Google OAuth token exchange failed:", JSON.stringify(tokenData))
    return c.json({ error: tokenData.error_description ?? tokenData.error ?? "Google OAuth failed" }, 400)
  }

  // Get user info
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const googleUser = (await userRes.json()) as {
    id: string
    email: string
    name: string
    picture: string
  }

  // Find or create user
  const existingUser = await db
    .select()
    .from(users)
    .where(and(eq(users.authProvider, "google"), eq(users.authProviderId, googleUser.id)))
    .then((rows) => rows[0])

  let userId: string
  let workspaceId: string

  if (existingUser) {
    userId = existingUser.id
    workspaceId = existingUser.workspaceId
  } else {
    workspaceId = createId("ws")
    userId = createId("usr")

    const slug = await uniqueSlug(googleUser.email.split("@")[0].toLowerCase())

    await db.insert(workspaces).values({
      id: workspaceId,
      name: googleUser.name,
      slug,
    })

    await db.insert(users).values({
      id: userId,
      workspaceId,
      email: googleUser.email,
      name: googleUser.name,
      role: "owner",
      authProvider: "google",
      authProviderId: googleUser.id,
      avatarUrl: googleUser.picture,
    })

    await db.insert(billing).values({
      id: createId("bill"),
      workspaceId,
    })
  }

  const token = await createJWT(userId, workspaceId)
  return c.json({ token, userId, workspaceId })
})

// ── Refresh token ──

authRoutes.post("/refresh", async (c) => {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing token" }, 401)
  }

  try {
    const { jwtVerify } = await import("jose")
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
    const { payload } = await jwtVerify(header.slice(7), secret)
    const token = await createJWT(payload.sub as string, payload.workspaceId as string)
    return c.json({ token })
  } catch {
    return c.json({ error: "Invalid token" }, 401)
  }
})

// ── Device Authorization Flow (IDE ↔ Web sign-in) ──

/** POST /device/code — IDE requests a device code to start sign-in */
authRoutes.post("/device/code", async (c) => {
  const deviceCode = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("") // 32-char hex secret
  const userCode = Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .slice(0, 6) // 6-char alphanumeric code

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

  await db.insert(deviceCodes).values({
    id: createId("dc"),
    deviceCode,
    userCode,
    status: "pending",
    expiresAt,
  })

  const webUrl = process.env.WEB_URL ?? "https://creor.ai"

  return c.json({
    deviceCode,
    userCode: `${userCode.slice(0, 3)}-${userCode.slice(3)}`, // format as ABC-DEF
    verifyUrl: `${webUrl}/auth/device`,
    expiresIn: 600,
  })
})

/** GET /device/status/:deviceCode — IDE polls this to check if user approved */
authRoutes.get("/device/status/:deviceCode", async (c) => {
  const { deviceCode } = c.req.param()

  const dc = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCode, deviceCode))
    .then((rows) => rows[0])

  if (!dc) {
    return c.json({ status: "expired" })
  }

  if (dc.expiresAt < new Date()) {
    return c.json({ status: "expired" })
  }

  if (dc.status === "approved" && dc.token && dc.userId && dc.workspaceId) {
    // Mark as completed so it can't be polled again
    await db
      .update(deviceCodes)
      .set({ status: "completed" })
      .where(eq(deviceCodes.id, dc.id))

    return c.json({
      status: "approved",
      token: dc.token,
      userId: dc.userId,
      workspaceId: dc.workspaceId,
    })
  }

  return c.json({ status: "pending" })
})

/** POST /device/approve — Web user approves a device code (requires auth) */
const approveSchema = z.object({
  userCode: z.string().min(1),
})

authRoutes.post("/device/approve", requireAuth, zValidator("json", approveSchema), async (c) => {
  const auth = c.get("auth")
  const { userCode } = c.req.valid("json")

  // Normalize: remove dash if formatted as ABC-DEF
  const normalized = userCode.replace(/-/g, "").toUpperCase()

  const dc = await db
    .select()
    .from(deviceCodes)
    .where(and(eq(deviceCodes.userCode, normalized), eq(deviceCodes.status, "pending")))
    .then((rows) => rows[0])

  if (!dc) {
    return c.json({ error: "Invalid or expired code" }, 400)
  }

  if (dc.expiresAt < new Date()) {
    return c.json({ error: "Code has expired" }, 400)
  }

  // Generate a JWT for the IDE
  const token = await createJWT(auth.userId, auth.workspaceId)

  await db
    .update(deviceCodes)
    .set({
      status: "approved",
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      token,
    })
    .where(eq(deviceCodes.id, dc.id))

  return c.json({ success: true })
})

// ── Helpers ──

async function uniqueSlug(base: string): Promise<string> {
  let slug = base.replace(/[^a-z0-9-]/g, "").slice(0, 48)
  const existing = await db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .then((rows) => rows[0])
  if (existing) {
    const suffix = Math.random().toString(36).slice(2, 6)
    slug = `${slug}-${suffix}`
  }
  return slug
}

async function createJWT(userId: string, workspaceId: string): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!)
  return new SignJWT({ sub: userId, workspaceId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret)
}
