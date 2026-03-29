-- Registry cache table: stores fetched MCP registry data so Edge Function
-- cold starts don't need to re-fetch ~19 pages from the external registry.
CREATE TABLE IF NOT EXISTS mcp_registry_cache (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  server_count INTEGER NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with empty row so UPDATE works on first refresh
INSERT INTO mcp_registry_cache (id) VALUES ('singleton') ON CONFLICT DO NOTHING;

-- Fix Supabase MCP: add required auth header config so install dialog
-- prompts for the personal access token.
UPDATE mcp_catalog
SET
  config_template = '{"type":"remote","url":"https://mcp.supabase.com","headers":{"Authorization":""}}',
  config_params = '[{"key":"Authorization","label":"Personal Access Token (Bearer sbp_...)","placeholder":"Bearer sbp_...","required":true,"secret":true}]'
WHERE slug = 'supabase';
