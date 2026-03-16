import { Hono } from "hono"
import { microToDisplay } from "../lib/currency.ts"
import { checkQuotaFast } from "../lib/quota.ts"
import { authenticateApiKey, getCachedAuth } from "../lib/gateway/authenticate.ts"
import { getModelConfig, getFallbackPricing, meetsMinPlan } from "../lib/gateway/entitlement.ts"
import { resolveProvider } from "../lib/gateway/provider.ts"
import { trackUsageAsync, trackStreamUsage } from "../lib/gateway/track-usage.ts"
import type { CostContext, ProviderConfig } from "../lib/gateway/types.ts"

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
  // ── 1. Extract API key ──
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  // ── 2. Check if auth is cached (enables speculative execution) ──
  const cachedAuth = getCachedAuth(apiKey)

  if (cachedAuth) {
    // ═══ FAST PATH: auth cached, speculative execution ═══
    // Start auth refresh, body parse, and quota ALL in parallel since we already know the workspace.
    let auth, body, quota, modelConfig, providerConfig
    try {
      ;[auth, body, quota, modelConfig, providerConfig] = await Promise.all([
        authenticateApiKey(apiKey),
        c.req.json(),
        checkQuotaFast(cachedAuth.workspaceId),
        // We don't know the model yet from body, but we need body first.
        // So we resolve model config after body parse below.
        Promise.resolve(null),
        Promise.resolve(null),
      ])
    } catch (err: any) {
      console.error("[gateway] speculative auth/parse error:", err?.message ?? err)
      return c.json(
        { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
        503,
      )
    }

    auth = auth ?? cachedAuth
    const model = body.model as string
    const isStream = body.stream === true
    if (!model) {
      return c.json({ error: { type: "ModelError", message: "Model is required" } }, 400)
    }

    // Resolve model config + provider in parallel
    try {
      ;[modelConfig, providerConfig] = await Promise.all([
        getModelConfig(model),
        resolveProvider(model, auth.workspaceId),
      ])
    } catch (err: any) {
      console.error("[gateway] speculative db lookup error:", err?.message ?? err)
      return c.json(
        { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
        503,
      )
    }

    // Validate quota
    if (!quota!.canSend) {
      return quotaError(c, quota!)
    }

    // Validate model entitlement
    const costs = await resolveCosts(model, modelConfig, quota!)
    if (!costs) return costs // null means error response already sent
    if ("response" in costs) return costs.response

    // Validate provider
    if (!providerConfig) {
      return c.json({ error: { type: "ModelError", message: `Model ${model} not supported` } }, 400)
    }

    // Build upstream request (strip unsupported params per provider)
    const upstreamUrl = `${providerConfig.baseUrl}${providerConfig.path}`
    const upstreamBody = sanitizeBody(body, providerConfig)
    const upstreamHeaders = new Headers()
    upstreamHeaders.set("Content-Type", "application/json")
    providerConfig.setAuth(upstreamHeaders)

    const requestId = crypto.randomUUID()
    console.log(`[gateway] ${model} stream=${isStream} workspace=${auth.workspaceId} [speculative]`)

    // Start upstream fetch (all checks passed)
    return proxyUpstream(c, {
      upstreamUrl,
      upstreamHeaders,
      upstreamBody,
      isStream,
      model,
      auth,
      quota: quota!,
      providerConfig,
      costs,
      requestId,
    })
  }

  // ═══ SLOW PATH: auth cache miss, sequential ═══
  let auth, body
  try {
    ;[auth, body] = await Promise.all([
      authenticateApiKey(apiKey),
      c.req.json(),
    ])
  } catch (err: any) {
    console.error("[gateway] auth/parse error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  const model = body.model as string
  const isStream = body.stream === true

  if (!model) {
    return c.json({ error: { type: "ModelError", message: "Model is required" } }, 400)
  }

  // Parallel: quota + model config + provider resolution
  let quota, modelConfig, providerConfig
  try {
    ;[quota, modelConfig, providerConfig] = await Promise.all([
      checkQuotaFast(auth.workspaceId),
      getModelConfig(model),
      resolveProvider(model, auth.workspaceId),
    ])
  } catch (err: any) {
    console.error("[gateway] db lookup error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  if (!quota.canSend) {
    return quotaError(c, quota)
  }

  const costs = await resolveCosts(model, modelConfig, quota)
  if (!costs) return costs
  if ("response" in costs) return costs.response

  if (!providerConfig) {
    return c.json({ error: { type: "ModelError", message: `Model ${model} not supported` } }, 400)
  }

  const requestId = crypto.randomUUID()
  const upstreamUrl = `${providerConfig.baseUrl}${providerConfig.path}`
  const upstreamBody = sanitizeBody(body, providerConfig)
  const upstreamHeaders = new Headers()
  upstreamHeaders.set("Content-Type", "application/json")
  providerConfig.setAuth(upstreamHeaders)

  console.log(`[gateway] ${model} stream=${isStream} workspace=${auth.workspaceId}`)

  return proxyUpstream(c, {
    upstreamUrl,
    upstreamHeaders,
    upstreamBody,
    isStream,
    model,
    auth,
    quota,
    providerConfig,
    costs,
    requestId,
  })
})

// ── Shared helpers ──

/** Strip params unsupported by specific upstream providers. */
function sanitizeBody(body: any, provider: ProviderConfig) {
  const cleaned = { ...body, model: provider.upstreamModel }
  if (provider.provider === "google") {
    delete cleaned.frequency_penalty
    delete cleaned.presence_penalty
    delete cleaned.logit_bias
    delete cleaned.logprobs
    delete cleaned.top_logprobs
    delete cleaned.seed
  }
  return cleaned
}

function quotaError(c: any, quota: any) {
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

async function resolveCosts(
  model: string,
  modelConfig: any,
  quota: any,
): Promise<{ inputCost: number; outputCost: number } | { response: Response } | any> {
  if (modelConfig) {
    if (!modelConfig.enabled) {
      return { response: new Response(JSON.stringify({ error: { type: "ModelError", message: "Model temporarily unavailable" } }), { status: 503, headers: { "Content-Type": "application/json" } }) }
    }
    if (!meetsMinPlan(quota.plan.id, modelConfig.minPlan)) {
      return {
        response: new Response(
          JSON.stringify({
            error: {
              type: "PlanError",
              message: `Model ${model} requires ${modelConfig.minPlan} plan or higher.`,
              requiredPlan: modelConfig.minPlan,
              currentPlan: quota.plan.id,
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      }
    }
    return { inputCost: modelConfig.inputCost, outputCost: modelConfig.outputCost }
  }
  const fallback = await getFallbackPricing()
  console.warn(`Unknown model ${model} — using fallback pricing`)
  return { inputCost: fallback.inputCost, outputCost: fallback.outputCost }
}

async function proxyUpstream(c: any, opts: {
  upstreamUrl: string
  upstreamHeaders: Headers
  upstreamBody: any
  isStream: boolean
  model: string
  auth: any
  quota: any
  providerConfig: any
  costs: { inputCost: number; outputCost: number }
  requestId: string
  signal?: AbortSignal
}) {
  try {
    const upstreamRes = await fetch(opts.upstreamUrl, {
      method: "POST",
      headers: opts.upstreamHeaders,
      body: JSON.stringify(opts.upstreamBody),
      signal: opts.signal,
    })

    if (!upstreamRes.ok) {
      const errorBody = await upstreamRes.text()
      console.error(`[gateway] upstream ${upstreamRes.status} for ${opts.model}: ${errorBody.slice(0, 200)}`)
      return new Response(errorBody, {
        status: upstreamRes.status,
        headers: { "Content-Type": "application/json" },
      })
    }

    const costCtx: CostContext = {
      requestId: opts.requestId,
      keyData: opts.auth,
      model: opts.model,
      provider: opts.providerConfig.provider,
      inputCost: opts.costs.inputCost,
      outputCost: opts.costs.outputCost,
      planLimit: opts.quota._effectiveLimitMicro,
    }

    const responseHeaders = new Headers()
    responseHeaders.set(
      "Content-Type",
      upstreamRes.headers.get("Content-Type") ?? "application/json",
    )

    if (opts.isStream) {
      // Force SSE Content-Type regardless of upstream (prevents proxy buffering)
      responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8")
      responseHeaders.set("Cache-Control", "no-cache, no-transform")
      responseHeaders.set("Connection", "keep-alive")
      responseHeaders.set("X-Accel-Buffering", "no")

      const { readable, writable } = new TransformStream()
      trackStreamUsage(upstreamRes.body!, writable, costCtx)

      return new Response(readable, {
        status: upstreamRes.status,
        headers: responseHeaders,
      })
    }

    const responseJson = await upstreamRes.json() as any
    if (responseJson.choices) {
      for (const choice of responseJson.choices) {
        const toolCalls = choice.message?.tool_calls
        if (toolCalls) {
          for (let i = 0; i < toolCalls.length; i++) {
            if (toolCalls[i].index === undefined) toolCalls[i].index = i
          }
        }
      }
    }

    trackUsageAsync(costCtx, responseJson.usage)

    return c.json(
      responseJson,
      upstreamRes.status as any,
      Object.fromEntries(responseHeaders.entries())
    )
  } catch (err: any) {
    return c.json(
      { error: { type: "GatewayError", message: `Upstream error: ${err.message}` } },
      502,
    )
  }
}

// ── Billing quota check (API key auth, for engine pre-flight) ──

gatewayRoutes.get("/billing/quota", async (c) => {
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  let auth
  try {
    auth = await authenticateApiKey(apiKey)
  } catch (err: any) {
    console.error("[gateway] billing auth error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  let result
  try {
    result = await checkQuotaFast(auth.workspaceId)
  } catch (err: any) {
    console.error("[gateway] billing quota error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  // Strip internal fields from API response
  const { _effectiveLimitMicro, _monthlyUsageMicro, _balanceMicro, ...publicResult } = result
  return c.json(publicResult)
})
