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

// ── In-memory cache for model configs (materialized view, rarely changes) ──
let modelConfigCache: Map<string, ModelConfig | null> | null = null
let modelConfigCacheTime = 0
const MODEL_CONFIG_TTL = 60_000 // 1 minute

async function loadModelConfigs(): Promise<Map<string, ModelConfig | null>> {
  const now = Date.now()
  if (modelConfigCache && now - modelConfigCacheTime < MODEL_CONFIG_TTL) {
    return modelConfigCache
  }

  const rows = await db.execute(sql`SELECT * FROM gateway_config`)
  const cache = new Map<string, ModelConfig | null>()

  for (const row of rows) {
    cache.set(row.model_id as string, {
      enabled: row.enabled as boolean,
      inputCost: Number(row.input_cost),
      outputCost: Number(row.output_cost),
      minPlan: (row.min_plan as string) ?? null,
    })
  }

  modelConfigCache = cache
  modelConfigCacheTime = now
  return cache
}

/**
 * Look up model config from the gateway_config materialized view.
 * Uses an in-memory cache (1 min TTL) to avoid per-request DB queries.
 */
export async function getModelConfig(model: string): Promise<ModelConfig | null> {
  const cache = await loadModelConfigs()
  return cache.get(model) ?? null
}

// ── Fallback pricing cache ──
let fallbackPricingCache: { inputCost: number; outputCost: number } | null = null
let fallbackPricingCacheTime = 0

/**
 * Get fallback pricing for unknown models.
 */
export async function getFallbackPricing(): Promise<{ inputCost: number; outputCost: number }> {
  const now = Date.now()
  if (fallbackPricingCache && now - fallbackPricingCacheTime < MODEL_CONFIG_TTL) {
    return fallbackPricingCache
  }

  const fallback = await db
    .execute(sql`SELECT fallback_input, fallback_output FROM gateway_config LIMIT 1`)
    .then((r) => r[0])

  fallbackPricingCache = {
    inputCost: Number(fallback?.fallback_input ?? 0.003),
    outputCost: Number(fallback?.fallback_output ?? 0.015),
  }
  fallbackPricingCacheTime = now
  return fallbackPricingCache
}

/**
 * Check if a plan meets the minimum tier required for a model.
 */
export function meetsMinPlan(currentPlan: string, requiredPlan: string | null): boolean {
  if (!requiredPlan || requiredPlan === "free") return true
  return (PLAN_ORDER[currentPlan] ?? 0) >= (PLAN_ORDER[requiredPlan] ?? 0)
}
