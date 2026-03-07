import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "../db/client.ts"
import { billing, subscriptions, plans, payments, systemConfig } from "../db/schema.ts"
import { eq, and, isNull, desc, sql } from "drizzle-orm"
import { requireAuth, requireAdmin, type AuthContext } from "../middleware/auth.ts"
import { createCashfreeOrder, getCashfreeOrderStatus, createCashfreeSubscription, fetchCashfreeSubscription, manageCashfreeSubscription, checkSubscriptionPaymentMethods } from "../lib/cashfree.ts"
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

// ── Add credits (multi-currency Cashfree order) ──

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
  const orderId = `credits_${auth.workspaceId}_${Date.now()}`

  const order = await createCashfreeOrder({
    orderId,
    amount, // Cashfree takes display units (decimal)
    currency,
    customerEmail: auth.email,
    customerPhone: "9999999999", // placeholder — Cashfree requires phone
    customerId: auth.userId,
    notifyUrl: "https://api.creor.ai/api/webhooks/cashfree",
    notes: {
      workspaceId: auth.workspaceId,
      type: "credits",
      userId: auth.userId,
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
    cashfreeOrderId: orderId,
    status: "created",
  })

  return c.json({
    orderId,
    paymentSessionId: order.payment_session_id,
    amount,
    currency,
    symbol: SYMBOL[currency] ?? "$",
  })
})

// ── Verify payment and credit balance instantly ──

const verifyPaymentSchema = z.object({
  orderId: z.string(),
})

