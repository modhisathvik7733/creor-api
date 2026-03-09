import { test, expect, describe } from "bun:test"
import {
  MICRO,
  SYMBOL,
  CURRENCY,
  microToDisplay,
  displayToMicro,
  microToSmallest,
  smallestToMicro,
} from "../src/lib/currency.ts"

describe("currency.ts (USD-only)", () => {
  describe("constants", () => {
    test("MICRO = 1_000_000", () => {
      expect(MICRO).toBe(1_000_000)
    })

    test("SYMBOL is $", () => {
      expect(SYMBOL).toBe("$")
    })

    test("CURRENCY is USD", () => {
      expect(CURRENCY).toBe("USD")
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
      expect(displayToMicro(1.999999)).toBe(1_999_999)
      expect(displayToMicro(0.1)).toBe(100_000)
    })
  })

  describe("microToSmallest", () => {
    test("converts micro-units to cents", () => {
      expect(microToSmallest(1_000_000)).toBe(100) // $1.00
      expect(microToSmallest(500_000)).toBe(50)     // $0.50
      expect(microToSmallest(25_500_000)).toBe(2550) // $25.50
    })

    test("rounds correctly", () => {
      expect(microToSmallest(15_000)).toBe(2) // rounds up
      expect(microToSmallest(5_000)).toBe(1)
    })
  })

  describe("smallestToMicro", () => {
    test("converts cents to micro-units", () => {
      expect(smallestToMicro(100)).toBe(1_000_000) // $1.00
      expect(smallestToMicro(50)).toBe(500_000)     // $0.50
      expect(smallestToMicro(2550)).toBe(25_500_000) // $25.50
    })

    test("roundtrip: microToSmallest → smallestToMicro", () => {
      const original = 5_000_000 // $5.00
      const smallest = microToSmallest(original)
      expect(smallest).toBe(500)
      expect(smallestToMicro(smallest)).toBe(original)
    })
  })

  describe("gateway cost calculation", () => {
    test("token cost in micro-units matches expected", () => {
      // 1000 input tokens + 500 output tokens on Claude Sonnet
      // Input: $0.003/1K, Output: $0.015/1K
      const inputTokens = 1000
      const outputTokens = 500
      const inputCost = 0.003
      const outputCost = 0.015

      const costUSD = (inputTokens * inputCost + outputTokens * outputCost) / 1000
      expect(costUSD).toBeCloseTo(0.0105, 4)

      const costMicro = Math.round(costUSD * MICRO)
      expect(costMicro).toBe(10_500)
      expect(microToDisplay(costMicro)).toBeCloseTo(0.0105, 4)
    })

    test("monthly limit comparison works", () => {
      // Plan limit: $6/month = 6_000_000 micro-units
      const planLimit = 6_000_000
      expect(microToDisplay(planLimit)).toBe(6)

      // Usage: $5.50 = 5_500_000 micro
      const usage = 5_500_000
      expect(usage < planLimit).toBe(true)
      expect(microToDisplay(planLimit - usage)).toBe(0.5)
    })
  })
})
