import { db } from "../../db/client.ts"
import { usage } from "../../db/schema.ts"
import { sql } from "drizzle-orm"
import { createId } from "../id.ts"
import { MICRO } from "../currency.ts"
import { appendLedger } from "../ledger.ts"
import type { CostContext } from "./types.ts"

/**
 * Track LLM usage after a response completes.
 * Atomically increments monthly usage counter and deducts overage from balance.
 * Idempotent via request_id unique constraint.
 */
export async function trackUsageAsync(
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
    // Still insert usage row for request count tracking
    try {
      await db.insert(usage).values({
        id: createId("usg"),
        requestId: ctx.requestId,
        workspaceId: ctx.keyData.workspaceId,
        keyId: ctx.keyData.keyId,
        model: ctx.model,
        provider: ctx.provider,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        costUsd: 0,
      }).onConflictDoNothing() // idempotent on request_id
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

    // Insert usage row (idempotent via request_id unique constraint)
    const usageId = createId("usg")
    await db.insert(usage).values({
      id: usageId,
      requestId: ctx.requestId,
      workspaceId: ctx.keyData.workspaceId,
      keyId: ctx.keyData.keyId,
      model: ctx.model,
      provider: ctx.provider,
      inputTokens,
      outputTokens,
      cost: costMicro,
      costUsd: costMicro,
    }).onConflictDoNothing() // idempotent on request_id

    // Append ledger entry for the usage deduction (fire-and-forget)
    if (costMicro > 0) {
      appendLedger(
        ctx.keyData.workspaceId,
        "usage_deduction",
        -costMicro,
        usageId,
        { model: ctx.model, inputTokens, outputTokens, requestId: ctx.requestId },
      )
    }
  } catch (err) {
    console.error("Failed to track usage:", err)
  }
}

/**
 * Track usage from a streaming (SSE) response.
 * Pipes through the stream, normalizes provider-specific fields,
 * accumulates usage data, then calls trackUsageAsync.
 */
export async function trackStreamUsage(
  upstream: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  ctx: CostContext,
) {
  const reader = upstream.getReader()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  let accumulatedText = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value, { stream: true })
      const lines = text.split("\n")
      let needsRewrite = false
      const outputLines: string[] = []

      for (const line of lines) {
        // Pass through non-data lines and [DONE] marker unchanged
        if (!line.startsWith("data: ") || line === "data: [DONE]") {
          outputLines.push(line)
          continue
        }

        let chunk: any
        try {
          chunk = JSON.parse(line.slice(6))
        } catch {
          outputLines.push(line)
          continue
        }

        // Extract usage + text for tracking
        if (chunk.usage) lastUsage = chunk.usage
        const delta =
          chunk.choices?.[0]?.delta?.content ??
          chunk.candidates?.[0]?.content?.parts?.[0]?.text
        if (delta) accumulatedText += delta

        // Normalize Google-specific fields on tool_calls
        let modified = false
        if (chunk.choices) {
          for (const choice of chunk.choices) {
            const toolCalls = choice.delta?.tool_calls
            if (toolCalls) {
              for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i]
                // Inject missing index (Google omits it, AI SDK requires it)
                if (tc.index === undefined) {
                  tc.index = i
                  modified = true
                }
                // Strip extra_content (Google thought_signature)
                if (tc.extra_content) {
                  delete tc.extra_content
                  modified = true
                }
              }
            }
          }
        }

        if (modified) {
          needsRewrite = true
          outputLines.push("data: " + JSON.stringify(chunk))
        } else {
          outputLines.push(line)
        }
      }

      if (needsRewrite) {
        await writer.write(encoder.encode(outputLines.join("\n")))
      } else {
        await writer.write(value)
      }
    }
  } catch (err) {
    console.error(`[gateway] stream pipe error for ${ctx.model}:`, err)
  } finally {
    try { await writer.close() } catch { /* client disconnected */ }
    if (lastUsage || (accumulatedText && accumulatedText.length > 10)) {
      trackUsageAsync(ctx, lastUsage, lastUsage ? undefined : accumulatedText || undefined)
    }
  }
}
