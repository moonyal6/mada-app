import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
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

// L1–L12 of #45 (login codes: issue and check), at SQL level, written before
// the implementation, in a separate session, from the approved spec (v2, with
// the approval's amendments 2–4). PR 45-0 ships them with no migration, so
// every one is red on main by design, until 45a merges.
//
// What each does on main, before 0005_login_codes.sql exists:
//  - L1: the first statement fails 42P01 (relation "login_codes" does not
//    exist), not 42501.
//  - L2: to_regprocedure('public.login_code_issue(text,text,text)') is NULL.
//  - L3–L11: the fixture inserts succeed, then the first call fails 42883
//    (function does not exist).
//  - L12: the 0001–0004 control passes, then reading
//    migrations/0005_login_codes.sql throws ENOENT.
//
// "As admin" is the harness's superuser (`db.query`). "As app" is `mada_app`
// (`db.url`): one statement per connection, in autocommit, never setting
// app.clinic_id. Every call of the two functions is made as app.
//
// Time is never slept through. The database clock is the only clock, so a
// test moves rows into the past as admin (`ageCodes`, `ageEvents`). A window
// is pinned from both sides: at 14 minutes the refusal must hold, and 1
// minute 1 second later it must be gone.
//
// The helpers `runOn`, `copyOf`, `asRole`, `applyAs`, `applyEach` and
// `dbOwnedByNewRole` follow the ones in pg-staff.test.ts and
// pg-founder.test.ts, and nothing is shared. A migrated database here is a
// template copy of one database migrated once in this file, by a server
// start, the first time a test asks for one.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A test on template copies: the first one in a run also pays for the migrating server start. */
const MIGRATED_MS = SERVER_START_MS + 60_000;
/** L9: six copies, and up to 40 connections at once. */
const RACES_MS = SERVER_START_MS + 180_000;
/** A test with no server. */
const NO_SERVER_MS = 120_000;

const NOW = "2026-11-26T09:00:00.000Z";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = Record<string, unknown>;
type Defer = (cleanup: () => unknown) => void;

/** What the tests need of a database: the harness's TestDb, or a template copy. */
type Db = {
  name: string;
  /** `mada_app` on it. */
  url: string;
  /** The admin on it. */
  ownerUrl: string;
  /** One statement as admin, on its own connection. */
  query: (sql: string, params?: unknown[]) => Promise<Row[]>;
};

/* ─── Connections ──────────────────────────────────────────────────────── */

/** Runs one statement on its own connection. */
async function runOn(connectionString: string, sql: string, params?: unknown[]): Promise<Row[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as Row[];
  } finally {
    await client.end();
  }
}

/** `url` with another role as its user. Trust auth locally and in CI, so no password. */
function asRole(url: string, role: string) {
  const u = new URL(url);
  u.username = role;
  u.password = "";
  return u.href;
}

type PgErr = { code?: string; constraint?: string; message: string };

/** The Postgres error a statement fails with, or null when it succeeds. */
async function pgError(run: () => Promise<unknown>): Promise<PgErr | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const err = e as PgErr;
    return { code: err.code, constraint: err.constraint, message: err.message };
  }
}

/**
 * What a statement did, in the terms the spec asserts: the SQLSTATE, plus
 * the constraint for 23514 and 23503, and the message for anything else.
 */
function said(err: PgErr | null): string {
  if (err === null) return "accepted";
  if (err.code === "23514" || err.code === "23503") return `${err.code} ${err.constraint}`;
  return `${err.code} ${err.message}`;
}

/* ─── Databases ────────────────────────────────────────────────────────── */

/** The one database a server migrates in this file; every migrated database is a copy of it. */
let template: Promise<TestDb> | undefined;

/**
 * A fresh database migrated (and seeded with c1 and the demo rows) by one
 * server start and GET /api/patients. Built once, by the first test that
 * needs it; a failed build fails every such test with the same error.
 */
function migratedTemplate(): Promise<TestDb> {
  template ??= (async () => {
    const db = await createTestDb();
    try {
      await withCleanup(async (defer) => {
        const dataDir = makeDataDir();
        defer(() => rmSync(dataDir, { recursive: true, force: true }));
        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
        defer(server.stop);
        const res = await request(server.base, "GET", "/api/patients");
        expect(
          res.status,
          `migrating start as ${APP_ROLE}, GET /api/patients: ${JSON.stringify(res.body).slice(0, 300)}`,
        ).toBe(200);
      });
    } catch (e) {
      await db.drop();
      throw e;
    }
    return db;
  })();
  return template;
}

