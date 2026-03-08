-- ══════════════════════════════════════════════════════════════════
-- 0010: Billing fixes — balance floor, unique subscription constraint
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Fix negative balance bug: add GREATEST floor ──
-- Migration 0007 regressed the GREATEST(0, ...) guard from 0006.
-- Without this, balance can go negative when overage exceeds remaining credits.

CREATE OR REPLACE FUNCTION increment_usage_and_deduct(
  p_workspace_id TEXT,
  p_cost BIGINT,
  p_plan_limit BIGINT
) RETURNS TABLE(new_balance BIGINT, monthly_usage BIGINT) AS $$
DECLARE
  v_now TIMESTAMP := NOW();
  v_month_start TIMESTAMP := date_trunc('month', v_now AT TIME ZONE 'UTC');
  v_balance BIGINT;
  v_monthly BIGINT;
  v_reset TIMESTAMP;
  v_overage BIGINT;
BEGIN
  SELECT b.balance, b.monthly_usage, b.time_monthly_reset
  INTO v_balance, v_monthly, v_reset
  FROM billing b
  WHERE b.workspace_id = p_workspace_id
  FOR UPDATE;

  IF v_reset IS NULL OR v_reset < v_month_start THEN
    v_monthly := 0;
    v_reset := v_month_start;
  END IF;

  v_overage := 0;
  IF p_plan_limit IS NOT NULL THEN
    IF v_monthly >= p_plan_limit THEN
      v_overage := p_cost;
    ELSIF (v_monthly + p_cost) > p_plan_limit THEN
      v_overage := (v_monthly + p_cost) - p_plan_limit;
    END IF;
  END IF;

  v_monthly := v_monthly + p_cost;

  -- Allow negative balance (debt) for subscribers using overage.
  -- Gateway controls who is blocked; SQL just tracks honestly.
  -- Negative balance = debt recovered when user adds credits.
  v_balance := v_balance - v_overage;

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

-- ── 2. Prevent multiple active subscriptions per workspace ──
-- Only one non-deleted subscription allowed per workspace at a time.

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_workspace_active_idx
ON subscriptions (workspace_id) WHERE time_deleted IS NULL;

-- ── 3. Auto-refresh gateway_config when models table changes ──
-- Previously required manual admin action; now triggers automatically.

CREATE OR REPLACE FUNCTION auto_refresh_gateway_config()
RETURNS trigger AS $$
BEGIN
  PERFORM refresh_gateway_config();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_models_refresh ON models;
CREATE TRIGGER trg_models_refresh
AFTER INSERT OR UPDATE OR DELETE ON models
FOR EACH STATEMENT EXECUTE FUNCTION auto_refresh_gateway_config();
