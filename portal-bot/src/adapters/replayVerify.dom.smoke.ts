// THE REPLAY NEVER CHECKED ITS OWN WORK.
//
// scrapeReviewScreen and compareReviewFields are shared utilities whose own comment says
// "the same logic serves all adapters". The LEARN adapter calls them four times — that check
// is what earns a recipe its trusted status. The REPLAY adapter, which runs on every filing
// after the first, referenced them ZERO times:
//
//   recipeAdapter.ts     scrapeReviewScreen / compareReviewFields   0
//   autoLearnAdapter.ts  scrapeReviewScreen                         4
//
// So a recipe verified once in August replayed forever on the strength of that one check. A
// drifted selector writing the homeowner's name into a contractor field, or a value that
// silently failed to commit, produced "Replayed 98 recorded step(s)" and a clean success.
// The only thing between that and a wrong filing was a person noticing by eye.
//
// This drives the SHARED functions against review screens in the shapes portals actually use
// — a definition list, a two-column table, and read-only inputs — because the comparison is
// only as good as the scrape underneath it.
//   npx tsx portal-bot/src/adapters/replayVerify.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { compareReviewFields, scrapeReviewScreen } from "../reviewScreenScraper";
import type { ProjectRecord } from "../../../shared/src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// A project shaped like the ones this system files.
const PROJECT = {
  id: "p1",
  homeownerName: "Wynema Wright",
  street: "1075 Flanagan Ave",
  city: "Coos Bay",
  state: "OR",
  zip: "97420",
  homeownerEmail: "wright@example.com",
  homeownerPhone: "(541) 555-0142",
} as unknown as ProjectRecord;

const dl = (rows: Array<[string, string]>): string =>
  `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
const table = (rows: Array<[string, string]>): string =>
  `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>`;

const CORRECT: Array<[string, string]> = [
  ["Applicant Name", "Wynema Wright"],
  ["Site Address", "1075 Flanagan Ave"],
  ["City", "Coos Bay"],
  ["State", "OR"],
  ["Zip", "97420"],
];
// The live failure this exists to catch: a drifted selector put the WRONG NAME in.
const WRONG_NAME: Array<[string, string]> = [
  ["Applicant Name", "Charles Bitton"],
  ["Site Address", "1075 Flanagan Ave"],
  ["City", "Coos Bay"],
  ["State", "OR"],
  ["Zip", "97420"],
];

const PAGES: Record<string, string> = {
  dlCorrect: `<!doctype html><html><body><h1>Step 6: Review</h1>${dl(CORRECT)}</body></html>`,
  tableCorrect: `<!doctype html><html><body><h1>Review Application</h1>${table(CORRECT)}</body></html>`,
  dlWrongName: `<!doctype html><html><body><h1>Step 6: Review</h1>${dl(WRONG_NAME)}</body></html>`,
  // A review page that renders values as read-only inputs rather than text.
  readonlyInputs: `<!doctype html><html><body><h1>Review</h1><form>
     ${CORRECT.map(([k, v]) => `<label>${k}<input readonly value="${v}" style="width:150px;height:20px" /></label>`).join("")}
     </form></body></html>`,
  // Nothing readable at all — must be reported as unreadable, not as "every field wrong".
  blank: `<!doctype html><html><body></body></html>`,
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

const verifyOn = async (key: string) => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(100);
  const fields = await scrapeReviewScreen(page);
  const body = String(await page.locator("body").innerText().catch(() => ""));
  return { fields, mismatches: compareReviewFields(fields, PROJECT, body) };
};

// ---------------------------------------------------------------------------
// The check that was missing.
// ---------------------------------------------------------------------------
const wrong = await verifyOn("dlWrongName");
check("THE REGRESSION: a wrong name on the review screen is caught",
  wrong.mismatches.length > 0, `saw ${wrong.fields.length} fields, 0 mismatches`);
check("...and the mismatch names the field, what it shows, and what was expected",
  wrong.mismatches.some((m) => /Bitton/i.test(String(m.found)) || /Wynema/i.test(String(m.expected))),
  JSON.stringify(wrong.mismatches.slice(0, 2)));
console.log(`   caught: ${JSON.stringify(wrong.mismatches.slice(0, 2))}`);

// ---------------------------------------------------------------------------
// The expensive direction. A false mismatch on a CORRECT filing would train the
// operator to ignore the warning, which is worse than not having it.
// ---------------------------------------------------------------------------
const dlOk = await verifyOn("dlCorrect");
check("a correct definition-list review screen produces NO mismatch",
  dlOk.mismatches.length === 0, JSON.stringify(dlOk.mismatches.slice(0, 3)));
check("...and it actually read the fields, rather than passing by reading nothing",
  dlOk.fields.length >= 4, `only ${dlOk.fields.length} fields scraped`);

const tableOk = await verifyOn("tableCorrect");
check("a correct TABLE review screen produces no mismatch either",
  tableOk.mismatches.length === 0, JSON.stringify(tableOk.mismatches.slice(0, 3)));
check("...and read its fields too", tableOk.fields.length >= 4, `${tableOk.fields.length} fields`);

const roOk = await verifyOn("readonlyInputs");
check("a review screen of READ-ONLY INPUTS is read and passes",
  roOk.mismatches.length === 0 && roOk.fields.length >= 4,
  `${roOk.fields.length} fields, ${roOk.mismatches.length} mismatches`);

// ---------------------------------------------------------------------------
// Unreadable is its own answer, not "everything is wrong".
// ---------------------------------------------------------------------------
const blank = await verifyOn("blank");
check("an unreadable review screen reports THAT, not a mismatch per field",
  blank.mismatches.length <= 1, `${blank.mismatches.length} mismatches from an empty page`);
check("...and says so by name", blank.mismatches.every((m) => /reviewScreen/i.test(m.field)),
  JSON.stringify(blank.mismatches.slice(0, 2)));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} replay-verify check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-verify checks passed.");
process.exit(0);
