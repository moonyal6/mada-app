import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_ROLE,
  SERVER_START_MS,
  createTestDb,
  freePort,
  makeDataDir,
  request,
  startServer,
  testDatabaseUrl,
  withCleanup,
  type TestDb,
} from "./pg/harness.mjs";

// F1–F15 of #44 (founder script: create a clinic and its owner), written
// before the implementation, in a separate session, from the approved spec
// (v2, with the approval's amendments 5–7). PR 44-0 ships them with no
// script, so every one is red on main by design.
//
// The tests never import the command. Each run spawns
// `node scripts/founder.mjs` the way an operator would, and judges it by its
// exit code, stdout and stderr (D13).
//
// What each does on main, where the script doesn't exist and Node exits 1
// with "Cannot find module":
//  - F1, F2, F12, F13: the first run exits 1, not 0.
//  - F3, F9: the setup run that must exit 0 exits 1.
//  - F5: neither run exits 0.
//  - F10, F11: exit 1, not 2.
//  - F4, F6, F7, F8, F15: the exit code is 1 as expected, but stderr is
//    Node's error: no `founder: ` last line with the stated pattern, and no
//    target line.
//  - F14: (a)–(c) exit 1, not 2; (d) and (e) exit 1 as expected, with Node's
//    error instead of the could-not-connect line.
//
// "As admin" is the harness's admin URL (`db.query`, `db.ownerUrl`), a
// superuser. "As mada_app" is `db.url`.
//
// The helpers `runOn`, `copyOf`, `asRole`, `applyAs` and `dbOwnedByNewRole`
// follow the ones in pg-staff.test.ts, and nothing is shared. A migrated
// database here is a template copy of one database migrated once in this
// file, by a server start, the first time a test asks for one.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "founder.mjs");

/** Planted as the password of every usable DATABASE_OWNER_URL. No run may print it. */
const SECRET = "founder-test-secret";

/** Each spawned command's own limit. */
const RUN_LIMIT_MS = 30_000;

/** A test on a migrated database: the first one in a run also pays for the migrating server start. */
const MIGRATED_MS = SERVER_START_MS + 60_000;
/** A test with no server. */
const NO_SERVER_MS = 120_000;

const TARGET = "founder: target: ";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NOW = "2026-11-25T09:00:00.000Z";
const C1_NAME = "عيادة العلاج الطبيعي";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = Record<string, unknown>;

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

/**
 * TEST_DATABASE_URL, which must also name a user (amendment 6): the command
 * is spawned with PATH only, so `pg` has no USER to fall back on.
 */
function adminUrl(): string {
  const url = testDatabaseUrl();
  if (new URL(url).username === "") {
    throw new Error(
      "TEST_DATABASE_URL names no user. The founder tests need one in the URL (such as " +
        "postgres://postgres@localhost:5432/postgres): the command is spawned with PATH only, " +
        "so pg has no default user.",
    );
  }
  return url;
}

/** `url` with the planted password. Trust auth locally and in CI, so it is ignored by the server. */
function withSecret(url: string): string {
  const u = new URL(url);
  if (u.username === "") {
    throw new Error("a DATABASE_OWNER_URL for the founder command must name a user: the command gets PATH only.");
  }
  u.password = SECRET;
  return u.href;
}

/** The command's environment (besides PATH) for a usable owner URL. */
const ownerEnv = (url: string) => ({ DATABASE_OWNER_URL: withSecret(url) });

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

/* ─── Databases ────────────────────────────────────────────────────────── */

/** A fresh, empty database: nothing applied. Dropped by `defer`. */
async function freshDb(defer: (cleanup: () => unknown) => void): Promise<TestDb> {
  adminUrl();
  const db = await createTestDb();
  defer(db.drop);
  return db;
}

/** The one database a server migrates in this file; every migrated database is a copy of it. */
let template: Promise<TestDb> | undefined;

/**
 * A fresh database migrated (and seeded with c1 and the demo rows) by one
 * server start and GET /api/patients, as pg-staff's `withMigratedDb` does.
 * Built once, by the first test that needs it; a failed build fails every
 * such test with the same error.
 */
function migratedTemplate(): Promise<TestDb> {
  template ??= (async () => {
    adminUrl();
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

/**
 * A copy of `db` (CREATE DATABASE … TEMPLATE): schema, grants, policies and
 * rows.
 */
async function copyOf(db: TestDb, suffix: string): Promise<Db & { drop: () => Promise<unknown> }> {
  const admin = adminUrl();
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

/**
 * One migrated database for one test: it holds c1, the demo seed, and empty
 * `staff` and `memberships`. `tag` keeps the copies' names apart.
 */
function withMigratedDb<T>(tag: string, fn: (ctx: { db: Db; defer: (cleanup: () => unknown) => void }) => Promise<T>) {
  return withCleanup(async (defer) => {
    const db = await copyOf(await migratedTemplate(), tag);
    defer(db.drop);
    return fn({ db, defer });
  });
}

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

/** Applies the named files in order as `url`. A failure names its file. */
async function applyAll(url: string, files: string[]): Promise<void> {
  for (const file of files) {
    try {
      await applyAs(url, readMigration(file));
    } catch (e) {
      const err = e as { code?: string; message: string };
      throw new Error(`fixture: ${file} did not apply: ${err.code} ${err.message}`);
    }
  }
}

/**
 * A fresh database owned by a new, random-named role with the given
 * attributes. Roles are cluster-wide and test files run in parallel, hence
 * the random name. Cleanups run in reverse: the database is dropped first,
 * then the role, which by then owns nothing.
 */
async function dbOwnedByNewRole(defer: (cleanup: () => unknown) => void, attributes: string) {
  const admin = adminUrl();
  const role = `mada_test_owner_${randomBytes(4).toString("hex")}`;
  await runOn(admin, `CREATE ROLE ${role} ${attributes}`);
  defer(() => runOn(admin, `DROP ROLE IF EXISTS ${role}`));
  const db = await createTestDb();
  defer(db.drop);
  await runOn(admin, `ALTER DATABASE ${db.name} OWNER TO ${role}`);
  return { db, role, url: asRole(db.ownerUrl, role) };
}

/* ─── The command ──────────────────────────────────────────────────────── */

type Ran = {
  args: string[];
  /** What the command got besides PATH. */
  env: Record<string, string>;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const clip = (s: string) => (s.length > 700 ? `${s.slice(0, 700)}…` : s);
const output = (ran: Ran) =>
  `exit ${ran.code ?? `none (${ran.signal})`}\nstdout: ${clip(ran.stdout) || "(empty)"}\nstderr: ${clip(ran.stderr) || "(empty)"}`;
const shown = (ran: Ran) => `founder ${JSON.stringify(ran.args)}\n${output(ran)}`;

/**
 * Spawns `node scripts/founder.mjs` with `args` as its argv, byte for byte
 * and never through a shell. Its `cwd` is a new empty directory, its
 * environment is exactly PATH plus `env` (nothing inherited: no
 * TEST_DATABASE_URL, DATABASE_URL or PG*), and stdin is ignored. A run that
 * is still going after 30 s is killed, by its PID, and fails the test with a
 * message saying so.
 *
 * Every run, whatever the test expects of it, is checked here for the
 * planted password. What else a run must look like is in `told`.
 */
async function start(args: string[], env: Record<string, string>): Promise<Ran> {
  const cwd = mkdtempSync(path.join(tmpdir(), "mada-founder-"));
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", ...env };
  let ran: Ran;
  try {
    ran = await new Promise<Ran>((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        cwd,
        env: childEnv as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (stdout += d));
      child.stderr.on("data", (d: string) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, RUN_LIMIT_MS);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `founder ${JSON.stringify(args)} did not exit within ${RUN_LIMIT_MS / 1000} s and was killed.\n` +
                `stdout so far: ${clip(stdout) || "(empty)"}\nstderr so far: ${clip(stderr) || "(empty)"}`,
            ),
          );
        } else {
          resolve({ args, env, code, signal, stdout, stderr });
        }
      });
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  expect(ran.stdout + ran.stderr, `founder ${JSON.stringify(args)} printed the planted password`).not.toContain(SECRET);
  return ran;
}

/** The success JSON (exit 0). */
type Success = {
  clinic: { id: string; name: string; created: boolean };
  owner: { id: string; name: string; phone: string | null; email: string | null };
  role: string;
};

/** stdout as exactly one line of JSON holding an object, or null. The line's own terminator is not a second line. */
function oneJsonLine(stdout: string): Success | null {
  const body = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (body === "" || body.includes("\n")) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Success) : null;
  } catch {
    return null;
  }
}