billingRoutes.post("/verify-payment", requireAdmin, zValidator("json", verifyPaymentSchema), async (c) => {
  const auth = c.get("auth")
  const { orderId } = c.req.valid("json")

  // Server-side verification: check order status with Cashfree
  const orderStatus = await getCashfreeOrderStatus(orderId)

  if (orderStatus.order_status !== "PAID") {
    return c.json({ error: `Payment not completed. Status: ${orderStatus.order_status}` }, 400)
  }

  // Update payment record
  await db
    .update(payments)
    .set({ cashfreePaymentId: `cf_${orderStatus.cf_order_id}`, status: "captured" })
    .where(eq(payments.cashfreeOrderId, orderId))

  // Credit balance from the payment record
  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.cashfreeOrderId, orderId))
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

  return c.json({ success: true, paymentId: orderStatus.cf_order_id })
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

  const prices = plan.prices as Record<string, number> | null
  const priceSmallest = prices?.[currency]
  if (!priceSmallest) {
    return c.json({ error: `Plan ${planId} not available in ${currency}` }, 400)
  }

  try {
    const prices = plan.prices as Record<string, number> | null
    const price = prices?.[currency] ? (prices[currency] as number) / 100 : 0

    const subscriptionId = `sub_${auth.workspaceId}_${Date.now()}`
    const subscription = await createCashfreeSubscription({
      subscriptionId,
      planName: `Creor ${plan.name} (${currency})`,
      planAmount: price,
      customerEmail: auth.email,
      customerPhone: "9999999999", // placeholder — Cashfree requires phone
      returnUrl: "https://creor.ai/dashboard/billing",
      currency,
      tags: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        plan: planId,
      },
    })

    return c.json({
      subscriptionId: subscription.subscription_id,
      paymentSessionId: subscription.subscription_session_id,
      plan: planId,
      price,
      currency,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cashfree subscription creation failed"
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
    .where(eq(subscriptions.cashfreeSubscriptionId, subscriptionId))
    .then((r) => r[0])

  if (existing && !existing.timeDeleted) {
    return c.json({ success: true, status: "already_active" })
  }

  // Verify with Cashfree that the subscription is actually active
  let cfSub: Awaited<ReturnType<typeof fetchCashfreeSubscription>>
  try {
    cfSub = await fetchCashfreeSubscription(subscriptionId)
  } catch {
    return c.json({ error: "Could not verify subscription with Cashfree" }, 400)
  }

  if (cfSub.subscription_status !== "ACTIVE") {
    return c.json({ error: `Subscription status is "${cfSub.subscription_status}", payment not completed` }, 400)
  }

  // Read plan from subscription tags
  const tags = cfSub.subscription_tags ?? {}
  const workspaceId = tags.workspaceId
  if (workspaceId && workspaceId !== auth.workspaceId) {
    return c.json({ error: "Subscription does not belong to this workspace" }, 403)
  }

  const planId = tags.plan as string | undefined
  if (!planId) {
    return c.json({ error: "Subscription missing plan info" }, 400)
  }

  // Create subscription record
  await db.insert(subscriptions).values({
    id: createId("sub"),
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    plan: planId as "starter" | "pro" | "team",
    cashfreeSubscriptionId: subscriptionId,
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
      cashfreeSubscriptionId: subscriptionId,
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
        cashfreePaymentId: `sub_upfront_${subscriptionId}`,
        status: "captured",
        metadata: { subscriptionId, plan: planId },
      })
    } catch {
      // Unique constraint on cashfree_payment_id — already recorded
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
  currency: z.enum(["USD", "INR"]),
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
//
// Upgrades: Cancel old subscription on Cashfree, create a NEW subscription
//           for the higher plan. Returns a checkout session so the user
//           completes payment + new mandate setup.
//
// Downgrades: Store as pending. Applied at next billing cycle
//             (handled by SUBSCRIPTION_PAYMENT_SUCCESS webhook).

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

  if (!sub?.cashfreeSubscriptionId) {
    return c.json({ error: "No active subscription to change" }, 400)
  }
  if (sub.plan === newPlanId) {
    return c.json({ error: "Already on this plan" }, 400)
  }

  // Get new plan
  const newPlan = await db.select().from(plans).where(eq(plans.id, newPlanId)).then((r) => r[0])
  if (!newPlan) return c.json({ error: "Plan not found" }, 404)

  const bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, auth.workspaceId))
    .then((r) => r[0])

  const currency = (bill?.currency ?? "INR") as SupportedCurrency

  // Determine direction
  const currentPlan = await db.select().from(plans).where(eq(plans.id, sub.plan)).then((r) => r[0])
  const currentPrice = (currentPlan?.prices as Record<string, number>)?.[currency] ?? 0
  const newPrice = (newPlan.prices as Record<string, number>)?.[currency] ?? 0
  const isUpgrade = newPrice > currentPrice

  // Check new plan has pricing for this currency
  const newPlanPrices = newPlan.prices as Record<string, number> | null
  if (!newPlanPrices?.[currency]) {
    return c.json({ error: `Plan ${newPlanId} not available in ${currency}` }, 400)
  }

  if (isUpgrade) {
    // ── UPGRADE: cancel old subscription, create new one ──
    // Cashfree mandates are capped at the original plan price,
    // so CHANGE_PLAN fails for higher amounts. Instead we cancel + re-subscribe.

    // 1. Cancel old subscription on Cashfree
    try {
      await manageCashfreeSubscription({
        subscriptionId: sub.cashfreeSubscriptionId,
        action: "CANCEL",
      })
    } catch {
      // Best effort — may already be cancelled or expired
    }

    // 2. Soft-delete old subscription in our DB
    await db
      .update(subscriptions)
      .set({ timeDeleted: new Date() })
      .where(eq(subscriptions.id, sub.id))

    await db
      .update(billing)
      .set({ cashfreeSubscriptionId: null, timeUpdated: new Date() })
      .where(eq(billing.workspaceId, auth.workspaceId))

    // 3. Create new subscription for the higher plan (same flow as /subscribe)
    const prices = newPlan.prices as Record<string, number> | null
    const price = prices?.[currency] ? (prices[currency] as number) / 100 : 0

    try {
      const subscriptionId = `sub_${auth.workspaceId}_${Date.now()}`
      const subscription = await createCashfreeSubscription({
        subscriptionId,
        planName: `Creor ${newPlan.name} (${currency})`,
        planAmount: price,
        customerEmail: auth.email,
        customerPhone: "9999999999",
        returnUrl: "https://creor.ai/dashboard/billing",
        currency,
        tags: {
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          plan: newPlanId,
        },
      })

      return c.json({
        success: true,
        direction: "upgrade" as const,
        newPlan: newPlanId,
        immediate: false,
        // Frontend must redirect to Cashfree checkout for the new subscription
        requiresCheckout: true,
        subscriptionId: subscription.subscription_id,
        paymentSessionId: subscription.subscription_session_id,
        price,
        currency,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Subscription creation failed"
      return c.json({ error: message }, 500)
    }
  } else {
    // ── DOWNGRADE: store pending, takes effect at cycle end ──
    const cfSub = await fetchCashfreeSubscription(sub.cashfreeSubscriptionId)
    const effectiveAt = cfSub.next_schedule_date
      ? new Date(cfSub.next_schedule_date)
      : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1))

    await db
      .update(subscriptions)
      .set({
        pendingPlan: newPlanId,
        pendingPlanEffectiveAt: effectiveAt,
      })
      .where(eq(subscriptions.id, sub.id))

    return c.json({
      success: true,
      direction: "downgrade" as const,
      newPlan: newPlanId,
      immediate: false,
      requiresCheckout: false,
    })
  }
})

