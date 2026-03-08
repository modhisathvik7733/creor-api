-- MCP Marketplace tables
-- Catalog: global list of available MCP servers
-- Installations: per-workspace installed MCP servers

CREATE TABLE IF NOT EXISTS "mcp_catalog" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "icon" text,
  "author" text,
  "source_url" text,
  "docs_url" text,
  "server_type" text NOT NULL,
  "config_template" jsonb NOT NULL,
  "config_params" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tags" jsonb DEFAULT '[]'::jsonb,
  "featured" boolean DEFAULT false,
  "verified" boolean DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "install_count" integer DEFAULT 0,
  "time_created" timestamp DEFAULT now() NOT NULL,
  "time_updated" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "mcp_installations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
  "catalog_id" text NOT NULL REFERENCES "mcp_catalog"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "mcp_name" text NOT NULL,
  "config" jsonb NOT NULL,
  "config_values" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "time_created" timestamp DEFAULT now() NOT NULL,
  "time_updated" timestamp DEFAULT now() NOT NULL,
  "time_deleted" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_mcp_installations_workspace" ON "mcp_installations" ("workspace_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_installations_workspace_name" ON "mcp_installations" ("workspace_id", "mcp_name") WHERE "time_deleted" IS NULL;
