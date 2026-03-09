-- Enable Supabase Realtime on models table
-- Required so the engine receives live updates when models are added/removed/updated

ALTER TABLE models REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE models;
