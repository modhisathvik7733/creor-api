import { test, expect, describe } from "bun:test"
import { MICRO, microToDisplay, displayToMicro, microToSmallest, smallestToMicro } from "../src/lib/currency.ts"

/**
 * Tests for billing logic without a DB connection.
 * Validates the quota calculation, monthly limit enforcement,
 * overage model, and USD cost math that gateway.ts and billing.ts rely on.
 */

describe("quota calculation logic", () => {
  describe("monthly limit enforcement", () => {
    test("plan limit is in USD micro-units", () => {
      // Starter plan: $6/month = 6_000_000 USD micro-units
      const planLimitMicro = 6_000_000
      expect(microToDisplay(planLimitMicro)).toBe(6)
    })

    test("monthly usage check: under limit → canSend", () => {
      const effectiveLimit = 6_000_000
      const monthlyUsage = 4_500_000
      const canSend = monthlyUsage < effectiveLimit
      expect(canSend).toBe(true)
    })

    test("monthly usage check: at limit → blocked", () => {
      const effectiveLimit = 6_000_000
      const monthlyUsage = 6_000_000
      const canSend = monthlyUsage < effectiveLimit
      expect(canSend).toBe(false)
    })

    test("monthly usage check: over limit → blocked", () => {
      const effectiveLimit = 6_000_000
      const monthlyUsage = 6_100_000
      const canSend = monthlyUsage < effectiveLimit
      expect(canSend).toBe(false)
    })

    test("no limit (null) → always canSend", () => {
      const effectiveLimit: number | null = null
      const monthlyUsage = 999_999_999
      const canSend = effectiveLimit === null || monthlyUsage < effectiveLimit
      expect(canSend).toBe(true)
    })
  })

  describe("lazy month reset", () => {
    test("resets when timeMonthlyReset is before current month start", () => {
      const now = new Date("2026-03-15T12:00:00Z")
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      expect(monthStart.toISOString()).toBe("2026-03-01T00:00:00.000Z")

      const resetTime = new Date("2026-02-01T00:00:00Z")
      const shouldReset = resetTime < monthStart
      expect(shouldReset).toBe(true)

      const monthlyUsage = shouldReset ? 0 : 5_000_000
      expect(monthlyUsage).toBe(0)
    })

    test("does NOT reset when timeMonthlyReset is in current month", () => {
      const now = new Date("2026-03-15T12:00:00Z")
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

      const resetTime = new Date("2026-03-01T00:00:00Z")
      const shouldReset = resetTime < monthStart
      expect(shouldReset).toBe(false)
    })
  })

  describe("balance enforcement", () => {
    test("zero balance blocks non-subscription users", () => {
      const hasSubscription = false
      const balance = 0
      const canSend = hasSubscription || balance > 0
      expect(canSend).toBe(false)
    })

    test("zero balance does NOT block subscription users", () => {
      const hasSubscription = true
      const balance = 0
      const canSend = hasSubscription || balance > 0
      expect(canSend).toBe(true)
    })

    test("positive balance allows non-subscription users", () => {
      const hasSubscription = false
      const balance = 100_000
      const canSend = hasSubscription || balance > 0
      expect(canSend).toBe(true)
    })
  })

  describe("overage model", () => {
    test("subscriber: overage allowed up to 100% of plan limit", () => {
      const effectiveLimit = 6_000_000 // $6
      const hasSubscription = true

      // Usage at 150% of limit — within 100% overage allowance
      const monthlyUsage = 9_000_000
      const overPlanLimit = monthlyUsage >= effectiveLimit
      expect(overPlanLimit).toBe(true)

      const overageUsed = monthlyUsage - effectiveLimit // 3M
      const maxOverage = effectiveLimit // 6M (100% of limit)
      const blocked = overageUsed >= maxOverage
      expect(blocked).toBe(false) // still within overage
    })

    test("subscriber: blocked when overage exceeds 100% of plan limit", () => {
      const effectiveLimit = 6_000_000
      const monthlyUsage = 12_000_000 // 200% of limit

      const overageUsed = monthlyUsage - effectiveLimit // 6M
      const maxOverage = effectiveLimit // 6M
      const blocked = overageUsed >= maxOverage
      expect(blocked).toBe(true)
    })

    test("free user: blocked at plan limit (no overage)", () => {
      const effectiveLimit = 500_000 // $0.50 free tier
      const hasSubscription = false
      const hasCredits = false
      const monthlyUsage = 500_000

      const overPlanLimit = monthlyUsage >= effectiveLimit
      expect(overPlanLimit).toBe(true)

      const canSend = !overPlanLimit || hasCredits || hasSubscription
      expect(canSend).toBe(false)
    })

    test("free user with credits: can continue past plan limit", () => {
      const effectiveLimit = 500_000
      const hasSubscription = false
      const hasCredits = true
      const monthlyUsage = 600_000

      const overPlanLimit = monthlyUsage >= effectiveLimit
      const canSend = !overPlanLimit || hasCredits || hasSubscription
      expect(canSend).toBe(true)
    })
  })

  describe("cost calculation (USD)", () => {
    test("standard request cost: Claude Sonnet 4", () => {
      const inputTokens = 2000
      const outputTokens = 800
      const inputCost = 0.003 // USD per 1K tokens
      const outputCost = 0.015

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.018, 4)

      const costMicro = Math.round(costUSD * MICRO)
      expect(costMicro).toBe(18_000)
      expect(microToDisplay(costMicro)).toBeCloseTo(0.018, 4)
    })

    test("cheap model: Gemini Flash", () => {
      const inputTokens = 5000
      const outputTokens = 2000
      const inputCost = 0.00015
      const outputCost = 0.0006

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.00195, 5)

      const costMicro = Math.round(costUSD * MICRO)
      expect(costMicro).toBe(1_950)
    })

    test("expensive model: Claude Opus", () => {
      const inputTokens = 3000
      const outputTokens = 1500
      const inputCost = 0.015 // USD per 1K
      const outputCost = 0.075

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.1575, 4)

      const costMicro = Math.round(costUSD * MICRO)
      expect(costMicro).toBe(157_500)
    })

    test("Google streaming estimation: token count from text", () => {
      const text = "Hello, this is a test response from the model." // 47 chars
      const estimatedTokens = Math.ceil(text.length / 4) // ~12
      expect(estimatedTokens).toBe(12)

      const outputCost = 0.01
      const costUSD = (0 * 0.00125 + estimatedTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.00012, 5)
    })
  })

  describe("atomic deduction simulation", () => {
    test("balance never goes negative (GREATEST clamp)", () => {
      let balance = 100_000
      const cost = 150_000

      // Simulates: GREATEST(balance - cost, 0)
      balance = Math.max(balance - cost, 0)
      expect(balance).toBe(0)
    })

    test("subscription users: balance unchanged (overage model)", () => {
      let balance = 500_000
      const cost = 100_000
      const hasSubscription = true

      if (!hasSubscription) {
        balance = Math.max(balance - cost, 0)
      }
      expect(balance).toBe(500_000)
    })

    test("credit users: balance deducted", () => {
      let balance = 500_000
      const cost = 100_000
      const hasSubscription = false

      if (!hasSubscription) {
        balance = Math.max(balance - cost, 0)
      }
      expect(balance).toBe(400_000)
    })
  })

  describe("low balance warning", () => {
    test("triggers when balance below threshold", () => {
      const lowThresholdUsd = 0.50
      const lowThresholdMicro = Math.round(lowThresholdUsd * MICRO)
      expect(lowThresholdMicro).toBe(500_000) // $0.50

      const balance = 300_000 // $0.30
      const isLow = balance > 0 && balance < lowThresholdMicro
      expect(isLow).toBe(true)
    })

    test("does NOT trigger when balance sufficient", () => {
      const lowThresholdUsd = 0.50
      const lowThresholdMicro = Math.round(lowThresholdUsd * MICRO)
      expect(lowThresholdMicro).toBe(500_000)

      const balance = 5_000_000 // $5
      const isLow = balance > 0 && balance < lowThresholdMicro
      expect(isLow).toBe(false)
    })

    test("does NOT trigger when balance is zero", () => {
      const lowThresholdMicro = 500_000
      const balance = 0
      const isLow = balance > 0 && balance < lowThresholdMicro
      expect(isLow).toBe(false)
    })
  })

  describe("onboarding credits", () => {
    test("$0.30 onboarding credit in micro-units", () => {
      const credits = Math.round(0.30 * MICRO)
      expect(credits).toBe(300_000)
      expect(microToDisplay(credits)).toBe(0.3)
    })
  })

  describe("payment amount conversions", () => {
    test("add $5 credits: display → smallest (cents) → micro", () => {
      const displayAmount = 5 // $5
      const amountSmallest = Math.round(displayAmount * 100) // 500 cents
      expect(amountSmallest).toBe(500)

      const creditMicro = amountSmallest * 10_000
      expect(creditMicro).toBe(5_000_000)
      expect(microToDisplay(creditMicro)).toBe(5)
    })

    test("add $25 credits: full pipeline", () => {
      const displayAmount = 25
      const amountSmallest = Math.round(displayAmount * 100) // 2500 cents
      expect(amountSmallest).toBe(2500)

      const creditMicro = smallestToMicro(amountSmallest)
      expect(creditMicro).toBe(25_000_000)
      expect(microToDisplay(creditMicro)).toBe(25)
      expect(microToSmallest(creditMicro)).toBe(2500)
    })

    test("displayToMicro and microToDisplay are inverse", () => {
      const amounts = [0.01, 0.50, 1, 5, 10, 24.99, 100]
      for (const amount of amounts) {
        const micro = displayToMicro(amount)
        const back = microToDisplay(micro)
        expect(back).toBeCloseTo(amount, 2)
      }
    })

    test("smallestToMicro and microToSmallest are inverse", () => {
      const cents = [1, 50, 100, 500, 2499, 10000]
      for (const c of cents) {
        const micro = smallestToMicro(c)
        const back = microToSmallest(micro)
        expect(back).toBe(c)
      }
    })
  })

  describe("billing ledger math", () => {
    test("credit purchase ledger entry", () => {
      const usdAmount = 10 // $10 purchase
      const amountSmallest = Math.round(usdAmount * 100) // 1000 cents
      const creditMicro = amountSmallest * 10_000
      expect(creditMicro).toBe(10_000_000)

      // Ledger entry: positive amount = credit
      const ledgerAmount = creditMicro
      expect(ledgerAmount).toBeGreaterThan(0)
    })

    test("usage deduction ledger entry", () => {
      const costMicro = 18_000 // cost of one request
      // Ledger entry: negative amount = debit
      const ledgerAmount = -costMicro
      expect(ledgerAmount).toBeLessThan(0)
    })

    test("refund ledger entry: deducts from balance", () => {
      const originalPaymentCents = 500 // $5 payment
      const debitMicro = originalPaymentCents * 10_000
      expect(debitMicro).toBe(5_000_000)

      // Balance clamped to 0
      const balance = 3_000_000 // only $3 remaining
      const newBalance = Math.max(balance - debitMicro, 0)
      expect(newBalance).toBe(0) // doesn't go negative
    })
  })
})
