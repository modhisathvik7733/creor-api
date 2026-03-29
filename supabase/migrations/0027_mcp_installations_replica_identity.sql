-- Set REPLICA IDENTITY FULL so Supabase Realtime includes all columns
-- (including workspace_id) in DELETE events. Without this, filtered
-- Realtime channels miss DELETE events because the default replica
-- identity only sends the primary key.
ALTER TABLE mcp_installations REPLICA IDENTITY FULL;
