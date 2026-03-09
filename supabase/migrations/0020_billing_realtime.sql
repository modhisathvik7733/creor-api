-- Enable Supabase Realtime on billing tables
-- REPLICA IDENTITY FULL is required so Realtime sends old+new row data on UPDATE

ALTER TABLE billing REPLICA IDENTITY FULL;
ALTER TABLE subscriptions REPLICA IDENTITY FULL;
ALTER TABLE plans REPLICA IDENTITY FULL;

-- Add these tables to the Supabase Realtime publication
-- (supabase_realtime is the default publication used by Supabase Realtime)
ALTER PUBLICATION supabase_realtime ADD TABLE billing;
ALTER PUBLICATION supabase_realtime ADD TABLE subscriptions;
