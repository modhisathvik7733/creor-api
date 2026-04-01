-- User custom MCP servers (account-level, personal — not published to marketplace)
CREATE TABLE IF NOT EXISTS "user_custom_mcps" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
  "name" text NOT NULL,
  "description" text,
  "server_type" text NOT NULL CHECK (server_type IN ('local', 'remote')),
  "config" jsonb NOT NULL,
  "config_values" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "time_created" timestamp DEFAULT now() NOT NULL,
  "time_updated" timestamp DEFAULT now() NOT NULL,
  "time_deleted" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_user_custom_mcps_user" ON "user_custom_mcps"("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_custom_mcps_workspace" ON "user_custom_mcps"("workspace_id");
