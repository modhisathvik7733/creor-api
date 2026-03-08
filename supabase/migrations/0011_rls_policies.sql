-- ══════════════════════════════════════════════════════════════════
-- 0011: Row-Level Security (RLS) policies for all tables
--
-- Defense-in-depth: The API scopes queries by workspace_id via
-- application middleware. These policies prevent data leakage
-- if a bug or injection bypasses the middleware.
--
-- Phase 1: RLS enabled, but current connection role (postgres/
-- service_role) bypasses RLS. Policies apply when using the
-- creor_api_rls role with SET LOCAL app.workspace_id.
-- ══════════════════════════════════════════════════════════════════

-- ── Create application role ──

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'creor_api_rls') THEN
    CREATE ROLE creor_api_rls NOLOGIN;
    GRANT USAGE ON SCHEMA public TO creor_api_rls;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO creor_api_rls;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO creor_api_rls;
  END IF;
END $$;

-- ── Enable RLS on all tables ──

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE models ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

-- ── Workspace-scoped policies ──

CREATE POLICY workspace_self ON workspaces
  FOR ALL TO creor_api_rls
  USING (id = current_setting('app.workspace_id', true));

CREATE POLICY users_workspace ON users
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY keys_workspace ON keys
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY billing_workspace ON billing
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY subscriptions_workspace ON subscriptions
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY usage_workspace ON usage
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY model_settings_workspace ON model_settings
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY provider_credentials_workspace ON provider_credentials
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY payments_workspace ON payments
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY invites_workspace ON invites
  FOR ALL TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

-- ── Public-read tables (catalogs) ──

CREATE POLICY models_public_read ON models
  FOR SELECT TO creor_api_rls
  USING (true);

CREATE POLICY models_admin_write ON models
  FOR INSERT TO creor_api_rls
  WITH CHECK (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY models_admin_update ON models
  FOR UPDATE TO creor_api_rls
  USING (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY models_admin_delete ON models
  FOR DELETE TO creor_api_rls
  USING (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY plans_public_read ON plans
  FOR SELECT TO creor_api_rls
  USING (true);

CREATE POLICY plans_admin_write ON plans
  FOR INSERT TO creor_api_rls
  WITH CHECK (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY plans_admin_update ON plans
  FOR UPDATE TO creor_api_rls
  USING (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY system_config_admin_read ON system_config
  FOR SELECT TO creor_api_rls
  USING (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY system_config_admin_write ON system_config
  FOR INSERT TO creor_api_rls
  WITH CHECK (current_setting('app.user_role', true) IN ('owner', 'admin'));

CREATE POLICY system_config_admin_update ON system_config
  FOR UPDATE TO creor_api_rls
  USING (current_setting('app.user_role', true) IN ('owner', 'admin'));

-- ── Special tables ──

-- Shares: public read (anyone with share ID), workspace-scoped write
CREATE POLICY shares_public_read ON shares
  FOR SELECT TO creor_api_rls
  USING (true);

CREATE POLICY shares_insert ON shares
  FOR INSERT TO creor_api_rls
  WITH CHECK (true);

CREATE POLICY shares_update ON shares
  FOR UPDATE TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE POLICY shares_delete ON shares
  FOR DELETE TO creor_api_rls
  USING (workspace_id = current_setting('app.workspace_id', true));

-- Webhook events: service-level (no workspace scope, used by webhook handler)
CREATE POLICY webhook_events_service ON webhook_events
  FOR ALL TO creor_api_rls
  USING (true);

-- Device codes: service-level (auth flow, before workspace is known)
CREATE POLICY device_codes_service ON device_codes
  FOR ALL TO creor_api_rls
  USING (true);
