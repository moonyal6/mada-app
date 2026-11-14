import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
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
  type Server,
  type TestDb,
} from "./pg/harness.mjs";

// R1–R7 of #10 (row-level security), written before the implementation, in
// a separate session, from the approved spec (issuecomment-6879445385). PR
// 10-0 ships them with no implementation, so every one is red on main by
// design (D1).
//
// Why they are red on main: the harness now starts every server as
// `mada_app`, which has no grants until 0003_rls.sql exists. Each test
// starts by letting a server migrate a fresh database, and on main that
// start fails (the app role can't create tables in `public`). Each test's
// comment says what it checks once that start succeeds.
//
// The test's own SQL (`db.query`) runs as the admin, a superuser, so it sees
// and writes every row whatever the policies say. Only R2 and R3 open their
// own connections as `mada_app`.

/** The nine clinic-scoped tables. */
const SCOPED = [
  "patients",
  "appointments",
  "invoices",
  "inventory",
  "sessions",
  "recordings",
  "segments",
  "adherence",
  "pain_logs",
] as const;
type Scoped = (typeof SCOPED)[number];
type Clinic = "c1" | "c2";

/** Each table's primary key, as stored. */
const PK: Record<Scoped, string[]> = {
  patients: ["id"],
  appointments: ["id"],
  invoices: ["id"],
  inventory: ["id"],
  sessions: ["id"],
  recordings: ["id"],
  segments: ["recordingId", "seq"],
  adherence: ["sessionId", "day", "exIdx"],
  pain_logs: ["sessionId", "day"],
};

const NOW = "2026-11-14T09:00:00.000Z";
const EXERCISE = { "back-bridge": { ar: "تمرين", en: "Bridge", desc: "", url: "", source: "case" } };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const keyExpr = (table: Scoped) => PK[table].map((c) => `${q(c)}::text`).join(` || '|' || `);
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

const addClinic2 = (db: TestDb) => insert(db, "clinics", { id: "c2", name: "عيادة الاختبار الثانية", createdAt: NOW });

type Parents = { patient: string; session: string; recording: string };

/** A valid row for `table`, without clinic_id, under the given parents. `k` keeps keys apart. */
function row(table: Scoped, k: string, p: Parents, seq: number): Record<string, unknown> {
  switch (table) {
    case "patients":
      return { id: `p_${k}`, name: `مريض ${k}`, caseKey: "back", createdAt: NOW };
    case "appointments":
      return { id: `a_${k}`, patientId: p.patient, date: "2026-11-20", time: "10:00", type: "متابعة" };
    case "invoices":
      return { id: `i_${k}`, patientId: p.patient, date: "2026-11-14" };
    case "inventory":
      return { id: `n_${k}`, name: `صنف ${k}` };
    case "sessions":
      return { id: `s_${k}`, patientId: p.patient, date: "2026-11-14", handoutToken: `tok_${k}`, createdAt: NOW, updatedAt: NOW };
    case "recordings":
      return { id: `r_${k}`, sessionId: p.session, mime: "audio/webm", startedAt: NOW };
    case "segments":
      return { recordingId: p.recording, seq, status: "done", createdAt: NOW, updatedAt: NOW };
    case "adherence":
      return { sessionId: p.session, day: `day_${k}`, exIdx: 0, updatedAt: NOW };
    case "pain_logs":
      return { sessionId: p.session, day: `day_${k}`, pain: 3, updatedAt: NOW };
  }
}

/** Each clinic's fixture rows are the parents of its later rows. */
const PARENTS: Record<Clinic, Parents> = {
  c1: { patient: "p_base_c1", session: "s_base_c1", recording: "r_base_c1" },
  c2: { patient: "p_base_c2", session: "s_base_c2", recording: "r_base_c2" },
};

/**
 * A fresh database migrated (and seeded with c1) by one server start, which
 * is stopped again before `fn` runs. The data directory is kept for a second
 * server. On main this start fails: `mada_app` can't create the tables.
 */
