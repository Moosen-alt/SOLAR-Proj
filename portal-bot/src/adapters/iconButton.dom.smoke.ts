// AN ICON BUTTON'S TEXT IS NOT ITS NAME.
//
// Icon fonts render by LIGATURE: a Material icon button's textContent is literally "add" or
// "filter_list", while the name a person or a screen reader sees lives in aria-label.
// Recording the ligature produces a selector that matches nothing useful — ComEd's
// interconnection portal is icon-only, and its first learn died clicking
// getByRole('button', { name: 'add' }) even though the planner had correctly read
// "New Application Button. This will open a popup drawer." from the aria-label.
//
// Pins that an icon button is identified by its accessible name, while an ordinary button
// still goes by its visible text — which is what a human reads and what most portals use.
//   npx tsx portal-bot/src/adapters/iconButton.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { EXTRACT_SEL, extractFieldsInPage } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const PAGE = `<!doctype html><html><body>
  <!-- ComEd's shape: a Material icon button whose text is the ligature. -->
  <button aria-label="New Application Button. This will open a popup drawer.">
    <i class="material-icons">add</i>
  </button>
  <!-- The ligature directly on the button, no wrapper element. -->
  <button aria-label="Filter the project list">filter_list</button>
  <!-- An ordinary button: visible text is the name, and must stay the name. -->
  <button aria-label="submit-form-btn">Continue Application</button>
  <!-- No aria-label at all: the visible text is all there is. -->
  <button>Save Draft</button>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

// Extract through the adapter's own page-side extractor — the same function a learn runs.
const fields = await page.$$eval(EXTRACT_SEL, extractFieldsInPage) as Array<{ label?: string; text?: string; fieldType?: string }>;
const buttons = fields.filter((f) => f.fieldType === "button");
console.log(`  extracted ${buttons.length} button(s): ${buttons.map((b) => `"${b.text ?? b.label ?? ""}"`).join(", ")}`);

const textOf = (needle: RegExp): string => buttons.map((b) => b.text || b.label || "").find((t) => needle.test(t)) || "";

check("a Material icon button is named by its aria-label, not the 'add' ligature",
  Boolean(textOf(/New Application Button/i)) && !buttons.some((b) => (b.text || "") === "add"),
  JSON.stringify(buttons.map((b) => b.text)));

check("a bare ligature on the button itself also yields the aria-label",
  Boolean(textOf(/Filter the project list/i)),
  JSON.stringify(buttons.map((b) => b.text)));

check("an ordinary button keeps its VISIBLE text (a human reads that, not the aria-label)",
  Boolean(textOf(/Continue Application/i)) && !buttons.some((b) => (b.text || "") === "submit-form-btn"),
  JSON.stringify(buttons.map((b) => b.text)));

check("a button with no aria-label is unaffected",
  Boolean(textOf(/Save Draft/i)),
  JSON.stringify(buttons.map((b) => b.text)));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} icon-button check(s) FAILED.`); process.exit(1); }
console.log("\nAll icon-button checks passed (real Chromium).");
process.exit(0);
