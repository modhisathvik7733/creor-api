import { Hono } from "hono"
import { microToDisplay } from "../lib/currency.ts"
import { checkQuota } from "../lib/quota.ts"
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
 * Pipeline: authenticate → checkQuota → checkEntitlement → resolveProvider → proxy → trackUsage
 */
gatewayRoutes.post("/chat/completions", async (c) => {
  // ── 1. Authenticate ──
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  const auth = await authenticateApiKey(apiKey)
  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  // ── 2. Check quota (single source of truth for billing logic) ──
  const quota = await checkQuota(auth.workspaceId)

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

  // ── 3. Parse request ──
  const body = await c.req.json()
  const model = body.model as string
  const isStream = body.stream === true

  if (!model) {
    return c.json({ error: { type: "ModelError", message: "Model is required" } }, 400)
  }

  // ── 4. Check model entitlement ──
  let inputCost: number
  let outputCost: number

  const modelConfig = await getModelConfig(model)
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

  // ── 5. Resolve upstream provider ──
  const providerConfig = await resolveProvider(model, auth.workspaceId)
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

  const auth = await authenticateApiKey(apiKey)
  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  const result = await checkQuota(auth.workspaceId)

  // Strip internal fields from API response
  const { _effectiveLimitMicro, _monthlyUsageMicro, _balanceMicro, ...publicResult } = result
  return c.json(publicResult)
})
