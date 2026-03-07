import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { models, plans, systemConfig } from "../db/schema.ts"
import { eq, sql } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"

export const adminRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

adminRoutes.use("*", requireAuth)
adminRoutes.use("*", requireAdmin)

// ═══════════════════════════════════════
// Models CRUD
// ═══════════════════════════════════════

adminRoutes.get("/models", async (c) => {
  const rows = await db.select().from(models).orderBy(models.sortOrder)
  return c.json({ models: rows })
})

const modelSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().min(1),
  inputCost: z.string(), // NUMERIC as string
  outputCost: z.string(),
  contextWindow: z.number().int().default(200000),
  maxOutput: z.number().int().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  minPlan: z.string().default("free"),
  sortOrder: z.number().int().default(0),
})

adminRoutes.post("/models", zValidator("json", modelSchema), async (c) => {
  const data = c.req.valid("json")

  await db.insert(models).values({
    id: data.id,
    provider: data.provider,
    name: data.name,
    inputCost: data.inputCost,
    outputCost: data.outputCost,
    contextWindow: data.contextWindow,
    maxOutput: data.maxOutput ?? null,
    capabilities: data.capabilities,
    enabled: data.enabled,
    minPlan: data.minPlan,
    sortOrder: data.sortOrder,
  })

  await refreshGatewayConfig()
  return c.json({ success: true, id: data.id }, 201)
})

const modelUpdateSchema = modelSchema.partial().omit({ id: true })

adminRoutes.patch("/models/:id{.+}", zValidator("json", modelUpdateSchema), async (c) => {
  const id = c.req.param("id")
  const data = c.req.valid("json")

  const updates: Record<string, unknown> = { timeUpdated: new Date() }
  if (data.provider !== undefined) updates.provider = data.provider
  if (data.name !== undefined) updates.name = data.name
  if (data.inputCost !== undefined) updates.inputCost = data.inputCost
  if (data.outputCost !== undefined) updates.outputCost = data.outputCost
  if (data.contextWindow !== undefined) updates.contextWindow = data.contextWindow
  if (data.maxOutput !== undefined) updates.maxOutput = data.maxOutput
  if (data.capabilities !== undefined) updates.capabilities = data.capabilities
  if (data.enabled !== undefined) updates.enabled = data.enabled
  if (data.minPlan !== undefined) updates.minPlan = data.minPlan
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder

  await db.update(models).set(updates).where(eq(models.id, id))
  await refreshGatewayConfig()

  return c.json({ success: true })
})

adminRoutes.delete("/models/:id{.+}", async (c) => {
  const id = c.req.param("id")
  await db.delete(models).where(eq(models.id, id))
  await refreshGatewayConfig()
  return c.json({ success: true })
})

// ═══════════════════════════════════════
// Plans CRUD
// ═══════════════════════════════════════

adminRoutes.get("/plans", async (c) => {
  const rows = await db.select().from(plans).orderBy(plans.sortOrder)
  return c.json({ plans: rows })
})

const planUpdateSchema = z.object({
  name: z.string().optional(),
  prices: z.record(z.number()).optional(),
  monthlyLimit: z.number().nullable().optional(),
  onboardingCredits: z.number().nullable().optional(),
  features: z.array(z.string()).optional(),
  lsVariantId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

adminRoutes.patch("/plans/:id", zValidator("json", planUpdateSchema), async (c) => {
  const id = c.req.param("id")
  const data = c.req.valid("json")

  const updates: Record<string, unknown> = { timeUpdated: new Date() }
  if (data.name !== undefined) updates.name = data.name
  if (data.prices !== undefined) updates.prices = data.prices
  if (data.monthlyLimit !== undefined) updates.monthlyLimit = data.monthlyLimit
  if (data.onboardingCredits !== undefined) updates.onboardingCredits = data.onboardingCredits
  if (data.features !== undefined) updates.features = data.features
  if (data.lsVariantId !== undefined) updates.lsVariantId = data.lsVariantId
  if (data.enabled !== undefined) updates.enabled = data.enabled
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder

  await db.update(plans).set(updates).where(eq(plans.id, id))
  return c.json({ success: true })
})

// ═══════════════════════════════════════
// System Config
// ═══════════════════════════════════════

adminRoutes.get("/config", async (c) => {
  const rows = await db.select().from(systemConfig)
  return c.json({
    config: Object.fromEntries(rows.map((r) => [r.key, { value: r.value, description: r.description }])),
  })
})

const configUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  description: z.string().optional(),
})

adminRoutes.patch("/config", zValidator("json", configUpdateSchema), async (c) => {
  const { key, value, description } = c.req.valid("json")

  await db
    .insert(systemConfig)
    .values({ key, value, description, timeUpdated: new Date() })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value, description, timeUpdated: new Date() },
    })

  // If exchange rates changed, refresh the materialized view
  if (key === "exchange_rates" || key === "fallback_input_cost" || key === "fallback_output_cost") {
    await refreshGatewayConfig()
  }

  return c.json({ success: true })
})

// ═══════════════════════════════════════
// Manual refresh
// ═══════════════════════════════════════

adminRoutes.post("/refresh-config", async (c) => {
  await refreshGatewayConfig()
  return c.json({ success: true, message: "Materialized view refreshed" })
})

// ── Helper ──

async function refreshGatewayConfig() {
  try {
    await db.execute(sql`SELECT refresh_gateway_config()`)
  } catch (err) {
    console.error("Failed to refresh gateway_config:", err)
    // Non-fatal — gateway falls back to direct table query
  }
}
