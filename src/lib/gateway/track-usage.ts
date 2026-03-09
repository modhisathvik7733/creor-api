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
 * Pipes through the stream, accumulates usage data, then calls trackUsageAsync.
 */
export async function trackStreamUsage(
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
    // Track if we have usage data or significant accumulated text
    if (lastUsage || (accumulatedText && accumulatedText.length > 10)) {
      trackUsageAsync(ctx, lastUsage, lastUsage ? undefined : accumulatedText || undefined)
    }
  }
}
