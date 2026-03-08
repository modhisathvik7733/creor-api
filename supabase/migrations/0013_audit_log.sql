CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB DEFAULT '{}',
  ip_address TEXT,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_audit_log_workspace_time ON audit_log(workspace_id, time_created DESC);
