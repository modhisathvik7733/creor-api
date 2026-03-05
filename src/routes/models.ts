import { Hono } from "hono"

export const modelRoutes = new Hono()

/** Available models in Creor Gateway */
const GATEWAY_MODELS = {
  "anthropic/claude-sonnet-4": {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    cost: { input: 0.003, output: 0.015 }, // per 1K tokens in USD
    contextWindow: 200000,
    capabilities: ["tool_call", "reasoning", "vision"],
  },
  "anthropic/claude-haiku-3.5": {
    id: "anthropic/claude-haiku-3.5",
    name: "Claude Haiku 3.5",
    provider: "anthropic",
    cost: { input: 0.0008, output: 0.004 },
    contextWindow: 200000,
    capabilities: ["tool_call", "vision"],
  },
  "openai/gpt-4.1": {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    cost: { input: 0.002, output: 0.008 },
    contextWindow: 1000000,
    capabilities: ["tool_call", "reasoning", "vision"],
  },
  "openai/o3-mini": {
    id: "openai/o3-mini",
    name: "o3-mini",
    provider: "openai",
    cost: { input: 0.0011, output: 0.0044 },
    contextWindow: 200000,
    capabilities: ["tool_call", "reasoning"],
  },
  "google/gemini-2.5-pro": {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    cost: { input: 0.00125, output: 0.01 },
    contextWindow: 1000000,
    capabilities: ["tool_call", "reasoning", "vision"],
  },
  "google/gemini-2.5-flash": {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    cost: { input: 0.00015, output: 0.0006 },
    contextWindow: 1000000,
    capabilities: ["tool_call", "reasoning", "vision"],
  },
} as const

// ── List available models ──

modelRoutes.get("/", (c) => {
  return c.json({
    models: Object.values(GATEWAY_MODELS),
  })
})

// ── Get specific model ──

modelRoutes.get("/:modelId{.+}", (c) => {
  const modelId = c.req.param("modelId")
  const model = GATEWAY_MODELS[modelId as keyof typeof GATEWAY_MODELS]

  if (!model) return c.json({ error: "Model not found" }, 404)
  return c.json(model)
})
