import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { billing, subscriptions, plans, payments, systemConfig } from "../db/schema.ts"
import { eq, and, isNull, desc, sql } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createCheckout, updateSubscription, cancelSubscription, getSubscription as getLsSubscription } from "../lib/lemonsqueezy.ts"
import { createId } from "../lib/id.ts"
import { MICRO, SYMBOL, CURRENCY, microToDisplay } from "../lib/currency.ts"

export const billingRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

billingRoutes.use("*", requireAuth)

// ── Get billing info ──

billingRoutes.get("/", async (c) => {
  const auth = c.get("auth")
  let result = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((rows) => rows[0])

  // Auto-create billing record if missing (legacy accounts)
  if (!result) {
    await db.insert(billing).values({
      id: createId("bill"),
      workspaceId: auth.workspaceId,
    })
    result = await db
      .select()
      .from(billing)
      .where(eq(billing.workspaceId, auth.workspaceId))
      .then((rows) => rows[0])
    if (!result) return c.json({ error: "Failed to initialize billing" }, 500)
  }

  // Get active plan
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  const planId = sub?.plan ?? "free"
  const plan = await db.select().from(plans).where(eq(plans.id, planId)).then((r) => r[0])

  return c.json({
    balance: microToDisplay(result.balance),
    currency: CURRENCY,
    symbol: SYMBOL,
    plan: plan ? { id: plan.id, name: plan.name } : { id: "free", name: "Free" },
    monthlyLimit: result.monthlyLimit,
    monthlyUsage: microToDisplay(result.monthlyUsage ?? 0),
    hasSubscription: !!sub,
  })
})

// ── Quota status (lightweight, for IDE pre-send check) ──

billingRoutes.get("/quota", async (c) => {
  const auth = c.get("auth")
  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((rows) => rows[0])

  if (!bill) {
    return c.json({ canSend: false, blockReason: "no_billing", warnings: [] }, 200)
  }

  // Subscription check
  const sub = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, auth.workspaceId),
        isNull(subscriptions.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  const hasSubscription = !!sub

  // Get effective plan (free tier for non-subscribers)
  const userPlan = hasSubscription
    ? await db.select().from(plans).where(eq(plans.id, sub!.plan)).then((r) => r[0])
    : await db.select().from(plans).where(eq(plans.id, "free")).then((r) => r[0])

  // Monthly usage (lazy-reset aware)
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthlyUsage =
    bill.timeMonthlyReset && bill.timeMonthlyReset < monthStart
      ? 0
      : (bill.monthlyUsage ?? 0)

  // Plan limit in USD micro-units
  const planLimitMicro = userPlan?.monthlyLimit ?? 500000 // fallback free tier $0.50
  const workspaceLimitMicro = bill.monthlyLimit
    ? bill.monthlyLimit * MICRO
    : null
  const effectiveLimit = workspaceLimitMicro ?? planLimitMicro

  const overPlanLimit = effectiveLimit !== null && monthlyUsage >= effectiveLimit
  const hasCredits = bill.balance > 0

  // Determine if user can send
  let canSend = true
  let blockReason: string | null = null
  const warnings: string[] = []

  if (overPlanLimit && !hasCredits) {
    canSend = false
    blockReason = hasSubscription ? "limit_no_credits" : "free_limit_no_credits"
  }

  // Overage warning
  if (overPlanLimit && hasCredits) {
    warnings.push("using_credits")
  }

  // Monthly approaching
  if (effectiveLimit !== null && monthlyUsage > 0 && !overPlanLimit) {
    const pct = Math.round((monthlyUsage / effectiveLimit) * 100)
    if (pct >= 80) warnings.push("monthly_approaching")
  }

  // Low credits warning
  const lowThresholdRow = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, "low_balance_threshold_usd"))
    .then((r) => r[0])
  const lowThresholdUsd = Number(lowThresholdRow?.value ?? 0.5)
  const lowThresholdMicro = Math.round(lowThresholdUsd * MICRO)
  if (bill.balance > 0 && bill.balance < lowThresholdMicro) {
    warnings.push("low_credits")
  }

  const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  const prices = userPlan?.prices as Record<string, number> | null
  const planPrice = prices?.["USD"] ? (prices["USD"] as number) / 100 : null

  return c.json({
    balance: microToDisplay(bill.balance),
    currency: CURRENCY,
    symbol: SYMBOL,
    plan: userPlan
      ? { id: userPlan.id, name: userPlan.name, price: planPrice }
      : { id: "free", name: "Free", price: 0 },
    monthly: {
      current: microToDisplay(monthlyUsage),
      max: effectiveLimit !== null ? microToDisplay(effectiveLimit) : null,
      remaining: effectiveLimit !== null ? microToDisplay(Math.max(effectiveLimit - monthlyUsage, 0)) : null,
      pct: effectiveLimit !== null && effectiveLimit > 0
        ? Math.round((monthlyUsage / effectiveLimit) * 100)
        : null,
      resetsAt: resetDate.toISOString(),
    },
    canSend,
    blockReason,
    warnings,
    overageActive: overPlanLimit && hasCredits,
  })
})

