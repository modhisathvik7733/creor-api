import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { billing, subscriptions, plans, payments, systemConfig } from "../db/schema.ts"
import { eq, and, isNull, desc, sql } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createRazorpayOrder, createRazorpaySubscription, fetchRazorpaySubscription, verifyPaymentSignature, updateRazorpaySubscription, cancelRazorpaySubscriptionAtCycleEnd } from "../lib/razorpay.ts"
import { createId } from "../lib/id.ts"
import {
  MICRO,
  SYMBOL,
  microToDisplay,
  microToSmallest,
  displayToMicro,
  isSupportedCurrency,
} from "../lib/currency.ts"
import type { SupportedCurrency } from "../lib/currency.ts"

export const billingRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

billingRoutes.use("*", requireAuth)

// ── Helper: get exchange rates from system_config ──

async function getExchangeRates(): Promise<Record<string, number>> {
  const row = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, "exchange_rates"))
    .then((r) => r[0])
  if (row?.value) {
    return typeof row.value === "string" ? JSON.parse(row.value) : (row.value as Record<string, number>)
  }
  return { USD: 1, INR: 85, EUR: 0.92 }
}

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

  const currency = result.currency as SupportedCurrency

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
    currency,
    symbol: SYMBOL[currency] ?? "$",
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

  const currency = bill.currency as SupportedCurrency
  const exchangeRates = await getExchangeRates()
  const rate = exchangeRates[currency] ?? 1

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

  // Plan limit in workspace currency micro-units
  const planLimitLocal = userPlan?.monthlyLimit
    ? Math.round(userPlan.monthlyLimit * rate)
    : Math.round(500000 * rate) // fallback free tier $0.50
  const workspaceLimitMicro = bill.monthlyLimit
    ? bill.monthlyLimit * MICRO
    : null
  const effectiveLimit = workspaceLimitMicro ?? planLimitLocal

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
  const lowThresholdLocal = Math.round(lowThresholdUsd * rate * MICRO)
  if (bill.balance > 0 && bill.balance < lowThresholdLocal) {
    warnings.push("low_credits")
  }

  const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  const prices = userPlan?.prices as Record<string, number> | null
  const planPrice = prices?.[currency] ? (prices[currency] as number) / 100 : null

  return c.json({
    balance: microToDisplay(bill.balance),
    currency,
    symbol: SYMBOL[currency] ?? "$",
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
    exchangeRates,
  })
})

// ── Add credits (multi-currency Razorpay order) ──

const addCreditsSchema = z.object({
  amount: z.number().min(1).max(50000), // in display currency units
})

billingRoutes.post("/add-credits", requireAdmin, zValidator("json", addCreditsSchema), async (c) => {
  const auth = c.get("auth")
  const { amount } = c.req.valid("json")

  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((rows) => rows[0])

  if (!bill) return c.json({ error: "No billing record" }, 400)

  const currency = bill.currency as SupportedCurrency
  const amountSmallest = Math.round(amount * 100) // display units → cents/paise

  const order = await createRazorpayOrder({
    amount: amountSmallest,
    currency,
    receipt: `credits_${auth.workspaceId}_${Date.now()}`,
    notes: {
      workspaceId: auth.workspaceId,
      type: "credits",
    },
  })

  // Record pending payment
  await db.insert(payments).values({
    id: createId("pay"),
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    type: "credits",
    amountSmallest,
    currency,
    razorpayOrderId: order.id,
    status: "created",
  })

  return c.json({
    orderId: order.id,
    amount,
    amountSmallest,
    currency,
    symbol: SYMBOL[currency] ?? "$",
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
  })
})

// ── Verify payment and credit balance instantly ──

const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
})

billingRoutes.post("/verify-payment", requireAdmin, zValidator("json", verifyPaymentSchema), async (c) => {
  const auth = c.get("auth")
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = c.req.valid("json")

  const valid = await verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  })

  if (!valid) {
    return c.json({ error: "Invalid payment signature" }, 400)
  }

  // Update payment record
  await db
    .update(payments)
    .set({ razorpayPaymentId: razorpay_payment_id, status: "captured" })
    .where(eq(payments.razorpayOrderId, razorpay_order_id))

  // Credit balance from the payment record
  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.razorpayOrderId, razorpay_order_id))
    .then((r) => r[0])

  if (payment && payment.type === "credits") {
    // Convert smallest units (cents/paise) → micro-units
    const creditMicro = payment.amountSmallest * 10_000
    await db
      .update(billing)
      .set({
        balance: sql`${billing.balance} + ${creditMicro}`,
        timeUpdated: new Date(),
      })
      .where(eq(billing.workspaceId, auth.workspaceId))
  }

  return c.json({ success: true, paymentId: razorpay_payment_id })
})

// ── Subscribe (multi-currency) ──

const subscribeSchema = z.object({
  plan: z.enum(["starter", "pro", "team"]),
})

