/**
 * Therapist attribution — browser verification against a running instance.
 *
 *   node verify/therapist.mjs            (BASE=http://localhost:3210 by default)
 *
 * Checks, in order: pick a name in the sidebar → refresh keeps it → a new
 * session is stamped with it → the session view, the drafting package, the
 * printable handout and the patient page all show it → a pre-existing
 * session (empty therapistName) still opens and renders the fallback →
 * switching names mid-use changes only the next session. Console errors on
 * every page must be zero.
 */
import { chromium, devices } from "playwright";

const BASE = process.env.BASE || "http://localhost:3210";
const FALLBACK = "د. عبدالرحمن التركي";
const NAME_A = "د. سارة الزهراني";
const NAME_B = "أخصائي فهد القحطاني";

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
  console.log("✓", msg);
}
const j = async (url, init) => {
  const r = await fetch(BASE + url, init);
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${r.status}`);
  return r.json();
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
watch(page, "clinic");

try {
  // ── 0. A pre-existing session (created without any name) must still work.
  const { sessions: before } = await j("/api/sessions");
  const legacy = before.find((s) => s.therapistName === "") ?? null;
  assert(legacy, `a pre-existing session with empty therapistName exists (${legacy?.id})`);

  // ── 1. Sidebar shows the fallback before any pick; initials derived.
  await page.goto(`${BASE}/dashboard`);
  await page.locator(".who-btn").waitFor();
  assert((await page.locator(".who-btn .who-txt").innerText()).includes(FALLBACK), "sidebar shows the fallback name before any choice");
  assert((await page.locator(".who-btn .av").innerText()) === "عت", "initials derived from the fallback name are عت");

  // ── 2. Type a new name, pick it, refresh — it sticks.
  await page.locator(".who-btn").click();
  await page.locator(".who-add input").fill(NAME_A);
  await page.locator(".who-add button").click();
  assert((await page.locator(".who-btn .who-txt").innerText()).includes(NAME_A), "typed name becomes the current name");
  assert((await page.locator(".who-btn .av").innerText()) === "سز", "initials update from the new name");
  const cookies = await ctx.cookies(BASE);
  const ck = cookies.find((c) => c.name === "mada_therapist");
  assert(ck && decodeURIComponent(ck.value) === NAME_A, "choice persisted in the mada_therapist cookie");
  await page.reload();
  await page.locator(".who-btn").waitFor();
  assert((await page.locator(".who-btn .who-txt").innerText()).includes(NAME_A), "name survives a refresh (server-rendered from the cookie)");

  // ── 3. Start a session from the patient page; the row is stamped.
  await page.goto(`${BASE}/patients/p2`);
  await page.getByRole("button", { name: /بدء جلسة سريرية/ }).click();
  await page.waitForURL(/\/session\?id=/);
  const idA = new URL(page.url()).searchParams.get("id");
  const { session: sA } = await j(`/api/sessions/${idA}`);
  assert(sA.therapistName === NAME_A, `new session ${idA} stamped with "${NAME_A}"`);
  assert((await page.locator("text=المعالج:").first().innerText()).includes(NAME_A), "session view header shows the session's therapist");

  // Fill a plan so the handout has content, then check report + handout.
  await page.locator(".wiz-step").nth(1).click();
  // Toggle the first case-library exercise into the basket.
  await page.locator(".ex-list .ex .ex-top").first().click();
  await page.locator(".ex.sel").first().waitFor();

  await page.locator(".wiz-step").nth(2).click();
  const pkg = await page.locator(".pkg").innerText();
  assert(pkg.includes(`الطبيب المعالج: ${NAME_A}`), "drafting package names the therapist (what Claude writes the report under)");
  // Generate through Claude when it is configured; otherwise paste a report.
  const claudeUp = (await fetch(`${BASE}/api/exercises`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "تمارين الرقبة" }) })).ok;
  if (claudeUp) {
    await page.getByRole("button", { name: /توليد التقرير/ }).click();
    await page.locator(".report-draft").waitFor({ timeout: 90_000 });
    const report = await page.locator(".report-preview").innerText();
    assert(report.length > 40, `Claude drafted a report (${report.length} chars)`);
    const bare = NAME_A.replace(/^د\.\s*/, "");
    assert(report.includes(bare), `generated report text names the therapist ("${bare}")`);
  } else {
    console.log("· Claude not configured — pasting a report instead");
    await page.getByRole("button", { name: "نسخ ولصق يدوي" }).click();
    await page.locator("textarea.tall").fill("تقرير تجريبي للتحقق من الإسناد.");
    await page.getByRole("button", { name: /مراجعة التقرير الملصوق/ }).click();
  }
  await page.getByRole("button", { name: /اعتماد بختم الطبيب/ }).click();
  const seal = await page.locator(".seal").innerText();
  assert(seal.includes(NAME_A), "sealed report line carries the session's therapist");

  await page.locator(".wiz-step").nth(3).click();
  await page.locator(".handout").waitFor();
  assert((await page.locator(".handout .ho-head .meta").innerText()).includes(NAME_A), "printable handout header carries the session's therapist");
  await page.locator(".handout").screenshot({ path: ".verify-out/therapist-handout.png" });

  // Patient page (phone viewport).
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const pp = await phone.newPage();
  watch(pp, "patient");
  await pp.goto(`${BASE}/h/${sA.handoutToken}`);
  await pp.locator(".pt-note").waitFor();
  assert((await pp.locator(".pt-note").innerText()).includes(NAME_A), "patient handout page carries the session's therapist");
  await phone.close();

  // ── 4. Pre-existing session still opens and renders the fallback.
  await page.goto(`${BASE}/session?id=${legacy.id}`);
  await page.locator("text=المعالج:").first().waitFor();
  assert((await page.locator("text=المعالج:").first().innerText()).includes(FALLBACK), "pre-existing session renders the fallback name");
  const phone2 = await browser.newContext({ ...devices["iPhone 13"] });
  const pp2 = await phone2.newPage();
  watch(pp2, "patient-legacy");
  await pp2.goto(`${BASE}/h/${legacy.handoutToken}`);
  await pp2.locator(".pt-note").waitFor();
  assert((await pp2.locator(".pt-note").innerText()).includes(FALLBACK), "pre-existing session's patient page renders the fallback name");
  await phone2.close();

  // ── 5. Switch names; only the next session changes.
  await page.locator(".who-btn").click();
  await page.locator(".who-add input").fill(NAME_B);
  await page.locator(".who-add input").press("Enter");
  assert((await page.locator(".who-btn .who-txt").innerText()).includes(NAME_B), "switched to a second name");
  await page.goto(`${BASE}/patients/p3`);
  await page.getByRole("button", { name: /بدء جلسة سريرية/ }).click();
  await page.waitForURL(/\/session\?id=/);
  const idB = new URL(page.url()).searchParams.get("id");
  const { session: sB } = await j(`/api/sessions/${idB}`);
  assert(sB.therapistName === NAME_B, `second session ${idB} stamped with "${NAME_B}"`);
  const { session: sA2 } = await j(`/api/sessions/${idA}`);
  assert(sA2.therapistName === NAME_A, "first session keeps its original therapist after the switch");
  const { session: legacy2 } = await j(`/api/sessions/${legacy.id}`);
  assert(legacy2.therapistName === "", "pre-existing session keeps its empty therapistName");

  // Picking from the list (not typing) also works; the list holds both names.
  await page.locator(".who-btn").click();
  const items = await page.locator(".who-item .who-name").allInnerTexts();
  assert(items.includes(FALLBACK) && items.includes(NAME_A) && items.includes(NAME_B), "list offers the fallback and both typed names");
  await page.locator(".side").screenshot({ path: ".verify-out/therapist-picker.png" });
  await page.locator(".who-pick").filter({ hasText: NAME_A }).click();
  assert((await page.locator(".who-btn .who-txt").innerText()).includes(NAME_A), "picking from the list switches the name");

  // Autosave must never overwrite the stamp (PATCH ignores therapistName).
  await j(`/api/sessions/${idB}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ therapistName: "x", dx: "تحقق" }),
  });
  const { session: sB2 } = await j(`/api/sessions/${idB}`);
  assert(sB2.therapistName === NAME_B && sB2.dx === "تحقق", "PATCH cannot change therapistName (stamp is creation-only)");

  // ── 6. No console errors anywhere.
  assert(errors.length === 0, `no console errors (${errors.length})`);
  console.log("\nALL PASSED");
} catch (e) {
  console.error(e);
  if (errors.length) console.error("console errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
