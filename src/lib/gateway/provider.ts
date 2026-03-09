import { db } from "../../db/client.ts"
import { providerCredentials } from "../../db/schema.ts"
import { eq, and } from "drizzle-orm"
import { decrypt } from "../crypto.ts"
import type { ProviderConfig } from "./types.ts"

/**
 * Resolve the upstream LLM provider for a given model.
 * Checks workspace BYOK keys first, falls back to environment API keys.
 */
export async function resolveProvider(
  model: string,
  workspaceId?: string,
): Promise<ProviderConfig | null> {
  let providerName: string | null = null
  if (model.startsWith("anthropic/")) providerName = "anthropic"
  else if (model.startsWith("openai/")) providerName = "openai"
  else if (model.startsWith("google/")) providerName = "google"

  if (!providerName) return null

  // Check for workspace-level BYOK key (priority over env vars)
  let byokKey: string | null = null
  if (workspaceId) {
    const cred = await db
      .select({ credentials: providerCredentials.credentials })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.workspaceId, workspaceId),
          eq(providerCredentials.provider, providerName),
        ),
      )
      .then((rows) => rows[0])

    if (cred) {
      try {
        byokKey = await decrypt(cred.credentials)
      } catch (err) {
        console.error(`Failed to decrypt BYOK key for ${providerName}:`, err)
      }
    }
  }

  if (model.startsWith("anthropic/")) {
    const upstreamModel = model.replace("anthropic/", "")
    const apiKey = byokKey ?? process.env.ANTHROPIC_API_KEY!
    return {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      path: "/v1/messages",
      upstreamModel,
      setAuth: (h) => {
        h.set("x-api-key", apiKey)
        h.set("anthropic-version", "2023-06-01")
      },
    }
  }

  if (model.startsWith("openai/")) {
    const upstreamModel = model.replace("openai/", "")
    const apiKey = byokKey ?? process.env.OPENAI_API_KEY!
    return {
      provider: "openai",
      baseUrl: "https://api.openai.com",
      path: "/v1/chat/completions",
      upstreamModel,
      setAuth: (h) => h.set("Authorization", `Bearer ${apiKey}`),
    }
  }

  if (model.startsWith("google/")) {
    const upstreamModel = model.replace("google/", "")
    const apiKey = byokKey ?? process.env.GOOGLE_AI_API_KEY!
    return {
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      path: "/v1beta/openai/chat/completions",
      upstreamModel,
      setAuth: (h) => h.set("Authorization", `Bearer ${apiKey}`),
    }
  }

  return null
}
