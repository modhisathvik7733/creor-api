-- ══════════════════════════════════════════════════════════════════
-- 0007: Billing refactor — free tier, overage-only balance deduction,
--       subscription upgrade/downgrade support
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Insert free plan ──
INSERT INTO plans (id, name, prices, monthly_limit, onboarding_credits, features, enabled, sort_order)
VALUES ('free', 'Free', '{"USD": 0, "INR": 0, "EUR": 0}', 500000, 0,
  '["All models","$0.50/month included","Top up anytime"]', true, -1)
ON CONFLICT (id) DO UPDATE SET
  monthly_limit = EXCLUDED.monthly_limit,
  features = EXCLUDED.features,
  onboarding_credits = 0;

-- ── 2. Pending downgrade columns on subscriptions ──
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_effective_at TIMESTAMPTZ;

-- ── 3. Update SQL function: deduct from balance ONLY for overage beyond plan limit ──
CREATE OR REPLACE FUNCTION increment_usage_and_deduct(
  p_workspace_id TEXT,
  p_cost BIGINT,
  p_plan_limit BIGINT  -- plan limit in workspace currency micro-units (NULL = unlimited)
) RETURNS TABLE(new_balance BIGINT, monthly_usage BIGINT) AS $$
DECLARE
  v_now TIMESTAMP := NOW();
  v_month_start TIMESTAMP := date_trunc('month', v_now AT TIME ZONE 'UTC');
  v_balance BIGINT;
  v_monthly BIGINT;
  v_reset TIMESTAMP;
  v_overage BIGINT;
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

  -- Calculate overage: portion of this request that exceeds plan limit
  v_overage := 0;
  IF p_plan_limit IS NOT NULL THEN
    IF v_monthly >= p_plan_limit THEN
      -- Already over limit: entire cost is overage
      v_overage := p_cost;
    ELSIF (v_monthly + p_cost) > p_plan_limit THEN
      -- This request crosses the limit: only excess is overage
      v_overage := (v_monthly + p_cost) - p_plan_limit;
    END IF;
  END IF;

  -- Increment monthly counter
  v_monthly := v_monthly + p_cost;

  -- Deduct only overage from credits balance
  v_balance := v_balance - v_overage;

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

-- ── 4. Disable onboarding credits (replaced by free tier) ──
UPDATE system_config SET value = '0' WHERE key = 'onboarding_credits_usd';
