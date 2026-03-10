import { Hono } from "hono"
import { checkQuotaFast } from "../lib/quota.ts"
import { microToDisplay } from "../lib/currency.ts"
import { authenticateApiKey, getCachedAuth } from "../lib/gateway/authenticate.ts"
import { getModelConfig, meetsMinPlan } from "../lib/gateway/entitlement.ts"
import { getGoogleApiKey } from "../lib/gateway/provider.ts"
import { trackGoogleStreamUsage, trackUsageAsync } from "../lib/gateway/track-usage.ts"
import type { CostContext } from "../lib/gateway/types.ts"

export const googleProxyRoutes = new Hono()

/**
 * Google Native API Proxy — transparent reverse proxy for @ai-sdk/google.
 *
 * Forwards requests in Google's native format to generativelanguage.googleapis.com.
 * The engine uses @ai-sdk/google for Google gateway models, which sends requests
 * in Google's native format (not OpenAI-compatible). This proxy handles auth,
 * quota, and usage tracking without any format translation.
 *
 * URL pattern: /google/v1beta/models/{model}:streamGenerateContent
 *              /google/v1beta/models/{model}:generateContent
 */
googleProxyRoutes.all("/v1beta/*", async (c) => {
  // ── 1. Extract API key + URL info (no async) ──
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

  const reqUrl = new URL(c.req.url)
  const path = reqUrl.pathname.replace(/^\/google/, "") + reqUrl.search
  const modelMatch = path.match(/\/models\/([^/:]+)/)
  const modelId = modelMatch?.[1]
  const fullModelId = modelId ? `google/${modelId}` : null

  if (!modelId) {
    return c.json(
      { error: { type: "ModelError", message: "Could not extract model from URL path" } },
      400,
    )
  }

  const isStream = path.includes("streamGenerateContent")
  const cachedAuth = getCachedAuth(apiKey)

  if (cachedAuth) {
    // ═══ FAST PATH: auth cached — run everything in parallel ═══
    let auth, quota, modelConfig, googleKey, body
    try {
      ;[auth, quota, modelConfig, googleKey, body] = await Promise.all([
        authenticateApiKey(apiKey), // refresh cache in background
        checkQuotaFast(cachedAuth.workspaceId),
        getModelConfig(fullModelId!),
        getGoogleApiKey(cachedAuth.workspaceId),
        c.req.arrayBuffer(),
      ])
    } catch (err: any) {
      console.error("[google-proxy] speculative error:", err?.message ?? err)
      return c.json(
        { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
        503,
      )
    }

    auth = auth ?? cachedAuth

    if (!quota.canSend) return googleQuotaError(c, quota)

    const costs = resolveGoogleCosts(fullModelId!, modelConfig, quota)
    if ("response" in costs) return costs.response

    if (!googleKey) {
      return c.json(
        { error: { type: "GatewayError", message: "Google API key not configured" } },
        500,
      )
    }

    const requestId = crypto.randomUUID()
    console.log(`[google-proxy] ${fullModelId} stream=${isStream} workspace=${auth.workspaceId} [speculative]`)

    return proxyToGoogle(c, {
      path, fullModelId: fullModelId!, isStream, googleKey, body,
      auth, quota, costs, requestId,
    })
  }

  // ═══ SLOW PATH: auth cache miss — sequential auth, then parallel ═══
  let auth
  try {
    auth = await authenticateApiKey(apiKey)
  } catch (err: any) {
    console.error("[google-proxy] auth error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  if (!auth) {
    return c.json({ error: { type: "AuthError", message: "Invalid API key" } }, 401)
  }

  let quota, modelConfig, googleKey, body
  try {
    ;[quota, modelConfig, googleKey, body] = await Promise.all([
      checkQuotaFast(auth.workspaceId),
      getModelConfig(fullModelId!),
      getGoogleApiKey(auth.workspaceId),
      c.req.arrayBuffer(),
    ])
  } catch (err: any) {
    console.error("[google-proxy] db lookup error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  if (!quota.canSend) return googleQuotaError(c, quota)

  const costs = resolveGoogleCosts(fullModelId!, modelConfig, quota)
  if ("response" in costs) return costs.response

  if (!googleKey) {
    return c.json(
      { error: { type: "GatewayError", message: "Google API key not configured" } },
      500,
    )
  }

  const requestId = crypto.randomUUID()
  console.log(`[google-proxy] ${fullModelId} stream=${isStream} workspace=${auth.workspaceId}`)

  return proxyToGoogle(c, {
    path, fullModelId: fullModelId!, isStream, googleKey, body,
    auth, quota, costs, requestId,
  })
})

// ── Shared helpers ──

function googleQuotaError(c: any, quota: any) {
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

function resolveGoogleCosts(
  fullModelId: string,
  modelConfig: any,
  quota: any,
): { inputCost: number; outputCost: number } | { response: Response } {
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
              message: `Model ${fullModelId} requires ${modelConfig.minPlan} plan or higher.`,
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
  console.warn(`[google-proxy] Unknown model ${fullModelId} — using fallback pricing`)
  // Return a promise-like for fallback — but we need sync here, use defaults
  return { inputCost: 0.15, outputCost: 0.60 }
}

async function proxyToGoogle(c: any, opts: {
  path: string
  fullModelId: string
  isStream: boolean
  googleKey: string
  body: ArrayBuffer
  auth: any
  quota: any
  costs: { inputCost: number; outputCost: number }
  requestId: string
}) {
  const upstreamUrl = `https://generativelanguage.googleapis.com${opts.path}`
  const upstreamHeaders = new Headers()
  upstreamHeaders.set("Content-Type", c.req.header("Content-Type") || "application/json")
  upstreamHeaders.set("x-goog-api-key", opts.googleKey)

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: opts.body.byteLength > 0 ? opts.body : undefined,
    })

    if (!upstreamRes.ok) {
      const errorBody = await upstreamRes.text()
      console.error(`[google-proxy] upstream ${upstreamRes.status} for ${opts.fullModelId}: ${errorBody.slice(0, 200)}`)
      const errorHeaders: Record<string, string> = {
        "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json",
      }
      const retryAfter = upstreamRes.headers.get("retry-after")
      if (retryAfter) errorHeaders["retry-after"] = retryAfter
      const retryAfterMs = upstreamRes.headers.get("retry-after-ms")
      if (retryAfterMs) errorHeaders["retry-after-ms"] = retryAfterMs
      return new Response(errorBody, {
        status: upstreamRes.status,
        headers: errorHeaders,
      })
    }

    const costCtx: CostContext = {
      requestId: opts.requestId,
      keyData: opts.auth,
      model: opts.fullModelId,
      provider: "google",
      inputCost: opts.costs.inputCost,
      outputCost: opts.costs.outputCost,
      planLimit: opts.quota._effectiveLimitMicro,
    }

    if (opts.isStream && upstreamRes.body) {
      const responseHeaders = new Headers()
      responseHeaders.set("Content-Type", upstreamRes.headers.get("Content-Type") || "text/event-stream")
      responseHeaders.set("Cache-Control", "no-cache")
      responseHeaders.set("Connection", "keep-alive")

      const { readable, writable } = new TransformStream()
      trackGoogleStreamUsage(upstreamRes.body, writable, costCtx)

      return new Response(readable, {
        status: upstreamRes.status,
        headers: responseHeaders,
      })
    }

    const responseJson = await upstreamRes.json() as any
    const usageMeta = responseJson.usageMetadata
    if (usageMeta) {
      trackUsageAsync(costCtx, {
        prompt_tokens: usageMeta.promptTokenCount ?? 0,
        completion_tokens: usageMeta.candidatesTokenCount ?? 0,
      })
    }

    return new Response(JSON.stringify(responseJson), {
      status: upstreamRes.status,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err: any) {
    console.error("[google-proxy] upstream error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: `Upstream error: ${err.message}` } },
      502,
    )
  }
}
