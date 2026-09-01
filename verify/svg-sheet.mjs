// Renders every exercise illustration on one sheet for a quick eyeball check.
import { chromium } from "playwright";
import fs from "node:fs";
const files = fs.readdirSync("public/exercises").filter((f) => f.endsWith(".svg")).sort();
const html = `<html dir="rtl"><body style="margin:0;background:#fff;font-family:sans-serif"><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;padding:8px">${files
  .map((f) => `<div style="text-align:center;font-size:10px"><img src="file://${process.cwd()}/public/exercises/${f}" width="150" height="150"><div>${f.replace(".svg", "")}</div></div>`)
  .join("")}</div></body></html>`;
fs.writeFileSync(".verify-out/svg-sheet.html", html);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1180, height: 780 } });
await p.goto(`file://${process.cwd()}/.verify-out/svg-sheet.html`);
await p.screenshot({ path: ".verify-out/svg-sheet.png", fullPage: true });
await b.close();
console.log("wrote .verify-out/svg-sheet.png for", files.length, "files");
