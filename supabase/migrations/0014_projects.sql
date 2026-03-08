CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  path TEXT,
  repo_url TEXT,
  description TEXT,
  language TEXT,
  branch TEXT DEFAULT 'main',
  status TEXT DEFAULT 'active',
  session_count INTEGER DEFAULT 0,
  time_last_active TIMESTAMP,
  time_created TIMESTAMP DEFAULT NOW() NOT NULL,
  time_updated TIMESTAMP DEFAULT NOW() NOT NULL,
  time_deleted TIMESTAMP
);
CREATE INDEX idx_projects_workspace ON projects(workspace_id);
CREATE UNIQUE INDEX idx_projects_workspace_name ON projects(workspace_id, name) WHERE time_deleted IS NULL;
