-- Login codes: issue and check (#45, 45a).
--
-- Two tables and two functions. Nothing calls them yet: the app code comes
-- with 45b, sign-in with #46.
--
-- `login_codes` is one row per code issued to an account. Only the code's
-- SHA-256 hex is kept (the app hashes it; the CHECK refuses anything that
-- is not 64 hex characters), with when it was issued, when it expires and
-- when it was used or replaced. `login_events` is the ledger the caps
-- count: one row per code request let through and one per failed check,
-- with the identifier as passed (whether or not an account has it) and the
-- caller's address. No clinic_id: a code is asked for before a clinic is
-- known.
--
-- The app role gets nothing on either table: no grant, and row-level
-- security enabled and forced with no policy. It reaches them only through
-- the two functions, which run as their owner (SECURITY DEFINER) with
-- search_path pinned and every table schema-qualified, like sign_in_lookup.
-- Only mada_app may call them.
--
-- Both functions lock the identifier, then the address (transaction-level
-- advisory locks, always in that order), so calls sent together are counted
-- one at a time. Both read the clock once, after the locks, and use that
-- reading everywhere, the prune included: an inline clock_timestamp() in a
-- WHERE can't use an index. Both delete events and codes older than 24
-- hours each time they run. Matching is plain `=`. The bodies carry no
-- comments: a test reads them.
--
-- The functions' owner is the role that runs this migration
-- (DATABASE_OWNER_URL). Under FORCE with no policy, an owner that is
-- neither a superuser nor BYPASSRLS reads no rows and may not insert one:
-- every call would fail on its first insert (42501). The guard below
-- refuses that role, as 0004's does.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role % is neither a superuser nor BYPASSRLS. login_code_issue and login_code_check run as this role and could not read or write their tables under row-level security. Run migrations (DATABASE_OWNER_URL) as a superuser or a BYPASSRLS role.', current_user;
  END IF;
END
$$;

-- A code issued to an account. Only its hash is kept.
CREATE TABLE login_codes(
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT login_codes_pkey PRIMARY KEY,
  staff_id text NOT NULL,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT login_codes_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id),
  CONSTRAINT login_codes_code_hash_format CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

-- What the caps count: code requests let through, and failed checks.
CREATE TABLE login_events(
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT login_events_pkey PRIMARY KEY,
  kind text NOT NULL,
  identifier text NOT NULL,
  ip text NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT login_events_kind_check CHECK (kind IN ('request', 'failure'))
);

-- An account's codes; the two caps; the prune.
CREATE INDEX login_codes_staff_id_idx ON login_codes(staff_id);
CREATE INDEX login_events_identifier_idx ON login_events(kind, identifier, at);
CREATE INDEX login_events_ip_idx ON login_events(kind, ip, at);
CREATE INDEX login_events_at_idx ON login_events(at);

-- No policy and no grant: the app role can't touch either table, and under
-- FORCE neither can an owner without BYPASSRLS.
ALTER TABLE login_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE login_codes  FORCE ROW LEVEL SECURITY;
ALTER TABLE login_events FORCE ROW LEVEL SECURITY;

-- Issue a code: 'issued', 'none' (no account with a membership has that
-- phone or email) or 'limited' (3 requests for the identifier, or 20 from
-- the address, in the last 15 minutes; a refused request is not recorded).
-- The account's row is locked because one account can be asked for by its
-- phone and by its email; its earlier codes are retired, and the new one
-- lasts 10 minutes. Bad arguments: 22023, with no argument in the message.
CREATE FUNCTION public.login_code_issue(p_identifier text, p_ip text, p_code_hash text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_staff_id text;
BEGIN
  IF p_identifier IS NULL OR p_identifier = ''
     OR p_ip IS NULL OR p_ip = ''
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'login_code_issue: invalid argument' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(1, hashtext(p_identifier));
  PERFORM pg_advisory_xact_lock(2, hashtext(p_ip));

  v_now := clock_timestamp();

  DELETE FROM public.login_events e WHERE e.at < v_now - interval '24 hours';
  DELETE FROM public.login_codes c WHERE c.created_at < v_now - interval '24 hours';

  IF (SELECT count(*) FROM public.login_events e
      WHERE e.kind = 'request' AND e.identifier = p_identifier
        AND e.at > v_now - interval '15 minutes') >= 3
     OR (SELECT count(*) FROM public.login_events e
         WHERE e.kind = 'request' AND e.ip = p_ip
           AND e.at > v_now - interval '15 minutes') >= 20 THEN
    RETURN 'limited';
  END IF;

  INSERT INTO public.login_events(kind, identifier, ip, at)
  VALUES ('request', p_identifier, p_ip, v_now);

  SELECT s.id INTO v_staff_id
  FROM public.staff s
  JOIN public.memberships m ON m.staff_id = s.id
  WHERE s.phone = p_identifier OR s.email = p_identifier
  FOR NO KEY UPDATE OF s;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  UPDATE public.login_codes c
  SET used_at = v_now
  WHERE c.staff_id = v_staff_id AND c.used_at IS NULL;

  INSERT INTO public.login_codes(staff_id, code_hash, created_at, expires_at)
  VALUES (v_staff_id, p_code_hash, v_now, v_now + interval '15 minutes');

  RETURN 'issued';
END
$$;

-- Check a code: one row. 'ok' with the account's id, clinic and role, and
-- the code is used up; 'invalid', recorded as a failure; or 'blocked' (5
-- failures for the identifier, or 20 from the address, in the last 15
-- minutes), decided before the code is looked at, not recorded, and
-- refusing the correct code too. RETURNS TABLE makes staff_id, clinic_id
-- and role variables in the body, so every column there is qualified.
CREATE FUNCTION public.login_code_check(p_identifier text, p_ip text, p_code_hash text)
RETURNS TABLE (outcome text, staff_id text, clinic_id text, role text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_staff_id text;
  v_clinic_id text;
  v_role text;
BEGIN
  IF p_identifier IS NULL OR p_identifier = ''
     OR p_ip IS NULL OR p_ip = ''
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'login_code_check: invalid argument' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(1, hashtext(p_identifier));
  PERFORM pg_advisory_xact_lock(2, hashtext(p_ip));

  v_now := clock_timestamp();

  DELETE FROM public.login_events e WHERE e.at < v_now - interval '24 hours';
  DELETE FROM public.login_codes c WHERE c.created_at < v_now - interval '24 hours';

  IF (SELECT count(*) FROM public.login_events e
      WHERE e.kind = 'failure' AND e.identifier = p_identifier
        AND e.at > v_now - interval '15 minutes') >= 5
     OR (SELECT count(*) FROM public.login_events e
         WHERE e.kind = 'failure' AND e.ip = p_ip
           AND e.at > v_now - interval '15 minutes') >= 20 THEN
    RETURN QUERY SELECT 'blocked'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.login_codes c
  SET used_at = v_now
  FROM public.staff s
  JOIN public.memberships m ON m.staff_id = s.id
  WHERE (s.phone = p_identifier OR s.email = p_identifier)
    AND c.staff_id = s.id
    AND c.used_at IS NULL
    AND c.expires_at > v_now
    AND c.code_hash = p_code_hash
  RETURNING c.staff_id, m.clinic_id, m.role INTO v_staff_id, v_clinic_id, v_role;

  IF FOUND THEN
    RETURN QUERY SELECT 'ok'::text, v_staff_id, v_clinic_id, v_role;
    RETURN;
  END IF;

  INSERT INTO public.login_events(kind, identifier, ip, at)
  VALUES ('failure', p_identifier, p_ip, v_now);

  RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text, NULL::text;
END
$$;

-- A new function is executable by PUBLIC until that is revoked.
REVOKE EXECUTE ON FUNCTION public.login_code_issue(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.login_code_check(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.login_code_issue(text, text, text) TO mada_app;
GRANT EXECUTE ON FUNCTION public.login_code_check(text, text, text) TO mada_app;