// ── Add credits (Lemon Squeezy checkout with custom_price) ──

const addCreditsSchema = z.object({
  amount: z.number().min(1).max(50000), // USD
})

billingRoutes.post("/add-credits", requireAdmin, zValidator("json", addCreditsSchema), async (c) => {
  const auth = c.get("auth")
  const { amount } = c.req.valid("json")

  const storeId = process.env.LEMON_SQUEEZY_STORE_ID
  const variantId = process.env.LEMON_SQUEEZY_CREDITS_VARIANT_ID
  if (!storeId || !variantId) {
    return c.json({ error: "Lemon Squeezy not configured" }, 500)
  }

  const checkout = await createCheckout({
    storeId,
    variantId,
    customPrice: Math.round(amount * 100), // LS wants cents
    email: auth.email,
    custom: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      type: "credits",
      usdAmount: String(amount),
    },
    redirectUrl: `${process.env.WEB_URL ?? "https://creor.ai"}/dashboard/billing?payment=success`,
    embed: true,
  })

  return c.json({
    checkoutUrl: checkout.url,
    amount,
    currency: CURRENCY,
    symbol: SYMBOL,
  })
})

// ── Subscribe (Lemon Squeezy checkout for plan variant) ──

const subscribeSchema = z.object({
  plan: z.enum(["starter", "pro", "team"]),
})

billingRoutes.post("/subscribe", requireAdmin, zValidator("json", subscribeSchema), async (c) => {
  const auth = c.get("auth")
  const { plan: planId } = c.req.valid("json")

  const storeId = process.env.LEMON_SQUEEZY_STORE_ID
  if (!storeId) return c.json({ error: "Lemon Squeezy not configured" }, 500)

  const plan = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .then((r) => r[0])

  if (!plan?.lsVariantId) {
    return c.json({ error: `Plan ${planId} not configured for Lemon Squeezy` }, 400)
  }

  const checkout = await createCheckout({
    storeId,
    variantId: plan.lsVariantId,
    email: auth.email,
    custom: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      plan: planId,
    },
    redirectUrl: `${process.env.WEB_URL ?? "https://creor.ai"}/dashboard/billing?subscription=success`,
    embed: true,
  })

  const prices = plan.prices as Record<string, number> | null
  const priceUsd = prices?.["USD"] ? (prices["USD"] as number) / 100 : 0

  return c.json({
    checkoutUrl: checkout.url,
    plan: planId,
    price: priceUsd,
    currency: CURRENCY,
  })
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
        isNull(subscriptions.timeDeleted),
      ),
    )
    .then((rows) => rows[0])

  if (!sub) return c.json({ active: false })

  const plan = await db
    .select()
    .from(plans)
    .where(eq(plans.id, sub.plan))
    .then((r) => r[0])

  const prices = plan?.prices as Record<string, number> | null

  return c.json({
    active: true,
    plan: sub.plan,
    planName: plan?.name ?? sub.plan,
    price: prices?.["USD"] ? (prices["USD"] as number) / 100 : 0,
    currency: CURRENCY,
    graceUntil: sub.graceUntil?.toISOString() ?? null,
    pendingPlan: sub.pendingPlan ?? null,
    pendingPlanEffectiveAt: sub.pendingPlanEffectiveAt?.toISOString() ?? null,
  })
})

