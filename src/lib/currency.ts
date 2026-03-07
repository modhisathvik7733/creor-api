/** Billing currency — USD only */
export type SupportedCurrency = "USD"

/** 1 unit of currency = 1,000,000 micro-units */
export const MICRO = 1_000_000

/** Display symbol */
export const SYMBOL = "$"
export const CURRENCY = "USD"

/** Convert micro-units to display value (e.g. 1500000 → 1.50) */
export const microToDisplay = (micro: bigint | number): number =>
  Number(micro) / MICRO

/** Convert display value to micro-units (e.g. 1.50 → 1500000) */
export const displayToMicro = (display: number): number =>
  Math.round(display * MICRO)

/**
 * Convert micro-units to smallest currency unit (cents).
 * 1 micro-unit = 1/1,000,000 of a unit.
 * 1 cent = 1/100 of a unit.
 * So: smallest = micro / 10,000.
 */
export const microToSmallest = (micro: bigint | number): number =>
  Math.round(Number(micro) / 10_000)

/** Convert smallest currency unit (cents) to micro-units */
export const smallestToMicro = (smallest: number): number =>
  smallest * 10_000
