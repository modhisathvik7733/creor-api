-- ══════════════════════════════════════════════════════════════════
-- 0005: Server-driven configuration tables
-- Replaces hardcoded GATEWAY_MODELS (lib/models.ts) and getPlanConfig() (billing.ts)
-- ══════════════════════════════════════════════════════════════════

-- ── Model Catalog ──
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  input_cost NUMERIC(10,6) NOT NULL,
  output_cost NUMERIC(10,6) NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 200000,
  max_output INTEGER,
  capabilities JSONB DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  min_plan TEXT DEFAULT 'free',
  sort_order INTEGER DEFAULT 0,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ── Plan Catalog ──
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prices JSONB NOT NULL DEFAULT '{}',
  monthly_limit BIGINT,
  onboarding_credits BIGINT DEFAULT 0,
  features JSONB DEFAULT '[]',
  razorpay_plan_ids JSONB DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ── System Config (key-value) ──
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ── Seed system config ──
INSERT INTO system_config (key, value, description) VALUES
  ('exchange_rates', '{"USD": 1, "INR": 85, "EUR": 0.92}', 'Exchange rates relative to USD'),
  ('supported_currencies', '["USD", "INR", "EUR"]', 'Supported billing currencies'),
  ('fallback_input_cost', '0.003', 'Fallback USD per 1K input tokens'),
  ('fallback_output_cost', '0.015', 'Fallback USD per 1K output tokens'),
  ('low_balance_threshold_usd', '0.50', 'Low balance warning threshold (USD equivalent)'),
  ('onboarding_credits_usd', '0.30', 'Onboarding credits for free signup (USD equivalent)')
ON CONFLICT (key) DO NOTHING;

-- ── Seed models ──
INSERT INTO models (id, provider, name, input_cost, output_cost, context_window, capabilities, min_plan) VALUES
  ('anthropic/claude-sonnet-4', 'anthropic', 'Claude Sonnet 4', 0.003, 0.015, 200000, '["tool_call","reasoning","vision"]', 'free'),
  ('anthropic/claude-haiku-3.5', 'anthropic', 'Claude 3.5 Haiku', 0.0008, 0.004, 200000, '["tool_call","vision"]', 'free'),
  ('openai/gpt-4.1', 'openai', 'GPT-4.1', 0.002, 0.008, 1000000, '["tool_call","reasoning","vision"]', 'free'),
  ('openai/o3-mini', 'openai', 'o3-mini', 0.0011, 0.0044, 200000, '["tool_call","reasoning"]', 'free'),
  ('google/gemini-2.5-pro', 'google', 'Gemini 2.5 Pro', 0.00125, 0.01, 1000000, '["tool_call","reasoning","vision"]', 'free'),
  ('google/gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 0.00015, 0.0006, 1000000, '["tool_call","reasoning","vision"]', 'free')
ON CONFLICT (id) DO NOTHING;

-- ── Seed plans ──
-- monthly_limit in USD micro-units: $6 = 6_000_000, $24 = 24_000_000
-- prices in smallest currency unit: USD cents, INR paise, EUR cents
INSERT INTO plans (id, name, prices, monthly_limit, onboarding_credits, features, sort_order) VALUES
  ('free', 'Free', '{"USD": 0, "INR": 0, "EUR": 0}', NULL, 300000, '["basic_models"]', 0),
  ('starter', 'Starter', '{"USD": 599, "INR": 49900, "EUR": 549}', 6000000, 1200000, '["all_models","email_support"]', 1),
  ('pro', 'Pro', '{"USD": 2399, "INR": 199900, "EUR": 2199}', 24000000, 6000000, '["all_models","priority_models","priority_support"]', 2),
  ('team', 'Team', '{"USD": 5999, "INR": 499900, "EUR": 5499}', 60000000, 12000000, '["all_models","priority_models","dedicated_support","admin_roles"]', 3)
ON CONFLICT (id) DO NOTHING;

-- ── Materialized view for single-query gateway lookup ──
CREATE MATERIALIZED VIEW IF NOT EXISTS gateway_config AS
SELECT
  m.id AS model_id,
  m.provider,
  m.name AS model_name,
  m.input_cost,
  m.output_cost,
  m.context_window,
  m.capabilities,
  m.enabled,
  m.min_plan,
  (SELECT value FROM system_config WHERE key = 'exchange_rates') AS exchange_rates,
  (SELECT value::numeric FROM system_config WHERE key = 'fallback_input_cost') AS fallback_input,
  (SELECT value::numeric FROM system_config WHERE key = 'fallback_output_cost') AS fallback_output
FROM models m
WHERE m.enabled = true;

CREATE UNIQUE INDEX IF NOT EXISTS gateway_config_model_id_idx ON gateway_config (model_id);

-- ── Refresh function ──
CREATE OR REPLACE FUNCTION refresh_gateway_config() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY gateway_config;
END;
$$ LANGUAGE plpgsql;