// ── Change plan (upgrade/downgrade) ──
// Lemon Squeezy handles plan changes via PATCH — no new checkout needed!

const changePlanSchema = z.object({
  plan: z.enum(["starter", "pro", "team"]),
})

billingRoutes.post("/change-plan", requireAdmin, zValidator("json", changePlanSchema), async (c) => {
  const { plan: newPlanId } = c.req.valid("json")
  const auth = c.get("auth")

  // Get current subscription
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (!sub?.lsSubscriptionId) {
    return c.json({ error: "No active subscription to change" }, 400)
  }
  if (sub.plan === newPlanId) {
    return c.json({ error: "Already on this plan" }, 400)
  }

  // Get new plan
  const newPlan = await db.select().from(plans).where(eq(plans.id, newPlanId)).then((r) => r[0])
  if (!newPlan?.lsVariantId) return c.json({ error: "Plan not configured" }, 404)

  // Update subscription on Lemon Squeezy (instant — LS handles prorations)
  await updateSubscription(sub.lsSubscriptionId, {
    variantId: newPlan.lsVariantId,
  })

  // Determine direction for frontend display
  const currentPlan = await db.select().from(plans).where(eq(plans.id, sub.plan)).then((r) => r[0])
  const currentPrice = (currentPlan?.prices as Record<string, number>)?.["USD"] ?? 0
  const newPrice = (newPlan.prices as Record<string, number>)?.["USD"] ?? 0
  const isUpgrade = newPrice > currentPrice

  // Update local DB immediately (webhook will also confirm)
  await db
    .update(subscriptions)
    .set({ plan: newPlanId as "starter" | "pro" | "team" })
    .where(eq(subscriptions.id, sub.id))

  return c.json({
    success: true,
    direction: isUpgrade ? "upgrade" : "downgrade",
    newPlan: newPlanId,
  })
})

// ── Cancel subscription ──

billingRoutes.post("/cancel-subscription", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (!sub?.lsSubscriptionId) {
    return c.json({ error: "No active subscription" }, 400)
  }

  // Cancel on Lemon Squeezy — enters grace period until ends_at
  const lsSub = await cancelSubscription(sub.lsSubscriptionId)
  const endsAt = lsSub.data.attributes.ends_at

  // Set grace period locally
  if (endsAt) {
    await db
      .update(subscriptions)
      .set({ graceUntil: new Date(endsAt) })
      .where(eq(subscriptions.id, sub.id))
  }

  return c.json({
    success: true,
    message: "Subscription cancelled. Access continues until end of current billing cycle.",
    endsAt: endsAt ?? null,
  })
})

// ── Resume cancelled subscription (before grace period ends) ──

billingRoutes.post("/resume-subscription", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (!sub?.lsSubscriptionId) {
    return c.json({ error: "No subscription to resume" }, 400)
  }

  await updateSubscription(sub.lsSubscriptionId, { cancelled: false })

  await db
    .update(subscriptions)
    .set({ graceUntil: null })
    .where(eq(subscriptions.id, sub.id))

  return c.json({ success: true })
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

// ── Payment history ──

billingRoutes.get("/payments", async (c) => {
  const auth = c.get("auth")
  const page = Number(c.req.query("page") ?? "1")
  const limit = Math.min(Number(c.req.query("limit") ?? "20"), 50)
  const offset = (page - 1) * limit

  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.workspaceId, auth.workspaceId))
    .orderBy(desc(payments.timeCreated))
    .limit(limit)
    .offset(offset)

  return c.json({
    payments: rows.map((p) => ({
      id: p.id,
      type: p.type,
      amount: p.amountSmallest / 100, // cents → display
      currency: p.currency,
      status: p.status,
      timeCreated: p.timeCreated.toISOString(),
    })),
    page,
    limit,
  })
})
