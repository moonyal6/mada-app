import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  APP_ROLE,
  SERVER_START_MS,
  createTestDb,
  makeDataDir,
  request,
  startServer,
  testDatabaseUrl,
  withCleanup,
  type TestDb,
} from "./pg/harness.mjs";

// M1–M8 of #43 (staff accounts and clinic membership), written before the
// implementation, in a separate session, from the approved spec (v2, with the
// approval's amendments). PR 43-0 ships them with no migration, so they are
// red on main by design, except M7.
//
// What each does on main, before 0004_staff.sql exists:
//  - M1–M5: the migrating start succeeds, the fixture adds clinic c2, then its
//    first insert into `staff` fails 42P01 (relation "staff" does not exist).
//  - M6: to_regprocedure('public.sign_in_lookup(text)') is NULL.
//  - M7: green. 0003 already grants only SELECT on `clinics`.
//  - M8: 0001–0003 apply as a plain owner (the control), then reading
//    migrations/0004_staff.sql throws ENOENT.
//
// "As admin" is the harness's `db.query`, a superuser, which sees and writes
// every row whatever the policies say. "As c1" is `mada_app` (`db.url`)
// inside BEGIN with set_config('app.clinic_id', 'c1', true), the way the app
// sets it. There is no sign-in yet, so that is what "a member of clinic c1"
// means at database level.
//
// The helpers are copies of the ones in pg-rls.test.ts; nothing is shared.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const NOW = "2026-11-25T09:00:00.000Z";

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `INSERT INTO table("a","b") VALUES ($1,$2)` as SQL and parameters. */
function insertSql(table: string, values: Record<string, unknown>): [string, unknown[]] {
  const cols = Object.keys(values);
  return [
    `INSERT INTO ${table}(${cols.map(q).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(values),
  ];
}

const insert = (db: TestDb, table: string, values: Record<string, unknown>) => db.query(...insertSql(table, values));

/**
 * A fresh database migrated (and seeded with c1) by one server start, which
 * is stopped again before `fn` runs.
 */
function withMigratedDb<T>(fn: (ctx: { db: TestDb; defer: (cleanup: () => unknown) => void }) => Promise<T>) {
  return withCleanup(async (defer) => {
    const db = await createTestDb();
    defer(db.drop);
    const dataDir = makeDataDir();
    defer(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
    defer(first.stop);
    const res = await request(first.base, "GET", "/api/patients");
    expect(res.status, `migrating start as ${APP_ROLE}, GET /api/patients: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    await first.stop();
    return fn({ db, defer });
  });
}

/** Runs one statement on its own connection. */
async function runOn(connectionString: string, sql: string, params?: unknown[]) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

/**
 * A copy of `db` (CREATE DATABASE … TEMPLATE): schema, grants, policies and
 * rows. Returns its owner and app URLs, and its drop.
 */
async function copyOf(db: TestDb, suffix: string) {
  const adminUrl = testDatabaseUrl();
  const name = `${db.name}_${suffix}`;
  // A connection that has just closed can still hold the template for a
  // moment (55006: "being accessed by other users").
  for (let tries = 0; ; tries++) {
    try {
      await runOn(adminUrl, `CREATE DATABASE ${name} TEMPLATE ${db.name}`);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "55006" || tries >= 20) throw e;
      await sleep(250);
    }
  }
  const withName = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.href;
  };
  return {
    ownerUrl: withName(db.ownerUrl),
    appUrl: withName(db.url),
    drop: () => runOn(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/** `url` with another role as its user. Trust auth locally and in CI, so no password. */
function asRole(url: string, role: string) {
  const u = new URL(url);
  u.username = role;
  u.password = "";
  return u.href;
}

type PgErr = { code?: string; constraint?: string; column?: string; message: string };

/** The Postgres error a statement fails with, or null when it succeeds. */
async function pgError(run: () => Promise<unknown>): Promise<PgErr | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const err = e as PgErr;
    return { code: err.code, constraint: err.constraint, column: err.column, message: err.message };
  }
}

/**
 * What a statement did, in the terms the spec asserts: the SQLSTATE, plus
 * the constraint for 23505, 23514 and 23503, the column for 23502, and the
 * message for anything else.
 */
function said(err: PgErr | null): string {
  if (err === null) return "accepted";
  if (err.code === "23505" || err.code === "23514" || err.code === "23503") return `${err.code} ${err.constraint}`;
  if (err.code === "23502") return `23502 ${err.column}`;
  return `${err.code} ${err.message}`;
}

/* ─── Fixture ──────────────────────────────────────────────────────────── */

type Staff = { id: string; name: string; phone: string | null; email: string | null };

