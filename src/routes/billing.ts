import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { billing, subscriptions } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createRazorpayOrder, createRazorpaySubscription, createRazorpayPlan } from "../lib/razorpay.ts"

export const billingRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

billingRoutes.use("*", requireAuth)

// ── Get billing info ──

billingRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  const result = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((rows) => rows[0])

  if (!result) return c.json({ error: "Billing not found" }, 404)

  // Convert micro-paise to INR for display
  return c.json({
    balance: result.balance / 1_000_000, // INR
    monthlyLimit: result.monthlyLimit,
    monthlyUsage: (result.monthlyUsage ?? 0) / 1_000_000, // INR
    reloadEnabled: result.reloadEnabled,
    reloadAmount: result.reloadAmount,
    reloadTrigger: result.reloadTrigger,
    hasSubscription: !!result.razorpaySubscriptionId,
  })
})

// ── Add credits (create Razorpay order) ──

const addCreditsSchema = z.object({
  amount: z.number().min(100).max(50000), // INR 100 to 50,000
})

billingRoutes.post("/add-credits", requireAdmin, zValidator("json", addCreditsSchema), async (c) => {
  const auth = c.get("auth")
  const { amount } = c.req.valid("json")

  const order = await createRazorpayOrder({
    amount: amount * 100, // Razorpay uses paise
    currency: "INR",
    receipt: `credits_${auth.workspaceId}_${Date.now()}`,
    notes: {
      workspaceId: auth.workspaceId,
      type: "credits",
    },
  })

  return c.json({ orderId: order.id, amount, currency: "INR" })
})

// ── Subscribe to Creor Pro ──

const subscribeSchema = z.object({
  plan: z.enum(["starter", "pro", "team"]),
})

billingRoutes.post("/subscribe", requireAdmin, zValidator("json", subscribeSchema), async (c) => {
  const auth = c.get("auth")
  const { plan } = c.req.valid("json")

  const planConfig = PLAN_CONFIG[plan]

  if (!planConfig.razorpayPlanId) {
    return c.json({ error: `Razorpay plan ID not configured for "${plan}". Run POST /api/billing/setup-plans first.` }, 500)
  }

  try {
    const subscription = await createRazorpaySubscription({
      planId: planConfig.razorpayPlanId,
      totalCount: 12, // 12 months
      notes: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        plan,
      },
    })

    return c.json({
      subscriptionId: subscription.id,
      shortUrl: subscription.short_url,
      plan,
      price: planConfig.price,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Razorpay subscription creation failed"
    return c.json({ error: message }, 500)
  }
})

// ── Update monthly limit ──

const limitSchema = z.object({
  monthlyLimit: z.number().min(0).max(100000).nullable(),
})

billingRoutes.patch("/limit", requireAdmin, zValidator("json", limitSchema), async (c) => {
  const auth = c.get("auth")
  const { monthlyLimit } = c.req.valid("json")

  await db
    .update(billing)
    .set({ monthlyLimit, timeUpdated: new Date() })
    .where(eq(billing.workspaceId, auth.workspaceId))

  return c.json({ success: true })
})

// ── Get active subscription ──

billingRoutes.get("/subscription", async (c) => {
  const auth = c.get("auth")
  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, auth.workspaceId),
        eq(subscriptions.userId, auth.userId),
        isNull(subscriptions.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  if (!sub) return c.json({ active: false })

  return c.json({
    active: true,
    plan: sub.plan,
    ...PLAN_CONFIG[sub.plan as keyof typeof PLAN_CONFIG],
  })
})

// ── Setup Razorpay plans (one-time admin endpoint) ──

billingRoutes.post("/setup-plans", requireAdmin, async (c) => {
  const results: Record<string, string> = {}

  for (const [name, config] of Object.entries(PLAN_CONFIG)) {
    if (config.razorpayPlanId) {
      results[name] = `already configured: ${config.razorpayPlanId}`
      continue
    }

    try {
      const plan = await createRazorpayPlan({
        name: `Creor ${name.charAt(0).toUpperCase() + name.slice(1)}`,
        amount: config.price * 100, // INR to paise
        currency: "INR",
        description: `Creor ${name} monthly subscription`,
      })
      results[name] = plan.id
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create plan"
      results[name] = `error: ${message}`
    }
  }

  return c.json({
    message: "Set these plan IDs as Supabase secrets (RAZORPAY_PLAN_STARTER, RAZORPAY_PLAN_PRO, RAZORPAY_PLAN_TEAM)",
    plans: results,
  })
})

// ── Plan configuration (INR pricing) ──

const PLAN_CONFIG: Record<string, {
  price: number
  currency: string
  razorpayPlanId: string
  weeklyLimit: number
  rollingWindow: number
  rollingLimit: number
}> = {
  starter: {
    price: 499,
    currency: "INR",
    razorpayPlanId: process.env.RAZORPAY_PLAN_STARTER ?? "",
    weeklyLimit: 50_000_000, // micro-paise
    rollingWindow: 24, // hours
    rollingLimit: 20_000_000,
  },
  pro: {
    price: 1999,
    currency: "INR",
    razorpayPlanId: process.env.RAZORPAY_PLAN_PRO ?? "",
    weeklyLimit: 200_000_000,
    rollingWindow: 24,
    rollingLimit: 80_000_000,
  },
  team: {
    price: 4999,
    currency: "INR",
    razorpayPlanId: process.env.RAZORPAY_PLAN_TEAM ?? "",
    weeklyLimit: 500_000_000,
    rollingWindow: 24,
    rollingLimit: 200_000_000,
  },
}
