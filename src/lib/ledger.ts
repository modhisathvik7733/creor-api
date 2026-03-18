import { db } from "../db/client.ts"
import { billingLedger, billing } from "../db/schema.ts"
import { eq, sql } from "drizzle-orm"
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

/**
 * Get credit activity summary for the current billing month.
 * Returns total credits added (purchases) and credits spent (usage deductions).
 */
export async function getCreditSummary(workspaceId: string): Promise<{
  addedMicro: number
  spentMicro: number
}> {
  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    const rows = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'credit_purchase' AND amount_micro > 0 THEN amount_micro ELSE 0 END), 0) AS added,
        COALESCE(SUM(CASE WHEN type = 'usage_deduction' AND amount_micro < 0 THEN ABS(amount_micro) ELSE 0 END), 0) AS spent
      FROM billing_ledger
      WHERE workspace_id = ${workspaceId}
        AND time_created >= ${monthStart.toISOString()}
    `)

    return {
      addedMicro: Number(rows[0]?.added ?? 0),
      spentMicro: Number(rows[0]?.spent ?? 0),
    }
  } catch (err) {
    console.error("Failed to get credit summary:", err)
    return { addedMicro: 0, spentMicro: 0 }
  }
}
