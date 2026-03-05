import { Hono } from "hono"
import { db } from "../db/client.ts"
import { keys, billing, usage, subscriptions } from "../db/schema.ts"
import { eq, and, isNull, sql } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import { getModelCost } from "../lib/models.ts"

export const gatewayRoutes = new Hono()

/**
 * Creor Gateway — LLM proxy endpoint.
 *
 * Compatible with OpenAI's API format so AI SDKs work out of the box.
 * Supports: /v1/chat/completions
 *
 * Authentication: Bearer token (Creor API key starting with crk_)
 */
gatewayRoutes.post("/chat/completions", async (c) => {
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  // Authenticate
  const keyData = await db
    .select({
      id: keys.id,
      workspaceId: keys.workspaceId,
      userId: keys.userId,
    })
    .from(keys)
    .where(and(eq(keys.key, apiKey), isNull(keys.timeDeleted)))
    .then((rows) => rows[0])

  if (!keyData) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  // Check billing
  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, keyData.workspaceId))
    .then((rows) => rows[0])

  if (!bill) {
    return c.json({ error: { type: "BillingError", message: "No billing record found" } }, 402)
  }

  // Check subscription or balance
  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, keyData.workspaceId),
        eq(subscriptions.userId, keyData.userId),
        isNull(subscriptions.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  const hasSubscription = !!sub
  const hasBalance = bill.balance > 0

  if (!hasSubscription && !hasBalance) {
    return c.json(
      {
        error: {
          type: "CreditsError",
          message: "Insufficient balance. Add credits at https://creor.ai/dashboard/billing",
        },
      },
      402,
    )
  }

  // Parse request
  const body = await c.req.json()
  const model = body.model as string
  const isStream = body.stream === true

  if (!model) {
    return c.json({ error: { type: "ModelError", message: "Model is required" } }, 400)
  }

  // Route to upstream provider
  const providerConfig = getProviderConfig(model)
  if (!providerConfig) {
    return c.json({ error: { type: "ModelError", message: `Model ${model} not supported` } }, 400)
  }

  // Forward request to provider
  const upstreamUrl = `${providerConfig.baseUrl}${providerConfig.path}`
  const upstreamBody = {
    ...body,
    model: providerConfig.upstreamModel,
  }

  const upstreamHeaders = new Headers()
  upstreamHeaders.set("Content-Type", "application/json")
  providerConfig.setAuth(upstreamHeaders)

  const startTime = Date.now()

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
    })

    if (!upstreamRes.ok) {
      const errorBody = await upstreamRes.text()
      return new Response(errorBody, {
        status: upstreamRes.status,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Track usage (async, non-blocking)
    if (!isStream) {
      const responseClone = upstreamRes.clone()
      const responseJson = await responseClone.json() as {
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      trackUsageAsync(keyData, model, providerConfig.provider, responseJson.usage, hasSubscription)
    }

    // Return response (stream-through for SSE)
    const responseHeaders = new Headers()
    responseHeaders.set("Content-Type", upstreamRes.headers.get("Content-Type") ?? "application/json")
    if (isStream) {
      responseHeaders.set("Cache-Control", "no-cache")
      responseHeaders.set("Connection", "keep-alive")

      // For streaming, track usage from the stream's final chunk
      const { readable, writable } = new TransformStream()
      trackStreamUsage(upstreamRes.body!, writable, keyData, model, providerConfig.provider, hasSubscription)

      return new Response(readable, {
        status: upstreamRes.status,
        headers: responseHeaders,
      })
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    })
  } catch (err: any) {
    return c.json(
      { error: { type: "GatewayError", message: `Upstream error: ${err.message}` } },
      502,
    )
  }
})

// ── Provider routing ──

interface ProviderConfig {
  provider: string
  baseUrl: string
  path: string
  upstreamModel: string
  setAuth: (headers: Headers) => void
}

function getProviderConfig(model: string): ProviderConfig | null {
  // anthropic/* models
  if (model.startsWith("anthropic/")) {
    const upstreamModel = model.replace("anthropic/", "")
    return {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      path: "/v1/messages",
      upstreamModel,
      setAuth: (h) => {
        h.set("x-api-key", process.env.ANTHROPIC_API_KEY!)
        h.set("anthropic-version", "2023-06-01")
      },
    }
  }

  // openai/* models
  if (model.startsWith("openai/")) {
    const upstreamModel = model.replace("openai/", "")
    return {
      provider: "openai",
      baseUrl: "https://api.openai.com",
      path: "/v1/chat/completions",
      upstreamModel,
      setAuth: (h) => h.set("Authorization", `Bearer ${process.env.OPENAI_API_KEY!}`),
    }
  }

  // google/* models
  if (model.startsWith("google/")) {
    const upstreamModel = model.replace("google/", "")
    return {
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      path: `/v1beta/models/${upstreamModel}:generateContent`,
      upstreamModel,
      setAuth: (h) => h.set("x-goog-api-key", process.env.GOOGLE_AI_API_KEY!),
    }
  }

  return null
}

// ── Usage tracking ──

async function trackUsageAsync(
  keyData: { id: string; workspaceId: string },
  model: string,
  provider: string,
  usageData: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  hasSubscription: boolean,
) {
  if (!usageData) return

  const inputTokens = usageData.prompt_tokens ?? 0
  const outputTokens = usageData.completion_tokens ?? 0

  // Per-model cost (USD per 1K tokens) → micro-paise
  const modelCost = getModelCost(model)
  const costUSD = (inputTokens * modelCost.input + outputTokens * modelCost.output) / 1_000
  const costMicroPaise = Math.round(costUSD * 85 * 1_000_000) // USD → INR → micro-paise

  try {
    await db.insert(usage).values({
      id: createId("usg"),
      workspaceId: keyData.workspaceId,
      keyId: keyData.id,
      model,
      provider,
      inputTokens,
      outputTokens,
      cost: costMicroPaise,
    })

    // Deduct from balance (skip for subscription users)
    if (!hasSubscription && costMicroPaise > 0) {
      await db
        .update(billing)
        .set({ balance: sql`${billing.balance} - ${costMicroPaise}` })
        .where(eq(billing.workspaceId, keyData.workspaceId))
    }
  } catch (err) {
    console.error("Failed to track usage:", err)
  }
}

async function trackStreamUsage(
  upstream: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  keyData: { id: string; workspaceId: string },
  model: string,
  provider: string,
  hasSubscription: boolean,
) {
  const reader = upstream.getReader()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()

  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      await writer.write(value)

      // Try to parse usage from SSE chunks
      const text = decoder.decode(value, { stream: true })
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const chunk = JSON.parse(line.slice(6))
            if (chunk.usage) lastUsage = chunk.usage
          } catch {
            // ignore parse errors
          }
        }
      }
    }
  } finally {
    await writer.close()
    // Track usage from the final chunk
    if (lastUsage) {
      trackUsageAsync(keyData, model, provider, lastUsage, hasSubscription)
    }
  }
}
