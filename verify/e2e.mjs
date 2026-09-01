/**
 * End-to-end verification of the core loop against a running instance.
 *
 *   node verify/e2e.mjs            (BASE=http://localhost:3210 by default)
 *
 * Drives a real Chromium with a fake microphone that plays
 * .verify-out/dialogue.wav (Arabic clinic dialogue synthesised with macOS
 * `say -v Majed`), so every step below is the real code path: MediaRecorder
 * segments → upload → server-side transcription → Claude suggestion →
 * approval → Claude report → seal → handout → patient page on a phone
 * viewport → adherence + pain → therapist follow-up → refresh → server
 * restart. Console errors are collected on every page and must be zero.
 */
import { chromium, devices } from "playwright";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3210";
const PORT = new URL(BASE).port || "80";
const WAV = new URL("../.verify-out/dialogue.wav", import.meta.url).pathname;
const OUT = new URL("../.verify-out/", import.meta.url).pathname;

if (!existsSync(WAV)) {
  console.error("missing " + WAV + " — see README (verification) to generate it");
  process.exit(2);
}

{
  const pre = await fetch(`${BASE}/api/exercises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "تقوية عضلات لوح الكتف" }),
  }).catch(() => null);
  if (!pre || !pre.ok) {
    console.error(`Claude preflight failed (${pre ? pre.status : "no response"}): check ANTHROPIC_API_KEY on the server — steps 4 and 6 need it.`);
    if (process.env.ALLOW_NO_CLAUDE !== "1") process.exit(2);
    console.error("ALLOW_NO_CLAUDE=1: continuing with typed assessment + pasted report; result will be PARTIAL.");
    globalThis.NO_CLAUDE = true;
  }
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const errors = [];
// Fetches that fail during the deliberate offline window are logged by Chromium
// as resource errors; they are expected and counted separately.
const offlineNoise = [];
// next-dev HMR socket reconnects around the restart (absent in production).
const devNoise = [];
function watch(page, label) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (m.text().includes("ERR_INTERNET_DISCONNECTED")) offlineNoise.push(m.text());
    else if (m.text().includes("/_next/webpack-hmr")) devNoise.push(m.text());
    else errors.push(`[${label}] console: ${m.text()}`);
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

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}`,
  ],
});
const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
watch(page, "therapist");

