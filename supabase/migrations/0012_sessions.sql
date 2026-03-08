CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_hash TEXT NOT NULL,
  device TEXT,
  ip_address TEXT,
  user_agent TEXT,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_expires TIMESTAMP NOT NULL,
  time_revoked TIMESTAMP
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
