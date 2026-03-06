/** Supported billing currencies */
export type SupportedCurrency = "USD" | "INR" | "EUR"

/** 1 unit of currency = 1,000,000 micro-units */
export const MICRO = 1_000_000

/** Currency display symbols */
export const SYMBOL: Record<SupportedCurrency, string> = {
  USD: "$",
  INR: "₹",
  EUR: "€",
}

/** Convert micro-units to display value (e.g. 1500000 → 1.50) */
export const microToDisplay = (micro: bigint | number): number =>
  Number(micro) / MICRO

/** Convert display value to micro-units (e.g. 1.50 → 1500000) */
export const displayToMicro = (display: number): number =>
  Math.round(display * MICRO)

/**
 * Convert micro-units to smallest currency unit (cents/paise).
 * 1 micro-unit = 1/1,000,000 of a unit.
 * 1 smallest unit = 1/100 of a unit.
 * So: smallest = micro / 10,000.
 */
export const microToSmallest = (micro: bigint | number): number =>
  Math.round(Number(micro) / 10_000)

/** Convert smallest currency unit (cents/paise) to micro-units */
export const smallestToMicro = (smallest: number): number =>
  smallest * 10_000

/** Convert a USD cost to workspace micro-units using exchange rates */
export function usdToWorkspaceMicro(
  usd: number,
  rates: Record<string, number>,
  currency: SupportedCurrency,
): number {
  const rate = rates[currency] ?? 1
  return Math.round(usd * rate * MICRO)
}

/** Check if a currency string is a supported currency */
export function isSupportedCurrency(c: string): c is SupportedCurrency {
  return c === "USD" || c === "INR" || c === "EUR"
}
