import { chromium } from "playwright";

const BASE = "http://localhost:3210";
const routes = [
  "/dashboard",
  "/appointments",
  "/patients",
  "/patients/p1",
  "/session",
  "/followup",
  "/billing",
  "/inventory",
];

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`[console] ${page.url()} :: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`[pageerror] ${page.url()} :: ${err.message}`));

for (const r of routes) {
  const res = await page.goto(BASE + r, { waitUntil: "networkidle" });
  console.log(r, res.status());
}

// screenshot main screens
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
await page.screenshot({ path: new URL("../.verify-out/shot-dashboard.png", import.meta.url).pathname, fullPage: true });
await page.goto(BASE + "/patients/p1", { waitUntil: "networkidle" });
await page.screenshot({ path: new URL("../.verify-out/shot-patient.png", import.meta.url).pathname, fullPage: true });

console.log("\nERRORS:", errors.length);
for (const e of errors) console.log(e);
await browser.close();
