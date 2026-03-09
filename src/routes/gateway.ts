import { Hono } from "hono"
import { microToDisplay } from "../lib/currency.ts"
import { checkQuotaFast } from "../lib/quota.ts"
import { authenticateApiKey } from "../lib/gateway/authenticate.ts"
import { getModelConfig, getFallbackPricing, meetsMinPlan } from "../lib/gateway/entitlement.ts"
import { resolveProvider } from "../lib/gateway/provider.ts"
import { trackUsageAsync, trackStreamUsage } from "../lib/gateway/track-usage.ts"
import type { CostContext } from "../lib/gateway/types.ts"

export const gatewayRoutes = new Hono()

/**
 * Creor Gateway — LLM proxy endpoint.
 *
 * Compatible with OpenAI's API format so AI SDKs work out of the box.
 * Supports: /v1/chat/completions
 *
 * Pipeline: authenticate+parse → parallel(quota, modelConfig, resolveProvider) → proxy → trackUsage
 */
gatewayRoutes.post("/chat/completions", async (c) => {
  // ── 1. Authenticate + parse body (concurrent) ──
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  const [auth, body] = await Promise.all([
    authenticateApiKey(apiKey),
    c.req.json(),
  ])

  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  const model = body.model as string
  const isStream = body.stream === true

  if (!model) {
    return c.json({ error: { type: "ModelError", message: "Model is required" } }, 400)
  }

  // ── 2. Parallel: quota + model config + provider resolution ──
  const [quota, modelConfig, providerConfig] = await Promise.all([
    checkQuotaFast(auth.workspaceId),
    getModelConfig(model),
    resolveProvider(model, auth.workspaceId),
  ])

  // ── 3. Check quota ──
  if (!quota.canSend) {
    const now = new Date()
    const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    return c.json(
      {
        error: {
          type: "LimitError",
          plan: quota.plan.id,
          message: quota.blockReason === "free_limit_no_credits"
            ? "Free tier limit reached. Subscribe or add credits to continue."
            : quota.blockReason === "no_billing"
              ? "No billing record found. Please set up billing."
              : "Overage limit reached. Add credits to continue.",
          monthlyUsage: microToDisplay(quota._monthlyUsageMicro),
          monthlyLimit: quota._effectiveLimitMicro !== null
            ? microToDisplay(quota._effectiveLimitMicro)
            : null,
          balance: microToDisplay(quota._balanceMicro),
          currency: quota.currency,
          resetsAt: resetDate.toISOString(),
        },
      },
      402,
    )
  }

  // ── 4. Check model entitlement ──
  let inputCost: number
  let outputCost: number

  if (modelConfig) {
    if (!modelConfig.enabled) {
      return c.json(
        { error: { type: "ModelError", message: "Model temporarily unavailable" } },
        503,
      )
    }

    if (!meetsMinPlan(quota.plan.id, modelConfig.minPlan)) {
      return c.json(
        {
          error: {
            type: "PlanError",
            message: `Model ${model} requires ${modelConfig.minPlan} plan or higher.`,
            requiredPlan: modelConfig.minPlan,
            currentPlan: quota.plan.id,
          },
        },
        403,
      )
    }

    inputCost = modelConfig.inputCost
    outputCost = modelConfig.outputCost
  } else {
    const fallback = await getFallbackPricing()
    inputCost = fallback.inputCost
    outputCost = fallback.outputCost
    console.warn(`Unknown model ${model} — using fallback pricing`)
  }

  // ── 5. Validate provider ──
  if (!providerConfig) {
    return c.json({ error: { type: "ModelError", message: `Model ${model} not supported` } }, 400)
  }

  // ── 6. Proxy to upstream ──
  const requestId = crypto.randomUUID()
  const upstreamUrl = `${providerConfig.baseUrl}${providerConfig.path}`
  const upstreamBody = {
    ...body,
    model: providerConfig.upstreamModel,
  }

  const upstreamHeaders = new Headers()
  upstreamHeaders.set("Content-Type", "application/json")
  providerConfig.setAuth(upstreamHeaders)

  console.log(`[gateway] ${model} stream=${isStream} workspace=${auth.workspaceId}`)

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
    })

    if (!upstreamRes.ok) {
      const errorBody = await upstreamRes.text()
      console.error(`[gateway] upstream ${upstreamRes.status} for ${model}: ${errorBody.slice(0, 200)}`)
      return new Response(errorBody, {
        status: upstreamRes.status,
        headers: { "Content-Type": "application/json" },
      })
    }

    // ── 7. Track usage ──
    const costCtx: CostContext = {
      requestId,
      keyData: auth,
      model,
      provider: providerConfig.provider,
      inputCost,
      outputCost,
      planLimit: quota._effectiveLimitMicro,
    }

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

    // Non-streaming: normalize Google fields + track usage
    const responseJson = await upstreamRes.json() as any

    // Normalize Google-specific fields (same as streaming path)
    if (responseJson.choices) {
      for (const choice of responseJson.choices) {
        const toolCalls = choice.message?.tool_calls
        if (toolCalls) {
          for (let i = 0; i < toolCalls.length; i++) {
            if (toolCalls[i].index === undefined) toolCalls[i].index = i
            if (toolCalls[i].extra_content) delete toolCalls[i].extra_content
          }
        }
      }
    }

    trackUsageAsync(costCtx, responseJson.usage)

    return c.json(responseJson, {
      status: upstreamRes.status,
      headers: Object.fromEntries(responseHeaders.entries()),
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

  const auth = await authenticateApiKey(apiKey)
  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  const result = await checkQuotaFast(auth.workspaceId)

  // Strip internal fields from API response
  const { _effectiveLimitMicro, _monthlyUsageMicro, _balanceMicro, ...publicResult } = result
  return c.json(publicResult)
})
