import { Hono } from "hono"
import { db } from "../db/client.ts"
import { models } from "../db/schema.ts"
import { eq } from "drizzle-orm"

export const catalogRoutes = new Hono()

/**
 * Model catalog endpoint — returns all enabled models in a format
 * compatible with the engine's models.dev provider schema.
 *
 * This is the single source of truth for model availability and pricing.
 * The engine fetches this via CREOR_MODELS_URL to stay in sync.
 *
 * No auth required — model catalog is public information.
 * Response is cached for 5 minutes via Cache-Control header.
 */

let cachedResponse: { data: unknown; timestamp: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

catalogRoutes.get("/", async (c) => {
  // Return cached response if valid
  if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_TTL_MS) {
    c.header("Cache-Control", "public, max-age=300")
    c.header("X-Cache", "HIT")
    return c.json(cachedResponse.data)
  }

  const rows = await db
    .select()
    .from(models)
    .where(eq(models.enabled, true))
    .orderBy(models.sortOrder)

  // Group models by provider in models.dev compatible format
  const providers: Record<string, {
    id: string
    name: string
    models: Record<string, {
      id: string
      name: string
      cost: { input: number; output: number }
      limit: { context: number; output: number | null }
      capabilities: unknown
      minPlan: string | null
    }>
  }> = {}

  for (const m of rows) {
    if (!providers[m.provider]) {
      providers[m.provider] = {
        id: m.provider,
        name: m.provider.charAt(0).toUpperCase() + m.provider.slice(1),
        models: {},
      }
    }

    providers[m.provider].models[m.id] = {
      id: m.id,
      name: m.name,
      cost: {
        input: Number(m.inputCost),
        output: Number(m.outputCost),
      },
      limit: {
        context: m.contextWindow,
        output: m.maxOutput,
      },
      capabilities: m.capabilities,
      minPlan: m.minPlan,
    }
  }

  const data = {
    providers,
    updated: new Date().toISOString(),
  }

  cachedResponse = { data, timestamp: Date.now() }

  c.header("Cache-Control", "public, max-age=300")
  c.header("X-Cache", "MISS")
  return c.json(data)
})
