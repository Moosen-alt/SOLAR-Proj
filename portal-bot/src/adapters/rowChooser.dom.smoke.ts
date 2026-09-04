// WHEN EVERY BUTTON SAYS THE SAME WORD, THE CHOICE IS IN THE ROW.
//
// Des Moines (PermitTrax) offers twelve permit types, each row carrying an identically
// labelled button. The engine saw twelve controls all reading "SELECT", picked one with
// nothing to go on, and wandered for three runs — while row 5 said "RESIDENTIAL ROOFTOP
// PHOTOVOLTAIC PERMIT / You can apply for a RESIDENTIAL SOLAR permit" in plain words.
//
// THE FIXTURE IS THAT PORTAL'S OWN ROW TEXT, lifted from the run's page capture, including
// the traps: a RESIDENTIAL ELECTRICAL row that a naive electrical match would take, and a
// COMMERCIAL ELECTRICAL row that must never be chosen at all.
//
// Picking the wrong row files the wrong permit, which is the same failure PROGRAM_EXCLUDE
// and the record-type guard exist to prevent — so refusal beats ranking, and an
// unrecognised list is left alone rather than guessed at.
//   npx tsx portal-bot/src/adapters/rowChooser.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { chooseRow, scanRowChoices } from "./rowChooser";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// PermitTrax's own twelve, verbatim from data/learn-runs/…/page-p002-….json
const PERMIT_ROWS = [
  "01) RESIDENTIAL MECHANICAL PERMIT RESIDENTIAL Mechanical permit for new construction, remodeling, additions and repair.",
  "02) RESIDENTIAL PLUMBING PERMIT RESIDENTIAL Plumbing permit for new construction, remodeling, additions and repair.",
  "03) RESIDENTIAL ELECTRICAL PERMIT RESIDENTIAL Electrical permit for new construction, remodeling, additions and repair.",
  "04) RESIDENTIAL RE-ROOF PERMIT RESIDENTIAL Re-Roof permit. This is for one and two family dwellings and townhouses only.",
  "05) RESIDENTIAL ROOFTOP PHOTOVOLTAIC PERMIT You can apply for a RESIDENTIAL SOLAR permit. This is for one and two family dwellings.",
  "06) COMMERCIAL BUILDING PERMIT You can apply for a COMMERCIAL Building Permit which includes new construction, alterations.",
  "07) RESIDENTIAL BUILDING PERMIT You can apply for a RESIDENTIAL Building Permit which includes new construction, additions.",
  "08) COMMERCIAL PLUMBING PERMIT You can apply for a COMMERCIAL PLUMBING Permit. These require a review.",
  "09) COMMERCIAL MECHANICAL PERMIT You can apply for a COMMERCIAL MECHANICAL Permit. These require a review.",
  "10) COMMERCIAL ELECTRICAL PERMIT You can apply for a COMMERCIAL ELECTRICAL Permit. These require a review.",
  "11) DEMOLITION PERMIT You can apply for a DEMOLITION Permit. These require a review before issuance.",
  "12) FIRE PERMIT You can apply for a FIRE Permit. Fire Permits with no more than 10 sprinkler heads do not require review.",
];
const rowHtml = (t: string): string =>
  `<div class="row" style="border-bottom:1px solid #ccc">
     <div class="col-2 p-2"><button style="width:90px;height:30px">SELECT</button></div>
     <div class="col p-2" style="width:500px;height:40px">${t}</div>
   </div>`;

const PAGES: Record<string, string> = {
  permittrax: `<!doctype html><html><body>${PERMIT_ROWS.map(rowHtml).join("")}</body></html>`,
  // No solar row at all — electrical is then the right answer.
  noSolar: `<!doctype html><html><body>${[PERMIT_ROWS[0], PERMIT_ROWS[2], PERMIT_ROWS[6]].map(rowHtml).join("")}</body></html>`,
  // Only rows that would file the wrong thing. Must refuse outright.
  wrongOnly: `<!doctype html><html><body>${[PERMIT_ROWS[9], PERMIT_ROWS[10], PERMIT_ROWS[11]].map(rowHtml).join("")}</body></html>`,
  // Two buttons is a pair, not a chooser.
  justTwo: `<!doctype html><html><body>${[PERMIT_ROWS[4], PERMIT_ROWS[2]].map(rowHtml).join("")}</body></html>`,
  // Distinctly-labelled buttons need no row reading — the existing paths handle those.
  distinctLabels: `<!doctype html><html><body>
    <div><button style="width:90px;height:30px">Electrical</button></div>
    <div><button style="width:90px;height:30px">Plumbing</button></div>
    <div><button style="width:90px;height:30px">Solar</button></div></body></html>`,
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<!doctype html><html><body>none</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const scanOn = async (key: string) => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(100);
  return page.evaluate(scanRowChoices);
};

const rows = await scanOn("permittrax");
check("THE REGRESSION: twelve identical SELECT buttons are read as twelve ROWS",
  rows.length === 12, `found ${rows.length}`);
check("...and each row carries its own meaning, not the button's word",
  rows.every((r) => r.control.toLowerCase() === "select") && rows.some((r) => /PHOTOVOLTAIC/i.test(r.text)));

const picked = chooseRow(rows, "electrical");
check("the SOLAR row is chosen out of twelve", /PHOTOVOLTAIC/i.test(picked?.text || ""), picked?.text?.slice(0, 70));
check("...not the plain RESIDENTIAL ELECTRICAL row, which a naive match would take",
  !/03\)/.test(picked?.text || ""), picked?.text?.slice(0, 70));
console.log(`   picked: ${picked?.text?.slice(0, 78)}`);

check("the chosen row's own control is clickable by its learn-time tag",
  await page.locator(`[data-al-row="${picked!.key}"]`).first().click({ timeout: 4000 }).then(() => true).catch(() => false));

// ---------------------------------------------------------------------------
// Refusals. Filing under the wrong row is the wrong permit, not a worse one.
// ---------------------------------------------------------------------------
check("with no solar row, RESIDENTIAL ELECTRICAL is the right answer",
  /03\)/.test(chooseRow(await scanOn("noSolar"), "electrical")?.text || ""));

check("COMMERCIAL, DEMOLITION and FIRE only: nothing is chosen",
  chooseRow(await scanOn("wrongOnly"), "electrical") === undefined,
  "a commercial or demolition permit is not ours to file");

check("two rows is a pair of buttons, not a chooser", (await scanOn("justTwo")).length === 0);

check("distinctly-labelled buttons are not row-chooser material",
  (await scanOn("distinctLabels")).length === 0,
  "those are handled by the label-based paths already");

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} row-chooser check(s) FAILED.`); process.exit(1); }
console.log("\nAll row-chooser checks passed.");
process.exit(0);
