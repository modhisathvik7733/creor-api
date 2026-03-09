-- ══════════════════════════════════════════════════════════════════
-- 0019: Subscription status for payment failure handling (dunning)
-- ══════════════════════════════════════════════════════════════════

-- Add status column to subscriptions table
ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
CHECK (status IN ('active', 'past_due', 'cancelled', 'expired'));

-- Update existing cancelled subscriptions (those with grace_until set)
UPDATE subscriptions
SET status = 'cancelled'
WHERE grace_until IS NOT NULL
  AND time_deleted IS NULL
  AND status = 'active';
