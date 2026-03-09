-- Enable Supabase Realtime on mcp_installations table
-- Required so the engine receives live updates when users install/uninstall MCPs from the web app

ALTER TABLE mcp_installations REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE mcp_installations;
