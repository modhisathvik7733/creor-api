import { db } from "../db/client.ts"
import { billingLedger, billing } from "../db/schema.ts"
import { eq } from "drizzle-orm"
import { createId } from "./id.ts"

type LedgerType = "credit_purchase" | "usage_deduction" | "subscription_renewal" | "refund" | "adjustment" | "onboarding"

/**
 * Append an entry to the billing ledger.
 * Reads the current balance from the billing table for the balance_after snapshot.
 *
 * @param workspaceId - The workspace
 * @param type - The type of balance change
 * @param amountMicro - Positive for credits, negative for debits
 * @param referenceId - Reference to the source record (usage.id, payment.id, etc.)
 * @param metadata - Optional additional context
 */
export async function appendLedger(
  workspaceId: string,
  type: LedgerType,
  amountMicro: number,
  referenceId?: string,
  metadata?: Record<string, unknown>,
) {
  try {
    // Read current balance for the snapshot
    const bill = await db
      .select({ balance: billing.balance })
      .from(billing)
      .where(eq(billing.workspaceId, workspaceId))
      .then((rows) => rows[0])

    const balanceAfter = bill?.balance ?? 0

    await db.insert(billingLedger).values({
      id: createId("led"),
      workspaceId,
      type,
      amountMicro,
      balanceAfterMicro: balanceAfter,
      referenceId: referenceId ?? null,
      metadata: metadata ?? null,
    })
  } catch (err) {
    // Ledger writes should never block the main flow
    console.error("Failed to write billing ledger entry:", err)
  }
}
