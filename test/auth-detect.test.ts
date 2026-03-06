import { test, expect, describe } from "bun:test"
import type { SupportedCurrency } from "../src/lib/currency.ts"

/**
 * Tests for currency detection from Accept-Language header.
 * This mirrors the detectCurrency() function in auth.ts.
 */

function detectCurrency(acceptLanguage: string | undefined): SupportedCurrency {
  if (!acceptLanguage) return "USD"
  const lang = acceptLanguage.toLowerCase()
  if (lang.includes("hi") || lang.includes("en-in") || lang.includes("ta") || lang.includes("te") || lang.includes("mr")) {
    return "INR"
  }
  if (lang.includes("de") || lang.includes("fr") || lang.includes("es") || lang.includes("it") || lang.includes("nl") || lang.includes("pt")) {
    return "EUR"
  }
  return "USD"
}

describe("detectCurrency", () => {
  describe("INR detection", () => {
    test("Hindi locale", () => {
      expect(detectCurrency("hi-IN,hi;q=0.9,en;q=0.8")).toBe("INR")
    })

    test("English India locale", () => {
      expect(detectCurrency("en-IN,en;q=0.9")).toBe("INR")
    })

    test("Tamil locale", () => {
      expect(detectCurrency("ta-IN,ta;q=0.9")).toBe("INR")
    })

    test("Telugu locale", () => {
      expect(detectCurrency("te-IN,te;q=0.9")).toBe("INR")
    })

    test("Marathi locale", () => {
      expect(detectCurrency("mr-IN,mr;q=0.9")).toBe("INR")
    })
  })

  describe("EUR detection", () => {
    test("German locale", () => {
      expect(detectCurrency("de-DE,de;q=0.9")).toBe("EUR")
    })

    test("French locale", () => {
      expect(detectCurrency("fr-FR,fr;q=0.9")).toBe("EUR")
    })

    test("Spanish locale", () => {
      expect(detectCurrency("es-ES,es;q=0.9")).toBe("EUR")
    })

    test("Italian locale", () => {
      expect(detectCurrency("it-IT,it;q=0.9")).toBe("EUR")
    })

    test("Dutch locale", () => {
      expect(detectCurrency("nl-NL,nl;q=0.9")).toBe("EUR")
    })

    test("Portuguese locale", () => {
      expect(detectCurrency("pt-PT,pt;q=0.9")).toBe("EUR")
    })
  })

  describe("USD default", () => {
    test("English US locale", () => {
      expect(detectCurrency("en-US,en;q=0.9")).toBe("USD")
    })

    test("English UK locale (not EUR)", () => {
      expect(detectCurrency("en-GB,en;q=0.9")).toBe("USD")
    })

    test("Japanese locale", () => {
      expect(detectCurrency("ja-JP,ja;q=0.9")).toBe("USD")
    })

    test("Korean locale", () => {
      expect(detectCurrency("ko-KR,ko;q=0.9")).toBe("USD")
    })

    test("Chinese locale", () => {
      expect(detectCurrency("zh-CN,zh;q=0.9")).toBe("USD")
    })

    test("undefined header", () => {
      expect(detectCurrency(undefined)).toBe("USD")
    })

    test("empty string", () => {
      expect(detectCurrency("")).toBe("USD")
    })
  })

  describe("priority (INR before EUR)", () => {
    test("mixed Hindi + French → INR wins", () => {
      // Hindi checked first
      expect(detectCurrency("hi,fr;q=0.8")).toBe("INR")
    })
  })
})
