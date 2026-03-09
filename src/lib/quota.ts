import { db } from "../db/client.ts"
import { billing, subscriptions, plans, systemConfig } from "../db/schema.ts"
import { eq, and, isNull } from "drizzle-orm"
import { createId } from "./id.ts"
import { MICRO, CURRENCY, SYMBOL, microToDisplay } from "./currency.ts"

export interface QuotaResult {
  balance: number
  currency: string
  symbol: string
  plan: { id: string; name: string; price: number | null }
  monthly: {
    current: number
    max: number | null
    remaining: number | null
    pct: number | null
    resetsAt: string
  }
  canSend: boolean
  blockReason: string | null
  warnings: string[]
  overageActive: boolean
  /** Internal: effective plan limit in micro-units (used by gateway) */
  _effectiveLimitMicro: number | null
  /** Internal: monthly usage in micro-units (used by gateway for error responses) */
  _monthlyUsageMicro: number
  /** Internal: raw balance in micro-units */
  _balanceMicro: number
}

/**
 * Ensure a billing record exists for a workspace.
 * Creates one if missing (for new workspaces or legacy accounts).
 */
export async function ensureBilling(workspaceId: string) {
  let bill = await db
    .select()
    .from(billing)
    .where(eq(billing.workspaceId, workspaceId))
    .then((rows) => rows[0])

  if (!bill) {
    await db.insert(billing).values({
      id: createId("bill"),
      workspaceId,
    }).onConflictDoNothing()
    bill = await db
      .select()
      .from(billing)
      .where(eq(billing.workspaceId, workspaceId))
      .then((rows) => rows[0])
  }

  return bill ?? null
}

/**
 * Check billing quota for a workspace.
 * Shared between JWT-authenticated routes and API-key-authenticated gateway.
 */
export async function checkQuota(workspaceId: string): Promise<QuotaResult> {
  const bill = await ensureBilling(workspaceId)

  if (!bill) {
    return {
      balance: 0,
      currency: CURRENCY,
      symbol: SYMBOL,
      plan: { id: "free", name: "Free", price: 0 },
      monthly: { current: 0, max: null, remaining: null, pct: null, resetsAt: "" },
      canSend: false,
      blockReason: "no_billing",
      warnings: [],
      overageActive: false,
      _effectiveLimitMicro: null,
      _monthlyUsageMicro: 0,
      _balanceMicro: 0,
    }
  }

  const sub = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), isNull(subscriptions.timeDeleted)))
    .then((rows) => rows[0])

  const hasSubscription = !!sub

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

  const planLimitMicro = userPlan?.monthlyLimit ?? 500000
  const workspaceLimitMicro = bill.monthlyLimit ? bill.monthlyLimit * MICRO : null
  const effectiveLimit = workspaceLimitMicro ?? planLimitMicro

  const overPlanLimit = effectiveLimit !== null && monthlyUsage >= effectiveLimit
  const hasCredits = bill.balance > 0

  let canSend = true
  let blockReason: string | null = null
  const warnings: string[] = []

  if (overPlanLimit && !hasCredits) {
    if (hasSubscription) {
      const overageUsed = monthlyUsage - effectiveLimit!
      const maxOverage = effectiveLimit!
      if (overageUsed >= maxOverage) {
        canSend = false
        blockReason = "overage_limit"
      } else {
        warnings.push("using_overage")
      }
    } else {
      canSend = false
      blockReason = "free_limit_no_credits"
    }
  }

  if (overPlanLimit && hasCredits) {
    warnings.push("using_credits")
  }

  if (effectiveLimit !== null && monthlyUsage > 0 && !overPlanLimit) {
    const pct = Math.round((monthlyUsage / effectiveLimit) * 100)
    if (pct >= 80) warnings.push("monthly_approaching")
  }

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

  // Warn about past_due subscription (payment failed, retrying)
  if (sub?.status === "past_due") {
    warnings.push("payment_failed")
  }

  const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  const prices = userPlan?.prices as Record<string, number> | null
  const planPrice = prices?.["USD"] ? (prices["USD"] as number) / 100 : null

  return {
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
    overageActive: overPlanLimit && (hasCredits || hasSubscription),
    _effectiveLimitMicro: effectiveLimit,
    _monthlyUsageMicro: monthlyUsage,
    _balanceMicro: bill.balance,
  }
}
