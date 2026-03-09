import { Hono } from "hono"
import { db } from "../db/client.ts"
import { models } from "../db/schema.ts"
import { eq } from "drizzle-orm"

export const modelRoutes = new Hono()

// ── List available models (from DB) ──

modelRoutes.get("/", async (c) => {
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.enabled, true))
    .orderBy(models.sortOrder)

  return c.json({
    models: rows.map((m) => ({
      id: m.id,
      provider: m.provider,
      name: m.name,
      inputCost: Number(m.inputCost),
      outputCost: Number(m.outputCost),
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      capabilities: m.capabilities,
      minPlan: m.minPlan,
      sortOrder: m.sortOrder,
    })),
  })
})

// ── Get specific model ──

modelRoutes.get("/:modelId{.+}", async (c) => {
  const modelId = c.req.param("modelId")
  const model = await db
    .select()
    .from(models)
    .where(eq(models.id, modelId))
    .then((r) => r[0])

  if (!model) return c.json({ error: "Model not found" }, 404)

  return c.json({
    id: model.id,
    provider: model.provider,
    name: model.name,
    inputCost: Number(model.inputCost),
    outputCost: Number(model.outputCost),
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    capabilities: model.capabilities,
    minPlan: model.minPlan,
  })
})