const STAFF: Staff[] = [
  { id: "s1", name: "موظف أول", phone: "+966500000001", email: "s1@clinic.test" },
  { id: "s2", name: "موظف ثان", phone: "+966500000002", email: null },
  { id: "s3", name: "موظف ثالث", phone: null, email: "s3@clinic.test" },
  { id: "s4", name: "موظف رابع", phone: null, email: "s4@clinic.test" },
];

/** s3 has no membership. */
const MEMBERSHIPS = [
  { staff_id: "s1", clinic_id: "c1", role: "owner" },
  { staff_id: "s2", clinic_id: "c2", role: "therapist" },
  { staff_id: "s4", clinic_id: "c2", role: "therapist" },
];

/** A valid `staff` row but for what is given: a name unless it is null, and no phone or email unless given. */
const staffRow = (s: { id: string; name?: string | null; phone?: string | null; email?: string | null }) => ({
  id: s.id,
  name: s.name === undefined ? `موظف ${s.id}` : s.name,
  phone: s.phone ?? null,
  email: s.email ?? null,
  createdAt: NOW,
});

const membershipRow = (staff_id: string, clinic_id: string, role: string | null) => ({
  staff_id,
  clinic_id,
  role,
  createdAt: NOW,
});

/**
 * As admin, after a migrating start (c1 exists from 0002): clinic c2, the
 * four accounts and the three memberships. On main the insert of c2 succeeds
 * and the first insert into `staff` fails 42P01.
 */
async function buildFixture(db: TestDb): Promise<void> {
  await insert(db, "clinics", { id: "c2", name: "عيادة الاختبار الثانية", createdAt: NOW });
  for (const s of STAFF) await insert(db, "staff", staffRow(s));
  for (const m of MEMBERSHIPS) await insert(db, "memberships", membershipRow(m.staff_id, m.clinic_id, m.role));
}

/* ─── M3's check (shared with M4) ──────────────────────────────────────── */

/**
 * What one statement did: the SQLSTATE it failed with (null when it
 * succeeded) and the error's message, the number of rows it returned or
 * touched, the rows and their field names, and, for a SELECT with a `key`
 * column, the keys in order.
 */
type Outcome = {
  error: string | null;
  message: string | null;
  rowCount: number;
  rows: Record<string, unknown>[];
  fields: string[];
  keys: string[];
};

type Runner = { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> };

/**
 * Runs one statement and records what it did instead of throwing. Inside a
 * transaction it runs under a savepoint, so a refused statement doesn't
 * abort the rest of the check. The savepoint is rolled back either way: a
 * write that wrongly succeeds is recorded, and then undone, so it can't
 * change what the next statement sees.
 */
async function attempt(conn: Runner, inTransaction: boolean, sql: string, params: unknown[] = []): Promise<Outcome> {
  if (inTransaction) await conn.query("SAVEPOINT attempt");
  let outcome: Outcome;
  try {
    const res = await conn.query(sql, params);
    outcome = {
      error: null,
      message: null,
      rowCount: res.rowCount ?? 0,
      rows: res.rows,
      fields: res.fields.map((f) => f.name),
      keys: res.rows.map((r) => r.key as string).filter((k) => k !== undefined),
    };
  } catch (e) {
    const err = e as { code?: string; message: string };
    outcome = { error: err.code ?? err.message, message: err.message, rowCount: 0, rows: [], fields: [], keys: [] };
  }
  if (inTransaction) {
    await conn.query("ROLLBACK TO SAVEPOINT attempt");
    await conn.query("RELEASE SAVEPOINT attempt");
  }
  return outcome;
}

type Guarded = "staff" | "memberships";

const KEYS: Record<Guarded, string> = {
  staff: "SELECT id AS key FROM staff",
  memberships: "SELECT staff_id || '|' || clinic_id || '|' || role AS key FROM memberships",
};

/** What each clinic may see, from the fixture; and what it may not, asked for by name. */
const VISIBLE = {
  c1: {
    staff: ["s1"],
    memberships: ["s1|c1|owner"],
    hidden: { staff: "id IN ('s2','s3','s4')", memberships: "clinic_id = 'c2'" },
  },
  c2: {
    staff: ["s2", "s4"],
    memberships: ["s2|c2|therapist", "s4|c2|therapist"],
    hidden: { staff: "id IN ('s1','s3')", memberships: "clinic_id = 'c1'" },
  },
} as const;

