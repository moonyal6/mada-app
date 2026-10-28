// API baseline: replays verify/baseline/scenario.mjs against a fresh local
// instance and compares every response with verify/baseline/fixtures.json.
//
//   npm run build && node verify/baseline.mjs           # replay
//   npm run build && node verify/baseline.mjs --record  # write the fixtures again
//   BASE=http://localhost:3211 node verify/baseline.mjs # an instance already running
//
// Without BASE it starts `next start -p 3211` on a new temporary
// MADA_DATA_DIR, with the Sentry DSNs and the Anthropic key set to empty
// strings so nothing leaves the machine. It never reads .env.
//
// It refuses a BASE that isn't localhost before sending any request, and an
// instance whose patients aren't exactly the seed p1–p3. Together they keep it
// off the demo and staging.
//
// Temporary-database mode (#29, 8b-1), off unless BASELINE_PG_ADMIN_URL is set:
//
//   BASELINE_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres \
//     node verify/baseline.mjs
//
// It creates `mada_baseline_<random>` through that URL, starts the server with
// DATABASE_URL pointing at it, and after the replay checks that every row the
// scenario created is in that database and that no mada.db* file appeared in
// MADA_DATA_DIR. The database is dropped on the way out. The URL must be a
// postgres:// URL on this machine; anything else exits 2 before a connection
// is opened. It can't be combined with BASE: the server has to be one this
// script starts.
//
// Exit 0: no differences. Exit 1: differences. Exit 2: could not run — never a
// silent pass. A run that crosses midnight in Riyadh exits 2 ("re-run").

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNormalizer, diff } from "./baseline/normalize.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./baseline/fixtures.json", import.meta.url));
const PORT = 3211;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PG_SCHEMES = new Set(["postgres:", "postgresql:"]);

/**
 * The table behind each kind of row a 201 response returns, by the body's key:
 * `{ patient: { id } }` is a row in `patients`.
 */
const CREATED_ROWS = {
  patient: "patients",
  appointment: "appointments",
  invoice: "invoices",
  item: "inventory",
  session: "sessions",
};

/**
 * @typedef {Record<string, unknown>} Bodies raw response bodies by step name
 * @typedef {{
 *   name: string,
 *   method: string,
 *   path: string | ((prev: Bodies) => string),
 *   body?: unknown | ((prev: Bodies) => unknown),
 *   headers?: Record<string, string>,
 *   finding?: string,
 *   statusOnly?: boolean,
 *   extract?: (body: unknown, ctx: { today: string }) => unknown,
 *   order?: OrderRule,
 * }} Step
 * @typedef {{
 *   list: string,
 *   rule: string,
 *   compare: (a: any, b: any) => number,
 * }} OrderRule For a list whose order the server decides by random IDs:
 *   `compare` (negative, zero or positive, like a sort comparator) is
 *   checked on the raw response, and the items are compared in a fixed
 *   order instead of response order. At most one ID in such a list may be
 *   new to the run, or its alias would depend on the response order.
 * @typedef {{
 *   name: string,
 *   method: string,
 *   path: string,
 *   status: number,
 *   body?: unknown,
 *   statusOnly?: true,
 *   order?: string,
 *   finding?: string,
 *   orderError?: string,
 * }} Fixture A status-only fixture has no `body`: it was never recorded.
 *   `orderError` exists only on a live run and is never written.
 */

/**
 * True only for an http(s) URL whose host is this machine. Pure: it decides
 * from the string alone.
 * @param {string} base
 */
export function isLocalBase(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return LOCAL_HOSTS.has(url.hostname);
}

/**
 * True only for a postgres:// URL whose host is this machine. Credentials are
 * allowed; a query string isn't, because libpq takes `?host=` and
 * `?hostaddr=` over the host in front of it. Pure: it decides from the string
 * alone.
 * @param {string} dbUrl
 */
export function isLocalDbUrl(dbUrl) {
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    return false;
  }
  if (!PG_SCHEMES.has(url.protocol)) return false;
  if (url.search || url.hash) return false;
  // An empty host falls back to PGHOST; a comma-separated list is several hosts.
  return LOCAL_HOSTS.has(url.hostname);
}

/** Calendar date in Asia/Riyadh, as YYYY-MM-DD. Mirrors `clinicToday()` in lib/server/db.ts. */
function clinicToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Thrown for anything that means "could not run" (exit 2). */
class CannotRun extends Error {}

/** @param {unknown} v */
const show = (v) => (v === undefined ? "(missing)" : JSON.stringify(v));

/**
 * @param {string} base
 * @param {string} method
 * @param {string} urlPath
 * @param {{ body?: unknown, headers?: Record<string, string> }} [opts]
 */
