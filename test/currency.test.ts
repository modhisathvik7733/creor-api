import { test, expect, describe } from "bun:test"
import {
  MICRO,
  SYMBOL,
  microToDisplay,
  displayToMicro,
  microToSmallest,
  smallestToMicro,
  usdToWorkspaceMicro,
  isSupportedCurrency,
} from "../src/lib/currency.ts"

describe("currency.ts", () => {
  describe("constants", () => {
    test("MICRO = 1_000_000", () => {
      expect(MICRO).toBe(1_000_000)
    })

    test("SYMBOL map has all currencies", () => {
      expect(SYMBOL.USD).toBe("$")
      expect(SYMBOL.INR).toBe("₹")
      expect(SYMBOL.EUR).toBe("€")
    })
  })

  describe("microToDisplay", () => {
    test("converts micro-units to display value", () => {
      expect(microToDisplay(1_500_000)).toBe(1.5)
      expect(microToDisplay(1_000_000)).toBe(1)
      expect(microToDisplay(0)).toBe(0)
      expect(microToDisplay(500_000)).toBe(0.5)
    })

    test("handles large values", () => {
      expect(microToDisplay(25_500_000)).toBe(25.5)
      expect(microToDisplay(100_000_000)).toBe(100)
    })

    test("handles bigint input", () => {
      expect(microToDisplay(BigInt(1_500_000))).toBe(1.5)
    })
  })

  describe("displayToMicro", () => {
    test("converts display value to micro-units", () => {
      expect(displayToMicro(1.5)).toBe(1_500_000)
      expect(displayToMicro(1)).toBe(1_000_000)
      expect(displayToMicro(0)).toBe(0)
      expect(displayToMicro(0.5)).toBe(500_000)
    })

    test("rounds correctly", () => {
      // 1.999999 * 1M = 1999999
      expect(displayToMicro(1.999999)).toBe(1_999_999)
      // Floating point: 0.1 * 1M should round to 100000
      expect(displayToMicro(0.1)).toBe(100_000)
    })
  })

  describe("microToSmallest", () => {
    test("converts micro-units to smallest currency unit", () => {
      // 1 unit = 1M micro = 100 smallest → 1M / 10K = 100
      expect(microToSmallest(1_000_000)).toBe(100)
      // 0.50 unit = 500K micro = 50 smallest
      expect(microToSmallest(500_000)).toBe(50)
      // 25.50 INR = 25_500_000 micro = 2550 paise
      expect(microToSmallest(25_500_000)).toBe(2550)
    })

    test("rounds correctly", () => {
      expect(microToSmallest(15_000)).toBe(2) // 1.5 → rounds to 2
      expect(microToSmallest(5_000)).toBe(1)  // 0.5 → rounds to 1
    })
  })

  describe("smallestToMicro", () => {
    test("converts smallest unit to micro-units", () => {
      expect(smallestToMicro(100)).toBe(1_000_000) // $1.00 = 100 cents = 1M micro
      expect(smallestToMicro(50)).toBe(500_000)     // $0.50
      expect(smallestToMicro(2550)).toBe(25_500_000) // ₹25.50
    })

    test("roundtrip: microToSmallest → smallestToMicro", () => {
      const original = 5_000_000 // $5.00
      const smallest = microToSmallest(original)
      expect(smallest).toBe(500)
      expect(smallestToMicro(smallest)).toBe(original)
    })
  })

  describe("usdToWorkspaceMicro", () => {
    const rates = { USD: 1, INR: 85, EUR: 0.92 }

    test("USD → USD (rate 1)", () => {
      const result = usdToWorkspaceMicro(1.0, rates, "USD")
      expect(result).toBe(1_000_000)
    })

    test("USD → INR (rate 85)", () => {
      const result = usdToWorkspaceMicro(1.0, rates, "INR")
      expect(result).toBe(85_000_000)
    })

    test("USD → EUR (rate 0.92)", () => {
      const result = usdToWorkspaceMicro(1.0, rates, "EUR")
      expect(result).toBe(920_000)
    })

    test("small amounts don't lose precision", () => {
      // $0.003 (input cost per 1K tokens) → INR micro
      const result = usdToWorkspaceMicro(0.003, rates, "INR")
      // 0.003 * 85 * 1M = 255_000
      expect(result).toBe(255_000)
    })

    test("onboarding credits $0.30", () => {
      // USD workspace: $0.30
      expect(usdToWorkspaceMicro(0.30, rates, "USD")).toBe(300_000)
      // INR workspace: ₹25.50
      expect(usdToWorkspaceMicro(0.30, rates, "INR")).toBe(25_500_000)
      // EUR workspace: €0.276
      expect(usdToWorkspaceMicro(0.30, rates, "EUR")).toBe(276_000)
    })

    test("handles missing currency gracefully (fallback rate 1)", () => {
      // Unknown currency falls back to rate 1
      const result = usdToWorkspaceMicro(1.0, rates, "GBP" as any)
      expect(result).toBe(1_000_000)
    })
  })

  describe("isSupportedCurrency", () => {
    test("returns true for supported currencies", () => {
      expect(isSupportedCurrency("USD")).toBe(true)
      expect(isSupportedCurrency("INR")).toBe(true)
      expect(isSupportedCurrency("EUR")).toBe(true)
    })

    test("returns false for unsupported currencies", () => {
      expect(isSupportedCurrency("GBP")).toBe(false)
      expect(isSupportedCurrency("")).toBe(false)
      expect(isSupportedCurrency("usd")).toBe(false) // case-sensitive
    })
  })

  describe("conversion consistency", () => {
    test("gateway cost calculation matches expected", () => {
      // Simulate: 1000 input tokens + 500 output tokens on Claude Sonnet 4
      // Input: $0.003/1K, Output: $0.015/1K
      const inputTokens = 1000
      const outputTokens = 500
      const inputCost = 0.003 // USD per 1K
      const outputCost = 0.015

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      // = (3 + 7.5) / 1000 = 0.0105 USD
      expect(costUSD).toBeCloseTo(0.0105, 4)

      const rates = { USD: 1, INR: 85, EUR: 0.92 }

      // USD workspace: 0.0105 * 1 * 1M = 10,500
      const costMicroUSD = usdToWorkspaceMicro(costUSD, rates, "USD")
      expect(costMicroUSD).toBe(10_500)

      // INR workspace: 0.0105 * 85 * 1M = 892,500
      const costMicroINR = usdToWorkspaceMicro(costUSD, rates, "INR")
      expect(costMicroINR).toBe(892_500)

      // Display values
      expect(microToDisplay(costMicroUSD)).toBeCloseTo(0.0105, 4)
      expect(microToDisplay(costMicroINR)).toBeCloseTo(0.8925, 4)
    })

    test("monthly limit comparison works correctly", () => {
      // Plan limit: $6/month = 6_000_000 USD micro-units
      const planLimitUsdMicro = 6_000_000
      const rates = { USD: 1, INR: 85, EUR: 0.92 }

      // For INR workspace: limit = 6M * 85 = 510M INR micro-units = ₹510
      const inrLimit = Math.round(planLimitUsdMicro * rates.INR)
      expect(inrLimit).toBe(510_000_000)
      expect(microToDisplay(inrLimit)).toBe(510)

      // For USD workspace: limit = 6M * 1 = 6M = $6
      const usdLimit = Math.round(planLimitUsdMicro * rates.USD)
      expect(usdLimit).toBe(6_000_000)
      expect(microToDisplay(usdLimit)).toBe(6)
    })
  })
})
