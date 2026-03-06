-- ══════════════════════════════════════════════════════════════════
-- 0006: Billing enhancements — multi-currency, payments, atomic counters
-- ══════════════════════════════════════════════════════════════════

-- ── Multi-currency on billing ──
ALTER TABLE billing ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';

-- ── Monthly reset timestamp (for lazy counter reset) ──
ALTER TABLE billing ADD COLUMN IF NOT EXISTS time_monthly_reset TIMESTAMP DEFAULT NOW();

-- ── Payment history ──
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('credits', 'subscription', 'onboarding', 'refund')),
  amount_smallest INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'captured', 'failed', 'refunded')),
  metadata JSONB,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_workspace_idx ON payments (workspace_id);
CREATE INDEX IF NOT EXISTS payments_razorpay_order_idx ON payments (razorpay_order_id);

-- ── Subscription grace period ──
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until TIMESTAMP;

-- ── USD cost on usage for cross-currency analytics ──
ALTER TABLE usage ADD COLUMN IF NOT EXISTS cost_usd BIGINT;

-- ── Index for usage re-aggregation ──
CREATE INDEX IF NOT EXISTS idx_usage_workspace_time ON usage (workspace_id, time_created DESC);

-- ══════════════════════════════════════════════════════════════════
-- Atomic usage increment + balance deduction
--
-- Called from gateway after each request completes.
-- Uses FOR UPDATE to prevent concurrent race conditions.
-- Lazy-resets monthly counter at month boundary.
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION increment_usage_and_deduct(
  p_workspace_id TEXT,
  p_cost BIGINT,
  p_has_subscription BOOLEAN
) RETURNS TABLE(new_balance BIGINT, monthly_usage BIGINT) AS $$
DECLARE
  v_now TIMESTAMP := NOW();
  v_month_start TIMESTAMP := date_trunc('month', v_now AT TIME ZONE 'UTC');
  v_balance BIGINT;
  v_monthly BIGINT;
  v_reset TIMESTAMP;
BEGIN
  -- Lock the row
  SELECT b.balance, b.monthly_usage, b.time_monthly_reset
  INTO v_balance, v_monthly, v_reset
  FROM billing b
  WHERE b.workspace_id = p_workspace_id
  FOR UPDATE;

  -- Lazy reset at month boundary
  IF v_reset IS NULL OR v_reset < v_month_start THEN
    v_monthly := 0;
    v_reset := v_month_start;
  END IF;

  -- Increment monthly counter
  v_monthly := v_monthly + p_cost;

  -- Deduct from balance only for non-subscription users
  IF NOT p_has_subscription THEN
    v_balance := GREATEST(v_balance - p_cost, 0);
  END IF;

  -- Write back
  UPDATE billing b SET
    balance = v_balance,
    monthly_usage = v_monthly,
    time_monthly_reset = v_reset,
    time_monthly_usage_updated = v_now,
    time_updated = v_now
  WHERE b.workspace_id = p_workspace_id;

  RETURN QUERY SELECT v_balance, v_monthly;
END;
$$ LANGUAGE plpgsql;
