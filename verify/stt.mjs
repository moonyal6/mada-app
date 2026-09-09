/**
 * Transcription resilience — verification against production builds this
 * script starts itself (one server per scenario, each with a different
 * environment), on PORT (default 3210). Needs `next build` first and the
 * fixtures under .verify-out/ (see README → Verification).
 *
 *   node verify/stt.mjs
 *
 * Scenarios, each a real code path (browser MediaRecorder or raw segment
 * upload → queue → lib/server/transcribe):
 *   1. long silences → no hallucinated / repeated / foreign text, silent
 *      segments skipped and counted in the UI
 *   2. invalid OpenAI key + valid Groq key → failover, the UI names Groq
 *   3. OpenAI answering "insufficient_quota" → auto fails over; pinned to
 *      OpenAI the segment fails with the Arabic quota message on screen, and
 *      switching provider + retry recovers it
 *   4. picker: choice persists across a refresh (cookie) and applies from the
 *      next segment of a recording already running
 *   5. nothing configured → the pre-recording state says so
 * Console errors on every page must be zero.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, openSync } from "node:fs";
import http from "node:http";

const PORT = process.env.PORT || "3210";
const BASE = `http://localhost:${PORT}`;
const OUT = new URL("../.verify-out/", import.meta.url).pathname;
const MOCK_PORT = 18555;
const LOCAL_LABEL = "خادم العيادة";

for (const f of ["stt-silences.wav", "stt-a.wav", "dialogue.wav", "seg-silence.ogg", "seg-noise.ogg", "seg-short.ogg", "seg-speech.ogg"]) {
  if (!existsSync(OUT + f)) {
    console.error(`missing ${OUT}${f} — see README (verification) to generate the fixtures`);
    process.exit(2);
  }
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const errors = [];
function watch(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${label}] console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${e.message}`));
}
function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  log("✓", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** ONLY=3,4 runs a subset of the scenarios. */
const only = (process.env.ONLY || "1,2,3,4,5").split(",").map(Number);
const want = (n) => only.includes(n);

/* ─── server lifecycle ────────────────────────────────────────────────── */

function pidsOnPort() {
  try {
    return execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`).toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
let server = null;
let serverLog = "";
async function startServer(env, label) {
  await stopServer();
  serverLog = OUT + `stt-${label}.log`;
  const fd = openSync(serverLog, "w");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", PORT], {
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
  });
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/stt`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > until) throw new Error("server did not come up");
    await sleep(500);
  }
  log(`server up (${label}) → ${serverLog}`);
}
async function stopServer() {
  if (server) {
    server.kill("SIGTERM");
    server = null;
  }
  for (const pid of pidsOnPort()) {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
  const until = Date.now() + 15_000;
  while (pidsOnPort().length && Date.now() < until) await sleep(300);
}
const serverLogHas = (re) => re.test(readFileSync(serverLog, "utf8"));

/* ─── mock OpenAI that is out of credit ───────────────────────────────── */

const mock = http.createServer((req, res) => {
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }));
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

/* ─── API helpers ─────────────────────────────────────────────────────── */