/** The last stderr line of an exit 1, by the cases of the spec's table. */
type Last =
  /** `/phone/i` and `/already/i`, and not `/email/i`. */
  | { is: "phone already stored" }
  /** `/email/i` and `/already/i`, and not `/phone/i`. */
  | { is: "email already stored" }
  /** F3(a), where both collide: `/already/i` and `/phone|email/i`. */
  | { is: "already stored" }
  /** `/no clinic/i` and the id in double quotes. */
  | { is: "no clinic"; id: string }
  /** A table is missing (42P01): `/migrat/i`. */
  | { is: "not migrated" }
  /** 42501: `/permission denied/i` and the text DATABASE_OWNER_URL. */
  | { is: "permission denied" }
  /** `/could not connect/i` and the error's code. No connection opened, so no target line. */
  | { is: "could not connect"; code: string }
  /** `/not known/i`, and not the text `Nothing was written`. */
  | { is: "commit failed" }
  /** Any other database error: its SQLSTATE. */
  | { is: "sqlstate"; code: string }
  /** Only what every exit 1 must look like. */
  | { is: "refused" };

type Want =
  | { exit: 0 }
  /** `absent`: texts stderr must not contain (amendment 5). */
  | { exit: 1; last: Last; absent?: string[] }
  /** `first`: texts the first stderr line must contain. `anywhere`: texts stderr must contain. */
  | { exit: 2; first?: string[]; anywhere?: string[] };

type Refusal = Exclude<Want, { exit: 0 }>;

/** Where a usable URL points, in the target line's terms. */
function targetOf(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port || "5432",
    database: decodeURIComponent(u.pathname.slice(1)),
    role: decodeURIComponent(u.username),
  };
}

/**
 * What a run did and what `want` asks of it, as two objects to compare. The
 * spec's Conventions are here and nowhere else, so no run can skip them:
 *  - exit 0: stdout is exactly one JSON line.
 *  - exit 1: stdout is empty; the last stderr line starts `founder: ` and
 *    ends `Nothing was written.` (a failed COMMIT says "not known" instead),
 *    and matches its case's patterns.
 *  - exit 2: stdout is empty; the first stderr line starts `founder: `, and
 *    a later line starts `usage: `.
 *  - Target lines (stderr lines starting `founder: target: `): exactly one
 *    on a run that opened a connection (every exit 0, and every exit 1 but
 *    could-not-connect), naming the host, port, database and user of the
 *    URL the test passed; none on any other run.
 */
function told(ran: Ran, want: Want) {
  const lines = ran.stderr === "" ? [] : ran.stderr.replace(/\n$/, "").split("\n");
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  const targets = lines.filter((l) => l.startsWith(TARGET));
  const json = oneJsonLine(ran.stdout);

  const actual: Record<string, unknown> = { exit: ran.code ?? `none (${ran.signal})` };
  const expected: Record<string, unknown> = { exit: want.exit };
  const check = (name: string, got: unknown, wanted: unknown = true) => {
    actual[name] = got;
    expected[name] = wanted;
  };
  const lastMatches = (re: RegExp, wanted = true) => check(`the last stderr line matches ${re}`, re.test(last), wanted);
  const lastContains = (text: string, wanted = true) =>
    check(`the last stderr line contains ${text}`, last.includes(text), wanted);

  const connected = () => {
    check("target lines", targets.length, 1);
    const url = ran.env.DATABASE_OWNER_URL;
    if (!url) throw new Error("test bug: a run that must connect was given no DATABASE_OWNER_URL");
    const to = targetOf(url);
    const named = (targets[0] ?? "").slice(TARGET.length);
    check(
      "the target line names the URL's",
      {
        host: named.includes(to.host),
        port: named.includes(to.port),
        database: named.includes(to.database),
        user: named.includes(to.role),
      },
      { host: true, port: true, database: true, user: true },
    );
  };
  const notConnected = () => check("target lines", targets.length, 0);

  if (want.exit === 0) {
    check("stdout is exactly one JSON line", json !== null);
    connected();
  } else if (want.exit === 1) {
    check("stdout is empty", ran.stdout === "");
    check("the last stderr line starts 'founder: '", last.startsWith("founder: "));
    const l = want.last;
    if (l.is === "commit failed") {
      lastMatches(/not known/i);
      lastContains("Nothing was written", false);
    } else {
      check("the last stderr line ends 'Nothing was written.'", last.endsWith("Nothing was written."));
    }
    if (l.is === "phone already stored") {
      lastMatches(/phone/i);
      lastMatches(/already/i);
      lastMatches(/email/i, false);
    } else if (l.is === "email already stored") {
      lastMatches(/email/i);
      lastMatches(/already/i);
      lastMatches(/phone/i, false);
    } else if (l.is === "already stored") {
      lastMatches(/already/i);
      lastMatches(/phone|email/i);
    } else if (l.is === "no clinic") {
      lastMatches(/no clinic/i);
      lastContains(`"${l.id}"`);
    } else if (l.is === "not migrated") {
      lastMatches(/migrat/i);
    } else if (l.is === "permission denied") {
      lastMatches(/permission denied/i);
      lastContains("DATABASE_OWNER_URL");
    } else if (l.is === "could not connect") {
      lastMatches(/could not connect/i);
      lastContains(l.code);
    } else if (l.is === "sqlstate") {
      lastContains(l.code);
    }
    for (const text of want.absent ?? []) check(`stderr contains ${text}`, ran.stderr.includes(text), false);
    if (l.is === "could not connect") notConnected();
    else connected();
  } else {
    check("stdout is empty", ran.stdout === "");
    check("the first stderr line starts 'founder: '", first.startsWith("founder: "));
    check(
      "a later stderr line starts 'usage: '",
      lines.slice(1).some((line) => line.startsWith("usage: ")),
    );
    for (const text of want.first ?? []) check(`the first stderr line contains ${text}`, first.includes(text));
    for (const text of want.anywhere ?? []) check(`stderr contains ${text}`, ran.stderr.includes(text));
    notConnected();
  }
  return { actual, expected, json, target: targets[0] ?? "" };
}

