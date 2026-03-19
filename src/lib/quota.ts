import { db } from "../db/client.ts"
import { billing, subscriptions, plans, systemConfig } from "../db/schema.ts"
import { eq, and, isNull, sql } from "drizzle-orm"
import { createId } from "./id.ts"
import { MICRO, CURRENCY, SYMBOL, microToDisplay } from "./currency.ts"
import { getCreditSummary } from "./ledger.ts"

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
  /** Credit activity for the current billing month (null on fast-path) */
  credits: {
    added: number
    spent: number
    balance: number
  } | null
  /** Custom workspace spend limit in whole USD (null = using plan default) */
  spendLimit: number | null
  /** Plan's default monthly limit in display USD */
  planLimit: number | null
  /** Internal: effective plan limit in micro-units (used by gateway) */
  _effectiveLimitMicro: number | null
  /** Internal: monthly usage in micro-units (used by gateway for error responses) */
  _monthlyUsageMicro: number
  /** Internal: raw balance in micro-units */
  _balanceMicro: number
  /** Whether extra usage (credit spending beyond plan limit) is enabled */
  extraUsageEnabled: boolean
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
      credits: null,
      spendLimit: null,
      planLimit: null,
      _effectiveLimitMicro: null,
      _monthlyUsageMicro: 0,
      _balanceMicro: 0,
      extraUsageEnabled: false,
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

  const hasCredits = bill.balance > 0
  const extraUsageEnabled = bill.extraUsageEnabled ?? false
  const canUseCredits = hasCredits && extraUsageEnabled

  // Two thresholds:
  // - planLimitMicro: the plan's included usage (block here when extra usage OFF)
  // - effectiveLimit: the spend limit cap (block here when extra usage ON, uses credits for overage)
  const overPlanIncluded = monthlyUsage >= planLimitMicro
  const overSpendLimit = effectiveLimit !== null && monthlyUsage >= effectiveLimit

  let canSend = true
  let blockReason: string | null = null
  const warnings: string[] = []

  if (overPlanIncluded && !canUseCredits) {
    // Over plan's included usage and can't use credits → block
    canSend = false
    if (!hasSubscription && !hasCredits) {
      blockReason = "free_limit_no_credits"
    } else if (!extraUsageEnabled) {
      blockReason = "extra_usage_disabled"
    } else {
      // extraUsageEnabled but no credits
      blockReason = "no_credits"
    }
  } else if (overSpendLimit && canUseCredits) {
    // Over the spend limit cap even with credits → block
    canSend = false
    blockReason = "overage_limit"
  }

  if (overPlanIncluded && canUseCredits && !overSpendLimit) {
    warnings.push("using_credits")
  }

  if (planLimitMicro > 0 && monthlyUsage > 0 && !overPlanIncluded) {
    const pct = Math.round((monthlyUsage / planLimitMicro) * 100)
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

  // Credit activity for current month
  const creditSummary = await getCreditSummary(workspaceId)

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
    overageActive: overPlanIncluded && canUseCredits,
    credits: {
      added: microToDisplay(creditSummary.addedMicro),
      spent: microToDisplay(creditSummary.spentMicro),
      balance: microToDisplay(bill.balance),
    },
    spendLimit: bill.monthlyLimit ?? null,
    planLimit: microToDisplay(planLimitMicro),
    _effectiveLimitMicro: effectiveLimit,
    _monthlyUsageMicro: monthlyUsage,
    _balanceMicro: bill.balance,
    extraUsageEnabled,
  }
}

// ── Quota cache (10s TTL, keyed by workspaceId) ──
const quotaCache = new Map<string, { result: QuotaResult; expires: number }>()
const QUOTA_TTL = 10_000 // 10 seconds

/**
 * Fast-path quota check for the gateway hot path.
 * Uses a single SQL query instead of 4 sequential ones.
 * Cached for 10s per workspace to avoid redundant DB hits during rapid tool call sequences.
 */