/** Six writes as c1, each otherwise valid and inside c1. The app role holds no write privilege. */
const WRITES: { table: Guarded; label: string; sql: [string, unknown[]] }[] = [
  {
    table: "memberships",
    label: "INSERT (s3, c1, therapist)",
    sql: insertSql("memberships", membershipRow("s3", "c1", "therapist")),
  },
  {
    table: "memberships",
    label: "UPDATE role WHERE staff_id = 's1'",
    sql: [`UPDATE memberships SET role = 'therapist' WHERE staff_id = 's1'`, []],
  },
  {
    table: "memberships",
    label: "DELETE WHERE staff_id = 's1'",
    sql: [`DELETE FROM memberships WHERE staff_id = 's1'`, []],
  },
  {
    table: "staff",
    label: "INSERT s9",
    sql: insertSql("staff", staffRow({ id: "s9", phone: "+966500000009", email: null })),
  },
  {
    table: "staff",
    label: "UPDATE name WHERE id = 's1'",
    sql: [`UPDATE staff SET name = name WHERE id = 's1'`, []],
  },
  {
    table: "staff",
    label: "DELETE WHERE id = 's1'",
    sql: [`DELETE FROM staff WHERE id = 's1'`, []],
  },
];

/**
 * M3's check, through `pool` (one `mada_app` connection) on a database
 * holding the fixture: a transaction as c1, the next as c2, then the same
 * connection with no context. Every failure is collected as one line that
 * starts with the table's name, and they are thrown together (M4 relies on
 * that). An error without such a line means the setup itself is wrong.
 *
 * Two rules keep a check from passing for the wrong reason:
 *  - A read that "found nothing" only counts if it ran without an error; a
 *    permission error also returns no rows.
 *  - A refused write only counts if the missing privilege refused it: 42501
 *    with exactly "permission denied for table …". With a write privilege
 *    granted, row-level security refuses an insert into `staff` with 42501
 *    too, and other writes succeed, some touching no rows.
 */
