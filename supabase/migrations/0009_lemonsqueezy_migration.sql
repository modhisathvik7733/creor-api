-- Migration: Cashfree → Lemon Squeezy
-- Renames cashfree columns to ls, drops reload fields, defaults currency to USD

-- ── Billing table ──

ALTER TABLE billing RENAME COLUMN cashfree_customer_id TO ls_customer_id;
ALTER TABLE billing RENAME COLUMN cashfree_subscription_id TO ls_subscription_id;

-- Remove reload columns (not used with Lemon Squeezy)
ALTER TABLE billing DROP COLUMN IF EXISTS reload_enabled;
ALTER TABLE billing DROP COLUMN IF EXISTS reload_amount;
ALTER TABLE billing DROP COLUMN IF EXISTS reload_trigger;
ALTER TABLE billing DROP COLUMN IF EXISTS time_reload_locked_till;

-- Default currency to USD
ALTER TABLE billing ALTER COLUMN currency SET DEFAULT 'USD';
UPDATE billing SET currency = 'USD' WHERE currency != 'USD';

-- ── Subscriptions table ──

ALTER TABLE subscriptions RENAME COLUMN cashfree_subscription_id TO ls_subscription_id;

-- ── Payments table ──

ALTER TABLE payments RENAME COLUMN cashfree_order_id TO ls_order_id;
ALTER TABLE payments RENAME COLUMN cashfree_payment_id TO ls_subscription_payment_id;

-- Drop old index, create new
DROP INDEX IF EXISTS payments_cashfree_order_idx;
CREATE INDEX IF NOT EXISTS payments_ls_order_idx ON payments (ls_order_id);

-- ── Plans table ──

ALTER TABLE plans DROP COLUMN IF EXISTS cashfree_plan_ids;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS ls_variant_id TEXT;

-- ── Clear old subscription references (will be re-created via LS) ──

UPDATE billing SET ls_subscription_id = NULL;
UPDATE subscriptions SET ls_subscription_id = NULL, time_deleted = NOW() WHERE time_deleted IS NULL;