try {
  // ── 1. Start a session from the patient file ──────────────────────────
  await page.goto(`${BASE}/patients/p1`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "بدء جلسة سريرية" }).click();
  await page.waitForURL(/\/session\?id=/);
  const sessionId = new URL(page.url()).searchParams.get("id");
  assert(!!sessionId, `draft session created (${sessionId})`);
  await page.locator(".voice .mic").waitFor();

  // ── 2. Consent gate, then record ─────────────────────────────────────
  await page.locator(".voice .mic").click();
  await page.locator(".modal").waitFor();
  const consentText = await page.locator(".consent-text").innerText();
  assert(consentText.includes("يُرفَع التسجيل"), "consent text states where the audio goes");
  const startBtn = page.locator(".modal").getByRole("button", { name: /بدء التسجيل/ });
  assert(await startBtn.isDisabled(), "start is disabled until consent is ticked");
  await page.locator(".consent-check input").check();
  await startBtn.click();
  await page.locator(".voice.rec").waitFor({ timeout: 20_000 });
  const consentAt = (await (await fetch(`${BASE}/api/sessions/${sessionId}`)).json()).session.consentAt;
  assert(!!consentAt, `consent stored on the session (${consentAt})`);
  log("recording… (segments rotate every 15s)");

  await sleep(40_000); // ~2 segments uploaded

  // ── 3. Mid-session network drop ──────────────────────────────────────
  log("dropping the network for 35s while still recording");
  await ctx.setOffline(true);
  await sleep(35_000);
  const offlineBadge = await page.locator(".voice .badge.red").count();
  assert(offlineBadge > 0, "offline state is visible to the therapist (segments queued, retrying)");
  await ctx.setOffline(false);
  log("network back");
  await page.locator(".voice .badge.red").waitFor({ state: "detached", timeout: 60_000 });
  assert(true, "queued segments uploaded after reconnect");

  await sleep(20_000);
  await page.locator(".voice .mic").click(); // stop
  log("stopped; waiting for transcription to drain");

  const dialogue = page.locator("textarea").first();
  const deadline = Date.now() + 240_000;
  let text = "";
  for (;;) {
    const busy = await page.locator(".voice .badge").count();
    text = await dialogue.inputValue();
    if (busy === 0 && text.trim() && !(await page.locator(".voice.rec").count())) break;
    if (Date.now() > deadline) break;
    await sleep(2500);
  }
  assert(/[؀-ۿ]/.test(text), `Arabic transcript received (${text.length} chars)`);
  assert(/ظهر|ألم|الجلوس/.test(text), "transcript contains the spoken clinical content");
  log("transcript:", text.replace(/\s+/g, " ").slice(0, 160) + "…");
  assert(!(await page.locator(".voice .btn-danger").count()), "no failed segments left behind");

  // ── 4. Suggested assessment + impression (Claude) ─────────────────────
  if (globalThis.NO_CLAUDE) {
    log("SKIPPED (no Claude key): suggestion step — typing the assessment instead");
    await page.locator("textarea").nth(1).fill("ألم أسفل الظهر ميكانيكي منذ شهر، يزداد مع الجلوس المطوّل ويخف مع المشي، دون أعراض جذرية.");
  } else {
    await page.getByRole("button", { name: /اقتراح ملخّص وانطباع/ }).click();
    await page.getByRole("button", { name: "إدراج في ملخّص التقييم" }).waitFor({ timeout: 180_000 });
    assert(true, "assessment + impression suggestion returned");
    await page.getByRole("button", { name: "إدراج في ملخّص التقييم" }).click();
    const assessment = await page.locator("textarea").nth(1).inputValue();
    assert(assessment.trim().length > 20, "suggested assessment inserted (still editable)");
  }

  // ── 5. Plan: approve an impression, pick exercises ───────────────────
  await page.getByRole("button", { name: "التالي" }).click();
  await page.locator(".chip-btn.insert").first().waitFor();
  const suggested = page.locator(".chips-label:has-text('اقتراح من حوار الجلسة')");
  if (!globalThis.NO_CLAUDE) {
    assert((await suggested.count()) === 1, "model impressions shown as suggestions beside the diagnosis field");
  }
  await page.locator(".chip-btn.insert").first().click(); // approve first (suggested or common) impression
  const dx = await page.locator("textarea").first().inputValue();
  assert(dx.trim().length > 5, `impression approved into التشخيص المعتمد: ${dx.slice(0, 60)}`);
  await page.locator(".ex-top").nth(0).click();
  await page.locator(".ex-top").nth(1).click();
  await page.getByText("٦ جلسات").click();
  await page.getByText("مرّتان أسبوعياً").click();
  await page.getByText("يومي", { exact: true }).click();
  await page.locator(".chip-btn.num", { hasText: /^٥$/ }).click();
  assert((await page.locator(".bq svg").count()) === 2, "basket shows 2 exercises with video QRs");

  // ── 6. Report (Claude) → seal ────────────────────────────────────────
  await page.getByRole("button", { name: "التالي" }).click();
  if (globalThis.NO_CLAUDE) {
    log("SKIPPED (no Claude key): report generation — using the manual paste mode instead");
    await page.getByRole("button", { name: "نسخ ولصق يدوي" }).click();
    await page.locator("textarea.tall").fill("التقييم السريري:\nألم أسفل الظهر منذ شهر.\n\nالتشخيص:\nآلام أسفل الظهر الميكانيكية.\n\nخطة العلاج:\n٦ جلسات، مرّتان أسبوعياً.\n\nملاحظات وإرشادات:\nتصحيح وضعية الجلوس.");
    await page.getByRole("button", { name: "مراجعة التقرير الملصوق" }).click();
    await page.locator(".report-draft").waitFor();
  } else {
    await page.getByRole("button", { name: "توليد التقرير" }).click();
    await page.locator(".report-draft").waitFor({ timeout: 180_000 });
    const preview = await page.locator(".report-preview").innerText();
    assert(preview.includes("التشخيص") && preview.includes("خطة العلاج"), "report drafted with the mandated sections, no copy-paste");
  }
  await page.getByRole("button", { name: /اعتماد بختم الطبيب/ }).click();
  await page.locator(".report-draft.sealed").waitFor();
  assert(true, "report sealed by the therapist");

  // ── 7. Handout + portal link ─────────────────────────────────────────
  await page.getByRole("button", { name: "التالي" }).click();
  await page.locator(".handout").waitFor();
  assert((await page.locator(".ho-ex .qr svg").count()) === 2, "handout has a video QR per exercise");
  const portalUrl = (await page.locator(".ho-link .url").innerText()).trim();
  assert(portalUrl.startsWith(`${BASE}/h/`), `portal link on the handout: ${portalUrl}`);
  await page.screenshot({ path: OUT + "e2e-handout.png", fullPage: true });

  await page.getByRole("button", { name: "إنهاء وحفظ الجلسة" }).click();
  await page.waitForURL(/\/patients\/p1$/);
  await page.getByText("معتمد", { exact: true }).first().waitFor();
  assert(true, "session finished and listed on the patient file");

  // ── 8. Patient on a phone ────────────────────────────────────────────
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const pp = await phone.newPage();
  watch(pp, "patient");
  await pp.goto(portalUrl, { waitUntil: "networkidle" });
  assert((await pp.locator(".pt-ex").count()) === 2, "patient page lists the 2 prescribed exercises");
  const vids = await pp.locator(".pt-ex .vid").evaluateAll((a) => a.map((x) => x.href));
  assert(vids.length === 2 && vids.every((v) => v.includes("youtube.com/watch")), "exercise video links are real YouTube videos");
  const noScrollX = await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert(noScrollX, "no horizontal overflow on a phone viewport");
  await pp.locator(".pt-check").nth(0).click();
  await pp.locator(".pt-check").nth(1).click();
  await pp.locator(".pt-pain button", { hasText: /^٤$/ }).click();
  await pp.locator(".pt-saved:has-text('سُجّل مستوى الألم')").waitFor();
  await pp.reload({ waitUntil: "networkidle" });
  assert((await pp.locator(".pt-check.on").count()) === 2, "check-offs persisted across a refresh");
  assert((await pp.locator(".pt-pain button.on").innerText()) === "٤", "pain score persisted across a refresh");
  await pp.screenshot({ path: OUT + "e2e-patient.png", fullPage: true });

  // ── 9. Therapist follow-up reflects stored patient data ──────────────
  const checkFollowup = async (label) => {
    await page.goto(`${BASE}/followup`, { waitUntil: "networkidle" });
    const row = page.locator(".tbl-row", { hasText: "محمد عبدالله العتيبي" });
    const rowText = await row.innerText();
    assert(rowText.includes("١٠٠٪"), `${label}: adherence 100% (2/2 today) on the follow-up screen`);
    assert(rowText.includes("آخر ألم مسجّل: ٤/١٠"), `${label}: last pain score shown`);
  };
  await checkFollowup("follow-up");
  await page.screenshot({ path: OUT + "e2e-followup.png", fullPage: true });
  await page.reload({ waitUntil: "networkidle" });
  await checkFollowup("after refresh");

  // ── 10. Server restart ───────────────────────────────────────────────
  if (process.env.SKIP_RESTART !== "1") {
    const pids = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`).toString().trim().split(/\s+/).filter(Boolean);
    log(`restarting server (pids ${pids.join(",")})`);
    for (const pid of pids) process.kill(Number(pid), "SIGTERM");
    await sleep(2500);
    const startArgs = process.env.START === "prod" ? ["start", "--", "-p", PORT] : ["run", "dev", "--", "-p", PORT];
    log(`starting: npm ${startArgs.join(" ")}`);
    const child = spawn("npm", startArgs, {
      cwd: new URL("..", import.meta.url).pathname,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const up = Date.now() + 90_000;
    for (;;) {
      try {
        const r = await fetch(`${BASE}/api/stt`);
        if (r.ok) break;
      } catch {}
      if (Date.now() > up) throw new Error("server did not come back");
      await sleep(1000);
    }
    log("server back up");
    await checkFollowup("after server restart");
    try {
      await pp.reload({ waitUntil: "load" });
    } catch {
      await pp.goto(portalUrl, { waitUntil: "load" });
    }
    assert((await pp.locator(".pt-check.on").count()) === 2, "patient page state survived the restart");
  }

  await phone.close();
} catch (err) {
  console.error("\nE2E ERROR:", err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\nexpected resource failures during the simulated outage: ${offlineNoise.length}`);
  if (devNoise.length) console.log(`dev-mode HMR socket reconnects (not present with next start): ${devNoise.length}`);
  console.log(`CONSOLE/PAGE ERRORS: ${errors.length}`);
  for (const e of errors) console.log("  " + e);
  if (errors.length) process.exitCode = 1;
  console.log(process.exitCode ? "\nRESULT: FAIL" : globalThis.NO_CLAUDE ? "\nRESULT: PARTIAL (Claude steps skipped — no valid ANTHROPIC_API_KEY)" : "\nRESULT: PASS");
}