const j = async (url, init) => {
  const r = await fetch(BASE + url, init);
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${r.status}`);
  return r.json();
};
async function openRecording() {
  const { session } = await j("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: "p1" }) });
  await j(`/api/sessions/${session.id}/consent`, { method: "POST" });
  const { id } = await j("/api/recordings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.id, mime: "audio/ogg;codecs=opus" }) });
  return { sessionId: session.id, recordingId: id };
}
async function putSegment(recordingId, seq, file, cookie) {
  const r = await fetch(`${BASE}/api/recordings/${recordingId}/segments/${seq}`, {
    method: "PUT",
    headers: cookie ? { Cookie: `mada_stt=${cookie}` } : {},
    body: readFileSync(OUT + file),
  });
  if (!r.ok) throw new Error(`PUT segment ${seq} → ${r.status}`);
}
async function settled(recordingId, count, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { segments } = await j(`/api/recordings/${recordingId}`);
    if (segments.length >= count && segments.every((s) => s.status === "done" || s.status === "failed")) return segments;
    if (Date.now() > until) throw new Error("segments did not settle: " + JSON.stringify(segments));
    await sleep(1500);
  }
}
/** All segments done/failed and no new ones appearing for two polls. */
async function settledStable(recordingId, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  let prev = -1;
  for (;;) {
    const { segments } = await j(`/api/recordings/${recordingId}`);
    const quiet = segments.length && segments.every((s) => s.status === "done" || s.status === "failed");
    if (quiet && segments.length === prev) return segments;
    prev = quiet ? segments.length : -1;
    if (Date.now() > until) throw new Error("segments did not settle: " + JSON.stringify(segments));
    await sleep(3000);
  }
}
const ARABIC = /[؀-ۿ]/;
const FOREIGN = /[Ѐ-ӿ぀-ヿ一-鿿가-힯฀-๿]/;
function repeated(text) {
  const ws = text.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  let run = 1;
  for (let i = 1; i < ws.length; i += 1) {
    run = ws[i] === ws[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return ws.length >= 8 && new Set(ws).size / ws.length < 0.4;
}

/* ─── browser helpers ─────────────────────────────────────────────────── */

async function launch(wav, cookie) {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${OUT}${wav}`],
  });
  const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } });
  if (cookie) await ctx.addCookies([{ name: "mada_stt", value: cookie, url: BASE }]);
  const page = await ctx.newPage();
  return { browser, ctx, page };
}
async function openSession(page, label) {
  watch(page, label);
  const { session } = await j("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: "p1" }) });
  await j(`/api/sessions/${session.id}/consent`, { method: "POST" });
  await page.goto(`${BASE}/session?id=${session.id}`, { waitUntil: "networkidle" });
  await page.locator(".voice .mic").waitFor();
  return session.id;
}
async function drain(page, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await page.locator(".voice .badge:has-text('جارٍ التفريغ')").count();
    const rec = await page.locator(".voice.rec").count();
    if (!busy && !rec) break;
    if (Date.now() > deadline) break;
    await sleep(2000);
  }
  return (await page.locator("textarea").first().inputValue()).trim();
}

