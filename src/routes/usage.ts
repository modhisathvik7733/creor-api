import { Hono } from "hono"
import { db } from "../db/client"
import { usage } from "../db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { requireAuth, type AuthContext } from "../middleware/auth"

export const usageRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

usageRoutes.use("*", requireAuth)

// ── Get usage summary (current month) ──

usageRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const result = await db
    .select({
      totalCost: sql<number>`COALESCE(SUM(${usage.cost}), 0)`.as("total_cost"),
      totalInputTokens: sql<number>`COALESCE(SUM(${usage.inputTokens}), 0)`.as("total_input"),
      totalOutputTokens: sql<number>`COALESCE(SUM(${usage.outputTokens}), 0)`.as("total_output"),
      requestCount: sql<number>`COUNT(*)`.as("request_count"),
    })
    .from(usage)
    .where(
      and(eq(usage.workspaceId, auth.workspaceId), gte(usage.timeCreated, monthStart)),
    )
    .then((rows) => rows[0])

  return c.json({
    period: { start: monthStart.toISOString(), end: now.toISOString() },
    cost: (result?.totalCost ?? 0) / 1_000_000, // Convert micro-paise to INR
    tokens: {
      input: result?.totalInputTokens ?? 0,
      output: result?.totalOutputTokens ?? 0,
    },
    requests: result?.requestCount ?? 0,
  })
})

// ── Get usage by model ──

usageRoutes.get("/by-model", async (c) => {
  const auth = c.get("auth")
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const result = await db
    .select({
      model: usage.model,
      totalCost: sql<number>`COALESCE(SUM(${usage.cost}), 0)`.as("total_cost"),
      totalInputTokens: sql<number>`COALESCE(SUM(${usage.inputTokens}), 0)`.as("total_input"),
      totalOutputTokens: sql<number>`COALESCE(SUM(${usage.outputTokens}), 0)`.as("total_output"),
      requestCount: sql<number>`COUNT(*)`.as("request_count"),
    })
    .from(usage)
    .where(
      and(eq(usage.workspaceId, auth.workspaceId), gte(usage.timeCreated, monthStart)),
    )
    .groupBy(usage.model)

  return c.json(
    result.map((r) => ({
      model: r.model,
      cost: r.totalCost / 1_000_000,
      tokens: { input: r.totalInputTokens, output: r.totalOutputTokens },
      requests: r.requestCount,
    })),
  )
})

// ── Get daily usage (last 30 days) ──

usageRoutes.get("/daily", async (c) => {
  const auth = c.get("auth")
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const result = await db
    .select({
      date: sql<string>`DATE(${usage.timeCreated})`.as("date"),
      totalCost: sql<number>`COALESCE(SUM(${usage.cost}), 0)`.as("total_cost"),
      requestCount: sql<number>`COUNT(*)`.as("request_count"),
    })
    .from(usage)
    .where(
      and(eq(usage.workspaceId, auth.workspaceId), gte(usage.timeCreated, thirtyDaysAgo)),
    )
    .groupBy(sql`DATE(${usage.timeCreated})`)
    .orderBy(sql`DATE(${usage.timeCreated})`)

  return c.json(
    result.map((r) => ({
      date: r.date,
      cost: r.totalCost / 1_000_000,
      requests: r.requestCount,
    })),
  )
})
