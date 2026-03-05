-- Device codes for IDE ↔ Web authentication (device authorization flow)
CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'completed')),
  user_id TEXT REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  time_created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX device_codes_user_code_idx ON device_codes(user_code);
CREATE INDEX device_codes_status_expires_idx ON device_codes(status, expires_at);
