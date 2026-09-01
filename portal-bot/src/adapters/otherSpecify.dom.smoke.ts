// AN "OTHER — PLEASE SPECIFY" BOX IS REQUIRED THE MOMENT ITS PARENT SAYS "Other".
//
// Coos Bay's electrical application sets Category of Construction = Other, revealing a
// required "* Other Category of Construction:" box. Nothing filled it — it is not on the page
// when the plan is made and no project datum is named after it — so the portal answered
// "Please enter a Category of Construction" and the run looped on one page (live: pages 10
// through 14 were the same page) until it gave up. The sweep noticed the blank; noticing is
// not filling.
//
// Pins that the required specify box is answered, and that the three boxes which must NOT be
// touched are left alone — inventing an answer for an optional free-text field, or
// overwriting one a human already answered, is worse than leaving it blank.
//   npx tsx portal-bot/src/adapters/otherSpecify.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// The detector, mirroring fillOtherSpecifyFields' page-side pass.
const findTargets = (src: string): Array<{ key: string; label: string }> => {
  const re = new RegExp(src, "i");
  const out: Array<{ key: string; label: string }> = [];
  let n = 0;
  const nodes = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea')) as HTMLInputElement[];
  for (const el of nodes) {
    if ((el.value || "").trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const id = el.getAttribute("id") || "";
    let label = id ? ((document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText || "") : "";
    if (!label) label = (el.closest("label") as HTMLElement | null)?.innerText || "";
    if (!label) {
      const cell = el.closest("td, div, li");
      const prev = cell?.previousElementSibling as HTMLElement | null;
      if (prev && (prev.innerText || "").length < 120) label = prev.innerText || "";
    }
    label = label.replace(/\s+/g, " ").trim();
    if (!re.test(label)) continue;
    const wrap = el.closest("td, div, li, fieldset") as HTMLElement | null;
    const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true"
      || /\*/.test(label) || /\*/.test((wrap?.innerText || "").slice(0, 100));
    if (!required) continue;
    const key = `os${n++}`;
    el.setAttribute("data-al-other", key);
    out.push({ key, label: label.slice(0, 80) });
  }
  return out;
};

const PATTERN = /other\s+(category|type|description|use|construction)|please\s+specify|if\s+other|other\s*\(\s*specify/i;

const PAGE = `<!doctype html><html><body>
  <!-- Coos Bay's shape: parent select on "Other", revealing a REQUIRED specify box. -->
  <div>
    <label for="cat">Category of Construction:</label>
    <select id="cat"><option selected>Other</option></select>
  </div>
  <div>
    <label for="oth">* Other Category of Construction:</label>
    <input type="text" id="oth">
  </div>

  <!-- OPTIONAL free text. Inventing an answer here puts words in the applicant's mouth. -->
  <div>
    <label for="notes">Other notes about the project</label>
    <input type="text" id="notes">
  </div>

  <!-- Already answered by a human — must never be overwritten. -->
  <div>
    <label for="done">* Other Type of Work:</label>
    <input type="text" id="done" value="Re-roof">
  </div>

  <!-- The hidden twin ASP.NET leaves in the DOM for the un-chosen branch. -->
  <div style="display:none">
    <label for="hid">* Other Category of Construction:</label>
    <input type="text" id="hid">
  </div>

  <!-- A required field that is simply not a specify box. -->
  <div>
    <label for="valuation">* Job Valuation:</label>
    <input type="text" id="valuation">
  </div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const targets = await page.evaluate(findTargets, PATTERN.source);
const labels = targets.map((t) => t.label);
console.log(`  matched ${targets.length}: ${JSON.stringify(labels)}`);

check("the required Other-Category box is picked up",
  labels.some((l) => /Other Category of Construction/i.test(l)), JSON.stringify(labels));

check("an OPTIONAL other-notes box is left alone",
  !labels.some((l) => /notes/i.test(l)), JSON.stringify(labels));

check("a box a human already answered is never overwritten",
  !labels.some((l) => /Other Type of Work/i.test(l)), JSON.stringify(labels));

check("the hidden ASP.NET twin is not filled",
  targets.length === 1, `matched ${targets.length}, expected exactly the one visible box`);

check("an unrelated required field is not treated as a specify box",
  !labels.some((l) => /Valuation/i.test(l)), JSON.stringify(labels));

// End to end: filling by the tagged selector reaches the right input.
for (const t of targets) await page.locator(`[data-al-other="${t.key}"]`).first().fill("Solar");
const values = await page.evaluate(() => ({
  oth: (document.getElementById("oth") as HTMLInputElement).value,
  notes: (document.getElementById("notes") as HTMLInputElement).value,
  done: (document.getElementById("done") as HTMLInputElement).value,
  valuation: (document.getElementById("valuation") as HTMLInputElement).value,
}));
check('the specify box now reads "Solar", and nothing else moved',
  values.oth === "Solar" && values.notes === "" && values.done === "Re-roof" && values.valuation === "",
  JSON.stringify(values));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} other-specify check(s) FAILED.`); process.exit(1); }
console.log("\nAll other-specify checks passed (real Chromium).");
process.exit(0);
