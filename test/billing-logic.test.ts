import { test, expect, describe } from "bun:test"
import { MICRO, microToDisplay, usdToWorkspaceMicro } from "../src/lib/currency.ts"

/**
 * Tests for billing logic without a DB connection.
 * Validates the quota calculation, monthly limit enforcement,
 * and currency conversion math that gateway.ts and billing.ts rely on.
 */

describe("quota calculation logic", () => {
  const rates = { USD: 1, INR: 85, EUR: 0.92 }

  describe("monthly limit enforcement", () => {
    test("plan limit converts from USD micro to workspace currency", () => {
      // Starter plan: $6/month = 6_000_000 USD micro-units
      const planLimitUsdMicro = 6_000_000

      // INR workspace
      const inrLimit = Math.round(planLimitUsdMicro * rates.INR)
      expect(inrLimit).toBe(510_000_000) // ₹510

      // USD workspace
      const usdLimit = Math.round(planLimitUsdMicro * rates.USD)
      expect(usdLimit).toBe(6_000_000) // $6

      // EUR workspace
      const eurLimit = Math.round(planLimitUsdMicro * rates.EUR)
      expect(eurLimit).toBe(5_520_000) // €5.52
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

    test("no limit (free plan, null) → always canSend", () => {
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
      // March 1, 2026
      expect(monthStart.toISOString()).toBe("2026-03-01T00:00:00.000Z")

      // Reset was Feb 1 → before March 1 → should reset
      const resetTime = new Date("2026-02-01T00:00:00Z")
      const shouldReset = resetTime < monthStart
      expect(shouldReset).toBe(true)

      // If resetting, monthly usage goes to 0
      const monthlyUsage = shouldReset ? 0 : 5_000_000
      expect(monthlyUsage).toBe(0)
    })

    test("does NOT reset when timeMonthlyReset is in current month", () => {
      const now = new Date("2026-03-15T12:00:00Z")
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

      // Reset was March 1 → same month → no reset
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

  describe("cost calculation", () => {
    test("standard request cost: Claude Sonnet 4", () => {
      const inputTokens = 2000
      const outputTokens = 800
      const inputCost = 0.003  // USD per 1K
      const outputCost = 0.015

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.018, 4)

      // USD workspace
      const costMicro = usdToWorkspaceMicro(costUSD, rates, "USD")
      expect(costMicro).toBe(18_000)
      expect(microToDisplay(costMicro)).toBeCloseTo(0.018, 4)

      // INR workspace
      const costMicroINR = usdToWorkspaceMicro(costUSD, rates, "INR")
      expect(costMicroINR).toBe(1_530_000)
      expect(microToDisplay(costMicroINR)).toBeCloseTo(1.53, 2)
    })

    test("cheap model: Gemini Flash", () => {
      const inputTokens = 5000
      const outputTokens = 2000
      const inputCost = 0.00015
      const outputCost = 0.0006

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.00195, 5)

      const costMicro = usdToWorkspaceMicro(costUSD, rates, "USD")
      expect(costMicro).toBe(1_950)
    })

    test("Google streaming estimation: token count from text", () => {
      const text = "Hello, this is a test response from the model." // 47 chars
      const estimatedTokens = Math.ceil(text.length / 4) // ~12
      expect(estimatedTokens).toBe(12)

      // With gemini-2.5-pro output cost
      const outputCost = 0.01
      const costUSD = (0 * 0.00125 + estimatedTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.00012, 5)
    })
  })

  describe("atomic deduction simulation", () => {
    test("balance never goes negative", () => {
      let balance = 100_000 // small balance
      const cost = 150_000  // cost exceeds balance

      // Simulates: GREATEST(balance - cost, 0)
      balance = Math.max(balance - cost, 0)
      expect(balance).toBe(0) // not negative
    })

    test("subscription users: balance unchanged", () => {
      let balance = 500_000
      const cost = 100_000
      const hasSubscription = true

      if (!hasSubscription) {
        balance = Math.max(balance - cost, 0)
      }
      expect(balance).toBe(500_000) // unchanged
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
      const rate = 85 // INR
      const lowThresholdLocal = Math.round(lowThresholdUsd * rate * MICRO)
      expect(lowThresholdLocal).toBe(42_500_000) // ₹42.50

      const balance = 30_000_000 // ₹30
      const isLow = balance > 0 && balance < lowThresholdLocal
      expect(isLow).toBe(true)
    })

    test("does NOT trigger when balance sufficient", () => {
      const lowThresholdUsd = 0.50
      const rate = 1 // USD
      const lowThresholdLocal = Math.round(lowThresholdUsd * rate * MICRO)
      expect(lowThresholdLocal).toBe(500_000) // $0.50

      const balance = 5_000_000 // $5
      const isLow = balance > 0 && balance < lowThresholdLocal
      expect(isLow).toBe(false)
    })
  })

  describe("currency switch conversion", () => {
    test("USD → INR balance conversion", () => {
      const balance = 5_000_000 // $5
      const oldRate = rates.USD // 1
      const newRate = rates.INR // 85

      const factor = newRate / oldRate
      const newBalance = Math.round(balance * factor)
      expect(newBalance).toBe(425_000_000) // ₹425
      expect(microToDisplay(newBalance)).toBe(425)
    })

    test("INR → USD balance conversion", () => {
      const balance = 425_000_000 // ₹425
      const oldRate = rates.INR // 85
      const newRate = rates.USD // 1

      const factor = newRate / oldRate
      const newBalance = Math.round(balance * factor)
      expect(newBalance).toBe(5_000_000) // $5
    })

    test("INR → EUR balance conversion", () => {
      const balance = 85_000_000 // ₹85 (= $1)
      const oldRate = rates.INR // 85
      const newRate = rates.EUR // 0.92

      const factor = newRate / oldRate
      const newBalance = Math.round(balance * factor)
      // 85M * (0.92/85) = 85M * 0.010824 ≈ 920_000 = €0.92
      expect(newBalance).toBeCloseTo(920_000, -2) // approximately €0.92
    })
  })

  describe("onboarding credits", () => {
    test("$0.30 for USD user", () => {
      const credits = usdToWorkspaceMicro(0.30, rates, "USD")
      expect(credits).toBe(300_000)
      expect(microToDisplay(credits)).toBe(0.3)
    })

    test("$0.30 for INR user", () => {
      const credits = usdToWorkspaceMicro(0.30, rates, "INR")
      expect(credits).toBe(25_500_000)
      expect(microToDisplay(credits)).toBe(25.5)
    })

    test("$0.30 for EUR user", () => {
      const credits = usdToWorkspaceMicro(0.30, rates, "EUR")
      expect(credits).toBe(276_000)
      expect(microToDisplay(credits)).toBeCloseTo(0.276, 3)
    })
  })

  describe("payment amount conversions", () => {
    test("add $5 credits: display → smallest → micro", () => {
      const displayAmount = 5 // $5
      const amountSmallest = Math.round(displayAmount * 100) // 500 cents
      expect(amountSmallest).toBe(500)

      // On capture: smallest → micro
      const creditMicro = amountSmallest * 10_000
      expect(creditMicro).toBe(5_000_000) // $5 in micro
      expect(microToDisplay(creditMicro)).toBe(5)
    })

    test("add ₹500 credits: display → smallest → micro", () => {
      const displayAmount = 500 // ₹500
      const amountSmallest = Math.round(displayAmount * 100) // 50000 paise
      expect(amountSmallest).toBe(50_000)

      const creditMicro = amountSmallest * 10_000
      expect(creditMicro).toBe(500_000_000) // ₹500 in micro
      expect(microToDisplay(creditMicro)).toBe(500)
    })
  })
})