/** Fails the test unless the run did what `want` says. */
function judge(label: string, ran: Ran, want: Want) {
  const t = told(ran, want);
  expect(t.actual, `${label}: ${shown(ran)}`).toEqual(t.expected);
  return t;
}

/** A run that must exit 0: its JSON and its target line. */
function judgeSuccess(label: string, ran: Ran) {
  const { json, target } = judge(label, ran, { exit: 0 });
  if (json === null) throw new Error(`${label}: no JSON on stdout`);
  return { json, target };
}

/** `founder <args>` that must exit 0. */
async function succeeds(label: string, env: Record<string, string>, args: string[]) {
  return judgeSuccess(label, await start(args, env));
}

/** `founder <args>` that must exit 1 or 2 as `want` says. Returns its target line ("" when it has none). */
async function fails(label: string, env: Record<string, string>, args: string[], want: Refusal) {
  return judge(label, await start(args, env), want).target;
}

/** Many runs judged together, so one failure shows every case that is wrong. */
function tally() {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  const wrong: string[] = [];
  return {
    add(label: string, ran: Ran, want: Want) {
      const t = told(ran, want);
      actual[label] = t.actual;
      expected[label] = t.expected;
      if (JSON.stringify(t.actual) !== JSON.stringify(t.expected)) wrong.push(`${label}: ${shown(ran)}`);
    },
    settle(title: string) {
      const more = wrong.length > 2 ? `\n… and ${wrong.length - 2} more` : "";
      expect(actual, `${title}\n${wrong.slice(0, 2).join("\n\n")}${more}`).toEqual(expected);
    },
  };
}

/* ─── What the database holds ──────────────────────────────────────────── */

const TABLES = ["clinics", "staff", "memberships"] as const;
type Rows = Record<(typeof TABLES)[number], Row[]>;

/** "Rows": all rows of `clinics`, `staff` and `memberships`, read as admin, in a fixed order. */
async function readRows(db: Db): Promise<Rows> {
  return {
    clinics: await db.query(`SELECT * FROM clinics ORDER BY id`),
    staff: await db.query(`SELECT * FROM staff ORDER BY id`),
    memberships: await db.query(`SELECT * FROM memberships ORDER BY staff_id, clinic_id`),
  };
}

/**
 * The rows `after` holds that `before` didn't. Everything `before` held must
 * still be there, unchanged.
 */
function gained(label: string, before: Rows, after: Rows): Rows {
  const out = {} as Rows;
  for (const table of TABLES) {
    const had = new Set(before[table].map((r) => JSON.stringify(r)));
    out[table] = after[table].filter((r) => !had.has(JSON.stringify(r)));
    expect(
      after[table].filter((r) => had.has(JSON.stringify(r))),
      `${label}: the ${table} rows that were there before`,
    ).toEqual(before[table]);
  }
  return out;
}

const counts = (rows: Rows) => ({
  clinics: rows.clinics.length,
  staff: rows.staff.length,
  memberships: rows.memberships.length,
});

const ONE_OF_EACH = { clinics: 1, staff: 1, memberships: 1 };

/** "Lookup": sign_in_lookup as `mada_app`, with no clinic context. */
const lookup = (db: Db, identifier: string) => runOn(db.url, "SELECT * FROM sign_in_lookup($1)", [identifier]);

const lookupRow = (json: Success) => [{ staff_id: json.owner.id, clinic_id: json.clinic.id, role: "owner" }];

