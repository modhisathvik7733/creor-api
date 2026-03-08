import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { providerCredentials } from "../db/schema.ts"
import { eq, and } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createId } from "../lib/id.ts"
import { encrypt, decrypt } from "../lib/crypto.ts"

const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google"] as const
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export const providerRoutes = new Hono<{
  Variables: { auth: AuthContext }
}>()

// All routes require auth + admin
providerRoutes.use("*", requireAuth, requireAdmin)

// ── GET /credentials — list configured providers ──

providerRoutes.get("/credentials", async (c) => {
  const auth = c.get("auth")

  const creds = await db
    .select({
      id: providerCredentials.id,
      provider: providerCredentials.provider,
      timeCreated: providerCredentials.timeCreated,
    })
    .from(providerCredentials)
    .where(eq(providerCredentials.workspaceId, auth.workspaceId))

  return c.json(
    creds.map((cred) => ({
      id: cred.id,
      provider: cred.provider,
      hasCredential: true,
      timeCreated: cred.timeCreated,
    })),
  )
})

// ── PUT /credentials/:provider — set API key ──

const providerParam = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
})

const setKeySchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
})

providerRoutes.put(
  "/credentials/:provider",
  zValidator("json", setKeySchema),
  async (c) => {
    const auth = c.get("auth")
    const provider = c.req.param("provider") as string

    if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400)
    }

    const { apiKey } = c.req.valid("json")
    const encrypted = await encrypt(apiKey)

    await db
      .insert(providerCredentials)
      .values({
        id: createId("cred"),
        workspaceId: auth.workspaceId,
        provider,
        credentials: encrypted,
      })
      .onConflictDoUpdate({
        target: [providerCredentials.workspaceId, providerCredentials.provider],
        set: {
          credentials: encrypted,
          timeCreated: new Date(),
        },
      })

    return c.json({ success: true, provider })
  },
)

// ── DELETE /credentials/:provider — remove API key ──

providerRoutes.delete("/credentials/:provider", async (c) => {
  const auth = c.get("auth")
  const provider = c.req.param("provider") as string

  if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    return c.json({ error: `Unsupported provider: ${provider}` }, 400)
  }

  await db
    .delete(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, auth.workspaceId),
        eq(providerCredentials.provider, provider),
      ),
    )

  return c.json({ success: true })
})

// ── POST /credentials/:provider/test — validate API key ──

providerRoutes.post("/credentials/:provider/test", async (c) => {
  const auth = c.get("auth")
  const provider = c.req.param("provider") as string

  if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    return c.json({ error: `Unsupported provider: ${provider}` }, 400)
  }

  // Fetch stored credential
  const cred = await db
    .select({ credentials: providerCredentials.credentials })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, auth.workspaceId),
        eq(providerCredentials.provider, provider),
      ),
    )
    .then((rows) => rows[0])

  if (!cred) {
    return c.json({ valid: false, error: "No credential configured for this provider" })
  }

  let apiKey: string
  try {
    apiKey = await decrypt(cred.credentials)
  } catch {
    return c.json({ valid: false, error: "Failed to decrypt stored credential" })
  }

  try {
    let res: Response

    switch (provider) {
      case "anthropic":
        res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        })
        break

      case "openai":
        res = await fetch("https://api.openai.com/v1/models", {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        })
        break

      case "google":
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        )
        break

      default:
        return c.json({ valid: false, error: "Unknown provider" })
    }

    if (res.ok) {
      return c.json({ valid: true })
    }

    const body = await res.text()
    let errorMessage = `API returned status ${res.status}`
    try {
      const parsed = JSON.parse(body)
      errorMessage = parsed.error?.message ?? parsed.message ?? errorMessage
    } catch {
      // use default error message
    }
    return c.json({ valid: false, error: errorMessage })
  } catch (err: any) {
    return c.json({ valid: false, error: `Connection error: ${err.message}` })
  }
})
