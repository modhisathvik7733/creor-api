import { Hono } from "hono"
import { checkQuotaFast } from "../lib/quota.ts"
import { microToDisplay } from "../lib/currency.ts"
import { authenticateApiKey } from "../lib/gateway/authenticate.ts"
import { getModelConfig, getFallbackPricing, meetsMinPlan } from "../lib/gateway/entitlement.ts"
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
  // ── 1. Authenticate ──
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!apiKey) {
    return c.json({ error: { type: "AuthError", message: "Missing API key" } }, 401)
  }

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

  // ── 2. Extract model from URL path ──
  // Path: /v1beta/models/gemini-3-flash:streamGenerateContent
  const path = c.req.path.replace(/^\/google/, "")
  const modelMatch = path.match(/\/models\/([^/:]+)/)
  const modelId = modelMatch?.[1]
  const fullModelId = modelId ? `google/${modelId}` : null

  if (!modelId) {
    return c.json(
      { error: { type: "ModelError", message: "Could not extract model from URL path" } },
      400,
    )
  }

  // ── 3. Parallel: quota + model config ──
  let quota, modelConfig
  try {
    ;[quota, modelConfig] = await Promise.all([
      checkQuotaFast(auth.workspaceId),
      fullModelId ? getModelConfig(fullModelId) : Promise.resolve(null),
    ])
  } catch (err: any) {
    console.error("[google-proxy] db lookup error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  // ── 4. Check quota ──
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

  // ── 5. Check model entitlement ──
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
            message: `Model ${fullModelId} requires ${modelConfig.minPlan} plan or higher.`,
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
    console.warn(`[google-proxy] Unknown model ${fullModelId} — using fallback pricing`)
  }

  // ── 6. Get Google API key (BYOK or environment) ──
  let googleKey: string | null
  try {
    googleKey = await getGoogleApiKey(auth.workspaceId)
  } catch (err: any) {
    console.error("[google-proxy] failed to get Google API key:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: "Service temporarily unavailable" } },
      503,
    )
  }

  if (!googleKey) {
    return c.json(
      { error: { type: "GatewayError", message: "Google API key not configured" } },
      500,
    )
  }

  // ── 7. Forward to Google ──
  const upstreamUrl = `https://generativelanguage.googleapis.com${path}`
  const upstreamHeaders = new Headers()
  upstreamHeaders.set("Content-Type", c.req.header("Content-Type") || "application/json")
  upstreamHeaders.set("Authorization", `Bearer ${googleKey}`)

  const isStream = path.includes("streamGenerateContent")
  const requestId = crypto.randomUUID()

  console.log(`[google-proxy] ${fullModelId} stream=${isStream} workspace=${auth.workspaceId}`)

  try {
    const body = await c.req.arrayBuffer()
    const upstreamRes = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: body.byteLength > 0 ? body : undefined,
    })

    if (!upstreamRes.ok) {
      const errorBody = await upstreamRes.text()
      console.error(`[google-proxy] upstream ${upstreamRes.status} for ${fullModelId}: ${errorBody.slice(0, 200)}`)
      return new Response(errorBody, {
        status: upstreamRes.status,
        headers: { "Content-Type": upstreamRes.headers.get("Content-Type") || "application/json" },
      })
    }

    // ── 8. Track usage + stream response ──
    const costCtx: CostContext = {
      requestId,
      keyData: auth,
      model: fullModelId!,
      provider: "google",
      inputCost,
      outputCost,
      planLimit: quota._effectiveLimitMicro,
    }

    if (isStream && upstreamRes.body) {
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

    // Non-streaming: extract usageMetadata and track
    const responseJson = await upstreamRes.json() as any
    const usageMeta = responseJson.usageMetadata
    if (usageMeta) {
      trackUsageAsync(costCtx, {
        prompt_tokens: usageMeta.promptTokenCount ?? 0,
        completion_tokens: usageMeta.candidatesTokenCount ?? 0,
      })
    }

    return c.json(responseJson, {
      status: upstreamRes.status,
    })
  } catch (err: any) {
    console.error("[google-proxy] upstream error:", err?.message ?? err)
    return c.json(
      { error: { type: "GatewayError", message: `Upstream error: ${err.message}` } },
      502,
    )
  }
})