/** One transaction as `mada_app` with the clinic set the way the app sets it. */
async function asClinic<T>(db: Db, clinic: string, body: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const [who] = (await client.query("SELECT current_user AS who")).rows;
    if (who.who !== APP_ROLE) throw new Error(`setup: connected as ${who.who}, not ${APP_ROLE}`);
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinic]);
    const out = await body(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

/**
 * What one statement inside a transaction was refused with. It runs under a
 * savepoint that is rolled back either way, so a refusal doesn't abort the
 * transaction and a write that wrongly succeeds is undone.
 */
async function refusal(client: pg.Client, sql: string, params: unknown[]) {
  await client.query("SAVEPOINT attempt");
  let said: { code: string | null; message: string } = { code: null, message: "accepted" };
  try {
    await client.query(sql, params);
  } catch (e) {
    const err = e as { code?: string; message: string };
    said = { code: err.code ?? null, message: err.message };
  }
  await client.query("ROLLBACK TO SAVEPOINT attempt");
  await client.query("RELEASE SAVEPOINT attempt");
  return said;
}

/* ─── F9's snapshot ────────────────────────────────────────────────────── */

type Snapshot = Record<string, Row[]>;

/**
 * Everything that decides what `mada_app` may do in this database, read as
 * admin on one connection: the role itself, every relation, column, function
 * and policy in `public`, the schema, the default privileges and the
 * database's own ACL.
 */
async function privilegeSnapshot(db: Db): Promise<Snapshot> {
  const client = new pg.Client({ connectionString: db.ownerUrl });
  await client.connect();
  const read = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as Row[];
  try {
    return {
      "mada_app's role attributes": await read(
        `SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls,
                rolconnlimit, rolvaliduntil::text AS rolvaliduntil, rolconfig
         FROM pg_roles WHERE rolname = $1`,
        [APP_ROLE],
      ),
      "roles mada_app is a member of": await read(
        `SELECT r.rolname AS role, m.admin_option
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
         WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY 1`,
        [APP_ROLE],
      ),
      "relations in public": await read(
        `SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS relacl,
                c.relrowsecurity, c.relforcerowsecurity,
                CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f') THEN ARRAY(
                  SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
                    WITH ORDINALITY AS t(p, n)
                  WHERE has_table_privilege($1::name, c.oid, p) ORDER BY n
                ) END AS app_table_privileges,
                CASE WHEN c.relkind = 'S' THEN ARRAY(
                  SELECT p FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) WITH ORDINALITY AS t(p, n)
                  WHERE has_sequence_privilege($1::name, c.oid, p) ORDER BY n
                ) END AS app_sequence_privileges
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace ORDER BY c.relname`,
        [APP_ROLE],
      ),
      "column ACLs": await read(
        `SELECT c.relname, a.attname, a.attacl::text AS attacl
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL ORDER BY 1, 2`,
      ),
      "functions in public": await read(
        `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS proacl,
                p.prosecdef, p.prosrc, has_function_privilege($1::name, p.oid, 'EXECUTE') AS app_may_execute
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`,
        [APP_ROLE],
      ),
      "schema public": await read(
        `SELECT pg_get_userbyid(n.nspowner) AS owner, n.nspacl::text AS nspacl,
                has_schema_privilege($1::name, n.oid, 'CREATE') AS app_create,
                has_schema_privilege($1::name, n.oid, 'USAGE') AS app_usage
         FROM pg_namespace n WHERE n.nspname = 'public'`,
        [APP_ROLE],
      ),
      "pg_policies for public": await read(
        `SELECT schemaname, tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check
         FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
      ),
      pg_default_acl: await read(
        `SELECT pg_get_userbyid(d.defaclrole) AS role, d.defaclnamespace::regnamespace::text AS schema,
                d.defaclobjtype::text AS objtype, d.defaclacl::text AS acl
         FROM pg_default_acl d ORDER BY 1, 2, 3`,
      ),
      "the database's ACL": await read(`SELECT datacl::text AS datacl FROM pg_database WHERE datname = current_database()`),
    };
  } finally {
    await client.end();
  }
}

/** `mada_app`'s effective privileges on the three tables the command writes, from a snapshot. */
const appPrivileges = (snapshot: Snapshot) =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      snapshot["relations in public"].find((r) => r.relname === table)?.app_table_privileges ?? "no such table",
    ]),
  );

const SELECT_ONLY = { clinics: ["SELECT"], staff: ["SELECT"], memberships: ["SELECT"] };

/* ─── Commands used by more than one test ──────────────────────────────── */

/** F1(a). Also F3's setup and first case, and F9's first run. */
const F1A = [
  "--clinic-name",
  "  عيادة الاختبار  ",
  "--owner-name",
  "  د. سارة الأحمد  ",
  "--phone",
  "+966511110001",
  "--email",
  "Owner.One@Clinic.Test",
];

/** F2's first command. Also F9's second run. */
const F2_FIRST = ["--clinic-id", "c1", "--owner-name", "مالك العيادة", "--email", "c1.owner@clinic.test"];

/** F3(b): F1(a)'s phone with a new email. Also F9's third run. */
const F3B = ["--clinic-name", "أخرى", "--owner-name", "آخر", "--phone", "+966511110001", "--email", "new.one@clinic.test"];

/** F6's command. Also F9's fourth run. */
const F6_UNKNOWN = ["--clinic-id", "zz", "--owner-name", "مالك", "--phone", "+966511110007"];

/** F7's two commands: create, and --clinic-id c1. F8 runs the same two. */
const F7_CREATE = ["--clinic-name", "عيادة", "--owner-name", "مالك", "--phone", "+966511110008"];
const F7_C1 = ["--clinic-id", "c1", "--owner-name", "مالك", "--phone", "+966511110008"];

/** F10, F11 and F14: valid arguments naming a clinic that doesn't exist, so a run that wrongly connects can only read. */
const NO_SUCH_CLINIC = ["--clinic-id", "zz-no-such-clinic", "--owner-name", "مالك", "--email", "nobody@clinic.test"];

/** F15's trigger, exactly as the spec gives it. Deferred, so it fires at COMMIT and ends the command's own session there. */
const DROP_AT_COMMIT = `CREATE FUNCTION founder_test_drop_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_terminate_backend(pg_backend_pid());
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER founder_test_drop_at_commit AFTER INSERT ON memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION founder_test_drop_at_commit();`;

/* ─── Tests ────────────────────────────────────────────────────────────── */

describe("founder script: create a clinic and its owner (#44)", () => {
  afterAll(async () => {
    if (template === undefined) return;
    const db = await template.catch(() => null);
    await db?.drop();
  }, 60_000);

  it(
    "F1: --clinic-name creates a clinic, its owner account and an owner membership in one run, names trimmed and email lower-cased, and prints them as one JSON line",
    () =>
      withMigratedDb("f1", async ({ db }) => {
        // Done-when 1. Three runs on one database: phone and email, phone
        // only, email only.
        // On main the first run exits 1 (Cannot find module), not 0.
        const started = new Date().toISOString();
        const env = ownerEnv(db.ownerUrl);
        const cases = [
          { tag: "F1(a)", args: F1A, clinic: "عيادة الاختبار", owner: "د. سارة الأحمد", phone: "+966511110001", email: "owner.one@clinic.test" },
          {
            tag: "F1(b)",
            args: ["--clinic-name", "عيادة ثانية", "--owner-name", "مالك ثان", "--phone", "+966511110002"],
            clinic: "عيادة ثانية",
            owner: "مالك ثان",
            phone: "+966511110002",
            email: null,
          },
          {
            tag: "F1(c)",
            args: ["--clinic-name", "عيادة ثالثة", "--owner-name", "مالك ثالث", "--email", "owner.three@clinic.test"],
            clinic: "عيادة ثالثة",
            owner: "مالك ثالث",
            phone: null,
            email: "owner.three@clinic.test",
          },
        ];

        for (const c of cases) {
          const before = await readRows(db);
          const { json, target } = await succeeds(c.tag, env, c.args);
          expect(json, `${c.tag}: the JSON on stdout`).toEqual({
            clinic: { id: expect.stringMatching(/^c[0-9a-f]{12}$/), name: c.clinic, created: true },
            owner: { id: expect.stringMatching(/^u[0-9a-f]{12}$/), name: c.owner, phone: c.phone, email: c.email },
            role: "owner",
          });

          const added = gained(c.tag, before, await readRows(db));
          const ended = new Date().toISOString();
          expect(added, `${c.tag}: the rows gained`).toEqual({
            clinics: [{ id: json.clinic.id, name: json.clinic.name, createdAt: expect.stringMatching(ISO) }],
            staff: [
              {
                id: json.owner.id,
                name: json.owner.name,
                phone: json.owner.phone,
                email: json.owner.email,
                createdAt: expect.stringMatching(ISO),
              },
            ],
            memberships: [
              { staff_id: json.owner.id, clinic_id: json.clinic.id, role: "owner", createdAt: expect.stringMatching(ISO) },
            ],
          });
          for (const table of TABLES) {
            const at = String(added[table][0].createdAt);
            expect(
              started <= at && at <= ended,
              `${c.tag}: ${table}.createdAt ${at} lies between the test's start ${started} and ${ended}`,
            ).toBe(true);
          }

          if (c.tag !== "F1(a)") continue;

          // After (a): sign-in finds the account by the stored forms only.
          expect(await lookup(db, "+966511110001"), "F1(a): lookup of the phone").toEqual(lookupRow(json));
          expect(await lookup(db, "owner.one@clinic.test"), "F1(a): lookup of the stored email").toEqual(lookupRow(json));
          expect(await lookup(db, "Owner.One@Clinic.Test"), "F1(a): lookup of the email as typed").toEqual([]);

          // The account is visible from its own clinic and from no other.
          const staffSeenFrom = (clinic: string) =>
            asClinic(db, clinic, async (client) =>
              (await client.query("SELECT id FROM staff ORDER BY id")).rows.map((r) => r.id as string),
            );
          expect(
            { "the new clinic": await staffSeenFrom(json.clinic.id), c1: await staffSeenFrom("c1") },
            `F1(a): SELECT id FROM staff as ${APP_ROLE}, by clinic context`,
          ).toEqual({ "the new clinic": [json.owner.id], c1: [] });

          // The target line names the test database, the port and the admin role.
          const admin = targetOf(db.ownerUrl);
          expect(
            {
              "the test database": target.includes(db.name),
              "the port": target.includes(admin.port),
              "the admin role": target.includes(admin.role),
            },
            `F1(a): the target line: ${target}`,
          ).toEqual({ "the test database": true, "the port": true, "the admin role": true });
        }
      }),
    MIGRATED_MS,
  );

  it(
    "F2: --clinic-id c1 gives the existing clinic an owner without changing it, and a second owner is accepted",
    () =>
      withMigratedDb("f2", async ({ db }) => {
        // On main the first run exits 1, not 0.
        const env = ownerEnv(db.ownerUrl);
        const before = await readRows(db);

        const first = await succeeds("F2, first owner", env, F2_FIRST);
        expect(first.json.clinic, "F2: the JSON's clinic").toEqual({ id: "c1", name: C1_NAME, created: false });
        const after = await readRows(db);
        expect(after.clinics, "F2: the clinics rows are unchanged").toEqual(before.clinics);
        const added = gained("F2, first owner", before, after);
        expect(
          {
            clinics: added.clinics,
            staff: added.staff.map((r) => r.id),
            memberships: added.memberships.map((r) => [r.staff_id, r.clinic_id, r.role]),
          },
          "F2: one new account and one membership",
        ).toEqual({
          clinics: [],
          staff: [first.json.owner.id],
          memberships: [[first.json.owner.id, "c1", "owner"]],
        });
        expect(await lookup(db, "c1.owner@clinic.test"), "F2: lookup of the email").toEqual([
          { staff_id: first.json.owner.id, clinic_id: "c1", role: "owner" },
        ]);

        const second = await succeeds("F2, second owner", env, [
          "--clinic-id",
          "c1",
          "--owner-name",
          "شريك",
          "--phone",
          "+966511110003",
        ]);
        const owners = await db.query(`SELECT staff_id, role FROM memberships WHERE clinic_id = 'c1' ORDER BY staff_id`);
        expect(owners, "F2: c1's memberships after the second run").toEqual(
          [first.json.owner.id, second.json.owner.id].sort().map((id) => ({ staff_id: id, role: "owner" })),
        );
      }),
    MIGRATED_MS,
  );

  it(
    "F3: a phone or an email that is already stored exits 1, says which one, and leaves the rows unchanged",
    () =>
      withMigratedDb("f3", async ({ db }) => {
        // Done-when 2. On main the setup run exits 1, not 0.
        const env = ownerEnv(db.ownerUrl);
        await succeeds("F3 setup: F1(a)", env, F1A);
        const before = await readRows(db);

        const cases: { tag: string; args: string[]; last: Last }[] = [
          { tag: "F3(a): F1(a) again, identical", args: F1A, last: { is: "already stored" } },
          { tag: "F3(b): the same phone, a new email", args: F3B, last: { is: "phone already stored" } },
          {
            tag: "F3(c): a new phone, the same email in capitals",
            args: ["--clinic-name", "أخرى", "--owner-name", "آخر", "--phone", "+966511110009", "--email", "OWNER.ONE@CLINIC.TEST"],
            last: { is: "email already stored" },
          },
          {
            tag: "F3(d): --clinic-id c1 with the same phone",
            args: ["--clinic-id", "c1", "--owner-name", "آخر", "--phone", "+966511110001"],
            last: { is: "phone already stored" },
          },
          {
            tag: "F3(e): --clinic-id c1 with the same email",
            args: ["--clinic-id", "c1", "--owner-name", "آخر", "--email", "owner.one@clinic.test"],
            last: { is: "email already stored" },
          },
        ];
        for (const c of cases) {
          await fails(c.tag, env, c.args, { exit: 1, last: c.last });
          expect(await readRows(db), `${c.tag}: the rows are unchanged`).toEqual(before);
        }
      }),
    MIGRATED_MS,
  );

  it(
    "F4: when the last write fails, the clinic and the account are rolled back with it, and the same command succeeds once the block is lifted",
    () =>
      withMigratedDb("f4", async ({ db }) => {
        // Done-when 2: the three writes are one transaction. The CHECK lets
        // the clinic and the account in and refuses the membership.
        // On main the exit code is 1 as expected, but stderr is Node's
        // "Cannot find module", with no `founder: ` line and no 23514.
        const env = ownerEnv(db.ownerUrl);
        await db.query(`ALTER TABLE memberships ADD CONSTRAINT founder_test_block CHECK (false) NOT VALID`);
        const before = await readRows(db);
        const create = ["--clinic-name", "عيادة", "--owner-name", "مالك", "--phone", "+966511110004", "--email", "four@clinic.test"];

        await fails("F4, create", env, create, { exit: 1, last: { is: "sqlstate", code: "23514" } });
        expect(await readRows(db), "F4, create: the rows are unchanged").toEqual(before);

        await fails("F4, --clinic-id c1", env, ["--clinic-id", "c1", "--owner-name", "مالك", "--phone", "+966511110005"], {
          exit: 1,
          last: { is: "refused" },
        });
        expect(await readRows(db), "F4, --clinic-id c1: the rows are unchanged").toEqual(before);

        // Control: without the block the first command writes all three.
        await db.query(`ALTER TABLE memberships DROP CONSTRAINT founder_test_block`);
        await succeeds("F4 control: create with the constraint dropped", env, create);
        expect(counts(gained("F4 control", before, await readRows(db))), "F4 control: the rows gained").toEqual(ONE_OF_EACH);
      }),
    MIGRATED_MS,
  );

  it(
    "F5: of two runs started together with the same phone, exactly one exits 0 and the other exits 1 with the phone message, leaving one clinic, one account and one membership",
    () =>
      withMigratedDb("f5", async ({ db }) => {
        // On main neither run exits 0.
        const env = ownerEnv(db.ownerUrl);
        const before = await readRows(db);
        const [a, b] = await Promise.all([
          start(["--clinic-name", "سباق أ", "--owner-name", "أ", "--phone", "+966511110006", "--email", "race.a@clinic.test"], env),
          start(["--clinic-name", "سباق ب", "--owner-name", "ب", "--phone", "+966511110006", "--email", "race.b@clinic.test"], env),
        ]);
        expect(
          [a.code, b.code].sort(),
          `F5: the two exit codes, sorted\nrun A: ${shown(a)}\n\nrun B: ${shown(b)}`,
        ).toEqual([0, 1]);

        const [winner, loser] = a.code === 0 ? [a, b] : [b, a];
        const { json } = judgeSuccess("F5, the run that exited 0", winner);
        judge("F5, the run that exited 1", loser, { exit: 1, last: { is: "phone already stored" } });

        const added = gained("F5", before, await readRows(db));
        expect(
          {
            clinics: added.clinics.map((r) => r.id),
            staff: added.staff.map((r) => r.id),
            memberships: added.memberships.map((r) => [r.staff_id, r.clinic_id]),
          },
          "F5: the rows gained carry the winner's ids",
        ).toEqual({
          clinics: [json.clinic.id],
          staff: [json.owner.id],
          memberships: [[json.owner.id, json.clinic.id]],
        });
      }),
    MIGRATED_MS,
  );

  it(
    'F6: --clinic-id with an unknown id exits 1 with a "no clinic" line that quotes the id, names its target, and writes nothing',
    () =>
      withMigratedDb("f6", async ({ db }) => {
        // The run that can't write, which manual check 2 relies on to show
        // the target before the real run.
        // On main the exit code is 1 as expected, but stderr is Node's
        // "Cannot find module": no `founder: ` line, no target line.
        const before = await readRows(db);
        const target = await fails("F6", ownerEnv(db.ownerUrl), F6_UNKNOWN, { exit: 1, last: { is: "no clinic", id: "zz" } });
        expect(target.startsWith(TARGET), `F6: the refused run has its target line: ${target}`).toBe(true);
        expect(await readRows(db), "F6: the rows are unchanged").toEqual(before);
      }),
    MIGRATED_MS,
  );

  it(
    "F7: on a database that isn't migrated the command exits 1 saying so, and creates no table, runs no migration and leaves no clinic",
    () =>
      withCleanup(async (defer) => {
        // No server. On main the exit code is 1 as expected, but stderr is
        // Node's "Cannot find module", not a `founder: ` line with /migrat/i.
        const relations = (db: Db) =>
          db
            .query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace ORDER BY 1`)
            .then((rows) => rows.map((r) => r.relname as string));
        const notMigrated: Refusal = { exit: 1, last: { is: "not migrated" } };

        // (a) Nothing applied.
        const a = await freshDb(defer);
        await fails("F7(a), create", ownerEnv(a.ownerUrl), F7_CREATE, notMigrated);
        await fails("F7(a), --clinic-id c1", ownerEnv(a.ownerUrl), F7_C1, notMigrated);
        expect(await relations(a), "F7(a): relations in public afterwards").toEqual([]);

        // (b) 0001–0003 applied as admin, the way M8 applies them: `clinics`
        // exists, `staff` doesn't.
        const b = await freshDb(defer);
        await applyAll(b.ownerUrl, ["0001_init.sql", "0002_clinics.sql", "0003_rls.sql"]);
        const before = await relations(b);
        await fails("F7(b), create", ownerEnv(b.ownerUrl), F7_CREATE, notMigrated);
        expect(
          { clinics: (await b.query(`SELECT id FROM clinics ORDER BY id`)).map((r) => r.id), relations: await relations(b) },
          "F7(b): the clinics and the relation names in public afterwards",
        ).toEqual({ clinics: ["c1"], relations: before });
      }),
    NO_SERVER_MS,
  );

  it(
    "F8: with the app role's URL as DATABASE_OWNER_URL both commands exit 1 with the permission-denied line, write nothing, and name mada_app in the target line",
    () =>
      withMigratedDb("f8", async ({ db }) => {
        // On main the exit code is 1 as expected, but stderr is Node's
        // "Cannot find module": no `founder: ` line, no target line.
        const env = ownerEnv(db.url);
        const before = await readRows(db);
        const runs: [string, string[]][] = [
          ["F8, create", F7_CREATE],
          ["F8, --clinic-id c1", F7_C1],
        ];
        for (const [label, args] of runs) {
          const target = await fails(label, env, args, { exit: 1, last: { is: "permission denied" } });
          expect(target, `${label}: the target line names the role`).toContain(APP_ROLE);
          expect(await readRows(db), `${label}: the rows are unchanged`).toEqual(before);
        }
      }),
    MIGRATED_MS,
  );

  it(
    "F9: the app role's privileges, the ACLs, the RLS flags and the policies are the same after the command as before, and mada_app still can't insert into clinics, staff or memberships",
    () =>
      withMigratedDb("f9", async ({ db }) => {
        // Done-when 3. On main the two runs that must exit 0 exit 1 (the
        // test stops at the first).
        const env = ownerEnv(db.ownerUrl);
        const first = await privilegeSnapshot(db);

        const { json } = await succeeds("F9: F1(a)", env, F1A);
        await succeeds("F9: F2's first command", env, F2_FIRST);
        await fails("F9: F3(b)", env, F3B, { exit: 1, last: { is: "phone already stored" } });
        await fails("F9: F6's command", env, F6_UNKNOWN, { exit: 1, last: { is: "no clinic", id: "zz" } });

        expect(await privilegeSnapshot(db), "F9: the snapshot after the four runs").toEqual(first);
        expect(appPrivileges(first), `F9: ${APP_ROLE}'s effective privileges in the first snapshot`).toEqual(SELECT_ONLY);

        // As mada_app with the new clinic's context: no write privilege.
        const refused = await asClinic(db, json.clinic.id, async (client) => ({
          clinics: await refusal(client, `INSERT INTO clinics(id, name, "createdAt") VALUES ($1, $2, $3)`, ["c9", "عيادة تاسعة", NOW]),
          staff: await refusal(client, `INSERT INTO staff(id, name, phone, email, "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
            "u9",
            "موظف جديد",
            "+966511110099",
            null,
            NOW,
          ]),
          memberships: await refusal(
            client,
            `INSERT INTO memberships(staff_id, clinic_id, role, "createdAt") VALUES ($1, $2, $3, $4)`,
            [json.owner.id, json.clinic.id, "therapist", NOW],
          ),
        }));
        expect(refused, `F9: inserts as ${APP_ROLE} with the new clinic's context`).toEqual({
          clinics: { code: "42501", message: "permission denied for table clinics" },
          staff: { code: "42501", message: "permission denied for table staff" },
          memberships: { code: "42501", message: "permission denied for table memberships" },
        });

        // Controls: the snapshot sees each kind of change, and its undo.
        const controls = [
          { change: `GRANT INSERT ON clinics TO ${APP_ROLE}`, undo: `REVOKE INSERT ON clinics FROM ${APP_ROLE}` },
          { change: `GRANT INSERT ON staff TO PUBLIC`, undo: `REVOKE INSERT ON staff FROM PUBLIC` },
          { change: `ALTER TABLE staff NO FORCE ROW LEVEL SECURITY`, undo: `ALTER TABLE staff FORCE ROW LEVEL SECURITY` },
          { change: `CREATE POLICY f9_open ON memberships FOR SELECT USING (true)`, undo: `DROP POLICY f9_open ON memberships` },
        ];
        for (const { change, undo } of controls) {
          await db.query(change);
          expect(await privilegeSnapshot(db), `F9 control: the snapshot after ${change}`).not.toEqual(first);
          await db.query(undo);
          expect(await privilegeSnapshot(db), `F9 control: the snapshot after ${undo}`).toEqual(first);
        }
      }),
    MIGRATED_MS,
  );

  it(
    "F10: invalid arguments, names, phones and emails exit 2 with a usage line before any connection is tried, and valid ones go on to fail to connect",
    async () => {
      // No database. Nothing listens on the URL's port, so exit 2 rather
      // than 1 proves no connection was tried, and the two controls prove
      // the port really refuses.
      // On main every case exits 1 (Cannot find module), not 2.
      const port = await freePort();
      const env = { DATABASE_OWNER_URL: `postgres://founder:${SECRET}@127.0.0.1:${port}/nodb` };
      const P = ["--phone", "+966501234567"];
      const ID = ["--clinic-id", "c1"];
      const OWNER = ["--owner-name", "م"];
      const email255 = `${"a".repeat(243)}@clinic.test`;
      const email254 = `${"a".repeat(242)}@clinic.test`;
      expect([email255.length, email254.length], "fixture: the two long emails").toEqual([255, 254]);

      const cases: { label: string; args: string[]; want: Want }[] = [];
      const refused = (label: string, args: string[], first?: string) =>
        cases.push({ label, args, want: { exit: 2, first: first === undefined ? [] : [first] } });

      // Arguments.
      refused("no arguments", []);
      refused("both --clinic-name and --clinic-id", ["--clinic-name", "ع", ...ID, ...OWNER, ...P]);
      refused("neither --clinic-name nor --clinic-id", [...OWNER, ...P]);
      refused("no --owner-name", [...ID, ...P]);
      refused("neither --phone nor --email", [...ID, ...OWNER]);
      refused("an option that doesn't exist: --role therapist", [...ID, ...OWNER, ...P, "--role", "therapist"]);
      refused("a positional argument", [...ID, ...OWNER, ...P, "extra"]);
      refused("--phone twice", [...ID, ...OWNER, ...P, "--phone", "+966501234568"]);
      refused("--clinic-id ''", ["--clinic-id", "", ...OWNER, ...P]);

      // Names: empty, blank, and with a control character.
      for (const name of ["", "   ", "a\nb"]) {
        refused(`--owner-name ${JSON.stringify(name)}`, [...ID, "--owner-name", name, ...P], "--owner-name");
        refused(`--clinic-name ${JSON.stringify(name)}`, ["--clinic-name", name, ...OWNER, ...P], "--clinic-name");
      }

      // Phones: used exactly as typed, E.164 or refused.
      const phones: [string, string][] = [
        ["0501234567", "local form"],
        ["966501234567", "no plus"],
        ["00966501234567", "00 prefix"],
        ["+966 50 123 4567", "spaces"],
        ["+0501234567", "leading zero"],
        ["+9665012", "too short"],
        ["+9665012345678901", "too long"],
        ["", "empty"],
        [" +966501234567", "leading space"],
        ["+٩٦٦٥٠١٢٣٤٥٦٧", "Arabic-Indic digits"],
        ["\uFF0B966501234567", "fullwidth plus U+FF0B"],
        ["+966501234567\u200F", "trailing U+200F"],
      ];
      for (const [phone, why] of phones) {
        refused(`--phone ${JSON.stringify(phone)} (${why})`, [...ID, ...OWNER, "--phone", phone], "--phone");
      }

      // Emails: plain ASCII, one @, a dotted domain, at most 254 characters.
      const emails: [string, string][] = [
        ["xclinic.test", "no @"],
        ["x@y@clinic.test", "two @"],
        ["@clinic.test", "no local part"],
        ["x@", "no domain"],
        ["", "empty"],
        [" x@clinic.test", "leading space"],
        ["x@clinic.test ", "trailing space"],
        ["x@localhost", "no dot in the domain"],
        ["x@clinic..test", "empty domain label"],
        ["x\u200B@clinic.test", "U+200B"],
        ["x\u202E@clinic.test", "U+202E"],
        ["x\u0001@clinic.test", "U+0001"],
        ["مالك@clinic.test", "Arabic local part"],
        ["\u212A@clinic.test", "U+212A, which lower-cases to k"],
        [email255, "255 characters: only the length limit refuses it"],
      ];
      for (const [email, why] of emails) {
        const label = email === email255 ? "--email a×243@clinic.test" : `--email ${JSON.stringify(email)}`;
        refused(`${label} (${why})`, [...ID, ...OWNER, "--email", email], "--email");
      }
      refused("a valid --phone with --email xclinic.test", [...ID, ...OWNER, ...P, "--email", "xclinic.test"], "--email");

      // Controls: valid input reaches the connection attempt, which is
      // refused. The line names neither the host nor the port (amendment 5).
      const refusedConnection: Want = {
        exit: 1,
        last: { is: "could not connect", code: "ECONNREFUSED" },
        absent: ["127.0.0.1", String(port)],
      };
      cases.push({
        label: "control: --email Owner.Name+tag@Clinic.Test with a valid phone",
        args: [...ID, ...OWNER, ...P, "--email", "Owner.Name+tag@Clinic.Test"],
        want: refusedConnection,
      });
      cases.push({
        label: "control: --email a×242@clinic.test (254 characters, the longest allowed)",
        args: [...ID, ...OWNER, "--email", email254],
        want: refusedConnection,
      });
      expect(cases.length, "fixture: the number of F10 cases").toBe(45);

      const all = tally();
      for (const c of cases) all.add(c.label, await start(c.args, env), c.want);
      all.settle("F10");
    },
    NO_SERVER_MS,
  );

  it(
    "F11: with DATABASE_OWNER_URL absent or empty the command exits 2 naming the variable, and never falls back to DATABASE_URL",
    () =>
      withMigratedDb("f11", async ({ db }) => {
        // DATABASE_URL points at a database the command could write to. The
        // clinic id doesn't exist on purpose: a wrong implementation that
        // connects anywhere can only read.
        // On main both runs exit 1, not 2.
        const before = await readRows(db);
        const cases: [string, Record<string, string>][] = [
          ["F11(a): DATABASE_OWNER_URL absent", { DATABASE_URL: db.ownerUrl }],
          ["F11(b): DATABASE_OWNER_URL empty", { DATABASE_URL: db.ownerUrl, DATABASE_OWNER_URL: "" }],
        ];
        for (const [label, env] of cases) {
          await fails(label, env, NO_SUCH_CLINIC, { exit: 2, anywhere: ["DATABASE_OWNER_URL"] });
          expect(await readRows(db), `${label}: the rows are unchanged`).toEqual(before);
        }
      }),
    MIGRATED_MS,
  );

  it(
    "F12: under an owner that is BYPASSRLS but not a superuser both commands exit 0, name that role in the target line, and the lookup finds each account",
    () =>
      withCleanup(async (defer) => {
        // No server, as in M8(b): 0001–0004 applied as the new role, so this
        // database has no schema_migrations for the command to read.
        // On main the first run exits 1, not 0.
        const b = await dbOwnedByNewRole(defer, "LOGIN NOSUPERUSER BYPASSRLS");
        await applyAll(b.url, ["0001_init.sql", "0002_clinics.sql", "0003_rls.sql", "0004_staff.sql"]);
        const env = ownerEnv(b.url);

        const created = await succeeds("F12, create", env, ["--clinic-name", "عيادة", "--owner-name", "مالك", "--phone", "+966511110010"]);
        const given = await succeeds("F12, --clinic-id c1", env, [
          "--clinic-id",
          "c1",
          "--owner-name",
          "مالك",
          "--email",
          "bypass@clinic.test",
        ]);

        // The role comes from the connection, not from a fixed string.
        expect(created.target, "F12, create: the target line names the random role").toContain(b.role);
        expect(given.target, "F12, --clinic-id c1: the target line names the random role").toContain(b.role);

        expect(await lookup(b.db, "+966511110010"), "F12: lookup of the phone").toEqual(lookupRow(created.json));
        expect(await lookup(b.db, "bypass@clinic.test"), "F12: lookup of the email").toEqual([
          { staff_id: given.json.owner.id, clinic_id: "c1", role: "owner" },
        ]);
      }),
    NO_SERVER_MS,
  );

  it(
    "F13: quotes, semicolons and SQL in a name or an id are stored as text and never run",
    () =>
      withMigratedDb("f13", async ({ db }) => {
        // D17: every value is a bound parameter. The values are exact argv
        // strings. Only the stored rows and the grants show a statement
        // built by concatenation: such a draft exits 0 on (b) with the right
        // JSON, stores `x` and grants INSERT.
        // On main (a) exits 1, not 0.
        const env = ownerEnv(db.ownerUrl);
        const cases = [
          { tag: "F13(a)", clinic: `عيادة O'Neil "الفرع"; -- x`, owner: `د. سارة' "م"; -- y`, phone: "+966511110011" },
          { tag: "F13(b)", clinic: `x', 'y'); GRANT INSERT ON clinics TO mada_app; --`, owner: "مالك", phone: "+966511110012" },
          {
            tag: "F13(c)",
            clinic: "عيادة",
            owner: `x', NULL, NULL, 'y'); GRANT INSERT ON staff TO mada_app; --`,
            phone: "+966511110013",
          },
        ];
        for (const c of cases) {
          const before = await readRows(db);
          const { json } = await succeeds(c.tag, env, ["--clinic-name", c.clinic, "--owner-name", c.owner, "--phone", c.phone]);
          const added = gained(c.tag, before, await readRows(db));
          expect(
            {
              "JSON clinic.name": json.clinic.name,
              "JSON owner.name": json.owner.name,
              "stored clinics.name": added.clinics.map((r) => r.name),
              "stored staff.name": added.staff.map((r) => r.name),
              "rows gained": counts(added),
            },
            `${c.tag}: the names, as printed and as stored`,
          ).toEqual({
            "JSON clinic.name": c.clinic,
            "JSON owner.name": c.owner,
            "stored clinics.name": [c.clinic],
            "stored staff.name": [c.owner],
            "rows gained": ONE_OF_EACH,
          });
        }

        // (d) An id that a concatenated lookup would read as `… OR id='c1'`.
        const id = `zz' OR id='c1`;
        const before = await readRows(db);
        await fails("F13(d)", env, ["--clinic-id", id, "--owner-name", "دخيل", "--phone", "+966511110014"], {
          exit: 1,
          last: { is: "no clinic", id },
        });
        expect(await readRows(db), "F13(d): the rows are unchanged by this run").toEqual(before);
        expect(
          await db.query(`SELECT staff_id FROM memberships WHERE clinic_id = 'c1'`),
          "F13(d): c1's memberships",
        ).toEqual([]);

        // After all four: no GRANT hidden in a value ran.
        expect(
          appPrivileges(await privilegeSnapshot(db)),
          `F13: ${APP_ROLE}'s effective privileges after all four runs`,
        ).toEqual(SELECT_ONLY);
      }),
    MIGRATED_MS,
  );

  it(
    "F14: a DATABASE_OWNER_URL that can't be used exits 2 without a connection, one that can't connect exits 1 with only the error's code, and nothing of its value is printed",
    async () => {
      // No server, no migrated database. The arguments are valid in every
      // case, so only the URL decides the outcome. Each URL carries the
      // planted password somewhere a careless message would repeat it.
      // On main (a)–(c) exit 1, not 2; (d) and (e) exit 1 as expected, but
      // stderr is Node's "Cannot find module".
      const port = await freePort();
      const unusable: Want = { exit: 2, first: ["DATABASE_OWNER_URL"] };

      // (d) connects to the test cluster and asks for a database that
      // doesn't exist. The server's own message names that database. It is
      // never created.
      const missing = new URL(adminUrl());
      missing.pathname = `/nodb_${SECRET}`;

      const cases: { label: string; url: string; want: Want }[] = [
        {
          label: "F14(a): a port that isn't a number",
          url: `postgres://founder:${SECRET}@127.0.0.1:notaport/nodb`,
          want: unusable,
        },
        {
          label: "F14(b): an unencoded / in the password",
          url: `postgres://founder:${SECRET}/x@127.0.0.1:${port}/nodb`,
          want: unusable,
        },
        { label: "F14(c): a password pasted where the URL belongs", url: SECRET, want: unusable },
        {
          label: "F14(d): a database that doesn't exist, named after the password",
          url: missing.href,
          want: { exit: 1, last: { is: "could not connect", code: "3D000" } },
        },
        {
          label: "F14(e): the password parsed as the database name, on a port nothing listens on",
          url: `postgres://127.0.0.1:${port}/${SECRET}@127.0.0.1:${port}/nodb`,
          want: {
            exit: 1,
            last: { is: "could not connect", code: "ECONNREFUSED" },
            absent: ["127.0.0.1", String(port)],
          },
        },
      ];

      const all = tally();
      for (const c of cases) all.add(c.label, await start(NO_SUCH_CLINIC, { DATABASE_OWNER_URL: c.url }), c.want);
      all.settle("F14");
    },
    NO_SERVER_MS,
  );

  it(
    'F15: when the connection is lost during COMMIT the command exits 1 saying the outcome is not known, never "Nothing was written."',
    () =>
      withMigratedDb("f15", async ({ db }) => {
        // D16. The deferred trigger ends the command's own session at
        // COMMIT. Here the server did roll back; the command can't tell,
        // which is the point.
        // On main the exit code is 1 as expected, but stderr is Node's
        // "Cannot find module", and there is no target line.
        const env = ownerEnv(db.ownerUrl);
        await db.query(DROP_AT_COMMIT);
        const before = await readRows(db);
        const create = ["--clinic-name", "عيادة", "--owner-name", "مالك", "--phone", "+966511110015"];

        await fails("F15", env, create, { exit: 1, last: { is: "commit failed" } });
        expect(await readRows(db), "F15: the rows are unchanged").toEqual(before);

        // Control: without the trigger the same command commits.
        await db.query(`DROP TRIGGER founder_test_drop_at_commit ON memberships`);
        await succeeds("F15 control: the same command with the trigger dropped", env, create);
        expect(counts(gained("F15 control", before, await readRows(db))), "F15 control: the rows gained").toEqual(ONE_OF_EACH);
      }),
    MIGRATED_MS,
  );
});
