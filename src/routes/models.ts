import { Hono } from "hono"
import { GATEWAY_MODELS, type ModelId } from "../lib/models"

export const modelRoutes = new Hono()

// ── List available models ──

modelRoutes.get("/", (c) => {
  return c.json({
    models: Object.values(GATEWAY_MODELS),
  })
})

// ── Get specific model ──

modelRoutes.get("/:modelId{.+}", (c) => {
  const modelId = c.req.param("modelId")
  const model = GATEWAY_MODELS[modelId as ModelId]

  if (!model) return c.json({ error: "Model not found" }, 404)
  return c.json(model)
})