async function checkStaffIsolation(pool: pg.Pool): Promise<void> {
  const failures: string[] = [];
  const told = (o: Outcome) => (o.error === null ? `ok, ${o.rowCount} row(s)` : `${o.error} ${o.message}`);
  const list = (keys: readonly string[]) => `[${keys.join(", ")}]`;

  /** The backend every phase must run on. */
  let pid: number | undefined;
  const samePid = (seen: number, phase: string) => {
    if (pid === undefined) pid = seen;
    else if (seen !== pid) throw new Error(`M3 setup: ${phase} ran on a second connection (${pid} → ${seen})`);
  };

  /** One transaction with the clinic set the way the app sets it. */
  const asClinic = async (clinic: "c1" | "c2", body: (client: pg.PoolClient) => Promise<void>) => {
    const client = await pool.connect();
    try {
      const [who] = (await client.query("SELECT current_user AS who, pg_backend_pid() AS pid")).rows;
      if (who.who !== APP_ROLE) throw new Error(`M3 setup: connected as ${who.who}, not ${APP_ROLE}`);
      samePid(who.pid, `the transaction as ${clinic}`);
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinic]);
      await body(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  /** As `clinic`: exactly its own rows, and none of the others' when asked for by name. */
  const reads = async (client: pg.PoolClient, clinic: "c1" | "c2") => {
    for (const table of ["staff", "memberships"] as const) {
      const want = VISIBLE[clinic][table];
      const all = await attempt(client, true, `${KEYS[table]} ORDER BY 1`);
      if (all.error !== null || JSON.stringify(all.keys) !== JSON.stringify(want)) {
        failures.push(`${table}: as ${clinic}, sees ${list(all.keys)}, not exactly ${list(want)} (${told(all)})`);
      }
      const where = VISIBLE[clinic].hidden[table];
      const others = await attempt(client, true, `${KEYS[table]} WHERE ${where} ORDER BY 1`);
      if (others.error !== null || others.rowCount > 0) {
        failures.push(`${table}: as ${clinic}, WHERE ${where} is not 0 rows without error (${told(others)})`);
      }
    }
  };

  await asClinic("c1", async (client) => {
    await reads(client, "c1");
    for (const w of WRITES) {
      const o = await attempt(client, true, ...w.sql);
      if (o.error !== "42501" || o.message !== `permission denied for table ${w.table}`) {
        failures.push(`${w.table}: as c1, ${w.label} wasn't refused with "permission denied for table ${w.table}" (${told(o)})`);
      }
    }
  });

  // The positive control: a dropped policy hides everything, which the c1
  // reads of c2's rows would call a pass.
  await asClinic("c2", (client) => reads(client, "c2"));

  // Through the pool again: with max 1 it hands back the same connection,
  // which is what makes this a check that the context didn't outlive COMMIT.
  const [again] = (await pool.query("SELECT pg_backend_pid() AS pid")).rows;
  samePid(again.pid, "the read with no context");
  for (const table of ["staff", "memberships"] as const) {
    const o = await attempt(pool, false, `${KEYS[table]} ORDER BY 1`);
    if (o.error !== null || o.rowCount > 0) {
      failures.push(`${table}: with no clinic set, is not 0 rows without error (${told(o)})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`M3: staff and memberships isolation does not hold:\n${failures.join("\n")}`);
  }
}

/** Runs M3's check on a database as `mada_app`, through one `pg.Pool` with `max: 1`, closed afterwards. */
async function checkStaffIsolationOn(appUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: appUrl, max: 1 });
  try {
    await checkStaffIsolation(pool);
  } finally {
    await pool.end();
  }
}

/* ─── M5, M6 ───────────────────────────────────────────────────────────── */

const LOOKUP = "SELECT * FROM sign_in_lookup($1)";
const LOOKUP_FIELDS = ["staff_id", "clinic_id", "role"];

/* ─── M8 ───────────────────────────────────────────────────────────────── */

const readMigration = (file: string) => readFileSync(path.join(ROOT, "migrations", file), "utf8");

/** Applies one migration the way the runner does: the file's text in one `query` call, inside BEGIN … COMMIT. */
async function applyAs(url: string, sqlText: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sqlText);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

/**
 * A fresh database owned by a new, random-named role with the given
 * attributes. Roles are cluster-wide and test files run in parallel, hence
 * the random name. Cleanups run in reverse: the database is dropped first,
 * then the role, which by then owns nothing.
 */
async function dbOwnedByNewRole(defer: (cleanup: () => unknown) => void, attributes: string) {
  const adminUrl = testDatabaseUrl();
  const role = `mada_test_owner_${randomBytes(4).toString("hex")}`;
  await runOn(adminUrl, `CREATE ROLE ${role} ${attributes}`);
  defer(() => runOn(adminUrl, `DROP ROLE IF EXISTS ${role}`));
  const db = await createTestDb();
  defer(db.drop);
  await runOn(adminUrl, `ALTER DATABASE ${db.name} OWNER TO ${role}`);
  return { db, role, url: asRole(db.ownerUrl, role) };
}

/** Applies the named files in order as `url`; "applied", or what the first failure said, per file. */
async function applyEach(url: string, files: string[]) {
  const out: Record<string, string> = {};
  for (const file of files) {
    const err = await pgError(() => applyAs(url, readMigration(file)));
    out[file] = err === null ? "applied" : `${err.code} ${err.message}`;
  }
  return out;
}

const applied = (files: string[]) => Object.fromEntries(files.map((f) => [f, "applied"]));

/* ─── Tests ────────────────────────────────────────────────────────────── */

describe("staff accounts and clinic membership (#43)", () => {
  it(
    "M1: an account's second membership fails 23505 on memberships_one_clinic_per_staff, and succeeds once that one constraint is dropped",
    () =>
      withMigratedDb(async ({ db, defer }) => {
        // Done-when 2: one clinic per account, as a single constraint that
        // can be lifted. The control drops only that constraint, on a copy:
        // if anything else enforced the rule, the insert would still fail.
        // On main the fixture's first insert into staff fails 42P01.
        await buildFixture(db);
        const second = insertSql("memberships", membershipRow("s1", "c2", "therapist"));

        expect(said(await pgError(() => db.query(...second))), "s1, already in c1, joins c2").toBe(
          "23505 memberships_one_clinic_per_staff",
        );

        const copy = await copyOf(db, "m1");
        defer(copy.drop);
        await runOn(copy.ownerUrl, `ALTER TABLE memberships DROP CONSTRAINT memberships_one_clinic_per_staff`);
        expect(
          said(await pgError(() => runOn(copy.ownerUrl, ...second))),
          "control: the same insert with the constraint dropped",
        ).toBe("accepted");
        expect(
          await runOn(copy.ownerUrl, `SELECT clinic_id, role FROM memberships WHERE staff_id = 's1' ORDER BY 1`),
          "control: s1's memberships with the constraint dropped",
        ).toEqual([
          { clinic_id: "c1", role: "owner" },
          { clinic_id: "c2", role: "therapist" },
        ]);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "M2: staff and memberships accept valid rows and refuse each invalid one by the named constraint or column",
    () =>
      withMigratedDb(async ({ db }) => {
        // As admin. Every rejected row is valid except for the one thing its
        // label names, so the constraint or column in the error is the proof.
        // The accepted membership comes last: before it, s3 has none, so the
        // rejected (s3, …) rows can't trip the one-clinic rule instead.
        // On main the fixture's first insert into staff fails 42P01.
        await buildFixture(db);

        const actual: Record<string, string> = {};
        const expected: Record<string, string> = {};
        let n = 0;
        const staff = async (
          label: string,
          want: string,
          values: { name?: string | null; phone?: string | null; email?: string | null },
        ) => {
          expected[label] = want;
          actual[label] = said(await pgError(() => insert(db, "staff", staffRow({ id: `m2_${n++}`, ...values }))));
        };
        const membership = async (label: string, want: string, staffId: string, clinicId: string, role: string | null) => {
          expected[label] = want;
          actual[label] = said(await pgError(() => insert(db, "memberships", membershipRow(staffId, clinicId, role))));
        };

        // Accepted.
        await staff("both phone and email", "accepted", { phone: "+966511110001", email: "both@clinic.test" });
        await staff("phone only, first (email NULL)", "accepted", { phone: "+966511110002" });
        await staff("phone only, second (two NULL emails coexist)", "accepted", { phone: "+966511110003" });
        await staff("email only, first (phone NULL)", "accepted", { email: "only1@clinic.test" });
        await staff("email only, second (two NULL phones coexist)", "accepted", { email: "only2@clinic.test" });
        await staff("phone +12345678 (shortest)", "accepted", { phone: "+12345678" });
        await staff("phone +123456789012345 (longest)", "accepted", { phone: "+123456789012345" });

        // Rejected.
        await staff("phone +966500000001 again, email NULL", "23505 staff_phone_key", { phone: "+966500000001" });
        await staff("email s1@clinic.test again, phone NULL", "23505 staff_email_key", { email: "s1@clinic.test" });
        await staff("phone NULL and email NULL", "23514 staff_phone_or_email", {});
        await staff("name NULL", "23502 name", { name: null, phone: "+966511110004" });
        for (const phone of [
          "0501234567",
          "+966 50 123 4567",
          "966501234567",
          "+0501234567",
          "+9665012",
          "+9665012345678901",
          "",
        ]) {
          await staff(`phone ${JSON.stringify(phone)}, email NULL`, "23514 staff_phone_format", { phone });
        }
        for (const email of [
          "S1@Clinic.test",
          " x@clinic.test",
          "x@clinic.test ",
          "xclinic.test",
          "x@y@clinic.test",
          "",
          "@clinic.test",
          "x@",
        ]) {
          await staff(`email ${JSON.stringify(email)}, phone NULL`, "23514 staff_email_format", { email });
        }
        await membership("membership (s3, c1) with role NULL", "23502 role", "s3", "c1", null);
        await membership("membership (s3, c1, admin)", "23514 memberships_role_check", "s3", "c1", "admin");
        await membership("membership (s3, zz, therapist)", "23503 memberships_clinic_id_fkey", "s3", "zz", "therapist");
        await membership("membership (zz, c1, therapist)", "23503 memberships_staff_id_fkey", "zz", "c1", "therapist");

        // Accepted, finally.
        await membership("membership (s3, c1, therapist)", "accepted", "s3", "c1", "therapist");

        expect(actual).toEqual(expected);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "M3: as c1, mada_app sees exactly c1's account and membership, none of c2's, and can't write either table; as c2 the same for c2; with no context nothing; staff is forced with one SELECT policy",
    () =>
      withMigratedDb(async ({ db }) => {
        // Done-when 1, at the database level, on one pooled connection reused
        // across the two transactions and after COMMIT. The check is the one
        // M4 breaks.
        // On main the fixture's first insert into staff fails 42P01.
        await buildFixture(db);
        await checkStaffIsolationOn(db.url);

        // Catalog, as admin. `staff` has no clinic_id, so R1 doesn't see it,
        // and the app role isn't its owner, so the check above passes with
        // or without FORCE.
        const flags = await db.query(
          `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relname = 'staff'`,
        );
        const policies = await db.query(
          `SELECT policyname, permissive, cmd, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'staff'`,
        );
        expect(
          {
            flags,
            policies: policies.map((p) => ({
              permissive: p.permissive,
              cmd: p.cmd,
              "qual mentions memberships": /\bmemberships\b/.test(p.qual ?? ""),
              "qual mentions app.clinic_id": /app\.clinic_id/.test(p.qual ?? ""),
            })),
          },
          JSON.stringify(policies),
        ).toEqual({
          flags: [{ rls: true, force: true }],
          policies: [
            { permissive: "PERMISSIVE", cmd: "SELECT", "qual mentions memberships": true, "qual mentions app.clinic_id": true },
          ],
        });
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "M4: with the staff or memberships policy dropped, or replaced by USING (true), M3's check fails and names that table",
    () =>
      withMigratedDb(async ({ db, defer }) => {
        // The permanent "fails before it passes" proof for M3: each broken
        // policy, on its own copy of the fixture database, must make the
        // check throw with a line for that table. The intact copy is the
        // control: a check that always throws would otherwise pass here.
        // Every pool is closed before the next copy is made.
        // On main the fixture's first insert into staff fails 42P01.
        await buildFixture(db);

        /** "passed", or the error, said in terms of `table`. */
        const outcome = async (appUrl: string, table?: Guarded) => {
          try {
            await checkStaffIsolationOn(appUrl);
            return "passed";
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (table && message.split("\n").some((line) => line.startsWith(`${table}: `))) return `threw, naming ${table}`;
            return `threw: ${message.slice(0, 300)}`;
          }
        };

        const actual: Record<string, string> = {};
        const expected: Record<string, string> = {};
        let n = 0;
        const copy = async () => {
          const c = await copyOf(db, `m4_${n++}`);
          defer(c.drop);
          return c;
        };

        const intact = await copy();
        expected["control: nothing changed"] = "passed";
        actual["control: nothing changed"] = await outcome(intact.appUrl);
        await intact.drop();

        const cases: { table: Guarded; mode: string; replacement?: string }[] = [
          { table: "staff", mode: "policy dropped" },
          { table: "staff", mode: "policy replaced by FOR SELECT USING (true)", replacement: "FOR SELECT USING (true)" },
          { table: "memberships", mode: "policy dropped" },
          { table: "memberships", mode: "policy replaced by FOR ALL USING (true)", replacement: "FOR ALL USING (true)" },
        ];
        for (const { table, mode, replacement } of cases) {
          const label = `${table}: ${mode}`;
          expected[label] = `threw, naming ${table}`;
          const c = await copy();
          // Found from the catalog, not by name.
          const found = await runOn(
            c.ownerUrl,
            `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}'`,
          );
          if (found.length === 0) {
            actual[label] = "no policy to break";
          } else {
            for (const p of found) await runOn(c.ownerUrl, `DROP POLICY ${q(p.policyname as string)} ON ${table}`);
            if (replacement) await runOn(c.ownerUrl, `CREATE POLICY m4_open ON ${table} ${replacement}`);
            actual[label] = await outcome(c.appUrl, table);
          }
          await c.drop();
        }
        expect(actual).toEqual(expected);
      }),
    SERVER_START_MS + 120_000,
  );

  it(
    "M5: with no clinic context, sign_in_lookup finds an account's clinic and role by its exact phone or email, returns nothing for anything else, and leaves no access behind",
    () =>
      withMigratedDb(async ({ db }) => {
        // Sign-in has to find an account before any clinic is known. As
        // mada_app, in one transaction that never sets app.clinic_id.
        // On main the fixture's first insert into staff fails 42P01.
        await buildFixture(db);

        const found: [string, { staff_id: string; clinic_id: string; role: string }][] = [
          ["+966500000001", { staff_id: "s1", clinic_id: "c1", role: "owner" }],
          ["s1@clinic.test", { staff_id: "s1", clinic_id: "c1", role: "owner" }],
          ["+966500000002", { staff_id: "s2", clinic_id: "c2", role: "therapist" }],
          ["s4@clinic.test", { staff_id: "s4", clinic_id: "c2", role: "therapist" }],
        ];
        // An unknown phone and email; a case-folded match; the LIKE
        // wildcards; nothing at all (s2 has a NULL email and s4 a NULL
        // phone, so a NULL-matches-NULL lookup would find them); an account
        // with no clinic; and ids, which are not identifiers.
        const notFound: (string | null)[] = [
          "+966599999999",
          "nobody@clinic.test",
          "S1@CLINIC.TEST",
          "%",
          "_",
          "",
          null,
          "s3@clinic.test",
          "s1",
          "c1",
        ];

        const actual: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        const client = new pg.Client({ connectionString: db.url });
        await client.connect();
        try {
          await client.query("BEGIN");
          const [who] = (await client.query("SELECT current_user AS who, current_setting('app.clinic_id', true) AS clinic")).rows;
          if (who.who !== APP_ROLE) throw new Error(`M5 setup: connected as ${who.who}, not ${APP_ROLE}`);
          if (who.clinic) throw new Error(`M5 setup: a clinic context is set (${who.clinic})`);

          const lookup = async (identifier: string | null) => {
            const o = await attempt(client, true, LOOKUP, [identifier]);
            return o.error === null ? { fields: o.fields, rows: o.rows } : { error: `${o.error} ${o.message}` };
          };
          for (const [identifier, row] of found) {
            const label = `sign_in_lookup(${JSON.stringify(identifier)})`;
            expected[label] = { fields: LOOKUP_FIELDS, rows: [row] };
            actual[label] = await lookup(identifier);
          }
          for (const identifier of notFound) {
            const label = `sign_in_lookup(${identifier === null ? "NULL" : JSON.stringify(identifier)})`;
            expected[label] = { fields: LOOKUP_FIELDS, rows: [] };
            actual[label] = await lookup(identifier);
          }

          // The function leaves no access behind.
          for (const table of ["staff", "memberships"] as const) {
            const label = `afterwards, in the same transaction: count(*) of ${table}`;
            const o = await attempt(client, true, `SELECT count(*)::int AS n FROM ${table}`);
            expected[label] = 0;
            actual[label] = o.error === null ? o.rows[0].n : `${o.error} ${o.message}`;
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          await client.end();
        }
        expect(actual).toEqual(expected);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "M6: sign_in_lookup(text) is SECURITY DEFINER and STABLE with search_path pinned to public, pg_temp and a schema-qualified body, and only mada_app (besides its owner) may execute it, or any function in public",
    () =>
      withMigratedDb(async ({ db, defer }) => {
        // No fixture: this reads the catalog and calls the function on empty
        // tables. A SECURITY DEFINER function runs as its owner, so who may
        // call it, and what its unqualified names resolve to, is the whole
        // of its safety.
        // On main to_regprocedure(…) is NULL.
        const [{ oid }] = await db.query(`SELECT to_regprocedure('public.sign_in_lookup(text)')::oid::int AS oid`);
        expect(oid, "to_regprocedure('public.sign_in_lookup(text)')").not.toBeNull();

        const [fn] = await db.query(
          `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) AS result, p.prosrc,
                  (SELECT count(*)::int FROM pg_proc x
                   WHERE x.pronamespace = 'public'::regnamespace AND x.proname = 'sign_in_lookup') AS named
           FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_in_lookup(text)')`,
        );
        const grants = await db.query(
          `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE COALESCE(r.rolname, a.grantee::text) END AS grantee,
                  a.privilege_type AS privilege
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(p.proacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
           WHERE p.oid = to_regprocedure('public.sign_in_lookup(text)') AND a.grantee <> p.proowner
           ORDER BY 1, 2`,
        );
        const callable = await db.query(
          `SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS fn FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('${APP_ROLE}', p.oid, 'EXECUTE')
           ORDER BY 1`,
        );
        const [schema] = await db.query(`SELECT has_schema_privilege('${APP_ROLE}', 'public', 'CREATE') AS "canCreate"`);
        const src: string = fn.prosrc ?? "";

        expect(
          {
            "functions in public named sign_in_lookup": fn.named,
            prosecdef: fn.prosecdef,
            provolatile: fn.provolatile,
            proconfig: fn.proconfig,
            pg_get_function_result: fn.result,
            "prosrc contains public.staff": src.includes("public.staff"),
            "prosrc contains public.memberships": src.includes("public.memberships"),
            "prosrc has FROM or JOIN followed directly by a bare staff or memberships":
              /\b(?:from|join)\s+"?(?:staff|memberships)\b/i.test(src),
            "grantees other than the owner": grants,
            "PUBLIC (grantee 0) holds a grant": grants.some((g) => g.grantee === "PUBLIC"),
            [`functions in public ${APP_ROLE} may execute`]: callable.map((r) => r.fn),
            [`${APP_ROLE} may CREATE in schema public`]: schema.canCreate,
          },
          `prosrc: ${src}`,
        ).toEqual({
          "functions in public named sign_in_lookup": 1,
          prosecdef: true,
          provolatile: "s",
          proconfig: ["search_path=public, pg_temp"],
          pg_get_function_result: "TABLE(staff_id text, clinic_id text, role text)",
          "prosrc contains public.staff": true,
          "prosrc contains public.memberships": true,
          "prosrc has FROM or JOIN followed directly by a bare staff or memberships": false,
          "grantees other than the owner": [{ grantee: APP_ROLE, privilege: "EXECUTE" }],
          "PUBLIC (grantee 0) holds a grant": false,
          [`functions in public ${APP_ROLE} may execute`]: ["sign_in_lookup(text)"],
          [`${APP_ROLE} may CREATE in schema public`]: false,
        });

        // A role with nothing but USAGE on the schema can't call it. Roles
        // are cluster-wide: this one is dropped with its grant, before
        // db.drop (cleanups run in reverse).
        const stranger = `mada_test_stranger_${randomBytes(4).toString("hex")}`;
        const adminUrl = testDatabaseUrl();
        await runOn(adminUrl, `CREATE ROLE ${stranger} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
        defer(async () => {
          await runOn(db.ownerUrl, `DROP OWNED BY ${stranger}`);
          await runOn(adminUrl, `DROP ROLE IF EXISTS ${stranger}`);
        });
        await db.query(`GRANT USAGE ON SCHEMA public TO ${stranger}`);

        const refused = await pgError(() => runOn(asRole(db.url, stranger), LOOKUP, ["nobody@clinic.test"]));
        expect({ code: refused?.code, message: refused?.message }, "a fresh role calls sign_in_lookup").toEqual({
          code: "42501",
          message: "permission denied for function sign_in_lookup",
        });

        let rows: unknown = null;
        const err = await pgError(async () => {
          rows = await runOn(db.url, LOOKUP, ["nobody@clinic.test"]);
        });
        expect({ error: err && said(err), rows }, `${APP_ROLE} calls sign_in_lookup('nobody@clinic.test')`).toEqual({
          error: null,
          rows: [],
        });
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "M7: as c1, mada_app's INSERT INTO clinics fails 42501, permission denied for table clinics",
    () =>
      withMigratedDb(async ({ db }) => {
        // Done-when 3: `clinics` stays read-only for the app role. No
        // fixture. Green on main by design: 0003 already grants only SELECT
        // on clinics, and R4 pins the grant itself. This is the statement
        // that starts succeeding if a later migration adds INSERT.
        const client = new pg.Client({ connectionString: db.url });
        await client.connect();
        let o: Outcome;
        try {
          const [who] = (await client.query("SELECT current_user AS who")).rows;
          if (who.who !== APP_ROLE) throw new Error(`M7 setup: connected as ${who.who}, not ${APP_ROLE}`);
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.clinic_id', $1, true)", ["c1"]);
          o = await attempt(client, true, ...insertSql("clinics", { id: "c9", name: "عيادة تاسعة", createdAt: NOW }));
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          await client.end();
        }
        expect({ error: o.error, message: o.message }, `INSERT INTO clinics as c1: ${o.rowCount} row(s)`).toEqual({
          error: "42501",
          message: "permission denied for table clinics",
        });
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "M8: 0004_staff.sql refuses a migrating role that is neither superuser nor BYPASSRLS with P0001, and under a BYPASSRLS owner it applies and the lookup works",
    () =>
      withCleanup(async (defer) => {
        // No server. A SECURITY DEFINER function runs as its owner, and
        // under FORCE only a superuser or a BYPASSRLS role reads past the
        // policies: with a plain owner the lookup would silently find
        // nobody. So the migration must refuse such an owner (a), and a
        // BYPASSRLS owner must really make the lookup work (b).
        // On main the control in (a) passes, then reading
        // migrations/0004_staff.sql throws ENOENT.
        const before = ["0001_init.sql", "0002_clinics.sql", "0003_rls.sql"];
        const staffMigration = "0004_staff.sql";

        // (a) A plain owner.
        const a = await dbOwnedByNewRole(defer, "LOGIN NOSUPERUSER NOBYPASSRLS");
        expect(await applyEach(a.url, before), `(a) control: 0001–0003 as ${a.role}`).toEqual(applied(before));
        const staffSql = readMigration(staffMigration);
        const refused = await pgError(() => applyAs(a.url, staffSql));
        const message = refused?.message ?? "";
        expect(
          {
            code: refused?.code ?? null,
            "message matches /superuser/i": /superuser/i.test(message),
            "message matches /BYPASSRLS/i": /BYPASSRLS/i.test(message),
            "message contains the role's name": message.includes(a.role),
          },
          `(a) ${staffMigration} as ${a.role}: ${refused === null ? "applied" : message}`,
        ).toEqual({
          code: "P0001",
          "message matches /superuser/i": true,
          "message matches /BYPASSRLS/i": true,
          "message contains the role's name": true,
        });

        // (b) A BYPASSRLS owner.
        const b = await dbOwnedByNewRole(defer, "LOGIN NOSUPERUSER BYPASSRLS");
        const all = [...before, staffMigration];
        expect(await applyEach(b.url, all), `(b) 0001–0004 as ${b.role}`).toEqual(applied(all));
        await insert(b.db, "staff", staffRow({ id: "b1", phone: "+966500000008", email: null }));
        await insert(b.db, "memberships", membershipRow("b1", "c1", "owner"));
        expect(
          await runOn(b.db.url, LOOKUP, ["+966500000008"]),
          `(b) ${APP_ROLE} calls sign_in_lookup with the account's phone`,
        ).toEqual([{ staff_id: "b1", clinic_id: "c1", role: "owner" }]);
      }),
    120_000,
  );
});
