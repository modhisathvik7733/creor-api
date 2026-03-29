-- Add logo_url, github_url, github_stars columns to mcp_catalog
-- These are used for display in the marketplace UI

ALTER TABLE "mcp_catalog" ADD COLUMN IF NOT EXISTS "logo_url" text;
ALTER TABLE "mcp_catalog" ADD COLUMN IF NOT EXISTS "github_url" text;
ALTER TABLE "mcp_catalog" ADD COLUMN IF NOT EXISTS "github_stars" integer DEFAULT 0;

-- Populate logo_url for existing curated servers
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/github.com' WHERE "slug" = 'github';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/slack.com' WHERE "slug" = 'slack';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/notion.so' WHERE "slug" = 'notion';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/supabase.com' WHERE "slug" = 'supabase';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/linear.app' WHERE "slug" = 'linear';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/brave.com' WHERE "slug" = 'brave-search';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/google.com' WHERE "slug" = 'google-drive';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/sentry.io' WHERE "slug" = 'sentry';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/todoist.com' WHERE "slug" = 'todoist';
UPDATE "mcp_catalog" SET "logo_url" = 'https://logo.clearbit.com/exa.ai' WHERE "slug" = 'exa';