billingRoutes.post("/subscribe", requireAdmin, zValidator("json", subscribeSchema), async (c) => {
  const auth = c.get("auth")
  const { plan: planId } = c.req.valid("json")

  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((rows) => rows[0])

  if (!bill) return c.json({ error: "No billing record" }, 400)

  const currency = bill.currency as SupportedCurrency

  // Get plan from DB
  const plan = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .then((r) => r[0])

  if (!plan) return c.json({ error: "Plan not found" }, 400)

  // Get Razorpay plan ID for this currency
  const razorpayPlanIds = plan.razorpayPlanIds as Record<string, string> | null
  const razorpayPlanId = razorpayPlanIds?.[currency]

  if (!razorpayPlanId) {
    return c.json({ error: `Razorpay plan not configured for ${planId} in ${currency}` }, 500)
  }

  try {
    const subscription = await createRazorpaySubscription({
      planId: razorpayPlanId,
      totalCount: 12,
      notes: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        plan: planId,
      },
    })

    const prices = plan.prices as Record<string, number> | null
    const price = prices?.[currency] ? (prices[currency] as number) / 100 : 0

    return c.json({
      subscriptionId: subscription.id,
      plan: planId,
      price,
      currency,
      keyId: process.env.RAZORPAY_KEY_ID ?? "",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Razorpay subscription creation failed"
    return c.json({ error: message }, 500)
  }
})

// ── Activate subscription (callback-based, doesn't depend on webhook) ──

const activateSubSchema = z.object({
  subscriptionId: z.string().min(1),
})

billingRoutes.post("/activate-subscription", requireAdmin, zValidator("json", activateSubSchema), async (c) => {
  const auth = c.get("auth")
  const { subscriptionId } = c.req.valid("json")

  // Check if already activated
  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.razorpaySubscriptionId, subscriptionId))
    .then((r) => r[0])

  if (existing && !existing.timeDeleted) {
    return c.json({ success: true, status: "already_active" })
  }

  // Verify with Razorpay that the subscription is actually active
  let rzSub: { id: string; plan_id: string; status: string; notes: Record<string, string> }
  try {
    rzSub = await fetchRazorpaySubscription(subscriptionId)
  } catch {
    return c.json({ error: "Could not verify subscription with Razorpay" }, 400)
  }

  if (rzSub.status !== "active" && rzSub.status !== "authenticated") {
    return c.json({ error: `Subscription status is "${rzSub.status}", not active` }, 400)
  }

  // Verify this subscription belongs to this workspace
  const workspaceId = rzSub.notes?.workspaceId
  if (workspaceId && workspaceId !== auth.workspaceId) {
    return c.json({ error: "Subscription does not belong to this workspace" }, 403)
  }

  const planId = rzSub.notes?.plan as string | undefined
  if (!planId) {
    return c.json({ error: "Subscription missing plan info" }, 400)
  }

  // Create subscription record
  await db.insert(subscriptions).values({
    id: createId("sub"),
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    plan: planId as "starter" | "pro" | "team",
    razorpaySubscriptionId: subscriptionId,
  }).onConflictDoNothing()

  // Update billing record
  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((r) => r[0])

  await db
    .update(billing)
    .set({
      razorpaySubscriptionId: subscriptionId,
      timeUpdated: new Date(),
    })
    .where(eq(billing.workspaceId, auth.workspaceId))

  // Record subscription payment in payment history
  const plan = await db.select().from(plans).where(eq(plans.id, planId)).then((r) => r[0])
  if (plan && bill) {
    const currency = (bill.currency ?? "INR") as SupportedCurrency
    const prices = plan.prices as Record<string, number> | null
    const amountSmallest = prices?.[currency] ?? prices?.["INR"] ?? 0
    try {
      await db.insert(payments).values({
        id: createId("pay"),
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        type: "subscription",
        amountSmallest,
        currency,
        razorpayPaymentId: `sub_payment_${subscriptionId}`,
        status: "captured",
        metadata: { subscriptionId, plan: planId },
      })
    } catch {
      // Unique constraint on razorpay_payment_id — already recorded
    }
  }

  return c.json({ success: true, status: "activated", plan: planId })
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

// ── Switch workspace currency ──

const currencySchema = z.object({
  currency: z.enum(["USD", "INR", "EUR"]),
})

billingRoutes.patch("/currency", requireAdmin, zValidator("json", currencySchema), async (c) => {
  const auth = c.get("auth")
  const { currency: newCurrency } = c.req.valid("json")

  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((rows) => rows[0])

  if (!bill) return c.json({ error: "No billing record" }, 400)

  const oldCurrency = bill.currency as SupportedCurrency
  if (oldCurrency === newCurrency) {
    return c.json({ success: true, currency: newCurrency })
  }

  const exchangeRates = await getExchangeRates()
  const oldRate = exchangeRates[oldCurrency] ?? 1
  const newRate = exchangeRates[newCurrency] ?? 1

  // Convert balance and monthly usage from old currency to new
  const conversionFactor = newRate / oldRate
  const newBalance = Math.round(bill.balance * conversionFactor)
  const newMonthlyUsage = Math.round((bill.monthlyUsage ?? 0) * conversionFactor)

  await db
    .update(billing)
    .set({
      currency: newCurrency,
      balance: newBalance,
      monthlyUsage: newMonthlyUsage,
      timeUpdated: new Date(),
    })
    .where(eq(billing.workspaceId, auth.workspaceId))

  return c.json({
    success: true,
    currency: newCurrency,
    balance: microToDisplay(newBalance),
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
        eq(subscriptions.userId, auth.userId),
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

  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((r) => r[0])

  const currency = (bill?.currency ?? "USD") as SupportedCurrency
  const prices = plan?.prices as Record<string, number> | null

  return c.json({
    active: true,
    plan: sub.plan,
    planName: plan?.name ?? sub.plan,
    price: prices?.[currency] ? (prices[currency] as number) / 100 : 0,
    currency,
    graceUntil: sub.graceUntil?.toISOString() ?? null,
    pendingPlan: sub.pendingPlan ?? null,
    pendingPlanEffectiveAt: sub.pendingPlanEffectiveAt?.toISOString() ?? null,
  })
})

// ── Change plan (upgrade/downgrade) ──

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

  if (!sub?.razorpaySubscriptionId) {
    return c.json({ error: "No active subscription to change" }, 400)
  }
  if (sub.plan === newPlanId) {
    return c.json({ error: "Already on this plan" }, 400)
  }

  // Get new plan and its Razorpay plan ID
  const newPlan = await db.select().from(plans).where(eq(plans.id, newPlanId)).then((r) => r[0])
  if (!newPlan) return c.json({ error: "Plan not found" }, 404)

  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((r) => r[0])

  const currency = (bill?.currency ?? "INR") as SupportedCurrency
  const rzPlanIds = newPlan.razorpayPlanIds as Record<string, string> | null
  const rzPlanId = rzPlanIds?.[currency]
  if (!rzPlanId) return c.json({ error: `Plan not available in ${currency}` }, 400)

  // Determine direction
  const currentPlan = await db.select().from(plans).where(eq(plans.id, sub.plan)).then((r) => r[0])
  const currentPrice = (currentPlan?.prices as Record<string, number>)?.[currency] ?? 0
  const newPrice = (newPlan.prices as Record<string, number>)?.[currency] ?? 0
  const isUpgrade = newPrice > currentPrice

  // Call Razorpay
  try {
    await updateRazorpaySubscription({
      subscriptionId: sub.razorpaySubscriptionId,
      planId: rzPlanId,
      scheduleChangeAt: isUpgrade ? "now" : "cycle_end",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to change plan"
    return c.json({ error: message }, 500)
  }

  if (isUpgrade) {
    // Immediate: update subscription record now
    await db
      .update(subscriptions)
      .set({
        plan: newPlanId,
        pendingPlan: null,
        pendingPlanEffectiveAt: null,
      })
      .where(eq(subscriptions.id, sub.id))
  } else {
    // Downgrade: store pending, takes effect at cycle end
    const rzSub = await fetchRazorpaySubscription(sub.razorpaySubscriptionId)
    const effectiveAt = rzSub.current_end
      ? new Date(rzSub.current_end * 1000)
      : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1))

    await db
      .update(subscriptions)
      .set({
        pendingPlan: newPlanId,
        pendingPlanEffectiveAt: effectiveAt,
      })
      .where(eq(subscriptions.id, sub.id))
  }

  return c.json({
    success: true,
    direction: isUpgrade ? "upgrade" : "downgrade",
    newPlan: newPlanId,
    immediate: isUpgrade,
  })
})

// ── Cancel subscription (at end of billing cycle) ──

billingRoutes.post("/cancel-subscription", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (!sub?.razorpaySubscriptionId) {
    return c.json({ error: "No active subscription" }, 400)
  }

  try {
    await cancelRazorpaySubscriptionAtCycleEnd(sub.razorpaySubscriptionId)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel subscription"
    return c.json({ error: message }, 500)
  }

  // Fetch cycle end date from Razorpay
  const rzSub = await fetchRazorpaySubscription(sub.razorpaySubscriptionId)
  const endsAt = rzSub.current_end ? new Date(rzSub.current_end * 1000) : null

  return c.json({
    success: true,
    message: "Subscription will be cancelled at end of billing cycle.",
    endsAt: endsAt?.toISOString() ?? null,
  })
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
      amount: p.amountSmallest / 100, // display units
      currency: p.currency,
      status: p.status,
      timeCreated: p.timeCreated.toISOString(),
    })),
    page,
    limit,
  })
})
