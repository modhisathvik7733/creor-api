-- ══════════════════════════════════════════════════════════════════
-- 0017: Billing ledger + usage idempotency
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Usage idempotency: add request_id unique column ──
-- Prevents double-counting when requests are retried.
-- The gateway generates a UUID per request and uses ON CONFLICT DO NOTHING.

ALTER TABLE usage ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS usage_request_id_idx ON usage (request_id) WHERE request_id IS NOT NULL;

-- ── 2. Billing ledger: append-only audit trail for all balance changes ──
-- Every credit purchase, usage deduction, refund, or adjustment gets a row.
-- The balance_after_micro column enables balance reconciliation.

CREATE TABLE IF NOT EXISTS billing_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL CHECK (type IN (
    'credit_purchase', 'usage_deduction', 'subscription_renewal',
    'refund', 'adjustment', 'onboarding'
  )),
  amount_micro BIGINT NOT NULL,            -- positive = credit, negative = debit
  balance_after_micro BIGINT NOT NULL,     -- snapshot of balance after this entry
  reference_id TEXT,                        -- usage.id, payment.id, etc.
  metadata JSONB,
  time_created TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_workspace_time
  ON billing_ledger (workspace_id, time_created);

-- ── 3. Update increment_usage_and_deduct to return balance for ledger writes ──
-- (Already returns new_balance — no change needed to the function itself.)
-- The application layer will use the returned balance to write ledger entries.

-- ── 4. RLS for billing_ledger ──

ALTER TABLE billing_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "billing_ledger_workspace_access" ON billing_ledger
  FOR ALL
  TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