export async function checkQuotaFast(workspaceId: string): Promise<QuotaResult> {
  const cached = quotaCache.get(workspaceId)
  if (cached && Date.now() < cached.expires) return cached.result

  const rows = await db.execute(sql`
    SELECT
      b.balance,
      b.monthly_usage,
      b.monthly_limit AS workspace_limit,
      b.time_monthly_reset,
      s.id AS sub_id,
      s.plan AS sub_plan,
      s.status AS sub_status,
      p.id AS plan_id,
      p.name AS plan_name,
      p.prices AS plan_prices,
      p.monthly_limit AS plan_monthly_limit,
      b.extra_usage_enabled
    FROM billing b
    LEFT JOIN subscriptions s
      ON s.workspace_id = b.workspace_id AND s.time_deleted IS NULL
    LEFT JOIN plans p
      ON p.id = COALESCE(s.plan, 'free')
    WHERE b.workspace_id = ${workspaceId}
    LIMIT 1
  `)

  const row = rows[0]
  if (!row) {
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
      credits: null,
      spendLimit: null,
      planLimit: null,
      _effectiveLimitMicro: null,
      _monthlyUsageMicro: 0,
      _balanceMicro: 0,
      extraUsageEnabled: false,
    }
  }

  const balance = Number(row.balance ?? 0)
  const extraUsageEnabled = Boolean(row.extra_usage_enabled)
  const hasSubscription = !!row.sub_id
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const resetTime = row.time_monthly_reset ? new Date(row.time_monthly_reset as string) : null
  const monthlyUsage = resetTime && resetTime < monthStart ? 0 : Number(row.monthly_usage ?? 0)

  const planLimitMicro = Number(row.plan_monthly_limit ?? 500000)
  const workspaceLimitMicro = row.workspace_limit ? Number(row.workspace_limit) * MICRO : null
  const effectiveLimit = workspaceLimitMicro ?? planLimitMicro

  const hasCredits = balance > 0
  const canUseCredits = hasCredits && extraUsageEnabled

  // Two thresholds:
  // - planLimitMicro: the plan's included usage (block here when extra usage OFF)
  // - effectiveLimit: the spend limit cap (block here when extra usage ON, uses credits for overage)
  const overPlanIncluded = monthlyUsage >= planLimitMicro
  const overSpendLimit = effectiveLimit !== null && monthlyUsage >= effectiveLimit

  let canSend = true
  let blockReason: string | null = null
  const warnings: string[] = []

  if (overPlanIncluded && !canUseCredits) {
    // Over plan's included usage and can't use credits → block
    canSend = false
    if (!hasSubscription && !hasCredits) {
      blockReason = "free_limit_no_credits"
    } else if (!extraUsageEnabled) {
      blockReason = "extra_usage_disabled"
    } else {
      // extraUsageEnabled but no credits
      blockReason = "no_credits"
    }
  } else if (overSpendLimit && canUseCredits) {
    // Over the spend limit cap even with credits → block
    canSend = false
    blockReason = "overage_limit"
  }

  if (overPlanIncluded && canUseCredits && !overSpendLimit) {
    warnings.push("using_credits")
  }

  if (row.sub_status === "past_due") {
    warnings.push("payment_failed")
  }

  const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const prices = row.plan_prices as Record<string, number> | null
  const planPrice = prices?.["USD"] ? (prices["USD"] as number) / 100 : null

  const result: QuotaResult = {
    balance: microToDisplay(balance),
    currency: CURRENCY,
    symbol: SYMBOL,
    plan: row.plan_id
      ? { id: row.plan_id as string, name: row.plan_name as string, price: planPrice }
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
    overageActive: overPlanIncluded && canUseCredits,
    credits: null, // Skipped on fast path to avoid extra query
    spendLimit: null,
    planLimit: null,
    _effectiveLimitMicro: effectiveLimit,
    _monthlyUsageMicro: monthlyUsage,
    _balanceMicro: balance,
    extraUsageEnabled,
  }

  quotaCache.set(workspaceId, { result, expires: Date.now() + QUOTA_TTL })
  return result
}