function withMigratedDb<T>(
  fn: (ctx: { db: TestDb; dataDir: string; defer: (cleanup: () => unknown) => void }) => Promise<T>,
) {
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
    return fn({ db, dataDir, defer });
  });
}

/* ─── R2's check (shared with R3) ─────────────────────────────────────── */

/** What R2's setup put in the database, read back as the admin. */
type Fixture = {
  /** Every row's key, by clinic and table: c1 also holds the seed's rows. */
  keys: Record<Clinic, Record<Scoped, string[]>>;
};

/**
 * c2, then one row per table in each clinic, as the admin. Every table ends
 * up with rows in both clinics, so a check can't pass on an empty table.
 */
async function buildFixture(db: TestDb): Promise<Fixture> {
  await addClinic2(db);
  for (const clinic of ["c1", "c2"] as const) {
    for (const table of SCOPED) {
      await insert(db, table, { ...row(table, `base_${clinic}`, PARENTS[clinic], 0), clinic_id: clinic });
    }
  }
  const keys = { c1: {}, c2: {} } as Fixture["keys"];
  for (const clinic of ["c1", "c2"] as const) {
    for (const table of SCOPED) {
      const rows = await db.query(`SELECT ${keyExpr(table)} AS key FROM ${table} WHERE clinic_id=$1 ORDER BY 1`, [clinic]);
      keys[clinic][table] = rows.map((r) => r.key as string);
      expect(keys[clinic][table].length, `fixture: ${table} has ${clinic} rows`).toBeGreaterThan(0);
    }
  }
  return { keys };
}

/**
 * What one statement did: the SQLSTATE it failed with (null when it
 * succeeded), the number of rows it returned or touched, and, for a SELECT,
 * the keys it returned in order.
 */
type Outcome = { error: string | null; rowCount: number; keys: string[] };

/** What `mada_app` could do to one table. */
type TableObservation = {
  /** As c1: SELECT every key. */
  visibleAsC1: Outcome;
  /** As c1: SELECT the keys WHERE clinic_id='c2'. */
  c2VisibleAsC1: Outcome;
  /** As c1: UPDATE … SET clinic_id = clinic_id WHERE clinic_id='c2'. */
  updateC2AsC1: Outcome;
  /** As c1: INSERT a new, otherwise valid c2 row (under c2's parents). */
  insertC2AsC1: Outcome;
  /** As c1: UPDATE c1's fixture row SET clinic_id='c2'. */
  moveC1ToC2AsC1: Outcome;
  /** After COMMIT, same connection, no context set: SELECT every key. */
  visibleNoContext: Outcome;
  /** After COMMIT, same connection, no context set: INSERT a new, otherwise valid c1 row. */
  insertNoContext: Outcome;
};

type Observed = {
  /** Every table's observations. */
  tables: Record<Scoped, TableObservation>;
  /** What the admin read before the check: the keys each clinic owns. */
  fixture: Fixture;
};

type Runner = { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> };

/**
 * Runs one statement and records what it did instead of throwing. Inside a
 * transaction it runs under a savepoint, so a refused statement doesn't
 * abort the rest of the check.
 */
async function attempt(conn: Runner, inTransaction: boolean, sql: string, params: unknown[] = []): Promise<Outcome> {
  if (inTransaction) await conn.query("SAVEPOINT attempt");
  try {
    const res = await conn.query(sql, params);
    if (inTransaction) await conn.query("RELEASE SAVEPOINT attempt");
    return { error: null, rowCount: res.rowCount ?? 0, keys: res.rows.map((r) => r.key as string).filter((k) => k !== undefined) };
  } catch (e) {
    if (inTransaction) await conn.query("ROLLBACK TO SAVEPOINT attempt");
    const err = e as { code?: string; message: string };
    return { error: err.code ?? err.message, rowCount: 0, keys: [] };
  }
}

