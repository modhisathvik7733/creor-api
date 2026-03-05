-- Webhook events table for idempotent processing
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL
);