async function request(base, method, urlPath, { body, headers } = {}) {
  /** @type {RequestInit} */
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    /** @type {Record<string, string>} */ (init.headers)["content-type"] ??= "application/json";
  }
  const res = await fetch(base + urlPath, init);
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, body: json ? JSON.parse(text) : text };
}

/** @param {string} base */
async function assertFresh(base) {
  const { status, body } = await request(base, "GET", "/api/patients");
  const patients = /** @type {{ patients?: { id: string }[] }} */ (body)?.patients;
  const ids = Array.isArray(patients) ? patients.map((p) => p.id).sort() : null;
  if (status !== 200 || JSON.stringify(ids) !== JSON.stringify(["p1", "p2", "p3"])) {
    throw new CannotRun(
      `not a fresh instance: GET /api/patients returned ${status} with patients ${show(ids)}, expected exactly the seed p1–p3.`,
    );
  }
}

/**
 * Starts `next start` on a temporary data directory; resolves once it answers.
 * @param {Record<string, string>} [extraEnv] added to the server's environment
 */
async function startServer(extraEnv = {}) {
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new CannotRun("no production build. Run `npm run build` first.");
  }
  const base = `http://localhost:${PORT}`;
  if (await answers(base)) {
    throw new CannotRun(`something is already listening on port ${PORT}. Stop it, or point BASE= at it.`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), "mada-baseline-"));
  const child = spawn(path.join(ROOT, "node_modules", ".bin", "next"), ["start", "-p", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MADA_DATA_DIR: dataDir,
      SENTRY_DSN: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
      ANTHROPIC_API_KEY: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  /** @type {number | null} */
  let exitCode = null;
  const exited = new Promise((resolve) =>
    child.on("exit", (code) => {
      exitCode = code ?? -1;
      resolve(undefined);
    }),
  );

  const stop = async () => {
    if (exitCode === null && child.pid) {
      // The whole process group this script started, by PID — nothing else.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 60_000;
  while (!(await answers(base))) {
    if (exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new CannotRun(`next start did not come up on port ${PORT}.\n${log.trim()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, stop, dataDir };
}

/**
 * @typedef {{
 *   name: string,
 *   url: string,
 *   connect: () => Promise<import("pg").Client>,
 *   drop: () => Promise<void>,
 * }} TempDb
 */

/**
 * Creates `mada_baseline_<random>` through the admin URL. The caller has
 * already checked the URL with isLocalDbUrl; `pg` isn't loaded before that.
 * @param {string} adminUrl
 * @returns {Promise<TempDb>}
 */
async function createTempDb(adminUrl) {
  const { default: pg } = await import("pg");
  const name = `mada_baseline_${randomBytes(6).toString("hex")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  /** @param {string} connectionString */
  const connect = async (connectionString) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  };
  /** @param {string} sql */
  const admin = async (sql) => {
    const client = await connect(adminUrl);
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  try {
    // `name` is [a-z0-9_] only, so it needs no quoting.
    await admin(`CREATE DATABASE ${name}`);
  } catch (e) {
    throw new CannotRun(`cannot create a temporary database: ${/** @type {Error} */ (e).message}`);
  }
  return {
    name,
    url: url.href,
    connect: () => connect(url.href),
    drop: async () => {
      try {
        // FORCE closes connections the server's pool may have left open.
        await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } catch (e) {
        throw new CannotRun(`could not drop ${name}; drop it by hand: ${/** @type {Error} */ (e).message}`);
      }
    },
  };
}

/**
 * The rows the scenario created, by table: the IDs from every 201 response
 * shaped like `{ patient: { id } }`.
 * @param {{ status: number, body: unknown }[]} responses
 * @returns {Map<string, string[]>}
 */
function createdRows(responses) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const { status, body } of responses) {
    if (status !== 201 || !body || typeof body !== "object") continue;
    for (const [key, table] of Object.entries(CREATED_ROWS)) {
      const id = /** @type {any} */ (body)[key]?.id;
      if (typeof id === "string") out.set(table, [...(out.get(table) ?? []), id]);
    }
  }
  return out;
}

/**
 * What's wrong with where the server kept its data, or an empty list: a
 * mada.db* file in MADA_DATA_DIR, or a row the scenario created that isn't in
 * the temporary database.
 * @param {TempDb} db
 * @param {string} dataDir
 * @param {{ status: number, body: unknown }[]} responses
 * @returns {Promise<{ problems: string[], found: number, tables: number }>}
 */
async function checkDatabase(db, dataDir, responses) {
  /** @type {string[]} */
  const problems = [];
  const files = readdirSync(dataDir).filter((f) => f.startsWith("mada.db"));
  if (files.length) problems.push(`MADA_DATA_DIR holds ${files.join(", ")}: the server wrote to SQLite.`);

  const created = createdRows(responses);
  if (!created.size) throw new CannotRun("the scenario created no rows, so there is nothing to look for in the database.");

  let found = 0;
  let client;
  try {
    client = await db.connect();
  } catch (e) {
    throw new CannotRun(`cannot connect to ${db.name}: ${/** @type {Error} */ (e).message}`);
  }
  try {
    for (const [table, ids] of created) {
      let present;
      try {
        // `table` comes from CREATED_ROWS, never from a response.
        present = new Set((await client.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids])).rows.map((r) => r.id));
      } catch (e) {
        if (/** @type {{ code?: string }} */ (e).code === "42P01") {
          problems.push(`${db.name} has no table ${table}, so none of the ${ids.length} row(s) the scenario created there landed.`);
          continue;
        }
        throw new CannotRun(`cannot read ${table} in ${db.name}: ${/** @type {Error} */ (e).message}`);
      }
      found += present.size;
      const missing = ids.filter((id) => !present.has(id));
      if (missing.length) {
        problems.push(`${table} in ${db.name} lacks ${missing.length} of the ${ids.length} row(s) the scenario created: ${missing.join(", ")}`);
      }
    }
  } finally {
    await client.end();
  }
  return { problems, found, tables: created.size };
}

/** @param {string} base */
async function answers(base) {
  try {
    await fetch(base, { method: "HEAD", redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

/** @returns {Fixture[]} */
function readFixtures() {
  try {
    return JSON.parse(readFileSync(FIXTURES, "utf8")).steps;
  } catch (e) {
    throw new CannotRun(`cannot read ${path.relative(ROOT, FIXTURES)}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Runs every step and returns what it would record.
 * @param {string} base
 * @param {Step[]} steps
 * @param {string} today
 * @param {{ status: number, body: unknown }[]} [responses] gets every raw response, in step order
 * @returns {Promise<Fixture[]>}
 */
async function runSteps(base, steps, today, responses = []) {
  const normalizer = createNormalizer({ today });
  /** @type {Bodies} */
  const prev = {};
  /** @type {Fixture[]} */
  const out = [];
  for (const step of steps) {
    const urlPath = typeof step.path === "function" ? step.path(prev) : step.path;
    const body = typeof step.body === "function" ? step.body(prev) : step.body;
    const res = await request(base, step.method, urlPath, { body, headers: step.headers });
    responses.push(res);
    prev[step.name] = res.body;
    const shown = step.extract ? step.extract(res.body, { today }) : res.body;
    const recorded = step.statusOnly ? undefined : normalizer.normalize(shown);
    let orderError;
    if (step.order) {
      const { list } = step.order;
      const raw = /** @type {any} */ (shown)?.[list];
      const items = /** @type {any} */ (recorded)?.[list];
      if (!Array.isArray(raw) || !Array.isArray(items)) {
        orderError = `expected a list at $.${list}`;
      } else {
        orderError = outOfOrder(raw, step.order);
        /** @type {any} */ (recorded)[list] = items
          .map((item) => ({ item, key: canonical(item) }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map(({ item }) => item);
      }
    }
    out.push({
      name: step.name,
      method: step.method,
      // IDs and tokens in the path get the same aliases as in the bodies.
      path: urlPath.replace(/[^/?&=]+/g, (part) => String(normalizer.normalize(part))),
      status: res.status,
      ...(step.statusOnly ? { statusOnly: true } : { body: recorded }),
      ...(step.order
        ? {
            order: `$.${step.order.list} must be sorted by ${step.order.rule}. That is checked on the raw response; the items below are in a fixed comparison order, not response order.`,
          }
        : {}),
      ...(step.finding ? { finding: step.finding } : {}),
      ...(orderError ? { orderError } : {}),
    });
  }
  return out;
}

/**
 * The first adjacent pair the rule puts the other way round, or undefined.
 * @param {any[]} raw @param {OrderRule} order
 */
function outOfOrder(raw, { compare, rule }) {
  for (let i = 1; i < raw.length; i++) {
    if (compare(raw[i - 1], raw[i]) > 0) {
      return `items ${i - 1} and ${i} break "${rule}": ${JSON.stringify(raw[i - 1])} before ${JSON.stringify(raw[i])}`;
    }
  }
  return undefined;
}

/** JSON with object keys sorted, so equal values give equal strings. @param {unknown} value */
function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Prints every difference and returns how many steps differ.
 * @param {Fixture[]} fixtures
 * @param {Fixture[]} actual
 */
function report(fixtures, actual) {
  let failed = 0;
  fixtures.forEach((f, i) => {
    const a = actual[i];
    const diffs = [
      ...(f.status === a.status ? [] : [{ path: "(status)", expected: f.status, actual: a.status }]),
      ...(f.statusOnly ? [] : diff(f.body, a.body)),
      ...(a.orderError ? [{ path: "(order)", expected: f.order, actual: a.orderError }] : []),
    ];
    if (!diffs.length) return;
    failed++;
    console.log(`✗ step ${i + 1} "${f.name}": ${a.method} ${a.path}`);
    for (const d of diffs) {
      console.log(`    ${d.path}\n      expected ${show(d.expected)}\n      actual   ${show(d.actual)}`);
    }
  });
  return failed;
}

async function main() {
  const record = process.argv.includes("--record");
  const steps = (await import("./baseline/scenario.mjs")).steps;

  const fixtures = record ? null : readFixtures();
  if (fixtures) {
    /** @param {Step | Fixture} s */
    const key = (s) => `${s.name}${s.statusOnly ? " (status only)" : ""}${s.order ? " (order rule)" : ""}`;
    if (JSON.stringify(steps.map(key)) !== JSON.stringify(fixtures.map(key))) {
      throw new CannotRun("the fixtures don't match the scenario's steps. Re-record with --record.");
    }
  }

  const pgAdminUrl = process.env.BASELINE_PG_ADMIN_URL;
  if (pgAdminUrl !== undefined) {
    // The URL may carry a password, so it isn't printed.
    if (!isLocalDbUrl(pgAdminUrl)) {
      throw new CannotRun(
        "refusing BASELINE_PG_ADMIN_URL: not a postgres:// URL on localhost, 127.0.0.1 or [::1], without a query string. No connection was opened.",
      );
    }
    if (process.env.BASE !== undefined) {
      throw new CannotRun("BASELINE_PG_ADMIN_URL needs a server this script starts; unset BASE. No connection was opened.");
    }
  }

  let base = process.env.BASE;
  let stop = async () => {};
  /** @type {TempDb | undefined} */
  let db;
  /** @type {string | undefined} */
  let dataDir;
  if (base !== undefined) {
    if (!isLocalBase(base)) throw new CannotRun(`refusing BASE=${base}: not localhost. No request was sent.`);
    base = base.replace(/\/+$/, "");
  } else {
    if (pgAdminUrl !== undefined) db = await createTempDb(pgAdminUrl);
    try {
      ({ base, stop, dataDir } = await startServer(db ? { DATABASE_URL: db.url } : {}));
    } catch (e) {
      await db?.drop();
      throw e;
    }
    if (db) {
      const { drop } = db;
      const stopServer = stop;
      // The server goes first, so its connections are gone before the drop.
      stop = () => stopServer().finally(drop);
    }
    // The server runs in its own process group, so Ctrl-C wouldn't reach it.
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
      process.once(sig, () => stop().finally(() => process.exit(2)));
    }
  }

  try {
    const today = clinicToday();
    await assertFresh(base);
    /** @type {{ status: number, body: unknown }[]} */
    const responses = [];
    const actual = await runSteps(base, steps, today, responses);
    if (clinicToday() !== today) {
      throw new CannotRun("the clinic date (Asia/Riyadh) changed during the run. Re-run.");
    }
    const stored = db ? await checkDatabase(db, /** @type {string} */ (dataDir), responses) : undefined;

    if (record) {
      if (stored?.problems.length) {
        throw new CannotRun(`not recording: ${stored.problems.join(" ")}`);
      }
      const broken = actual.find((a) => a.orderError);
      if (broken) {
        throw new CannotRun(`not recording: step "${broken.name}" ${broken.orderError}`);
      }
      writeFileSync(FIXTURES, JSON.stringify({ steps: actual }, null, 2) + "\n");
      console.log(`baseline: recorded ${actual.length} step(s) to ${path.relative(ROOT, FIXTURES)}.`);
      return 0;
    }

    const known = /** @type {Fixture[]} */ (fixtures).filter((f) => f.finding);
    const failed = report(/** @type {Fixture[]} */ (fixtures), actual);
    console.log(`known findings: ${known.length}`);
    for (const f of known) console.log(`  - "${f.name}" (${f.method} ${f.path}): ${f.finding}`);
    if (stored) {
      for (const p of stored.problems) console.log(`✗ database: ${p}`);
      if (!stored.problems.length) {
        console.log(
          `database: all ${stored.found} row(s) the scenario created are in ${db?.name} (${stored.tables} tables); no mada.db* in MADA_DATA_DIR.`,
        );
      }
    }
    if (failed || stored?.problems.length) {
      if (failed) console.log(`baseline: ${failed} of ${actual.length} step(s) differ.`);
      if (stored?.problems.length) console.log(`baseline: ${stored.problems.length} database check(s) failed.`);
      return 1;
    }
    console.log(`baseline: ${actual.length} step(s) match.`);
    return 0;
  } finally {
    await stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`baseline: ${e instanceof CannotRun ? e.message : e?.stack ?? e}`);
      process.exit(2);
    },
  );
}
