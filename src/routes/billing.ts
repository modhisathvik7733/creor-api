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
import { checkQuota } from "../lib/quota.ts"
import { logAudit } from "../lib/audit.ts"

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
  const result = await checkQuota(auth.workspaceId)
  return c.json(result)
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
    productName: "Creor Credits",
    productDescription: "Top-up credits for AI model usage beyond your plan allowance. Credits never expire.",
    mediaUrls: [`${process.env.WEB_URL ?? "https://creor.ai"}/checkout-banner.png`],
  })

  void logAudit({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    action: "billing.checkout_started",
    resourceType: "billing",
    metadata: { amount, currency: CURRENCY },
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

  const planLabel = plan.name ?? planId.charAt(0).toUpperCase() + planId.slice(1)
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
    productName: `Creor ${planLabel}`,
    productDescription: `${planLabel} plan — access all AI models with priority support and higher usage limits.`,
    mediaUrls: [`${process.env.WEB_URL ?? "https://creor.ai"}/checkout-banner.png`],
  })

  const prices = plan.prices as Record<string, number> | null
  const priceUsd = prices?.["USD"] ? (prices["USD"] as number) / 100 : 0

  void logAudit({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    action: "billing.subscribe_started",
    resourceType: "billing",
    metadata: { plan: planId, price: priceUsd, currency: CURRENCY },
  })

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

  // Fetch card + portal info from Lemon Squeezy
  let cardBrand: string | null = null
  let cardLastFour: string | null = null
  let updatePaymentUrl: string | null = null
  let renewsAt: string | null = null

  if (sub.lsSubscriptionId) {
    try {
      const lsSub = await getLsSubscription(sub.lsSubscriptionId)
      cardBrand = lsSub.data.attributes.card_brand ?? null
      cardLastFour = lsSub.data.attributes.card_last_four ?? null
      updatePaymentUrl = lsSub.data.attributes.urls?.update_payment_method ?? null
      renewsAt = lsSub.data.attributes.renews_at ?? null
    } catch {
      // LS fetch failed — return what we have locally
    }
  }

  return c.json({
    active: true,
    plan: sub.plan,
    planName: plan?.name ?? sub.plan,
    price: prices?.["USD"] ? (prices["USD"] as number) / 100 : 0,
    currency: CURRENCY,
    graceUntil: sub.graceUntil?.toISOString() ?? null,
    pendingPlan: sub.pendingPlan ?? null,
    pendingPlanEffectiveAt: sub.pendingPlanEffectiveAt?.toISOString() ?? null,
    cardBrand,
    cardLastFour,
    updatePaymentUrl,
    renewsAt,
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
  if (sub.plan === newPlanId && !sub.pendingPlan) {
    return c.json({ error: "Already on this plan" }, 400)
  }

  // Get new plan
  const newPlan = await db.select().from(plans).where(eq(plans.id, newPlanId)).then((r) => r[0])
  if (!newPlan?.lsVariantId) return c.json({ error: "Plan not configured" }, 404)

  // Determine direction
  const currentPlan = await db.select().from(plans).where(eq(plans.id, sub.plan)).then((r) => r[0])
  const currentPrice = (currentPlan?.prices as Record<string, number>)?.["USD"] ?? 0
  const newPrice = (newPlan.prices as Record<string, number>)?.["USD"] ?? 0
  const isUpgrade = newPrice > currentPrice

  if (isUpgrade) {
    // ── UPGRADE: Immediate change with prorated charge ──
    await updateSubscription(sub.lsSubscriptionId, {
      variantId: newPlan.lsVariantId,
      invoiceImmediately: true,
    })

    // Update local DB immediately, clear any pending downgrade
    await db
      .update(subscriptions)
      .set({
        plan: newPlanId as "starter" | "pro" | "team",
        pendingPlan: null,
        pendingPlanEffectiveAt: null,
      })
      .where(eq(subscriptions.id, sub.id))

    // Record upgrade payment for immediate visibility in payment history
    // Amount is the price difference (LS charges the actual prorated amount on-card)
    const priceDiffCents = newPrice - currentPrice
    try {
      await db.insert(payments).values({
        id: createId("pay"),
        workspaceId: sub.workspaceId,
        userId: auth.userId,
        type: "subscription",
        amountSmallest: priceDiffCents > 0 ? priceDiffCents : newPrice,
        currency: "USD",
        lsOrderId: `upgrade_${sub.lsSubscriptionId}_${newPlanId}`,
        status: "captured",
        metadata: {
          upgrade: true,
          from: sub.plan,
          to: newPlanId,
          subscriptionId: sub.lsSubscriptionId,
        },
      })
    } catch {
      // Already recorded (idempotent)
    }

    return c.json({
      success: true,
      direction: "upgrade" as const,
      newPlan: newPlanId,
    })
  } else {
    // ── DOWNGRADE: Schedule for end of billing cycle ──
    // Fetch subscription from LS to get renews_at date
    const lsSub = await getLsSubscription(sub.lsSubscriptionId)
    const renewsAt = lsSub.data.attributes.renews_at

    // Record the pending downgrade — do NOT change anything on LS yet
    await db
      .update(subscriptions)
      .set({
        pendingPlan: newPlanId,
        pendingPlanEffectiveAt: renewsAt ? new Date(renewsAt) : null,
      })
      .where(eq(subscriptions.id, sub.id))

    return c.json({
      success: true,
      direction: "downgrade" as const,
      newPlan: newPlanId,
      effectiveAt: renewsAt ?? null,
    })
  }
})

// ── Cancel pending downgrade ──

billingRoutes.post("/cancel-pending-change", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (!sub?.pendingPlan) {
    return c.json({ error: "No pending plan change" }, 400)
  }

  await db
    .update(subscriptions)
    .set({ pendingPlan: null, pendingPlanEffectiveAt: null })
    .where(eq(subscriptions.id, sub.id))

  return c.json({ success: true })
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
    payments: rows.map((p) => {
      const meta = p.metadata as Record<string, unknown> | null
      return {
        id: p.id,
        type: p.type,
        amount: p.amountSmallest / 100, // cents → display
        currency: p.currency,
        status: p.status,
        timeCreated: p.timeCreated.toISOString(),
        upgrade: meta?.upgrade === true ? { from: meta.from as string, to: meta.to as string } : undefined,
      }
    }),
    page,
    limit,
  })
})

// ── TEST RESET: Wipe billing state for fresh testing ──
// WARNING: This deletes all billing data for the workspace. Test only!

billingRoutes.post("/reset-test", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const wid = auth.workspaceId

  // Cancel LS subscription if exists
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, wid), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (sub?.lsSubscriptionId) {
    try {
      await cancelSubscription(sub.lsSubscriptionId)
    } catch {
      // May already be cancelled or expired
    }
  }

  // Delete subscription records
  await db
    .update(subscriptions)
    .set({ timeDeleted: new Date() })
    .where(and(eq(subscriptions.workspaceId, wid), isNull(subscriptions.timeDeleted)))

  // Delete all payment history
  await db.delete(payments).where(eq(payments.workspaceId, wid))

  // Reset billing record to defaults
  await db
    .update(billing)
    .set({
      balance: 0,
      monthlyUsage: 0,
      monthlyLimit: null,
      lsSubscriptionId: null,
      lsCustomerId: null,
      timeUpdated: new Date(),
    })
    .where(eq(billing.workspaceId, wid))

  return c.json({ success: true, message: "Billing fully reset. You are now on the Free plan." })
})