try {
  /* ── 1. Silence ─────────────────────────────────────────────────────── */
  if (want(1)) {
  await startServer({}, "auto");
  {
    const st = await j("/api/stt");
    assert(st.ready && st.selected === "auto" && st.providers.length === 3, `status: ready, auto, providers listed (${st.chain.join(" → ")})`);
    assert(!JSON.stringify(st).match(/sk-|gsk_/), "status carries no key material");

    const { recordingId } = await openRecording();
    await putSegment(recordingId, 0, "seg-silence.ogg");
    await putSegment(recordingId, 1, "seg-noise.ogg");
    await putSegment(recordingId, 2, "seg-short.ogg");
    await putSegment(recordingId, 3, "seg-speech.ogg");
    const segs = await settled(recordingId, 4);
    assert(segs[0].status === "done" && segs[0].note === "silence" && segs[0].text === "", "pure silence: skipped, nothing sent, no text");
    assert(segs[1].status === "done" && segs[1].note === "silence" && segs[1].text === "", "room noise only: skipped, no text");
    assert(segs[2].status === "done" && ARABIC.test(segs[2].text) && !repeated(segs[2].text) && !FOREIGN.test(segs[2].text), `4s speech + 11s silence: Arabic, no repetition (${segs[2].text.slice(0, 60)})`);
    assert(segs[3].status === "done" && /ظهر|ألم|الجلوس/.test(segs[3].text) && segs[3].provider, `full speech segment transcribed via ${segs[3].provider}`);
    assert(serverLogHas(/\[stt\] skipped silent segment/), "server log records the skipped segments");

    const { browser, page } = await launch("stt-silences.wav");
    await openSession(page, "silence");
    await page.locator(".voice .mic").click();
    await page.locator(".voice.rec").waitFor({ timeout: 20_000 });
    log("recording 73s of speech/26s silence/speech/22s silence…");
    await sleep(76_000);
    await page.locator(".voice .mic").click();
    const text = await drain(page);
    assert(ARABIC.test(text) && /ظهر|ألم/.test(text), `transcript has the spoken content (${text.length} chars)`);
    assert(!repeated(text), "no repeated-word runs in the transcript");
    assert(!FOREIGN.test(text) && !/[A-Za-z]{4,}/.test(text), "no foreign-language text in the transcript");
    const skipped = await page.locator(".voice .badge:has-text('مقطع صامت')").count();
    assert(skipped === 1, "UI reports the silent segments it skipped");
    assert((await page.locator(".voice .btn-danger").count()) === 0, "no failed segments");
    log("transcript:", text.replace(/\s+/g, " ").slice(0, 200));
    await page.screenshot({ path: OUT + "stt-silence.png" });
    await browser.close();
  }

  }
  /* ── 2. Invalid OpenAI key, valid Groq ──────────────────────────────── */
  if (want(2)) {
  await startServer({ OPENAI_API_KEY: "sk-invalid-for-verification" }, "badkey");
  {
    const { browser, page } = await launch("stt-a.wav");
    await openSession(page, "badkey");
    await page.locator(".voice .mic").click();
    await page.locator(".voice.rec").waitFor({ timeout: 20_000 });
    await sleep(17_000);
    await page.locator(".voice .mic").click();
    const text = await drain(page);
    assert(ARABIC.test(text) && /ظهر|ألم/.test(text), `recording still transcribed (${text.length} chars)`);
    const badge = page.locator(".voice .badge:has-text('تحوّل تلقائياً إلى Groq')");
    assert((await badge.count()) === 1, "UI says the text came from Groq after the automatic switch");
    assert(serverLogHas(/\[stt\] openai auth/), "server log names the OpenAI key failure");
    assert((await page.locator(".voice .btn-danger").count()) === 0, "no failed segments");
    await page.screenshot({ path: OUT + "stt-failover.png" });
    await browser.close();
  }

  }
  /* ── 3. OpenAI out of credit ────────────────────────────────────────── */
  if (want(3)) {
  await startServer({ OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1` }, "quota");
  {
    const { recordingId } = await openRecording();
    await putSegment(recordingId, 0, "seg-speech.ogg");
    const [auto] = await settled(recordingId, 1);
    assert(auto.status === "done" && auto.provider === "Groq" && auto.note === "failover", "auto: quota-exhausted OpenAI → segment done via Groq");
    assert(serverLogHas(/\[stt\] openai quota/), "server log classifies the 429 as quota");

    const pinned = await openRecording();
    await putSegment(pinned.recordingId, 0, "seg-speech.ogg", "openai");
    const [seg] = await settled(pinned.recordingId, 1);
    assert(seg.status === "failed" && seg.error.includes("انتهى رصيد OpenAI") && seg.error.includes("تواصل مع المطوّر"), `pinned to OpenAI: fails with the Arabic quota message: ${seg.error}`);
    assert(!/\b429\b|insufficient_quota/.test(seg.error), "no status code or provider payload in the therapist-facing message");

    const { browser, page } = await launch("stt-a.wav", "openai");
    await openSession(page, "quota");
    assert((await page.locator(".stt-pick select").inputValue()) === "openai", "picker shows the device's pinned choice");
    let recId = "";
    page.on("request", (r) => {
      const m = r.url().match(/\/api\/recordings\/([^/]+)$/);
      if (m) recId = m[1];
    });
    await page.locator(".voice .mic").click();
    await page.locator(".voice.rec").waitFor({ timeout: 20_000 });
    await sleep(17_000);
    await page.locator(".voice .mic").click();
    await page.locator(".voice-note").waitFor({ timeout: 120_000 });
    const failedSegs = await settledStable(recId); // every segment failed the same way
    assert(failedSegs.every((s) => s.status === "failed"), `${failedSegs.length} segment(s) failed under the pinned provider`);
    await sleep(3000); // let the UI poll catch up
    const note = await page.locator(".voice-note").innerText();
    assert(note.includes("انتهى رصيد OpenAI") && note.includes("تواصل مع المطوّر"), `message on screen, no dev tools: ${note}`);
    assert((await page.locator(".voice .btn-danger").count()) === 1, "retry button offered");
    await page.screenshot({ path: OUT + "stt-quota.png" });

    await page.locator(".stt-pick select").selectOption("groq");
    await page.locator(".voice .btn-danger").click();
    await page.locator(".voice-note").waitFor({ state: "detached", timeout: 120_000 });
    const text = await drain(page);
    assert(ARABIC.test(text) && /ظهر|ألم/.test(text), "switched to Groq + retry: the failed segment transcribed");
    assert((await page.locator(".voice .badge:has-text('تمّ التفريغ عبر Groq')").count()) === 1, "UI names Groq as the provider after the switch");
    await browser.close();
  }

  }
  /* ── 4. Picker persists and applies to the next segment ─────────────── */
  if (want(4)) {
  await startServer({}, "picker");
  {
    const { browser, ctx, page } = await launch("dialogue.wav");
    await openSession(page, "picker");
    const options = await page.locator(".stt-pick select option").allInnerTexts();
    assert(options.length === 4 && options[0].startsWith("تلقائي"), `picker lists auto + 3 providers: ${options.join(" | ")}`);
    await page.locator(".stt-pick select").selectOption("groq");
    const ck = (await ctx.cookies(BASE)).find((c) => c.name === "mada_stt");
    assert(ck?.value === "groq", "choice stored in the mada_stt cookie");
    await page.reload({ waitUntil: "networkidle" });
    assert((await page.locator(".stt-pick select").inputValue()) === "groq", "choice survives a refresh");
    assert((await j("/api/stt", { headers: { Cookie: "mada_stt=groq" } })).selected === "groq", "server reports the device's choice");

    let recordingId = "";
    page.on("request", (r) => {
      const m = r.url().match(/\/api\/recordings\/([^/]+)$/);
      if (m) recordingId = m[1];
    });
    await page.locator(".voice .mic").click();
    await page.locator(".voice.rec").waitFor({ timeout: 20_000 });
    await sleep(18_000); // segment 0 uploaded under groq
    await page.locator(".stt-pick select").selectOption("local");
    log("switched to local mid-recording");
    await sleep(34_000); // segments 1–2 under local
    await page.locator(".voice .mic").click();
    await drain(page);
    const { segments } = await j(`/api/recordings/${recordingId}`);
    const spoken = segments.filter((s) => s.status === "done" && s.text);
    assert(spoken.length >= 3, `${spoken.length} segments transcribed`);
    assert(spoken[0].provider === "Groq", "segment 0 (before the switch) went to Groq");
    assert(spoken.slice(1).every((s) => s.provider.includes(LOCAL_LABEL)), `segments after the switch went to the local server (${spoken.slice(1).map((s) => s.provider).join(", ")})`);
    assert((await page.locator(`.voice .badge:has-text('${LOCAL_LABEL}')`).count()) === 1, "UI names the local server as the last provider used");
    assert((await page.locator(".voice .btn-danger").count()) === 0, "no failed segments");
    await page.screenshot({ path: OUT + "stt-picker.png" });
    await browser.close();
  }

  }
  /* ── 5. Nothing configured ──────────────────────────────────────────── */
  if (want(5)) {
  await startServer({ OPENAI_API_KEY: "", GROQ_API_KEY: "", WHISPER_SERVER: "/nonexistent/whisper-server" }, "none");
  {
    const st = await j("/api/stt");
    assert(!st.ready && st.providers.every((p) => !p.available), "status: not ready, every provider unavailable with a reason");
    const { browser, page } = await launch("stt-a.wav");
    await openSession(page, "none");
    const label = await page.locator(".voice .vt b").innerText();
    const sub = await page.locator(".voice .vt span").innerText();
    assert(label.includes("غير مهيّأ") && sub.includes("تواصل مع المطوّر"), `pre-recording state: "${label}" — ${sub}`);
    assert(await page.locator(".voice .mic").isDisabled(), "mic disabled");
    const options = await page.locator(".stt-pick select option").allInnerTexts();
    assert(options.slice(1).every((o) => o.includes("غير متاح")), "every provider option marked unavailable");
    await page.screenshot({ path: OUT + "stt-none.png" });
    await browser.close();
  }
  }
} finally {
  await stopServer();
  mock.close();
}

if (errors.length) {
  console.error("\nCONSOLE/PAGE ERRORS:");
  for (const e of errors) console.error(" ", e);
  process.exitCode = 1;
} else {
  log("✓ zero console errors / uncaught exceptions on every page");
}
log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
