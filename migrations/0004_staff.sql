-- Staff accounts and clinic membership (#43, 43a).
--
-- Two tables and one function. Nothing reads or writes them yet: sign-in,
-- sessions and the screens come with #44–#49.
--
-- `staff` is an account: a name, and a phone, an email, or both. Each is
-- unique across all clinics when present, and stored normalised (E.164
-- phone, lower-case email): sign-in looks an account up by one of them
-- before any clinic is known. A CHECK passes on NULL and UNIQUE lets many
-- NULLs coexist, so staff_phone_or_email is what requires at least one.
--
-- `memberships` links an account to a clinic, as owner or therapist. One
-- clinic per account for now: that rule is the single constraint
-- memberships_one_clinic_per_staff, and lifting it is one DROP CONSTRAINT.
--
-- Both tables are under row-level security, as in 0003. A clinic sees its
-- own memberships, and the accounts that belong to it. The app role only
-- reads them; write grants come with the issue that needs them.
--
-- Sign-in has to find an account when no clinic is set, and then the
-- policies show nothing. A second policy on memberships would be OR-ed with
-- the clinic policy and open the table to every query, so the lookup is a
-- function: sign_in_lookup(identifier) runs as its owner (SECURITY DEFINER),
-- matches a phone or an email exactly, and returns only the account's id,
-- clinic and role. Its search_path is pinned and its tables are
-- schema-qualified, because it runs with its owner's rights. Only mada_app
-- may call it.
--
-- The function's owner is the role that runs this migration
-- (DATABASE_OWNER_URL). Under FORCE an owner reads past the policies only if
-- it is a superuser or has BYPASSRLS. With neither, the migration would
-- succeed and the lookup would return no rows and no error: nobody could
-- sign in, and nothing would say why. The guard below refuses that role.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role % is neither a superuser nor BYPASSRLS. sign_in_lookup runs as this role and would find no account under row-level security. Run migrations (DATABASE_OWNER_URL) as a superuser or a BYPASSRLS role.', current_user;
  END IF;
END
$$;

-- An account. No clinic_id: the clinic is in memberships.
CREATE TABLE staff(
  id text CONSTRAINT staff_pkey PRIMARY KEY,
  name text NOT NULL,
  phone text,
  email text,
  "createdAt" text NOT NULL,
  CONSTRAINT staff_phone_key UNIQUE (phone),
  CONSTRAINT staff_email_key UNIQUE (email),
  CONSTRAINT staff_phone_format CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT staff_email_format CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

-- An account's clinic and its role there.
CREATE TABLE memberships(
  staff_id text NOT NULL,
  clinic_id text NOT NULL,
  role text NOT NULL,
  "createdAt" text NOT NULL,
  CONSTRAINT memberships_pkey PRIMARY KEY (staff_id, clinic_id),
  CONSTRAINT memberships_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id),
  CONSTRAINT memberships_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES clinics(id),
  CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'therapist')),
  CONSTRAINT memberships_one_clinic_per_staff UNIQUE (staff_id)
);

-- Read-only for the app role (D6).
GRANT SELECT ON staff, memberships TO mada_app;

ALTER TABLE staff       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE staff       FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- 0003's policy: a clinic's own memberships.
CREATE POLICY clinic_isolation ON memberships FOR ALL
  USING (clinic_id = current_setting('app.clinic_id', true))
  WITH CHECK (clinic_id = current_setting('app.clinic_id', true));

-- An account is visible only from a clinic it belongs to (D4).
CREATE POLICY clinic_member ON staff FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.staff_id = staff.id
      AND m.clinic_id = current_setting('app.clinic_id', true)
  ));

-- The sign-in lookup (D5). Plain `=`: a NULL identifier matches nothing, and
-- neither does a pattern or another letter case.
CREATE FUNCTION public.sign_in_lookup(identifier text)
RETURNS TABLE (staff_id text, clinic_id text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.staff_id, m.clinic_id, m.role
  FROM public.staff s
  JOIN public.memberships m ON m.staff_id = s.id
  WHERE s.phone = identifier OR s.email = identifier
$$;

-- A new function is executable by PUBLIC until that is revoked.
REVOKE EXECUTE ON FUNCTION public.sign_in_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_in_lookup(text) TO mada_app;
