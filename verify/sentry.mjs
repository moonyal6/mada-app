/**
 * Sentry error tracking — triggers the server throw and the client throw.
 *
 * Against a deploy (SENTRY_DEBUG_ROUTE=1 must be set on the service):
 *
 *   node verify/sentry.mjs https://<app>.up.railway.app
 *
 * Both throws fire and the browser's event must be accepted by Sentry's
 * ingest; then check the dashboard for the two issues and their stack traces.
 *
 * Locally, against a stand-in for Sentry that records what arrives:
 *
 *   NEXT_PUBLIC_SENTRY_DSN=http://public@localhost:18556/1 npm run build
 *   node verify/sentry.mjs
 *
 * The script starts the production build on PORT (default 3210) and asserts
 * that both events arrive with stack frames and without the request body,
 * cookies, headers, query string or patient-page token it sent along.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import { gunzipSync } from "node:zlib";

const PORT = process.env.PORT || "3210";
const MOCK_PORT = 18556;
const MOCK_DSN = `http://public@localhost:${MOCK_PORT}/1`;
const target = process.argv[2]?.replace(/\/$/, "");
const BASE = target || `http://localhost:${PORT}`;

// Stand-ins for patient data; none of them may reach Sentry.
const SECRETS = ["سارة المطيري", "ألم-حاد-في-الركبة", "mada_therapist", "q-secret"];

const failures = [];
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every envelope item of type "event", as raw text and parsed JSON. */
const received = [];
function startMockIngest() {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      const lines = body.toString("utf8").split("\n");
      for (let i = 1; i < lines.length - 1; i++) {
        let header;
        try { header = JSON.parse(lines[i]); } catch { continue; }
        if (header.type === "event") {
          received.push({ raw: lines[i + 1], event: JSON.parse(lines[i + 1]) });
        }
      }
      res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((r) => srv.listen(MOCK_PORT, () => r(srv)));
}

let server;
async function startServer() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", PORT], {
    env: { ...process.env, SENTRY_DSN: MOCK_DSN, SENTRY_DEBUG_ROUTE: "1" },
    stdio: "ignore",
  });
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/debug/sentry`)).ok) return;
    } catch {}
    if (Date.now() > until) throw new Error("server did not come up");
    await sleep(500);
  }
}

async function waitForEvent(message, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = received.find((r) => r.raw.includes(message));
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

function checkEvent(hit, label) {
  check(hit, `${label}: event reached Sentry`);
  if (!hit) return;
  const frames = hit.event.exception?.values?.at(-1)?.stacktrace?.frames ?? [];
  check(frames.length > 0, `${label}: stack trace has ${frames.length} frames`);
  for (const s of SECRETS) check(!hit.raw.includes(s), `${label}: does not contain "${s}"`);
  const req = hit.event.request ?? {};
  check(
    !req.data && !req.cookies && !req.headers && !req.query_string,
    `${label}: request carries no body, cookies, headers or query (${JSON.stringify(req)})`,
  );
  const crumbs = (hit.event.breadcrumbs ?? []).map((b) => b.category);
  check(
    !crumbs.some((c) => ["fetch", "xhr", "http", "console"].includes(c)),
    `${label}: no network or console breadcrumbs (${crumbs.join(", ") || "none"})`,
  );
}

const mock = target ? null : await startMockIngest();
if (!target) await startServer();

try {
  // 1. Server throw, with data that must be scrubbed.
  const res = await fetch(`${BASE}/api/debug/sentry?patient=q-secret`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "mada_therapist=x" },
    body: JSON.stringify({ name: SECRETS[0], note: SECRETS[1] }),
  });
  check(res.status === 500, `server throw answered ${res.status} (want 500; 404 means SENTRY_DEBUG_ROUTE is not 1)`);

  // 2. Client throw from a button.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const ingest = [];
  page.on("request", (r) => {
    if (/\/api\/\d+\/envelope\//.test(r.url())) ingest.push(r);
  });
  const nav = await page.goto(`${BASE}/debug/sentry?ref=q-secret`);
  check(nav?.status() === 200, `client throw page answered ${nav?.status()}`);
  await page.getByRole("button", { name: "Throw client error" }).click();
  if (target) {
    const until = Date.now() + 15_000;
    while (!ingest.length && Date.now() < until) await sleep(250);
    const status = (await ingest[0]?.response())?.status();
    check(status === 200, `browser event accepted by Sentry ingest (status ${status ?? "none sent"})`);
  }
  await browser.close();

  if (!target) {
    checkEvent(await waitForEvent("deliberate server throw"), "server");
    checkEvent(await waitForEvent("deliberate client throw"), "client");
  }
} finally {
  server?.kill("SIGTERM");
  mock?.close();
}

if (target && !failures.length) {
  console.log("\nBoth throws sent. In Sentry, check the two issues have readable stack traces,");
  console.log("then remove SENTRY_DEBUG_ROUTE from the service.");
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