/** A copy of `db` (CREATE DATABASE … TEMPLATE): schema, grants, policies and rows. */
async function copyOf(db: TestDb, suffix: string): Promise<Db & { drop: () => Promise<unknown> }> {
  const admin = testDatabaseUrl();
  const name = `${db.name}_${suffix}`;
  // A connection that has just closed can still hold the template for a
  // moment (55006: "being accessed by other users").
  for (let tries = 0; ; tries++) {
    try {
      await runOn(admin, `CREATE DATABASE ${name} TEMPLATE ${db.name}`);
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
  const ownerUrl = withName(db.ownerUrl);
  return {
    name,
    url: withName(db.url),
    ownerUrl,
    query: (sql, params) => runOn(ownerUrl, sql, params),
    drop: () => runOn(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/** One migrated database: c1, the demo seed, and no account. `tag` keeps the copies' names apart. */
async function migratedDb(defer: Defer, tag: string): Promise<Db> {
  const db = await copyOf(await migratedTemplate(), tag);
  defer(db.drop);
  return db;
}

/* ─── Fixture ──────────────────────────────────────────────────────────── */

const S1_PHONE = "+966500000001";
const S1_EMAIL = "s1@clinic.test";
const S2_PHONE = "+966500000002";
const S3_EMAIL = "s3@clinic.test";
const UNKNOWN_PHONE = "+966599999999";
const UNKNOWN_EMAIL = "nobody@clinic.test";

const STAFF = [
  { id: "s1", name: "موظف أول", phone: S1_PHONE, email: S1_EMAIL },
  { id: "s2", name: "موظف ثان", phone: S2_PHONE, email: null },
  { id: "s3", name: "موظف ثالث", phone: null, email: S3_EMAIL },
];

/** s3 has no membership. */
const MEMBERSHIPS = [
  { staff_id: "s1", clinic_id: "c1", role: "owner" },
  { staff_id: "s2", clinic_id: "c2", role: "therapist" },
];

const insertStaff = (db: Db, s: { id: string; name: string; phone: string | null; email: string | null }) =>
  db.query(`INSERT INTO staff(id, name, phone, email, "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
    s.id,
    s.name,
    s.phone,
    s.email,
    NOW,
  ]);

const insertMembership = (db: Db, m: { staff_id: string; clinic_id: string; role: string }) =>
  db.query(`INSERT INTO memberships(staff_id, clinic_id, role, "createdAt") VALUES ($1, $2, $3, $4)`, [
    m.staff_id,
    m.clinic_id,
    m.role,
    NOW,
  ]);

/**
 * As admin (c1 exists from 0002): clinic c2, the three accounts and the two
 * memberships. These inserts succeed on main.
 */
async function buildFixture(db: Db): Promise<void> {
  await db.query(`INSERT INTO clinics(id, name, "createdAt") VALUES ($1, $2, $3)`, ["c2", "عيادة الاختبار الثانية", NOW]);
  for (const s of STAFF) await insertStaff(db, s);
  for (const m of MEMBERSHIPS) await insertMembership(db, m);
}

/** A migrated database holding the fixture. */
async function fixtureDb(defer: Defer, tag: string): Promise<Db> {
  const db = await migratedDb(defer, tag);
  await buildFixture(db);
  return db;
}

/* ─── The two functions, as app ────────────────────────────────────────── */

/** SQL-level hashes are fixed strings: one hex character, 64 times. */
const hashOf = (hexChar: string) => hexChar.repeat(64);
const HA = hashOf("a");
const HB = hashOf("b");
const HC = hashOf("c");
const HD = hashOf("d");
const HE = hashOf("e");
const H1 = hashOf("1");
const H2 = hashOf("2");
const H3 = hashOf("3");
const H4 = hashOf("4");
const H5 = hashOf("5");
/** One of 256 distinct hashes, for the races. */
const hashNo = (i: number) => i.toString(16).padStart(2, "0").repeat(32);

/** The address most calls come from. */
const IP = "198.51.100.1";

const ISSUE = "SELECT login_code_issue($1, $2, $3) AS outcome";
const CHECK = "SELECT * FROM login_code_check($1, $2, $3)";
const CHECK_FIELDS = ["outcome", "staff_id", "clinic_id", "role"];

type Args = [identifier: string | null, ip: string | null, codeHash: string | null];

/** The arguments, short enough to read in a failure. */
const shown = (args: Args) =>
  args.map((a) => (a === null ? "NULL" : a.length >= 60 ? `'${a.slice(0, 2)}…'×${a.length}` : `'${a}'`)).join(", ");

/**
 * One statement as app, on its own connection, in autocommit. A failure says
 * which call it was and keeps the SQLSTATE: on main that is 42883.
 */
async function asApp(db: { url: string }, label: string, sql: string, params: unknown[]): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } catch (e) {
    const err = e as PgErr;
    throw new Error(`${label} failed: ${err.code} ${err.message}`);
  } finally {
    await client.end();
  }
}

/** login_code_issue as app: `issued`, `none` or `limited`. */
async function issue(db: { url: string }, ...args: Args): Promise<unknown> {
  const res = await asApp(db, `login_code_issue(${shown(args)})`, ISSUE, args);
  if (res.rows.length !== 1) throw new Error(`login_code_issue(${shown(args)}) returned ${res.rows.length} rows, not 1`);
  return res.rows[0].outcome;
}

/** login_code_check as app: its one row, and the result's field names. */
async function checkResult(db: { url: string }, ...args: Args): Promise<{ row: Row; fields: string[] }> {
  const res = await asApp(db, `login_code_check(${shown(args)})`, CHECK, args);
  if (res.rows.length !== 1) throw new Error(`login_code_check(${shown(args)}) returned ${res.rows.length} rows, not 1`);
  return { row: res.rows[0], fields: res.fields.map((f) => f.name) };
}

/** login_code_check as app: its one row. */
const check = async (db: { url: string }, ...args: Args) => (await checkResult(db, ...args)).row;

const INVALID = { outcome: "invalid", staff_id: null, clinic_id: null, role: null };
const BLOCKED = { outcome: "blocked", staff_id: null, clinic_id: null, role: null };
const ok = (staff_id: string, clinic_id: string, role: string) => ({ outcome: "ok", staff_id, clinic_id, role });

/* ─── Reading and ageing rows, as admin ────────────────────────────────── */

/** Every code row, oldest first: whose it is, its hash, whether it is unused, and its lifetime in seconds. */
const codes = (db: Db) =>
  db.query(
    `SELECT staff_id, code_hash, used_at IS NULL AS unused,
            EXTRACT(EPOCH FROM expires_at - created_at)::float8 AS lifetime_s
     FROM login_codes ORDER BY id`,
  );

/** How many code rows there are, and how many of them are unused. */
async function codeCounts(db: Db) {
  const [row] = await db.query(
    `SELECT count(*)::int AS rows, (count(*) FILTER (WHERE used_at IS NULL))::int AS unused FROM login_codes`,
  );
  return row;
}

/** Every event, oldest first. */
const events = (db: Db) => db.query(`SELECT kind, identifier, ip FROM login_events ORDER BY id`);

/** How many events of one kind exist, for one identifier or in all. */
async function eventCount(db: Db, kind: "request" | "failure", identifier?: string): Promise<unknown> {
  const [row] =
    identifier === undefined
      ? await db.query(`SELECT count(*)::int AS n FROM login_events WHERE kind = $1`, [kind])
      : await db.query(`SELECT count(*)::int AS n FROM login_events WHERE kind = $1 AND identifier = $2`, [kind, identifier]);
  return row.n;
}

/** "Age codes by X": every code was issued, and expires, X earlier. */
const ageCodes = (db: Db, by: string) =>
  db.query(`UPDATE login_codes SET created_at = created_at - $1::interval, expires_at = expires_at - $1::interval`, [by]);

/** "Age events by X": every event happened X earlier. Codes stay alive. */
const ageEvents = (db: Db, by: string) => db.query(`UPDATE login_events SET at = at - $1::interval`, [by]);

/** Just inside a 15-minute window, and then past its end: the margin on each side is 60 seconds. */
const NEARLY = "14 minutes";
const THE_REST = "1 minute 1 second";

/* ─── Steps ────────────────────────────────────────────────────────────── */

/**
 * A test's steps, in order, each with what it gave and what the spec says it
 * gives; `verify` compares them all at once, so a failure shows the whole
 * sequence. A call that throws (on main: 42883) fails the test where it is.
 */
function steps() {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  let n = 0;
  return {
    note(label: string, got: unknown, want: unknown) {
      const key = `${String(++n).padStart(2, "0")}. ${label}`;
      actual[key] = got;
      expected[key] = want;
    },
    verify() {
      expect(actual).toEqual(expected);
    },
  };
}

/* ─── L9 ───────────────────────────────────────────────────────────────── */

/**
 * Sends every call at once, each on its own app connection. The connections
 * are all opened first, and only then are the calls sent, in one tick:
 * opening inside the race staggers the calls and hides a missing lock.
 * Returns each call's outcome, in the order given.
 *
 * Each connection carries a statement timeout as a connection setting (no
 * statement is spent on it): calls that wait on each other for ever, as they
 * would behind a lock that outlives its transaction, then fail with 57014
 * instead of hanging until the test's own limit and leaking its databases.
 */
async function together(db: Db, label: string, sql: string, calls: Args[]): Promise<unknown[]> {
  const clients = calls.map(() => new pg.Client({ connectionString: db.url, statement_timeout: 60_000 }));
  try {
    const opened = await Promise.allSettled(clients.map((c) => c.connect()));
    const refused = opened.find((o) => o.status === "rejected");
    if (refused) {
      const err = (refused as PromiseRejectedResult).reason as PgErr;
      throw new Error(`${label}: opening ${calls.length} connections failed: ${err.code} ${err.message}`);
    }
    const settled = await Promise.allSettled(clients.map((c, i) => c.query(sql, calls[i])));
    return settled.map((s, i) => {
      if (s.status === "rejected") {
        const err = s.reason as PgErr;
        throw new Error(`${label}: call ${i + 1} (${shown(calls[i])}) failed: ${err.code} ${err.message}`);
      }
      return s.value.rows[0]?.outcome;
    });
  } finally {
    await Promise.allSettled(clients.map((c) => c.end()));
  }
}

/** How many times each outcome came back. */
function tally(outcomes: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of outcomes) out[String(o)] = (out[String(o)] ?? 0) + 1;
  return out;
}

/** `count` addresses, all different. */
const manyIps = (count: number) => Array.from({ length: count }, (_, i) => `198.51.100.${i + 1}`);
/** `count` emails nobody has, all different. */
const manyUnknownEmails = (count: number) => Array.from({ length: count }, (_, i) => `unknown${i + 1}@clinic.test`);

/* ─── L12 ──────────────────────────────────────────────────────────────── */

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
async function dbOwnedByNewRole(defer: Defer, attributes: string) {
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

describe("login codes: issue and check, at SQL level (#45)", () => {
  afterAll(async () => {
    if (template === undefined) return;
    const db = await template.catch(() => null);
    await db?.drop();
  }, 60_000);

  it(
    "L1: mada_app can't read or write login_codes or login_events (42501), both are forced under row-level security with no policy and no grant, and they refuse a plain code, an unknown staff_id and an unknown kind",
    () =>
      withCleanup(async (defer) => {
        // The two tables are reached only through the two functions (D5):
        // the app role holds no privilege on them at all, and the hash
        // column can't hold a plain code.
        // On main the first statement fails 42P01, not 42501.
        const db = await fixtureDb(defer, "l1");

        const refused = steps();
        const statements: { table: string; label: string; sql: string; params?: unknown[] }[] = [
          { table: "login_codes", label: "SELECT", sql: `SELECT * FROM login_codes` },
          {
            table: "login_codes",
            label: "INSERT",
            sql: `INSERT INTO login_codes(staff_id, code_hash, created_at, expires_at)
                  VALUES ('s1', $1, now(), now() + interval '10 minutes')`,
            params: [HA],
          },
          { table: "login_codes", label: "UPDATE", sql: `UPDATE login_codes SET used_at = now()` },
          { table: "login_codes", label: "DELETE", sql: `DELETE FROM login_codes` },
          { table: "login_events", label: "SELECT", sql: `SELECT * FROM login_events` },
          {
            table: "login_events",
            label: "INSERT",
            sql: `INSERT INTO login_events(kind, identifier, ip, at) VALUES ('request', $1, $2, now())`,
            params: [S1_PHONE, IP],
          },
          { table: "login_events", label: "UPDATE", sql: `UPDATE login_events SET at = now()` },
          { table: "login_events", label: "DELETE", sql: `DELETE FROM login_events` },
        ];
        for (const s of statements) {
          // The missing privilege must be what refuses it: with a privilege
          // granted, row-level security refuses an insert with 42501 too,
          // under another message.
          refused.note(
            `as ${APP_ROLE}: ${s.label} on ${s.table}`,
            said(await pgError(() => runOn(db.url, s.sql, s.params))),
            `42501 permission denied for table ${s.table}`,
          );
        }
        refused.verify();

        // Catalog, as admin.
        const flags = await db.query(
          `SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                  (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('login_codes', 'login_events')
           ORDER BY 1`,
        );
        const [sequences] = await db.query(
          `SELECT pg_get_serial_sequence('public.login_codes', 'id') AS codes,
                  pg_get_serial_sequence('public.login_events', 'id') AS events`,
        );
        // What the app role holds, itself or through PUBLIC, on the two
        // tables, their columns and their sequences.
        const relationGrants = await db.query(
          `SELECT c.relname AS relation, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
                  a.privilege_type AS privilege
           FROM pg_class c
           CROSS JOIN LATERAL aclexplode(c.relacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
           WHERE c.oid IN (to_regclass('public.login_codes'), to_regclass('public.login_events'),
                           to_regclass($1), to_regclass($2))
             AND (a.grantee = 0 OR r.rolname = $3)
           ORDER BY 1, 2, 3`,
          [sequences.codes, sequences.events, APP_ROLE],
        );
        const columnGrants = await db.query(
          `SELECT c.relname || '.' || at.attname AS "column", CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
                  a.privilege_type AS privilege
           FROM pg_attribute at
           JOIN pg_class c ON c.oid = at.attrelid
           CROSS JOIN LATERAL aclexplode(at.attacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
           WHERE c.oid IN (to_regclass('public.login_codes'), to_regclass('public.login_events'))
             AND (a.grantee = 0 OR r.rolname = $1)
           ORDER BY 1, 2, 3`,
          [APP_ROLE],
        );
        expect({
          flags,
          "login_codes.id has a sequence": sequences.codes !== null,
          "login_events.id has a sequence": sequences.events !== null,
          [`grants to ${APP_ROLE} or PUBLIC on the tables and their sequences`]: relationGrants,
          [`column grants to ${APP_ROLE} or PUBLIC`]: columnGrants,
        }).toEqual({
          flags: [
            { table: "login_codes", rls: true, force: true, policies: 0 },
            { table: "login_events", rls: true, force: true, policies: 0 },
          ],
          "login_codes.id has a sequence": true,
          "login_events.id has a sequence": true,
          [`grants to ${APP_ROLE} or PUBLIC on the tables and their sequences`]: [],
          [`column grants to ${APP_ROLE} or PUBLIC`]: [],
        });

        // Three bad inserts, as admin. Each row is valid but for the one
        // thing its label names, so the constraint in the error is the proof.
        const bad = steps();
        const insertCode = `INSERT INTO login_codes(staff_id, code_hash, created_at, expires_at)
                            VALUES ($1, $2, now(), now() + interval '10 minutes')`;
        bad.note(
          "code_hash = '12345678' (a plain code)",
          said(await pgError(() => db.query(insertCode, ["s1", "12345678"]))),
          "23514 login_codes_code_hash_format",
        );
        bad.note(
          "staff_id = 'zz' (no such account)",
          said(await pgError(() => db.query(insertCode, ["zz", HA]))),
          "23503 login_codes_staff_id_fkey",
        );
        bad.note(
          "kind = 'x'",
          said(
            await pgError(() =>
              db.query(`INSERT INTO login_events(kind, identifier, ip, at) VALUES ('x', $1, $2, now())`, [S1_PHONE, IP]),
            ),
          ),
          "23514 login_events_kind_check",
        );
        bad.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L2: login_code_issue and login_code_check are SECURITY DEFINER and VOLATILE with search_path pinned and a schema-qualified body, take transaction-level locks, read the clock once, and only mada_app (besides the owner) may execute them",
    () =>
      withCleanup(async (defer) => {
        // No fixture: this reads the catalog and calls the functions with an
        // identifier nobody has. A SECURITY DEFINER function runs as its
        // owner, so who may call it, and what its unqualified names resolve
        // to, is the whole of its safety.
        // On main to_regprocedure('public.login_code_issue(text,text,text)')
        // is NULL.
        const db = await migratedDb(defer, "l2");
        const functions = [
          { name: "login_code_issue", signature: "public.login_code_issue(text,text,text)", result: "text" },
          {
            name: "login_code_check",
            signature: "public.login_code_check(text,text,text)",
            result: "TABLE(outcome text, staff_id text, clinic_id text, role text)",
          },
        ];
        for (const f of functions) {
          const [{ oid }] = await db.query(`SELECT to_regprocedure($1)::oid::int AS oid`, [f.signature]);
          expect(oid, `to_regprocedure('${f.signature}')`).not.toBeNull();
        }

        const TABLE_NAMES = ["login_codes", "login_events", "staff", "memberships"];
        const unqualified = new RegExp(`\\b(?:from|join|into|update)\\s+"?(?:${TABLE_NAMES.join("|")})\\b`, "i");

        for (const f of functions) {
          const [fn] = await db.query(
            `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) AS result,
                    pg_get_function_identity_arguments(p.oid) AS arguments, p.prosrc,
                    (SELECT count(*)::int FROM pg_proc x
                     WHERE x.pronamespace = 'public'::regnamespace AND x.proname = $2) AS named
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [f.signature, f.name],
          );
          const grants = await db.query(
            `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE COALESCE(r.rolname, a.grantee::text) END AS grantee,
                    a.privilege_type AS privilege
             FROM pg_proc p
             CROSS JOIN LATERAL aclexplode(p.proacl) a
             LEFT JOIN pg_roles r ON r.oid = a.grantee
             WHERE p.oid = to_regprocedure($1) AND a.grantee <> p.proowner
             ORDER BY 1, 2`,
            [f.signature],
          );
          const src = (fn.prosrc as string | null) ?? "";

          expect(
            {
              [`functions in public named ${f.name}`]: fn.named,
              prosecdef: fn.prosecdef,
              provolatile: fn.provolatile,
              proconfig: fn.proconfig,
              pg_get_function_result: fn.result,
              pg_get_function_identity_arguments: fn.arguments,
              ...Object.fromEntries(TABLE_NAMES.map((t) => [`prosrc contains public.${t}`, src.includes(`public.${t}`)])),
              "prosrc has FROM, JOIN, INTO or UPDATE followed directly by one of those names unqualified": unqualified.test(src),
              "prosrc contains pg_advisory_xact_lock": src.includes("pg_advisory_xact_lock"),
              "prosrc matches /pg_advisory_lock\\s*\\(/i (a session-level lock)": /pg_advisory_lock\s*\(/i.test(src),
              "times prosrc reads clock_timestamp": (src.match(/clock_timestamp/gi) ?? []).length,
              "grantees other than the owner": grants,
              "PUBLIC (grantee 0) holds a grant": grants.some((g) => g.grantee === "PUBLIC"),
            },
            `${f.name} prosrc: ${src}`,
          ).toEqual({
            [`functions in public named ${f.name}`]: 1,
            prosecdef: true,
            provolatile: "v",
            proconfig: ["search_path=public, pg_temp"],
            pg_get_function_result: f.result,
            pg_get_function_identity_arguments: "p_identifier text, p_ip text, p_code_hash text",
            ...Object.fromEntries(TABLE_NAMES.map((t) => [`prosrc contains public.${t}`, true])),
            "prosrc has FROM, JOIN, INTO or UPDATE followed directly by one of those names unqualified": false,
            "prosrc contains pg_advisory_xact_lock": true,
            "prosrc matches /pg_advisory_lock\\s*\\(/i (a session-level lock)": false,
            "times prosrc reads clock_timestamp": 1,
            "grantees other than the owner": [{ grantee: APP_ROLE, privilege: "EXECUTE" }],
            "PUBLIC (grantee 0) holds a grant": false,
          });
        }

        // A role with nothing but USAGE on the schema can't call either.
        // Roles are cluster-wide: this one is dropped with its grant, before
        // the database (cleanups run in reverse).
        const stranger = `mada_test_stranger_${randomBytes(4).toString("hex")}`;
        const adminUrl = testDatabaseUrl();
        await runOn(adminUrl, `CREATE ROLE ${stranger} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
        defer(async () => {
          await runOn(db.ownerUrl, `DROP OWNED BY ${stranger}`);
          await runOn(adminUrl, `DROP ROLE IF EXISTS ${stranger}`);
        });
        await db.query(`GRANT USAGE ON SCHEMA public TO ${stranger}`);
        const strangerUrl = asRole(db.url, stranger);
        const args: Args = [UNKNOWN_EMAIL, IP, HA];
        expect(
          {
            login_code_issue: said(await pgError(() => runOn(strangerUrl, ISSUE, args))),
            login_code_check: said(await pgError(() => runOn(strangerUrl, CHECK, args))),
          },
          "a fresh role with only USAGE on public calls each function",
        ).toEqual({
          login_code_issue: "42501 permission denied for function login_code_issue",
          login_code_check: "42501 permission denied for function login_code_check",
        });

        // One held app connection, in autocommit: an advisory lock taken at
        // session level would still be there after the two calls, and would
        // stay on a pooled connection.
        const held = new pg.Client({ connectionString: db.url });
        await held.connect();
        try {
          const [who] = (await held.query("SELECT current_user AS who")).rows;
          if (who.who !== APP_ROLE) throw new Error(`L2 setup: connected as ${who.who}, not ${APP_ROLE}`);
          const issued = await held.query(ISSUE, args);
          const checked = await held.query(CHECK, args);
          const [locks] = (
            await held.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
            )
          ).rows;
          expect(
            {
              "rows the issue call returned": issued.rows.length,
              "rows the check call returned": checked.rows.length,
              "advisory locks this backend still holds": locks.n,
            },
            `issue: ${JSON.stringify(issued.rows)}, check: ${JSON.stringify(checked.rows)}`,
          ).toEqual({
            "rows the issue call returned": 1,
            "rows the check call returned": 1,
            "advisory locks this backend still holds": 0,
          });
        } finally {
          await held.end();
        }
      }),
    MIGRATED_MS,
  );

  it(
    "L3: a code is issued for 10 minutes, a wrong code and another identifier's check fail, the right code works once, by phone or email, and returns the account's clinic and role",
    () =>
      withCleanup(async (defer) => {
        // Done-when 1. Every call comes from one address. The steps added by
        // the approval: the code is bound to the identifier's account
        // (amendment 2), a correct code does not clear earlier failures
        // (amendment 3), and a count sees only its own kind of event
        // (amendment 4).
        // On main the first call fails 42883.
        const db = await fixtureDb(defer, "l3");
        const s = steps();

        s.note(`issue (${S1_PHONE}, HA)`, await issue(db, S1_PHONE, IP, HA), "issued");
        s.note("the one code row", await codes(db), [{ staff_id: "s1", code_hash: HA, unused: true, lifetime_s: 600 }]);

        s.note(`check HA as ${S2_PHONE} (another account)`, await check(db, S2_PHONE, IP, HA), INVALID);
        s.note(`check HA as ${UNKNOWN_PHONE} (nobody)`, await check(db, UNKNOWN_PHONE, IP, HA), INVALID);
        s.note("code rows, unused, after the two", await codeCounts(db), { rows: 1, unused: 1 });

        s.note("check HB (a wrong code)", await check(db, S1_PHONE, IP, HB), INVALID);
        s.note("code rows, unused, after the wrong code", await codeCounts(db), { rows: 1, unused: 1 });

        const first = await checkResult(db, S1_PHONE, IP, HA);
        s.note("check HA", first.row, ok("s1", "c1", "owner"));
        s.note("the result's fields", first.fields, CHECK_FIELDS);
        s.note("code rows, unused, after the right code", await codeCounts(db), { rows: 1, unused: 0 });

        s.note("check HA again", await check(db, S1_PHONE, IP, HA), INVALID);
        s.note(`failure events for ${S1_PHONE}`, await eventCount(db, "failure", S1_PHONE), 2);

        // Two failures and one request so far for this phone: a request cap
        // that counted both kinds would refuse here.
        s.note(`issue (${S1_PHONE}, HE)`, await issue(db, S1_PHONE, IP, HE), "issued");

        s.note(`issue (${S1_EMAIL}, HC)`, await issue(db, S1_EMAIL, IP, HC), "issued");
        s.note(`check HC as ${S1_EMAIL}`, await check(db, S1_EMAIL, IP, HC), ok("s1", "c1", "owner"));

        s.note(`issue (${S2_PHONE}, HD)`, await issue(db, S2_PHONE, IP, HD), "issued");
        s.note(`check HD as ${S2_PHONE}`, await check(db, S2_PHONE, IP, HD), ok("s2", "c2", "therapist"));
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L4: a code works at 9 minutes and not at 10 minutes 1 second, and a newer code replaces an older one for the same account",
    () =>
      withCleanup(async (defer) => {
        // Expiry is by the database clock (D2), and an account has at most
        // one usable code, whichever identifier asked for it (D3).
        // On main the first call fails 42883.
        const s = steps();

        const a = await fixtureDb(defer, "l4a");
        s.note("(a) issue", await issue(a, S1_PHONE, IP, HA), "issued");
        await ageCodes(a, "9 minutes");
        s.note("(a) check at 9 minutes", await check(a, S1_PHONE, IP, HA), ok("s1", "c1", "owner"));

        const b = await fixtureDb(defer, "l4b");
        s.note("(b) issue", await issue(b, S1_PHONE, IP, HA), "issued");
        await ageCodes(b, "10 minutes 1 second");
        s.note("(b) check at 10 minutes 1 second", await check(b, S1_PHONE, IP, HA), INVALID);
        s.note("(b) code rows, unused", await codeCounts(b), { rows: 1, unused: 1 });
        s.note("(b) failure events", await eventCount(b, "failure"), 1);

        const c = await fixtureDb(defer, "l4c");
        s.note("(c) issue HA by phone", await issue(c, S1_PHONE, IP, HA), "issued");
        s.note("(c) issue HB by email", await issue(c, S1_EMAIL, IP, HB), "issued");
        s.note("(c) code rows, unused, before the checks", await codeCounts(c), { rows: 2, unused: 1 });
        s.note("(c) check HA by phone (replaced)", await check(c, S1_PHONE, IP, HA), INVALID);
        s.note("(c) check HB by email", await check(c, S1_EMAIL, IP, HB), ok("s1", "c1", "owner"));
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L5: an unknown identifier, an account with no membership, another letter case and a pattern get 'none' and no code, are recorded as passed, and fail every check like a known account with no code",
    () =>
      withCleanup(async (defer) => {
        // Done-when 3, at SQL level: nothing about the answer or the
        // bookkeeping depends on whether the account exists (D6), and
        // matching is plain `=`.
        // On main the first call fails 42883.
        const db = await fixtureDb(defer, "l5");
        const s = steps();

        // Each call from its own address, so "the IP as passed" can be told apart.
        const identifiers = [UNKNOWN_PHONE, UNKNOWN_EMAIL, S3_EMAIL, "S1@CLINIC.TEST", "%"];
        const issueIps = identifiers.map((_, i) => `198.51.100.${i + 1}`);
        const checked = [...identifiers, S2_PHONE];
        const checkIps = checked.map((_, i) => `203.0.113.${i + 1}`);

        for (const [i, identifier] of identifiers.entries()) {
          s.note(`issue for ${identifier}`, await issue(db, identifier, issueIps[i], HA), "none");
        }
        s.note("code rows after the issues", await codes(db), []);
        const requests = identifiers.map((identifier, i) => ({ kind: "request", identifier, ip: issueIps[i] }));
        s.note("events after the issues", await events(db), requests);

        for (const [i, identifier] of checked.entries()) {
          const label = identifier === S2_PHONE ? `check HA for ${identifier} (known, no code issued)` : `check HA for ${identifier}`;
          s.note(label, await check(db, identifier, checkIps[i], HA), INVALID);
        }
        s.note("events after the checks", await events(db), [
          ...requests,
          ...checked.map((identifier, i) => ({ kind: "failure", identifier, ip: checkIps[i] })),
        ]);
        s.note("code rows after the checks", await codes(db), []);
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L6: five failed checks block an identifier, known or not, for 15 minutes: the correct code is refused and not recorded, another identifier is not blocked, and a correct code clears nothing",
    () =>
      withCleanup(async (defer) => {
        // Done-when 2 (D8). Every call comes from one address (amendment 3):
        // if s2's correct code cleared that address's failures, s1 would no
        // longer be blocked at 14 minutes.
        // On main the first call fails 42883.
        const db = await fixtureDb(defer, "l6");
        const s = steps();

        s.note(`issue (${S1_PHONE}, HA)`, await issue(db, S1_PHONE, IP, HA), "issued");
        for (let i = 1; i <= 5; i++) s.note(`s1: wrong code ${i} of 5`, await check(db, S1_PHONE, IP, HB), INVALID);
        s.note("s1: sixth check, with the correct code", await check(db, S1_PHONE, IP, HA), BLOCKED);
        s.note("code rows, unused, after the block", await codeCounts(db), { rows: 1, unused: 1 });
        s.note("s1's failure events after the block", await eventCount(db, "failure", S1_PHONE), 5);

        s.note(`issue (${S2_PHONE}, HD)`, await issue(db, S2_PHONE, IP, HD), "issued");
        s.note("s2: check HD (the block is per identifier)", await check(db, S2_PHONE, IP, HD), ok("s2", "c2", "therapist"));

        for (let i = 1; i <= 5; i++) {
          s.note(`${UNKNOWN_PHONE}: check ${i} of 5`, await check(db, UNKNOWN_PHONE, IP, HA), INVALID);
        }
        s.note(`${UNKNOWN_PHONE}: sixth check`, await check(db, UNKNOWN_PHONE, IP, HA), BLOCKED);

        await ageEvents(db, NEARLY);
        s.note("s1: the correct code, 14 minutes on", await check(db, S1_PHONE, IP, HA), BLOCKED);
        s.note("s1's failure events, 14 minutes on", await eventCount(db, "failure", S1_PHONE), 5);

        await ageEvents(db, THE_REST);
        s.note("s1: the correct code, 15 minutes 1 second on", await check(db, S1_PHONE, IP, HA), ok("s1", "c1", "owner"));
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L7: twenty failed checks from one address block every check from it for 15 minutes, and no other address, and don't count against its code requests",
    () =>
      withCleanup(async (defer) => {
        // The per-IP attempt cap (D8). Issuing from X after its 20 failures
        // (amendment 4): a request cap that counted failures would refuse.
        // On main the first call fails 42883.
        const db = await fixtureDb(defer, "l7");
        const s = steps();
        const X = "198.51.100.10";
        const Y = "198.51.100.11";
        const THIRD = "203.0.113.5";

        for (const [i, email] of manyUnknownEmails(20).entries()) {
          s.note(`from X: check ${i + 1} of 20, for ${email}`, await check(db, email, X, HB), INVALID);
        }
        s.note("from a third address: issue HA for s1", await issue(db, S1_PHONE, THIRD, HA), "issued");
        s.note("from X: issue HD for s2", await issue(db, S2_PHONE, X, HD), "issued");

        s.note("from X: check HA for s1 (correct)", await check(db, S1_PHONE, X, HA), BLOCKED);
        s.note("from Y: check HD for s2", await check(db, S2_PHONE, Y, HD), ok("s2", "c2", "therapist"));

        await ageEvents(db, NEARLY);
        s.note("from X: check HA for s1, 14 minutes on", await check(db, S1_PHONE, X, HA), BLOCKED);

        await ageEvents(db, THE_REST);
        s.note("from X: check HA for s1, 15 minutes 1 second on", await check(db, S1_PHONE, X, HA), ok("s1", "c1", "owner"));
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L8: code requests are capped at 3 per identifier, known or not, and 20 per address in 15 minutes; a refused request is not recorded and leaves the live code usable",
    () =>
      withCleanup(async (defer) => {
        // The request caps (D7). (a) to (c) share one database; (d) is fresh.
        // On main the first call fails 42883.
        const s = steps();
        const db = await fixtureDb(defer, "l8");
        const four = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];

        // (a) A known phone, from four addresses.
        for (const [i, hash] of [H1, H2, H3, H4].entries()) {
          s.note(`(a) issue ${i + 1} of 4 for ${S1_PHONE}, H${i + 1}`, await issue(db, S1_PHONE, four[i], hash), i < 3 ? "issued" : "limited");
        }
        s.note("(a) code rows, unused", await codeCounts(db), { rows: 3, unused: 1 });
        s.note("(a) request events", await eventCount(db, "request"), 3);
        s.note("(a) check H3, the newest issued", await check(db, S1_PHONE, "198.51.100.5", H3), ok("s1", "c1", "owner"));

        // (b) An unknown phone is capped the same way.
        for (let i = 0; i < 4; i++) {
          s.note(`(b) issue ${i + 1} of 4 for ${UNKNOWN_PHONE}`, await issue(db, UNKNOWN_PHONE, four[i], HA), i < 3 ? "none" : "limited");
        }
        s.note(`(b) request events for ${UNKNOWN_PHONE}`, await eventCount(db, "request", UNKNOWN_PHONE), 3);

        // (c) The identifier's window.
        await ageEvents(db, NEARLY);
        s.note(`(c) issue for ${S1_PHONE}, 14 minutes on`, await issue(db, S1_PHONE, "198.51.100.6", H5), "limited");
        s.note(`(c) request events for ${S1_PHONE}`, await eventCount(db, "request", S1_PHONE), 3);
        await ageEvents(db, THE_REST);
        s.note(`(c) issue for ${S1_PHONE}, 15 minutes 1 second on`, await issue(db, S1_PHONE, "198.51.100.6", H5), "issued");

        // (d) One address. The check from X (amendment 4): an attempt cap
        // that counted requests would answer `blocked`.
        const d = await fixtureDb(defer, "l8d");
        const X = "203.0.113.10";
        const Y = "203.0.113.11";
        for (const [i, email] of manyUnknownEmails(20).entries()) {
          s.note(`(d) from X: issue ${i + 1} of 20, for ${email}`, await issue(d, email, X, HA), "none");
        }
        s.note("(d) from X: issue for s1", await issue(d, S1_PHONE, X, HA), "limited");
        s.note("(d) from Y: issue for s1", await issue(d, S1_PHONE, Y, HA), "issued");
        s.note(`(d) from X: check HB for ${UNKNOWN_PHONE}`, await check(d, UNKNOWN_PHONE, X, HB), INVALID);
        await ageEvents(d, NEARLY);
        s.note("(d) from X: issue for s2, 14 minutes on", await issue(d, S2_PHONE, X, HD), "limited");
        await ageEvents(d, THE_REST);
        s.note("(d) from X: issue for s2, 15 minutes 1 second on", await issue(d, S2_PHONE, X, HD), "issued");
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L9: calls sent together are counted one at a time, per identifier, per address and per account, so the caps and the one-live-code rule hold exactly",
    () =>
      withCleanup(async (defer) => {
        // The caps can't be raced (D9). Each case is on a fresh database,
        // every call on its own connection, opened first and sent together.
        // On main the first call fails 42883.
        const s = steps();

        // (a) 20 wrong checks for one identifier from 20 addresses.
        const a = await fixtureDb(defer, "l9a");
        s.note("(a) issue HA", await issue(a, S1_PHONE, IP, HA), "issued");
        const wrong = await together(a, "(a)", CHECK, manyIps(20).map((ip): Args => [S1_PHONE, ip, HB]));
        s.note("(a) 20 wrong checks at once", tally(wrong), { invalid: 5, blocked: 15 });
        s.note("(a) failure events", await eventCount(a, "failure"), 5);

        // (b) 20 correct checks for one identifier from 20 addresses.
        const b = await fixtureDb(defer, "l9b");
        s.note("(b) issue HA", await issue(b, S1_PHONE, IP, HA), "issued");
        const right = await together(b, "(b)", CHECK, manyIps(20).map((ip): Args => [S1_PHONE, ip, HA]));
        s.note("(b) 20 correct checks at once", tally(right), { ok: 1, invalid: 5, blocked: 14 });

        // (c) 12 requests for one phone from 12 addresses.
        const c = await fixtureDb(defer, "l9c");
        const twelve = await together(c, "(c)", ISSUE, manyIps(12).map((ip, i): Args => [S1_PHONE, ip, hashNo(i)]));
        s.note("(c) 12 issues at once for one phone", tally(twelve), { issued: 3, limited: 9 });
        s.note("(c) code rows, unused", await codeCounts(c), { rows: 3, unused: 1 });

        // (d) One account by its phone and by its email: two identifiers,
        // so only the account's row lock puts them in line.
        const d = await fixtureDb(defer, "l9d");
        const six = await together(
          d,
          "(d)",
          ISSUE,
          manyIps(6).map((ip, i): Args => [i < 3 ? S1_PHONE : S1_EMAIL, ip, hashNo(i)]),
        );
        s.note("(d) 3 issues by phone and 3 by email at once", tally(six), { issued: 6 });
        s.note("(d) code rows, unused", await codeCounts(d), { rows: 6, unused: 1 });

        // (e) 40 checks from one address for 40 identifiers.
        const e = await fixtureDb(defer, "l9e");
        const checks = await together(e, "(e)", CHECK, manyUnknownEmails(40).map((email): Args => [email, IP, HA]));
        s.note("(e) 40 checks at once from one address", tally(checks), { invalid: 20, blocked: 20 });
        s.note("(e) failure events", await eventCount(e, "failure"), 20);

        // (f) 40 requests from one address for 40 identifiers.
        const f = await fixtureDb(defer, "l9f");
        const issues = await together(f, "(f)", ISSUE, manyUnknownEmails(40).map((email): Args => [email, IP, HA]));
        s.note("(f) 40 issues at once from one address", tally(issues), { none: 20, limited: 20 });
        s.note("(f) request events", await eventCount(f, "request"), 20);
        s.verify();
      }),
    RACES_MS,
  );

  it(
    "L10: both functions refuse a NULL or empty identifier or address, and anything but 64 lower-case hex characters as the hash, with 22023 and a fixed message, and write nothing",
    () =>
      withCleanup(async (defer) => {
        // The functions never accept a plain code or an empty key, and the
        // error carries no argument: Sentry sends messages as written.
        // On main every call fails 42883, not 22023.
        const db = await fixtureDb(defer, "l10");
        const s = steps();
        const cases: [string, Args][] = [
          ["identifier NULL", [null, IP, HA]],
          ["identifier ''", ["", IP, HA]],
          ["ip NULL", [S1_PHONE, null, HA]],
          ["ip ''", [S1_PHONE, "", HA]],
          ["hash NULL", [S1_PHONE, IP, null]],
          ["hash 'zz'", [S1_PHONE, IP, "zz"]],
          ["hash of 63 hex characters", [S1_PHONE, IP, "a".repeat(63)]],
          ["hash of 64 upper-case hex characters", [S1_PHONE, IP, "A".repeat(64)]],
          ["hash '12345678' (a plain code)", [S1_PHONE, IP, "12345678"]],
        ];
        for (const [name, sql] of [
          ["login_code_issue", ISSUE],
          ["login_code_check", CHECK],
        ]) {
          for (const [label, args] of cases) {
            s.note(`${name}: ${label}`, said(await pgError(() => runOn(db.url, sql, args))), `22023 ${name}: invalid argument`);
          }
        }
        // The calls are judged before the tables are read: on main the
        // tables don't exist either, and that is not this test's reason.
        s.verify();
        expect({ "code rows afterwards": await codes(db), "events afterwards": await events(db) }).toEqual({
          "code rows afterwards": [],
          "events afterwards": [],
        });
      }),
    MIGRATED_MS,
  );

  it(
    "L11: each function deletes events and codes older than 24 hours when it runs, and nothing younger",
    () =>
      withCleanup(async (defer) => {
        // Retention (D11). The same history twice; the last call is a check
        // on one database and an issue on the other.
        // On main the first call fails 42883.
        const s = steps();
        const OLD = { kind: "request", identifier: "yesterday@clinic.test", ip: "203.0.113.23" };

        for (const last of ["check", "issue"] as const) {
          const db = await fixtureDb(defer, `l11${last}`);
          const tag = `last call a ${last}:`;

          s.note(`${tag} issue for s1`, await issue(db, S1_PHONE, IP, HA), "issued");
          s.note(`${tag} one failed check`, await check(db, S1_PHONE, IP, HB), INVALID);
          await ageEvents(db, "24 hours 1 second");
          await ageCodes(db, "24 hours 1 second");
          await db.query(
            `INSERT INTO login_events(kind, identifier, ip, at) VALUES ($1, $2, $3, now() - interval '23 hours')`,
            [OLD.kind, OLD.identifier, OLD.ip],
          );
          // Without this, rows that were never there would count as pruned.
          s.note(`${tag} events before it`, await events(db), [
            { kind: "request", identifier: S1_PHONE, ip: IP },
            { kind: "failure", identifier: S1_PHONE, ip: IP },
            OLD,
          ]);
          s.note(`${tag} code rows before it`, await codeCounts(db), { rows: 1, unused: 1 });

          if (last === "check") {
            s.note(`${tag} check for s2`, await check(db, S2_PHONE, IP, HB), INVALID);
            s.note(`${tag} events after it`, await events(db), [OLD, { kind: "failure", identifier: S2_PHONE, ip: IP }]);
            s.note(`${tag} code rows after it`, await codes(db), []);
          } else {
            s.note(`${tag} issue for s2`, await issue(db, S2_PHONE, IP, HD), "issued");
            s.note(`${tag} events after it`, await events(db), [OLD, { kind: "request", identifier: S2_PHONE, ip: IP }]);
            s.note(`${tag} code rows after it`, await codes(db), [
              { staff_id: "s2", code_hash: HD, unused: true, lifetime_s: 600 },
            ]);
          }
        }
        s.verify();
      }),
    MIGRATED_MS,
  );

  it(
    "L12: 0005_login_codes.sql refuses a migrating role that is neither superuser nor BYPASSRLS with P0001, and under a BYPASSRLS owner it applies and a code can be issued and checked",
    () =>
      withCleanup(async (defer) => {
        // No server. The functions run as their owner, and under FORCE only
        // a superuser or a BYPASSRLS role reads past the policies: with a
        // plain owner they would find no account. So the migration must
        // refuse such an owner (a), and a BYPASSRLS owner must really make
        // them work (b).
        // On main the control in (a) passes, then reading
        // migrations/0005_login_codes.sql throws ENOENT.
        const before = ["0001_init.sql", "0002_clinics.sql", "0003_rls.sql", "0004_staff.sql"];
        const loginMigration = "0005_login_codes.sql";
        const adminUrl = testDatabaseUrl();

        // (a) An owner that loses BYPASSRLS after 0004.
        const a = await dbOwnedByNewRole(defer, "LOGIN NOSUPERUSER BYPASSRLS");
        expect(await applyEach(a.url, before), `(a) control: 0001–0004 as ${a.role}`).toEqual(applied(before));
        await runOn(adminUrl, `ALTER ROLE ${a.role} NOBYPASSRLS`);
        const loginSql = readMigration(loginMigration);
        const refused = await pgError(() => applyAs(a.url, loginSql));
        const message = refused?.message ?? "";
        const [{ table }] = await a.db.query(`SELECT to_regclass('public.login_codes')::text AS "table"`);
        expect(
          {
            code: refused?.code ?? null,
            "message matches /superuser/i": /superuser/i.test(message),
            "message matches /BYPASSRLS/i": /BYPASSRLS/i.test(message),
            "message contains the role's name": message.includes(a.role),
            "to_regclass('public.login_codes')": table,
          },
          `(a) ${loginMigration} as ${a.role}: ${refused === null ? "applied" : message}`,
        ).toEqual({
          code: "P0001",
          "message matches /superuser/i": true,
          "message matches /BYPASSRLS/i": true,
          "message contains the role's name": true,
          "to_regclass('public.login_codes')": null,
        });

        // (b) A BYPASSRLS owner.
        const b = await dbOwnedByNewRole(defer, "LOGIN NOSUPERUSER BYPASSRLS");
        const all = [...before, loginMigration];
        expect(await applyEach(b.url, all), `(b) 0001–0005 as ${b.role}`).toEqual(applied(all));
        const phone = "+966500000008";
        await insertStaff(b.db, { id: "b1", name: "موظف ب", phone, email: null });
        await insertMembership(b.db, { staff_id: "b1", clinic_id: "c1", role: "owner" });
        const s = steps();
        s.note(`(b) ${APP_ROLE} issues a code for the account's phone`, await issue(b.db, phone, IP, HA), "issued");
        s.note(`(b) ${APP_ROLE} checks it`, await check(b.db, phone, IP, HA), ok("b1", "c1", "owner"));
        s.verify();
      }),
    NO_SERVER_MS,
  );
});
