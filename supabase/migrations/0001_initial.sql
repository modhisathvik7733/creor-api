-- Creor API: Initial schema migration
-- Run this in Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL,
  time_deleted TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('github', 'google')),
  auth_provider_id TEXT NOT NULL,
  avatar_url TEXT,
  monthly_limit INTEGER,
  monthly_usage BIGINT DEFAULT 0,
  time_monthly_usage_updated TIMESTAMP,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL,
  time_deleted TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_workspace_idx ON users(email, workspace_id);
CREATE INDEX IF NOT EXISTS users_auth_provider_idx ON users(auth_provider, auth_provider_id);

CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  time_used TIMESTAMP,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_deleted TIMESTAMP
);

CREATE INDEX IF NOT EXISTS keys_workspace_idx ON keys(workspace_id);

CREATE TABLE IF NOT EXISTS billing (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) UNIQUE,
  balance BIGINT NOT NULL DEFAULT 0,
  monthly_limit INTEGER,
  monthly_usage BIGINT DEFAULT 0,
  time_monthly_usage_updated TIMESTAMP,
  razorpay_customer_id TEXT,
  razorpay_subscription_id TEXT,
  reload_enabled BOOLEAN DEFAULT FALSE,
  reload_amount INTEGER DEFAULT 500,
  reload_trigger INTEGER DEFAULT 100,
  time_reload_locked_till TIMESTAMP,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'pro', 'team')),
  razorpay_subscription_id TEXT,
  rolling_usage BIGINT DEFAULT 0,
  fixed_usage BIGINT DEFAULT 0,
  time_rolling_updated TIMESTAMP,
  time_fixed_updated TIMESTAMP,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_deleted TIMESTAMP
);

CREATE INDEX IF NOT EXISTS subscriptions_workspace_user_idx ON subscriptions(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key_id TEXT REFERENCES keys(id),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost BIGINT NOT NULL DEFAULT 0,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_workspace_idx ON usage(workspace_id);
CREATE INDEX IF NOT EXISTS usage_time_idx ON usage(time_created);

CREATE TABLE IF NOT EXISTS model_settings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  model TEXT NOT NULL,
  disabled BOOLEAN DEFAULT FALSE,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS model_settings_workspace_model_idx ON model_settings(workspace_id, model);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL,
  credentials TEXT NOT NULL,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_workspace_provider_idx ON provider_credentials(workspace_id, provider);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  data JSONB NOT NULL,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_deleted TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_accepted TIMESTAMP,
  time_deleted TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS invites_workspace_email_idx ON invites(workspace_id, email);
