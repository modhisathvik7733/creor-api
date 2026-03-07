-- ======================================================================
-- 0008: Migrate from Razorpay to Cashfree payment gateway
-- Clean cutover — rename columns in-place (no active Razorpay subscriptions)
-- ======================================================================

-- ── billing table ──
ALTER TABLE billing RENAME COLUMN razorpay_customer_id TO cashfree_customer_id;
ALTER TABLE billing RENAME COLUMN razorpay_subscription_id TO cashfree_subscription_id;

-- ── subscriptions table ──
ALTER TABLE subscriptions RENAME COLUMN razorpay_subscription_id TO cashfree_subscription_id;

-- ── plans table ──
ALTER TABLE plans RENAME COLUMN razorpay_plan_ids TO cashfree_plan_ids;

-- ── payments table ──
ALTER TABLE payments RENAME COLUMN razorpay_order_id TO cashfree_order_id;
ALTER TABLE payments RENAME COLUMN razorpay_payment_id TO cashfree_payment_id;

-- ── Rename indexes ──
ALTER INDEX IF EXISTS payments_razorpay_order_idx RENAME TO payments_cashfree_order_idx;
ALTER INDEX IF EXISTS payments_razorpay_payment_id_unique RENAME TO payments_cashfree_payment_id_unique;
