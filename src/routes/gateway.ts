import { Hono } from "hono"
import { db } from "../db/client.ts"
import { keys, billing, usage, subscriptions, plans } from "../db/schema.ts"
import { eq, and, isNull, sql } from "drizzle-orm"
import { createId } from "../lib/id.ts"
import { MICRO, microToDisplay, usdToWorkspaceMicro } from "../lib/currency.ts"
import type { SupportedCurrency } from "../lib/currency.ts"

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

  // Check subscription
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

  // Monthly usage (lazy-reset aware)
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthlyUsage =
    bill.timeMonthlyReset && bill.timeMonthlyReset < monthStart
      ? 0
      : (bill.monthlyUsage ?? 0)

  // Fetch exchange rates for currency conversion
  const exchangeRates = await getExchangeRates()
  const currency = bill.currency as SupportedCurrency
  const rate = exchangeRates[currency] ?? 1

  // Determine effective plan limit
  const userPlan = hasSubscription
    ? await db.select().from(plans).where(eq(plans.id, sub!.plan)).then((r) => r[0])
    : await db.select().from(plans).where(eq(plans.id, "free")).then((r) => r[0])

  // Plan limit is in USD micro-units → convert to workspace currency
  const planLimitLocal = userPlan?.monthlyLimit
    ? Math.round(userPlan.monthlyLimit * rate)
    : Math.round(500000 * rate) // fallback free tier $0.50

  // Workspace override (legacy: monthlyLimit is in INR units → convert to micro-units)
  const workspaceLimitMicro = bill.monthlyLimit
    ? bill.monthlyLimit * MICRO
    : null

  const effectiveLimit = workspaceLimitMicro ?? planLimitLocal

  // Block if over plan limit AND no credits for overage
  if (effectiveLimit !== null && monthlyUsage >= effectiveLimit && bill.balance <= 0) {
    const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    return c.json(
      {
        error: {
          type: "LimitError",
          plan: userPlan?.id ?? "free",
          message: hasSubscription
            ? "Plan usage limit reached. Add credits or upgrade your plan."
            : "Free tier limit reached. Subscribe or add credits to continue.",
          monthlyUsage: microToDisplay(monthlyUsage),
          monthlyLimit: microToDisplay(effectiveLimit),
          balance: microToDisplay(bill.balance),
          currency: bill.currency,
          resetsAt: resetDate.toISOString(),
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
      exchangeRates,
      currency,
      planLimitLocal: effectiveLimit,
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

// ── Provider routing ──

interface ProviderConfig {
  provider: string
  baseUrl: string
  path: string
  upstreamModel: string
  setAuth: (headers: Headers) => void
}

function getProviderConfig(model: string): ProviderConfig | null {
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

interface CostContext {
  keyData: { id: string; workspaceId: string }
  model: string
  provider: string
  inputCost: number // USD per 1K tokens
  outputCost: number // USD per 1K tokens
  exchangeRates: Record<string, number>
  currency: SupportedCurrency
  planLimitLocal: number | null // plan limit in workspace currency micro-units
}

/** Get exchange rates from system_config (cached in materialized view) */
async function getExchangeRates(): Promise<Record<string, number>> {
  const row = await db
    .execute(sql`SELECT exchange_rates FROM gateway_config LIMIT 1`)
    .then((r) => r[0])
  if (row?.exchange_rates) {
    return typeof row.exchange_rates === "string"
      ? JSON.parse(row.exchange_rates) as Record<string, number>
      : row.exchange_rates as Record<string, number>
  }
  // Hardcoded fallback (should never happen if migrations ran)
  return { USD: 1, INR: 85, EUR: 0.92 }
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

  if (inputTokens === 0 && outputTokens === 0) return

  // Cost in USD
  const costUSD = (inputTokens * ctx.inputCost + outputTokens * ctx.outputCost) / 1_000
  const costUsdMicro = Math.round(costUSD * MICRO)

  // Cost in workspace currency (micro-units)
  const costMicro = usdToWorkspaceMicro(costUSD, ctx.exchangeRates, ctx.currency)

  try {
    // Atomic: increment monthly counter + deduct overage from balance
    await db.execute(
      sql`SELECT * FROM increment_usage_and_deduct(${ctx.keyData.workspaceId}, ${costMicro}, ${ctx.planLimitLocal})`,
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
      costUsd: costUsdMicro,
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
    await writer.close()
    // Track with usage data, or estimate from accumulated text
    trackUsageAsync(ctx, lastUsage, lastUsage ? undefined : accumulatedText || undefined)
  }
}