/** `WHERE "a"=$n AND "b"=$n+1` for the row's primary key. */
function pkWhere(table: Scoped, values: Record<string, unknown>, first: number): [string, unknown[]] {
  const cols = PK[table];
  return [cols.map((c, i) => `${q(c)}=$${first + i}`).join(" AND "), cols.map((c) => values[c])];
}

/**
 * Everything R2 looks at, through `pool` (one `mada_app` connection). One
 * transaction as c1, set the way the app sets it (D8), then, after COMMIT,
 * the same connection with no context. Throws only when the setup itself is
 * wrong; what the database allowed is recorded, not judged.
 */
async function observe(pool: pg.Pool, fixture: Fixture): Promise<Observed> {
  const tables = {} as Record<Scoped, TableObservation>;
  const client = await pool.connect();
  let pid: number;
  try {
    const [who] = (await client.query("SELECT current_user AS who, pg_backend_pid() AS pid")).rows;
    if (who.who !== APP_ROLE) throw new Error(`R2 setup: connected as ${who.who}, not ${APP_ROLE}`);
    pid = who.pid;

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clinic_id', $1, true)", ["c1"]);
    for (const table of SCOPED) {
      const c1Row = row(table, "base_c1", PARENTS.c1, 0);
      const [where, whereParams] = pkWhere(table, c1Row, 1);
      tables[table] = {
        visibleAsC1: await attempt(client, true, `SELECT ${keyExpr(table)} AS key FROM ${table} ORDER BY 1`),
        c2VisibleAsC1: await attempt(client, true, `SELECT ${keyExpr(table)} AS key FROM ${table} WHERE clinic_id='c2' ORDER BY 1`),
        updateC2AsC1: await attempt(client, true, `UPDATE ${table} SET clinic_id = clinic_id WHERE clinic_id='c2'`),
        insertC2AsC1: await attempt(client, true, ...insertSql(table, { ...row(table, "new_c2", PARENTS.c2, 1), clinic_id: "c2" })),
        moveC1ToC2AsC1: await attempt(client, true, `UPDATE ${table} SET clinic_id='c2' WHERE ${where}`, whereParams),
      } as TableObservation;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Through the pool again: with max 1 it hands back the same connection,
  // which is what makes this a check that the context didn't outlive COMMIT.
  const [again] = (await pool.query("SELECT pg_backend_pid() AS pid")).rows;
  if (again.pid !== pid) throw new Error(`R2 setup: the pool opened a second connection (${pid} → ${again.pid})`);
  for (const table of SCOPED) {
    tables[table].visibleNoContext = await attempt(pool, false, `SELECT ${keyExpr(table)} AS key FROM ${table} ORDER BY 1`);
    tables[table].insertNoContext = await attempt(
      pool,
      false,
      ...insertSql(table, { ...row(table, "noctx_c1", PARENTS.c1, 2), clinic_id: "c1" }),
    );
  }
  return { tables, fixture };
}

/**
 * R2's assertion: "As clinic A, the app role sees all of A's rows, none of
 * B's, and cannot write a row into B." It must throw when that doesn't hold,
 * and its message must name the table (R3 relies on that).
 *
 * The owner writes this (issue #10, "Your part"). The spec's list, per table,
 * in terms of `observed.tables[table]` and `observed.fixture.keys`:
 *  - all c1 rows are visible (the positive control: a dropped policy hides
 *    everything rather than leaking, so without it nothing here can fail);
 *  - zero c2 rows are visible;
 *  - UPDATE … WHERE clinic_id='c2' touches 0 rows;
 *  - inserting a c2 row fails with 42501;
 *  - moving a c1 row to c2 fails with 42501;
 *  - after COMMIT, with no context, the table returns 0 rows and an insert
 *    fails.
 */
function assertIsolation(observed: Observed): void {
  throw new Error(
    `R2 assertion: owner writes this (issue #10, "Your part"). Nothing is checked yet; ${Object.keys(observed.tables).length} table(s) were observed.`,
  );
}

/** R2's check: observe through `pool`, then assert. Throws, naming a table, when isolation fails. */
async function checkIsolation(pool: pg.Pool, fixture: Fixture): Promise<void> {
  assertIsolation(await observe(pool, fixture));
}

/** Runs R2's check on a database as `mada_app`, through one `pg.Pool` with `max: 1`. */
async function checkIsolationOn(appUrl: string, fixture: Fixture): Promise<void> {
  const pool = new pg.Pool({ connectionString: appUrl, max: 1 });
  try {
    await checkIsolation(pool, fixture);
  } finally {
    await pool.end();
  }
}

/* ─── Database copies (R3) ─────────────────────────────────────────────── */

/** Runs one statement on its own connection. */
async function runOn(connectionString: string, sql: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
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

/* ─── Tests ────────────────────────────────────────────────────────────── */

describe("row-level security (#10)", () => {
  it(
    "R1: every table in public with a clinic_id column has ENABLE and FORCE ROW LEVEL SECURITY and a FOR ALL policy whose USING and WITH CHECK reference clinic_id",
    () =>
      withMigratedDb(async ({ db }) => {
        // The CI check. Tables are found from information_schema, not from a
        // list, so a future table with clinic_id and no policy fails here.
        // On main the migrating start already fails (no grants); with the
        // grants alone, every table here would show RLS off and no policy.
        const tables = (
          await db.query(
            `SELECT c.table_name AS name
             FROM information_schema.columns c
             JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
             WHERE c.table_schema = 'public' AND c.column_name = 'clinic_id' AND t.table_type = 'BASE TABLE'
             ORDER BY 1`,
          )
        ).map((r) => r.name as string);
        // A floor, not the list: discovery that silently finds nothing (a
        // wrong schema, a renamed column) would pass every table it found.
        expect(tables, "discovery finds at least today's nine scoped tables").toEqual(expect.arrayContaining([...SCOPED]));

        const flags = await db.query(
          `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
          [tables],
        );
        const policies = await db.query(
          `SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`,
          [tables],
        );
        const refersToClinic = (expr: string | null) => /\bclinic_id\b/.test(expr ?? "");

        const want = { rls: true, force: true, "FOR ALL policy, USING and WITH CHECK on clinic_id": true };
        const actual = Object.fromEntries(
          tables.map((t) => {
            const f = flags.find((r) => r.relname === t);
            return [
              t,
              {
                rls: f?.relrowsecurity === true,
                force: f?.relforcerowsecurity === true,
                "FOR ALL policy, USING and WITH CHECK on clinic_id": policies.some(
                  (p) => p.tablename === t && p.cmd === "ALL" && refersToClinic(p.qual) && refersToClinic(p.with_check),
                ),
              },
            ];
          }),
        );
        expect(actual, JSON.stringify(policies)).toEqual(Object.fromEntries(tables.map((t) => [t, want])));
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "R2: as c1, mada_app sees all of c1's rows and none of c2's, can't write into c2, and a connection without context sees nothing",
    () =>
      withMigratedDb(async ({ db }) => {
        // The negative test at the database level: what the app role can do
        // with its clinic context set as the app sets it, on one pooled
        // connection reused after COMMIT. The check is the one R3 breaks.
        // On main the migrating start fails; with grants and no RLS, every
        // c2 row would be visible and every c2 write would succeed.
        const fixture = await buildFixture(db);
        await checkIsolationOn(db.url, fixture);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "R3: with any one table's policy dropped, or replaced by USING (true), R2's check fails and names that table",
    () =>
      withMigratedDb(async ({ db, defer }) => {
        // The permanent "fails before it passes" proof for R2: each broken
        // policy, on its own copy of R2's fixture, must make the check throw
        // with that table's name. The intact copy is the control: a check
        // that always throws would otherwise pass here.
        // On main the migrating start fails; past it, there is no policy to
        // drop.
        const fixture = await buildFixture(db);

        /** "passed", or the error, said in terms of `table`. */
        const outcome = async (appUrl: string, table?: Scoped) => {
          try {
            await checkIsolationOn(appUrl, fixture);
            return "passed";
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (table && new RegExp(`\\b${table}\\b`).test(message)) return `threw, naming ${table}`;
            return `threw: ${message.slice(0, 300)}`;
          }
        };

        const actual: Record<string, string> = {};
        const expected: Record<string, string> = {};
        let n = 0;
        const copy = async () => {
          const c = await copyOf(db, `r3_${n++}`);
          defer(c.drop);
          return c;
        };

        const intact = await copy();
        expected["control: no policy changed"] = "passed";
        actual["control: no policy changed"] = await outcome(intact.appUrl);
        await intact.drop();

        for (const table of SCOPED) {
          for (const mode of ["policy dropped", "policy replaced by USING (true)"] as const) {
            const label = `${table}: ${mode}`;
            expected[label] = `threw, naming ${table}`;
            const c = await copy();
            const forAll = await runOn(
              c.ownerUrl,
              `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' AND cmd = 'ALL'`,
            );
            if (forAll.length === 0) {
              actual[label] = "no FOR ALL policy to break";
            } else {
              for (const p of forAll) await runOn(c.ownerUrl, `DROP POLICY ${q(p.policyname)} ON ${table}`);
              if (mode === "policy replaced by USING (true)") {
                await runOn(c.ownerUrl, `CREATE POLICY r3_open ON ${table} FOR ALL USING (true)`);
              }
              actual[label] = await outcome(c.appUrl, table);
            }
            await c.drop();
          }
        }
        expect(actual).toEqual(expected);
      }),
    SERVER_START_MS + 240_000,
  );

  it(
    "R4: mada_app is not superuser, BYPASSRLS, CREATEDB or CREATEROLE, owns nothing, and has exactly the grants 0003 lists",
    () =>
      withMigratedDb(async ({ db }) => {
        // The role the app connects as can't step around the policies, and
        // holds no privilege beyond D7: SELECT, INSERT, UPDATE on the nine
        // tables, SELECT on clinics, USAGE on public; nothing on
        // schema_migrations, no DELETE, no column grants.
        // On main the migrating start fails; past it, mada_app holds no grant
        // at all.
        const [attrs] = await db.query(
          `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1`,
          [APP_ROLE],
        );
        const owned = await db.query(
          `SELECT n.nspname || '.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY 1`,
          [APP_ROLE],
        );
        const tableGrants = await db.query(
          `SELECT n.nspname || '.' || c.relname AS rel, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
           GROUP BY 1`,
          [APP_ROLE],
        );
        const columnGrants = await db.query(
          `SELECT c.relname || '.' || at.attname || ': ' || a.privilege_type AS grant
           FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid
           CROSS JOIN LATERAL aclexplode(at.attacl) a
           WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY 1`,
          [APP_ROLE],
        );
        const schemaGrants = await db.query(
          `SELECT n.nspname AS schema, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
           FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
           WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
           GROUP BY 1`,
          [APP_ROLE],
        );

        expect({
          attributes: attrs,
          "relations it owns": owned.map((r) => r.rel),
          "table grants": Object.fromEntries(tableGrants.map((r) => [r.rel, r.privs])),
          "column grants": columnGrants.map((r) => r.grant),
          "schema grants": Object.fromEntries(schemaGrants.map((r) => [r.schema, r.privs])),
        }).toEqual({
          attributes: { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
          "relations it owns": [],
          "table grants": {
            ...Object.fromEntries(SCOPED.map((t) => [`public.${t}`, "INSERT,SELECT,UPDATE"])),
            "public.clinics": "SELECT",
          },
          "column grants": [],
          "schema grants": { public: "USAGE" },
        });
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "R5: a server whose DATABASE_URL is a superuser, or a role with BYPASSRLS, refuses: 500, the log names the reason, no rows change",
    () =>
      withMigratedDb(async ({ db, dataDir, defer }) => {
        // The startup guard (D3): a misconfigured DATABASE_URL would silently
        // turn RLS off, so the server must refuse it loudly instead. The
        // BYPASSRLS role gets the same grants as mada_app, so without the
        // guard its requests would succeed, not fail on permissions.
        // On main the migrating start fails; past it, there is no guard and
        // both servers answer 200/201.
        const bypass = `mada_test_bypassrls_${randomBytes(4).toString("hex")}`;
        const adminUrl = testDatabaseUrl();
        await runOn(adminUrl, `CREATE ROLE ${bypass} LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        // Roles are cluster-wide: this one is dropped with its grants. It
        // runs before db.drop (cleanups run in reverse).
        defer(async () => {
          await runOn(db.ownerUrl, `DROP OWNED BY ${bypass}`);
          await runOn(adminUrl, `DROP ROLE IF EXISTS ${bypass}`);
        });
        await db.query(`GRANT USAGE ON SCHEMA public TO ${bypass}`);
        await db.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${bypass}`);
        const bypassUrl = new URL(db.url);
        bypassUrl.username = bypass;

        /** Every row of every table in public, as text. */
        const snapshot = async () => {
          const tables = await db.query(
            `SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
          );
          const out: Record<string, string[]> = {};
          for (const { name } of tables) {
            out[name] = (await db.query(`SELECT t::text AS r FROM ${q(name)} t ORDER BY 1`)).map((r) => r.r as string);
          }
          return out;
        };

        const cases = [
          { label: "superuser (the owner URL)", url: db.ownerUrl, reason: /superuser/i },
          { label: `BYPASSRLS role ${bypass}`, url: bypassUrl.href, reason: /bypassrls/i },
        ];
        const actual: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const c of cases) {
          const before = await snapshot();
          const server: Server = await startServer({
            dataDir,
            env: { DATABASE_URL: c.url, DATABASE_OWNER_URL: db.ownerUrl },
          });
          defer(server.stop);
          const get = await request(server.base, "GET", "/api/patients");
          const post = await request(server.base, "POST", "/api/patients", {
            body: { name: "مريض من خادم مرفوض", caseKey: "back" },
          });
          await server.stop();
          actual[c.label] = {
            "GET /api/patients": get.status,
            "POST /api/patients": post.status,
            "the log names the reason": c.reason.test(server.log()),
            "rows unchanged": JSON.stringify(await snapshot()) === JSON.stringify(before),
          };
          expected[c.label] = {
            "GET /api/patients": 500,
            "POST /api/patients": 500,
            "the log names the reason": true,
            "rows unchanged": true,
          };
        }
        expect(actual).toEqual(expected);
      }),
    3 * SERVER_START_MS + 60_000,
  );

  it(
    "R6: after server A (c1) opens a c2 handout, GET /api/sessions never lists the c2 session",
    () =>
      withCleanup(async (defer) => {
        // The token context (D5) must not outlive the request that set it:
        // the app's pool hands the same connection to the next request. A
        // leaked app.handout_token would make the c2 session readable to c1
        // requests through the token policy on sessions.
        // Note: listSessions also keeps its 9b `WHERE clinic_id` filter, which
        // on its own keeps the c2 session out of this list.
        // On main the migrating start fails.
        const db = await createTestDb();
        defer(db.drop);
        const dataDir = makeDataDir();
        defer(() => rmSync(dataDir, { recursive: true, force: true }));
        const a = await startServer({ dataDir, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "c1" } });
        defer(a.stop);
        const first = await request(a.base, "GET", "/api/patients");
        expect(first.status, `migrating start as ${APP_ROLE}: ${JSON.stringify(first.body).slice(0, 300)}`).toBe(200);

        // c2's session, as the admin; c1's own session through A.
        await addClinic2(db);
        const c2Patient = "مريض العيادة الثانية";
        await insert(db, "patients", { id: "p_r6_c2", name: c2Patient, caseKey: "back", createdAt: NOW, clinic_id: "c2" });
        await insert(db, "sessions", {
          id: "s_r6_c2",
          patientId: "p_r6_c2",
          date: "2026-11-14",
          selected: JSON.stringify(EXERCISE),
          handoutToken: "tok_r6_c2",
          createdAt: NOW,
          updatedAt: NOW,
          clinic_id: "c2",
        });
        const own = await request(a.base, "POST", "/api/sessions", { body: { patientId: "p1" } });
        expect(own.status, `control: A creates its own session: ${JSON.stringify(own.body).slice(0, 300)}`).toBe(201);
        const ownId: string = own.body.session.id;

        // Control: the token path works across clinics, so the context was set.
        const page = await request(a.base, "GET", "/h/tok_r6_c2");
        expect(
          { status: page.status, "page shows c2's patient": typeof page.body === "string" && page.body.includes(c2Patient) },
          "control: A opens c2's handout",
        ).toEqual({ status: 200, "page shows c2's patient": true });

        const actual: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (let i = 1; i <= 5; i++) {
          const res = await request(a.base, "GET", "/api/sessions");
          const ids: string[] = res.status === 200 ? res.body.sessions.map((s: { id: string }) => s.id) : [];
          actual[`GET /api/sessions #${i}`] = {
            status: res.status,
            "lists A's own session": ids.includes(ownId),
            "lists c2's session": ids.includes("s_r6_c2"),
          };
          expected[`GET /api/sessions #${i}`] = { status: 200, "lists A's own session": true, "lists c2's session": false };
        }
        expect(actual).toEqual(expected);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "R7: after a restart, pending segments in c1 and in c2 both leave `uploaded`",
    () =>
      withMigratedDb(async ({ db, dataDir, defer }) => {
        // The transcription worker under RLS (D6): recovery covers every
        // clinic, so a c1 server still picks up c2's pending segment. A
        // worker query with no clinic context would see neither and leave
        // both `uploaded`. Transcription itself fails here (no provider
        // key), which is fine: any status but uploaded/transcribing means
        // the worker reached the row.
        // On main the migrating start fails.
        await addClinic2(db);
        for (const clinic of ["c1", "c2"] as const) {
          const p = { patient: `p_r7_${clinic}`, session: `s_r7_${clinic}`, recording: `r_r7_${clinic}` };
          for (const table of ["patients", "sessions", "recordings", "segments"] as const) {
            const values = row(table, `r7_${clinic}`, p, 0);
            if (table === "segments") values.status = "uploaded";
            await insert(db, table, { ...values, clinic_id: clinic });
          }
        }

        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "c1" } });
        defer(server.stop);
        // The recording GET runs the queue's once-per-process recovery.
        const res = await request(server.base, "GET", "/api/recordings/r_r7_c1");
        expect(res.status, `GET /api/recordings/r_r7_c1: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);

        const statuses = async () =>
          Object.fromEntries(
            (await db.query(`SELECT clinic_id, status FROM segments WHERE "recordingId" LIKE 'r_r7_%' ORDER BY 1`)).map(
              (r) => [r.clinic_id as string, r.status as string],
            ),
          );
        const settled = (s: string | undefined) => s !== undefined && s !== "uploaded" && s !== "transcribing";
        // 30 s covers the queue's one automatic retry, 4 s after a transient failure.
        const deadline = Date.now() + 30_000;
        let seen = await statuses();
        while (!(settled(seen.c1) && settled(seen.c2)) && Date.now() < deadline) {
          await sleep(250);
          seen = await statuses();
        }
        expect(
          { "c1 segment left uploaded": settled(seen.c1), "c2 segment left uploaded": settled(seen.c2) },
          `segment statuses: ${JSON.stringify(seen)}`,
        ).toEqual({ "c1 segment left uploaded": true, "c2 segment left uploaded": true });
      }),
    2 * SERVER_START_MS + 60_000,
  );
});
