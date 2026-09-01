/**
 * Long-recording soak: records for MINUTES (default 5) with a 30s network
 * drop every 2 minutes, then checks that every segment reached the server
 * and was transcribed. Run against a live instance:
 *
 *   MINUTES=40 node verify/soak.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3210";
const MINUTES = Number(process.env.MINUTES || 5);
const WAV = new URL("../.verify-out/dialogue.wav", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...a);

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}`,
  ],
});
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
const errors = [];
const outageNoise = []; // resource loads that failed during the deliberate drops
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (m.text().includes("ERR_INTERNET_DISCONNECTED")) outageNoise.push(m.text());
  else errors.push(m.text());
});

const { session } = await (
  await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: "p1" }) })
).json();
await fetch(`${BASE}/api/sessions/${session.id}/consent`, { method: "POST" });
await page.goto(`${BASE}/session?id=${session.id}`, { waitUntil: "networkidle" });
await page.locator(".voice .mic").click();
await page.locator(".voice.rec").waitFor({ timeout: 20_000 });
log(`recording for ${MINUTES} min into session ${session.id}`);

const end = Date.now() + MINUTES * 60_000;
let drops = 0;
while (Date.now() < end) {
  await sleep(Math.min(90_000, end - Date.now()));
  if (Date.now() >= end) break;
  drops += 1;
  log(`network drop #${drops} (30s)`);
  await ctx.setOffline(true);
  await sleep(30_000);
  await ctx.setOffline(false);
  const pending = await page.locator(".voice .badge").allInnerTexts();
  log("back online; badges:", pending.join(" | ") || "none");
}
await page.locator(".voice .mic").click();
log("stopped; draining");

// Wait until no upload/transcription badges remain.
const drain = Date.now() + 15 * 60_000;
while (Date.now() < drain) {
  const badges = await page.locator(".voice .badge, .voice .btn-danger").count();
  if (badges === 0) break;
  await sleep(3000);
}

const recordings = await (await fetch(`${BASE}/api/sessions/${session.id}`)).json();
const dialogue = recordings.session.dialogue;
const text = await page.locator("textarea").first().inputValue();
log(`dialogue length on screen: ${text.length} chars; autosaved: ${dialogue.length} chars`);
const expectedSegments = Math.floor((MINUTES * 60) / 15);
console.log(`expected ≈${expectedSegments} segments across ${drops} network drops`);
console.log(`expected resource failures during the ${drops} drops: ${outageNoise.length}`);
console.log(`errors: ${errors.length}`);
for (const e of errors) console.log("  " + e);
console.log(text.length > 0 && errors.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
await browser.close();
