// Shared harness for the Postgres tests (#30, 8b-2), written before the
// implementation.
//
// The tests never import app code: lib/server/db.ts imports `server-only`,
// which throws under vitest. Each test instead starts the production build
// (`next start`) on a free port, against a fresh `mada_test_<random>`
// database created through TEST_DATABASE_URL, and a fresh temporary
// MADA_DATA_DIR — the pattern verify/baseline.mjs uses. Both are removed
// afterwards.
//
// Without TEST_DATABASE_URL every test fails. None is ever skipped.
//
//   npm run build
//   TEST_DATABASE_URL=postgres://moony@localhost:5433/postgres npm test
//
// Plain JS with JSDoc, like verify/: `pg` ships no types, and a .ts import of
// it fails the typecheck until @types/pg is added.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isLocalDbUrl } from "../../verify/baseline.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Generous: several servers may start at once on a small CI runner. */
export const SERVER_START_MS = 90_000;

/**
 * TEST_DATABASE_URL, checked the way the baseline checks its admin URL: a
 * postgres:// URL on this machine. Throws (fails the test) when it is missing
 * or not local; no connection is opened before the check.
 */
export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The Postgres tests need it (an admin URL such as " +
        "postgres://moony@localhost:5433/postgres) and fail without it; they are never skipped.",
    );
  }
  // The URL may carry a password, so it isn't printed.
  if (!isLocalDbUrl(url)) {
    throw new Error(
      "refusing TEST_DATABASE_URL: not a postgres:// URL on localhost, 127.0.0.1 or [::1], without a query string.",
    );
  }
  return url;
}

/**
 * @typedef {{
 *   name: string,
 *   url: string,
 *   query: (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>,
 *   drop: () => Promise<void>,
 * }} TestDb
 */

/**
 * Creates `mada_test_<random>` through TEST_DATABASE_URL. `query` opens a
 * fresh connection per call, so the test never holds one the server needs.
 * @returns {Promise<TestDb>}
 */
export async function createTestDb() {
  const adminUrl = testDatabaseUrl();
  const name = `mada_test_${randomBytes(6).toString("hex")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  /** @param {string} connectionString @param {string} sql @param {unknown[]} [params] */
  const run = async (connectionString, sql, params) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows;
    } finally {
      await client.end();
    }
  };

  // `name` is [a-z0-9_] only, so it needs no quoting.
  await run(adminUrl, `CREATE DATABASE ${name}`);
  return {
    name,
    url: url.href,
    query: (sql, params) => run(url.href, sql, params),
    // FORCE closes connections a server's pool may have left open.
    drop: async () => {
      await run(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/** A port nothing listens on right now. */
export async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const { port } = /** @type {net.AddressInfo} */ (srv.address());
  await new Promise((resolve) => srv.close(() => resolve(undefined)));
  return port;
}

/** A new, empty temporary directory for MADA_DATA_DIR. */
export function makeDataDir() {
  return mkdtempSync(path.join(tmpdir(), "mada-test-"));
}

/** Top-level names in a data directory, sorted. @param {string} dir */
export function listDataDir(dir) {
  return readdirSync(dir).sort();
}

/**
 * @typedef {{
 *   base: string,
 *   dataDir: string,
 *   log: () => string,
 *   stop: () => Promise<void>,
 * }} Server
 */

/**
 * Starts `next start` on a free port and resolves once it answers. It is
 * probed on /favicon.ico, a static file, so the database is first touched by
 * the test's own requests.
 *
 * The server gets MADA_DATA_DIR = `dataDir`, the Sentry DSNs, the Anthropic
 * key and the transcription keys as empty strings, and transcription pinned
 * to a provider with no key, so nothing leaves the machine (an empty string
 * in the process env wins over the env files). DATABASE_URL is whatever `env`
 * says; a key set to `undefined` there is removed from the server's
 * environment. Note that removing it can't stop `next start` reading it from
 * an env file in the repo root.
 *
 * @param {{ dataDir: string, env: Record<string, string | undefined> }} opts
 * @returns {Promise<Server>}
 */
export async function startServer({ dataDir, env }) {
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error("no production build. Run `npm run build` first.");
  }
  const port = await freePort();
  const base = `http://localhost:${port}`;

  /** @type {Record<string, string | undefined>} */
  const childEnv = {
    ...process.env,
    // The server must not see the test's own admin URLs.
    TEST_DATABASE_URL: undefined,
    BASELINE_PG_ADMIN_URL: undefined,
    DATABASE_URL: undefined,
    MADA_DATA_DIR: dataDir,
    SENTRY_DSN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GROQ_API_KEY: "",
    MADA_STT: "openai",
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];

  const child = spawn(path.join(ROOT, "node_modules", ".bin", "next"), ["start", "-p", String(port)], {
    cwd: ROOT,
    env: /** @type {NodeJS.ProcessEnv} */ (childEnv),
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
      // The process group this harness started, by PID — nothing else.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      }
    }
  };

  const deadline = Date.now() + SERVER_START_MS;
  for (;;) {
    try {
      await fetch(`${base}/favicon.ico`, { method: "HEAD", signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (exitCode !== null || Date.now() > deadline) {
        await stop();
        throw new Error(`next start did not come up on port ${port}.\n${log.trim()}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { base, dataDir, log: () => log, stop };
}

/**
 * One request; JSON bodies are parsed. Times out rather than hanging, so a
 * server stuck on its pool fails the test with a message.
 * @param {string} base
 * @param {string} method
 * @param {string} urlPath
 * @param {{ body?: unknown, raw?: Uint8Array, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function request(base, method, urlPath, { body, raw, timeoutMs = 15_000 } = {}) {
  /** @type {RequestInit} */
  const init = { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) };
  if (raw !== undefined) {
    init.body = raw;
    init.headers = { "content-type": "application/octet-stream" };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  let res;
  try {
    res = await fetch(base + urlPath, init);
  } catch (e) {
    throw new Error(`${method} ${urlPath} got no response within ${timeoutMs} ms: ${/** @type {Error} */ (e).message}`);
  }
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, body: json ? JSON.parse(text) : text };
}

/**
 * Runs `fn` with a cleanup list, then cleans up in reverse order even when
 * `fn` throws. A failed cleanup fails the test too, after `fn`'s own error.
 * @template T
 * @param {(defer: (cleanup: () => unknown) => void) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withCleanup(fn) {
  /** @type {(() => unknown)[]} */
  const cleanups = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {T | undefined} */
  let result;
  try {
    result = await fn((c) => cleanups.push(c));
  } catch (e) {
    errors.push(e);
  }
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) throw errors[0];
  return /** @type {T} */ (result);
}

/**
 * The common case: a fresh database and data directory, and a server on them.
 * Everything is stopped, dropped and removed when `fn` settles.
 * @template T
 * @param {(ctx: { db: TestDb, server: Server, defer: (cleanup: () => unknown) => void }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withServerOnFreshDb(fn) {
  return withCleanup(async (defer) => {
    const db = await createTestDb();
    defer(db.drop);
    const dataDir = makeDataDir();
    defer(() => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
    defer(server.stop);
    return fn({ db, server, defer });
  });
}
