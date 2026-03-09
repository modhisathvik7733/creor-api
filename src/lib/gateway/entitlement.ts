import { db } from "../../db/client.ts"
import { sql } from "drizzle-orm"

/** Plan ordering for tier comparison */
const PLAN_ORDER: Record<string, number> = { free: 0, starter: 1, pro: 2, team: 3 }

export interface ModelConfig {
  enabled: boolean
  inputCost: number
  outputCost: number
  minPlan: string | null
}

/**
 * Look up model config from the gateway_config materialized view.
 * Returns pricing and tier requirements for the model.
 */
export async function getModelConfig(model: string): Promise<ModelConfig | null> {
  const config = await db
    .execute(sql`SELECT * FROM gateway_config WHERE model_id = ${model}`)
    .then((r) => r[0])

  if (!config) return null

  return {
    enabled: config.enabled as boolean,
    inputCost: Number(config.input_cost),
    outputCost: Number(config.output_cost),
    minPlan: (config.min_plan as string) ?? null,
  }
}

/**
 * Get fallback pricing for unknown models.
 */
export async function getFallbackPricing(): Promise<{ inputCost: number; outputCost: number }> {
  const fallback = await db
    .execute(sql`SELECT fallback_input, fallback_output FROM gateway_config LIMIT 1`)
    .then((r) => r[0])

  return {
    inputCost: Number(fallback?.fallback_input ?? 0.003),
    outputCost: Number(fallback?.fallback_output ?? 0.015),
  }
}

/**
 * Check if a plan meets the minimum tier required for a model.
 */
export function meetsMinPlan(currentPlan: string, requiredPlan: string | null): boolean {
  if (!requiredPlan || requiredPlan === "free") return true
  return (PLAN_ORDER[currentPlan] ?? 0) >= (PLAN_ORDER[requiredPlan] ?? 0)
}
