-- Row-level security (#10, 10a).
--
-- The app connects as `mada_app` (DATABASE_URL); migrations run as the owner
-- (DATABASE_OWNER_URL). Each transaction says which clinic it acts for with
-- set_config('app.clinic_id', …, true), and the policies below only let it
-- see and write that clinic's rows. With no clinic set, a table shows no
-- rows and refuses every insert.
--
-- FORCE makes the policies apply to the table owner too. A superuser, or a
-- role with BYPASSRLS, still skips them: the app refuses to start as one
-- (lib/server/db.ts).
--
-- A person creates `mada_app` once per cluster, with a password (D4):
--   CREATE ROLE mada_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- This migration only grants to it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mada_app') THEN
    RAISE EXCEPTION 'role mada_app does not exist. Create it once per cluster before deploying: CREATE ROLE mada_app LOGIN PASSWORD ''…'' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;';
  END IF;
END
$$;

-- Grants (D7). No DELETE: the app never deletes. Nothing on
-- schema_migrations. clinics is read-only and has no RLS: it has no
-- clinic_id, and the app reads it to check the clinic it serves.
GRANT USAGE ON SCHEMA public TO mada_app;
GRANT SELECT ON clinics TO mada_app;
GRANT SELECT, INSERT, UPDATE ON
  patients, appointments, invoices, inventory, sessions,
  recordings, segments, adherence, pain_logs
TO mada_app;

-- One policy per table, for every command. current_setting(…, true) is NULL
-- (or '') when no clinic is set, so nothing matches.
ALTER TABLE patients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE adherence    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pain_logs    ENABLE ROW LEVEL SECURITY;

ALTER TABLE patients     FORCE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices     FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory    FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions     FORCE ROW LEVEL SECURITY;
ALTER TABLE recordings   FORCE ROW LEVEL SECURITY;
ALTER TABLE segments     FORCE ROW LEVEL SECURITY;
ALTER TABLE adherence    FORCE ROW LEVEL SECURITY;
ALTER TABLE pain_logs    FORCE ROW LEVEL SECURITY;

CREATE POLICY clinic_isolation ON appointments FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON invoices FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON inventory FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON sessions FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON recordings FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON segments FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON adherence FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));
CREATE POLICY clinic_isolation ON pain_logs FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

-- The handout page has no clinic of its own: its token is the credential
-- (D5). Read-only; the app sets the token in the same transaction, reads the
-- session, then sets that session's clinic for the rest of the work.
CREATE POLICY handout_token ON sessions FOR SELECT
  USING ("handoutToken" = current_setting('app.handout_token', true));