// ── Cancel subscription ──

billingRoutes.post("/cancel-subscription", requireAdmin, async (c) => {
  const auth = c.get("auth")
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (!sub?.cashfreeSubscriptionId) {
    return c.json({ error: "No active subscription" }, 400)
  }

  // Fetch current period end before cancelling
  let endsAt: Date | null = null
  try {
    const cfSub = await fetchCashfreeSubscription(sub.cashfreeSubscriptionId)
    if (cfSub.next_schedule_date) {
      endsAt = new Date(cfSub.next_schedule_date)
    }
  } catch {
    // Best effort — continue with cancellation
  }

  try {
    await manageCashfreeSubscription({
      subscriptionId: sub.cashfreeSubscriptionId,
      action: "CANCEL",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel subscription"
    return c.json({ error: message }, 500)
  }

  // Set grace period until current cycle end
  if (endsAt) {
    await db
      .update(subscriptions)
      .set({ graceUntil: endsAt })
      .where(eq(subscriptions.id, sub.id))
  }

  return c.json({
    success: true,
    message: "Subscription cancelled. Access continues until end of current billing cycle.",
    endsAt: endsAt?.toISOString() ?? null,
  })
})

// ── Dev: reset subscription (for testing) ──

billingRoutes.post("/reset-subscription", requireAdmin, async (c) => {
  const auth = c.get("auth")

  // Cancel on Cashfree (best effort)
  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))
    .then((r) => r[0])

  if (sub?.cashfreeSubscriptionId) {
    try {
      await manageCashfreeSubscription({
        subscriptionId: sub.cashfreeSubscriptionId,
        action: "CANCEL",
      })
    } catch {
      // ignore — may already be cancelled
    }
  }

  // Soft-delete all subscriptions for this workspace
  await db
    .update(subscriptions)
    .set({ timeDeleted: new Date() })
    .where(and(eq(subscriptions.workspaceId, auth.workspaceId), isNull(subscriptions.timeDeleted)))

  // Clear subscription from billing record
  await db
    .update(billing)
    .set({ cashfreeSubscriptionId: null, timeUpdated: new Date() })
    .where(eq(billing.workspaceId, auth.workspaceId))

  // Delete all payment history for this workspace
  await db
    .delete(payments)
    .where(eq(payments.workspaceId, auth.workspaceId))

  return c.json({ success: true, message: "Subscription and payment history reset." })
})

// ── Dev: check eligible payment methods on Cashfree account ──

billingRoutes.get("/debug/payment-methods", requireAdmin, async (c) => {
  try {
    const methods = await checkSubscriptionPaymentMethods()
    return c.json({ methods })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to check" }, 500)
  }
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
