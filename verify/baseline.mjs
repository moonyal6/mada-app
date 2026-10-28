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
// Exit 0: no differences. Exit 1: differences. Exit 2: could not run — never a
// silent pass. A run that crosses midnight in Riyadh exits 2 ("re-run").

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNormalizer, diff } from "./baseline/normalize.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./baseline/fixtures.json", import.meta.url));
const PORT = 3211;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * @typedef {Record<string, unknown>} Bodies raw response bodies by step name
 * @typedef {{
 *   name: string,
 *   method: string,
 *   path: string | ((prev: Bodies) => string),
 *   body?: unknown | ((prev: Bodies) => unknown),
 *   headers?: Record<string, string>,
 *   finding?: string,
 * }} Step
 * @typedef {{ name: string, method: string, path: string, status: number, body: unknown, finding?: string }} Fixture
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

/** Starts `next start` on a temporary data directory; resolves once it answers. */
async function startServer() {
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
  return { base, stop };
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
 * @returns {Promise<Fixture[]>}
 */
async function runSteps(base, steps, today) {
  const normalizer = createNormalizer({ today });
  /** @type {Bodies} */
  const prev = {};
  /** @type {Fixture[]} */
  const out = [];
  for (const step of steps) {
    const urlPath = typeof step.path === "function" ? step.path(prev) : step.path;
    const body = typeof step.body === "function" ? step.body(prev) : step.body;
    const res = await request(base, step.method, urlPath, { body, headers: step.headers });
    prev[step.name] = res.body;
    out.push({
      name: step.name,
      method: step.method,
      path: urlPath,
      status: res.status,
      body: normalizer.normalize(res.body),
      ...(step.finding ? { finding: step.finding } : {}),
    });
  }
  return out;
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
      ...diff(f.body, a.body),
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
    const names = steps.map((/** @type {Step} */ s) => s.name);
    if (JSON.stringify(names) !== JSON.stringify(fixtures.map((f) => f.name))) {
      throw new CannotRun("the fixtures don't match the scenario's steps. Re-record with --record.");
    }
  }

  let base = process.env.BASE;
  let stop = async () => {};
  if (base !== undefined) {
    if (!isLocalBase(base)) throw new CannotRun(`refusing BASE=${base}: not localhost. No request was sent.`);
    base = base.replace(/\/+$/, "");
  } else {
    ({ base, stop } = await startServer());
    // The server runs in its own process group, so Ctrl-C wouldn't reach it.
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
      process.once(sig, () => stop().finally(() => process.exit(2)));
    }
  }

  try {
    const today = clinicToday();
    await assertFresh(base);
    const actual = await runSteps(base, steps, today);
    if (clinicToday() !== today) {
      throw new CannotRun("the clinic date (Asia/Riyadh) changed during the run. Re-run.");
    }

    if (record) {
      writeFileSync(FIXTURES, JSON.stringify({ steps: actual }, null, 2) + "\n");
      console.log(`baseline: recorded ${actual.length} step(s) to ${path.relative(ROOT, FIXTURES)}.`);
      return 0;
    }

    const known = /** @type {Fixture[]} */ (fixtures).filter((f) => f.finding);
    const failed = report(/** @type {Fixture[]} */ (fixtures), actual);
    console.log(`known findings: ${known.length}`);
    for (const f of known) console.log(`  - "${f.name}" (${f.method} ${f.path}): ${f.finding}`);
    if (failed) {
      console.log(`baseline: ${failed} of ${actual.length} step(s) differ.`);
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
