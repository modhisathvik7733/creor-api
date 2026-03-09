-- ══════════════════════════════════════════════════════════════════
-- 0018: Background jobs via pg_cron
-- ══════════════════════════════════════════════════════════════════
-- Replaces lazy-reset with deterministic scheduled resets.
-- Adds usage rollup, grace period cleanup, and session cleanup.

-- Enable pg_cron extension (must be enabled in Supabase dashboard first)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant cron job execution to the postgres role
GRANT USAGE ON SCHEMA cron TO postgres;

-- ── 1. Monthly usage reset (1st of each month at midnight UTC) ──
-- Replaces the lazy-reset pattern in checkQuota() and increment_usage_and_deduct().
-- Ensures clean data even for inactive workspaces.

SELECT cron.schedule(
  'monthly-usage-reset',
  '0 0 1 * *',
  $$
    UPDATE billing
    SET monthly_usage = 0,
        time_monthly_reset = NOW(),
        time_updated = NOW()
    WHERE monthly_usage > 0
       OR time_monthly_reset < date_trunc('month', NOW() AT TIME ZONE 'UTC');
  $$
);

-- ── 2. Expired grace period cleanup (hourly) ──
-- Soft-deletes subscriptions whose grace period has ended.
-- Fallback for when Lemon Squeezy's subscription_expired webhook fails.

SELECT cron.schedule(
  'grace-period-cleanup',
  '0 * * * *',
  $$
    UPDATE subscriptions
    SET time_deleted = NOW()
    WHERE grace_until IS NOT NULL
      AND grace_until < NOW()
      AND time_deleted IS NULL;

    -- Clear billing.ls_subscription_id for expired subscriptions
    UPDATE billing b
    SET ls_subscription_id = NULL, time_updated = NOW()
    WHERE ls_subscription_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.ls_subscription_id = b.ls_subscription_id
          AND s.time_deleted IS NULL
      );
  $$
);

-- ── 3. Daily usage rollup (2:00 AM UTC) ──
-- Aggregates raw usage rows into usage_daily for fast dashboard queries.

CREATE TABLE IF NOT EXISTS usage_daily (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  model TEXT NOT NULL,
  day DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micro BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, model, day)
);

SELECT cron.schedule(
  'daily-usage-rollup',
  '0 2 * * *',
  $$
    INSERT INTO usage_daily (workspace_id, model, day, request_count, input_tokens, output_tokens, cost_micro)
    SELECT
      workspace_id,
      model,
      DATE(time_created AT TIME ZONE 'UTC') AS day,
      COUNT(*) AS request_count,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cost) AS cost_micro
    FROM usage
    WHERE time_created >= (NOW() - INTERVAL '2 days')
      AND time_created < date_trunc('day', NOW() AT TIME ZONE 'UTC')
    GROUP BY workspace_id, model, DATE(time_created AT TIME ZONE 'UTC')
    ON CONFLICT (workspace_id, model, day)
    DO UPDATE SET
      request_count = EXCLUDED.request_count,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cost_micro = EXCLUDED.cost_micro;
  $$
);

-- ── 4. Stale session cleanup (daily at 3:00 AM UTC) ──
-- Removes expired JWT sessions older than 30 days.

SELECT cron.schedule(
  'stale-session-cleanup',
  '0 3 * * *',
  $$
    DELETE FROM sessions
    WHERE time_expires < NOW() - INTERVAL '30 days';
  $$
);

-- ── 5. RLS for usage_daily ──

ALTER TABLE usage_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_daily_workspace_access" ON usage_daily
  FOR ALL
  TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
