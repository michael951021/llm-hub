-- The application role. Deliberately NOT the table owner: an owner would
-- bypass RLS silently, which defeats the point.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelhub_app') THEN
    CREATE ROLE modelhub_app LOGIN PASSWORD 'devpassword';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO modelhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO modelhub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO modelhub_app;

ALTER TABLE nodes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY nodes_org_isolation ON nodes
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));

CREATE POLICY devices_org_isolation ON devices
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));

CREATE POLICY pairing_codes_org_isolation ON pairing_codes
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
