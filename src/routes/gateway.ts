import { Hono } from "hono"
import { db } from "../db/client.ts"
import { keys, billing, usage, subscriptions, plans, providerCredentials } from "../db/schema.ts"
import { eq, and, isNull, sql } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import { MICRO, microToDisplay } from "../lib/currency.ts"
import { checkQuota } from "../lib/quota.ts"
import { decrypt } from "../lib/crypto.ts"

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
  let bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, keyData.workspaceId))
    .then((rows) => rows[0])

  if (!bill) {
    // Auto-create billing record for new workspaces (EC-5)
    await db.insert(billing).values({
      id: createId("bill"),
      workspaceId: keyData.workspaceId,
    }).onConflictDoNothing()
    bill = await db
      .select()
      .from(billing)
      .where(eq(billing.workspaceId, keyData.workspaceId))
      .then((rows) => rows[0])
    if (!bill) {
      return c.json({ error: { type: "BillingError", message: "No billing record found" } }, 402)
    }
  }

  // Check subscription (workspace-level, not user-level)
  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, keyData.workspaceId),
        isNull(subscriptions.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  const hasSubscription = !!sub

  // Monthly usage (lazy-reset aware)
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthlyUsage =
    bill.timeMonthlyReset && bill.timeMonthlyReset < monthStart
      ? 0
      : (bill.monthlyUsage ?? 0)

  // Determine effective plan limit
  const userPlan = hasSubscription
    ? await db.select().from(plans).where(eq(plans.id, sub!.plan)).then((r) => r[0])
    : await db.select().from(plans).where(eq(plans.id, "free")).then((r) => r[0])

  // Plan limit in USD micro-units
  const planLimitMicro = userPlan?.monthlyLimit ?? 500000 // fallback free tier $0.50

  // Workspace override (monthlyLimit is in USD units → convert to micro-units)
  const workspaceLimitMicro = bill.monthlyLimit
    ? bill.monthlyLimit * MICRO
    : null

  const effectiveLimit = workspaceLimitMicro ?? planLimitMicro

  // Block logic: subscribers get overage allowance, free users hard-blocked
  const overPlanLimit = effectiveLimit !== null && monthlyUsage >= effectiveLimit
  const hasCredits = bill.balance > 0

  if (overPlanLimit && !hasCredits) {
    if (hasSubscription) {
      // Subscribers: allow overage up to 100% of plan limit before blocking
      // e.g. Pro ($24 limit) can use up to $48 total before hard block
      const overageUsed = monthlyUsage - effectiveLimit!
      const maxOverage = effectiveLimit! // 100% of plan limit as cap
      if (overageUsed < maxOverage) {
        // Allow — usage tracked, balance goes negative (debt)
        // User sees overage warning in IDE
      } else {
        // Subscriber hit overage cap — hard block
        const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        return c.json(
          {
            error: {
              type: "LimitError",
              plan: userPlan?.id ?? "free",
              message: "Overage limit reached. Add credits to continue.",
              monthlyUsage: microToDisplay(monthlyUsage),
              monthlyLimit: microToDisplay(effectiveLimit!),
              balance: microToDisplay(bill.balance),
              currency: bill.currency,
              resetsAt: resetDate.toISOString(),
            },
          },
          402,
        )
      }
    } else {
      // Free users: hard block immediately
      const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      return c.json(
        {
          error: {
            type: "LimitError",
            plan: userPlan?.id ?? "free",
            message: "Free tier limit reached. Subscribe or add credits to continue.",
            monthlyUsage: microToDisplay(monthlyUsage),
            monthlyLimit: microToDisplay(effectiveLimit!),
            balance: microToDisplay(bill.balance),
            currency: bill.currency,
            resetsAt: resetDate.toISOString(),
          },
        },
        402,
      )
    }
  }

  // Parse request
  const body = await c.req.json()
  const model = body.model as string
  const isStream = body.stream === true

  if (!model) {
    return c.json({ error: { type: "ModelError", message: "Model is required" } }, 400)
  }

  // Look up model pricing from materialized view
  const config = await db
    .execute(sql`SELECT * FROM gateway_config WHERE model_id = ${model}`)
    .then((r) => r[0])

  let inputCost: number
  let outputCost: number

  if (config) {
    if (!config.enabled) {
      return c.json(
        { error: { type: "ModelError", message: "Model temporarily unavailable" } },
        503,
      )
    }

    // Enforce model tier restrictions (minPlan)
    const minPlan = config.min_plan as string | undefined
    if (minPlan && minPlan !== "free") {
      const planOrder: Record<string, number> = { free: 0, starter: 1, pro: 2, team: 3 }
      const requiredOrder = planOrder[minPlan] ?? 0
      const currentOrder = planOrder[userPlan?.id ?? "free"] ?? 0
      if (currentOrder < requiredOrder) {
        return c.json(
          {
            error: {
              type: "PlanError",
              message: `Model ${model} requires ${minPlan} plan or higher.`,
              requiredPlan: minPlan,
              currentPlan: userPlan?.id ?? "free",
            },
          },
          403,
        )
      }
    }

    inputCost = Number(config.input_cost)
    outputCost = Number(config.output_cost)
  } else {
    // Fallback pricing for unknown models
    const fallback = await db
      .execute(sql`SELECT fallback_input, fallback_output FROM gateway_config LIMIT 1`)
      .then((r) => r[0])
    inputCost = Number(fallback?.fallback_input ?? 0.003)
    outputCost = Number(fallback?.fallback_output ?? 0.015)
    console.warn(`Unknown model ${model} — using fallback pricing`)
  }

  // Route to upstream provider (BYOK keys take priority over env vars)
  const providerConfig = await getProviderConfig(model, keyData.workspaceId)
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

    const costCtx: CostContext = {
      keyData,
      model,
      provider: providerConfig.provider,
      inputCost,
      outputCost,
      planLimit: effectiveLimit,
    }

    // Return response (stream-through for SSE)
    const responseHeaders = new Headers()
    responseHeaders.set(
      "Content-Type",
      upstreamRes.headers.get("Content-Type") ?? "application/json",
    )

    if (isStream) {
      responseHeaders.set("Cache-Control", "no-cache")
      responseHeaders.set("Connection", "keep-alive")

      const { readable, writable } = new TransformStream()
      trackStreamUsage(upstreamRes.body!, writable, costCtx)

      return new Response(readable, {
        status: upstreamRes.status,
        headers: responseHeaders,
      })
    }

    // Non-streaming: read response, track usage
    const responseClone = upstreamRes.clone()
    const responseJson = (await responseClone.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    trackUsageAsync(costCtx, responseJson.usage)

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

// ── Billing quota check (API key auth, for engine pre-flight) ──

gatewayRoutes.get("/billing/quota", async (c) => {
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  const keyData = await db
    .select({ workspaceId: keys.workspaceId })
    .from(keys)
    .where(and(eq(keys.key, apiKey), isNull(keys.timeDeleted)))
    .then((rows) => rows[0])

  if (!keyData) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  const result = await checkQuota(keyData.workspaceId)
  return c.json(result)
})

// ── Provider routing ──

interface ProviderConfig {
  provider: string
  baseUrl: string
  path: string
  upstreamModel: string
  setAuth: (headers: Headers) => void
}

async function getProviderConfig(model: string, workspaceId?: string): Promise<ProviderConfig | null> {
  // Determine provider name from model prefix
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
        byokKey = decrypt(cred.credentials)
      } catch (err) {
        console.error(`Failed to decrypt BYOK key for ${providerName}:`, err)
        // Fall through to env var
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

// ── Usage tracking ──

interface CostContext {
  keyData: { id: string; workspaceId: string }
  model: string
  provider: string
  inputCost: number // USD per 1K tokens
  outputCost: number // USD per 1K tokens
  planLimit: number | null // plan limit in USD micro-units
}

async function trackUsageAsync(
  ctx: CostContext,
  usageData: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  estimatedText?: string,
) {
  let inputTokens = usageData?.prompt_tokens ?? 0
  let outputTokens = usageData?.completion_tokens ?? 0

  // Google streaming fallback: estimate from text length
  if (!usageData && estimatedText) {
    outputTokens = Math.ceil(estimatedText.length / 4)
    console.warn(`Estimated ${outputTokens} output tokens for ${ctx.model} (no usage data)`)
  }

  if (inputTokens === 0 && outputTokens === 0) {
    // Still insert usage row for request count tracking (EC-4)
    try {
      await db.insert(usage).values({
        id: createId("usg"),
        workspaceId: ctx.keyData.workspaceId,
        keyId: ctx.keyData.id,
        model: ctx.model,
        provider: ctx.provider,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        costUsd: 0,
      })
    } catch { /* ignore */ }
    return
  }

  // Cost in USD micro-units
  const costUSD = (inputTokens * ctx.inputCost + outputTokens * ctx.outputCost) / 1_000
  const costMicro = Math.round(costUSD * MICRO)

  try {
    // Atomic: increment monthly counter + deduct overage from balance
    await db.execute(
      sql`SELECT * FROM increment_usage_and_deduct(${ctx.keyData.workspaceId}, ${costMicro}, ${ctx.planLimit})`,
    )

    // Insert usage row
    await db.insert(usage).values({
      id: createId("usg"),
      workspaceId: ctx.keyData.workspaceId,
      keyId: ctx.keyData.id,
      model: ctx.model,
      provider: ctx.provider,
      inputTokens,
      outputTokens,
      cost: costMicro,
      costUsd: costMicro,
    })
  } catch (err) {
    console.error("Failed to track usage:", err)
  }
}

async function trackStreamUsage(
  upstream: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  ctx: CostContext,
) {
  const reader = upstream.getReader()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()

  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  let accumulatedText = ""

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
            // Accumulate text for Google token estimation
            const delta =
              chunk.choices?.[0]?.delta?.content ??
              chunk.candidates?.[0]?.content?.parts?.[0]?.text
            if (delta) accumulatedText += delta
          } catch {
            // ignore parse errors
          }
        }
      }
    }
  } finally {
    try { await writer.close() } catch { /* client disconnected */ }
    // Track if we have usage data or significant accumulated text (EC-3)
    if (lastUsage || (accumulatedText && accumulatedText.length > 10)) {
      trackUsageAsync(ctx, lastUsage, lastUsage ? undefined : accumulatedText || undefined)
    }
  }
}
