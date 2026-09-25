// THE PORTAL TOLD US WHY, AND NOBODY READ IT.
//
// Miami's Property Search advanced on every attempt — the URL gained ?searchFor=…&searchBy=
// address each time — and every one of those pages came back carrying "Property Address not
// found." in an ASP.NET MVC ValidationSummary. The walk read validation errors in exactly one
// place: after an advance that did NOTHING. Every advance here worked, so nothing was ever
// read, and the run ended saying "the advance on this page is not advancing" — the opposite of
// what happened, and no cause anyone could act on.
//
// Two things are under test, and they pull against each other:
//   MUST PASS    — an MVC ValidationSummary with real errors is read.
//   MUST EXCLUDE — the empty .validation-summary-valid twin MVC renders on EVERY page is not,
//                  and neither is a page full of not-yet-filled required fields. A channel
//                  that says "the portal reported" on a healthy run is worse than silence.
//
//   npx tsx portal-bot/src/adapters/portalNotice.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { collectPortalNoticesFrom, collectValidationErrorsFrom } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Miami's actual markup: the empty summary MVC renders unconditionally, plus a form whose
// required fields are blank because nobody has filled them yet.
const CLEAN = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Property Search</h2>
  <form id="frmPropertySearch">
    <div class="validation-summary-valid" data-valmsg-summary="true"><ul><li style="display:none"></li></ul></div>
    <select id="SearchType"><option value="address">By Property Address</option></select>
    <input id="cbAutoComplete" name="cbAutoComplete" required aria-invalid="true" />
    <input id="owner" name="owner" required aria-invalid="true" />
  </form>
  <div role="alert">This page begins the data collection for a NEW scope of work. Please proceed to select the appropriate SEARCH option, enter data in the adjacent field, and continue by clicking on the Search icon. If the proposed work is within an existing permit, use the process number instead, and refer to the applicant user guide for the standard naming convention before uploading any drawings.</div>
</body></html>`;

// The same page after a search the portal refused.
const NOT_FOUND = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Property Search</h2>
  <form id="frmPropertySearch">
    <div class="validation-summary-errors" data-valmsg-summary="true"><ul><li>Property Address not found.</li></ul></div>
    <select id="SearchType"><option value="address">By Property Address</option></select>
    <input id="cbAutoComplete" name="cbAutoComplete" value="Pan American" />
  </form>
</body></html>`;

const pages: Record<string, string> = { "/clean": CLEAN, "/notfound": NOT_FOUND };
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(pages[q.url ?? "/clean"] ?? CLEAN);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();

// ---------------------------------------------------------------------------
// MUST PASS: the refusal is read, verbatim.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/notfound`);
const refused = await collectPortalNoticesFrom(page);
console.log(`   notices on the refused search: ${JSON.stringify(refused)}`);
check("an MVC ValidationSummary carrying a refusal is read",
  refused.some((n) => /Property Address not found/i.test(n)),
  `got ${JSON.stringify(refused)} — .validation-summary-errors is the most common error container in the fleet's legacy portals`);

// The blocked-advance channel must see it too: that path fires when an advance does
// nothing, and it was equally blind to MVC summaries.
const blockers = await collectValidationErrorsFrom(page);
check("the blocked-advance collector sees MVC summaries as well",
  blockers.some((n) => /Property Address not found/i.test(n)),
  `got ${JSON.stringify(blockers)}`);

// ---------------------------------------------------------------------------
// MUST EXCLUDE: a healthy page is silent on this channel.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/clean`);
const clean = await collectPortalNoticesFrom(page);
console.log(`   notices on the clean page: ${JSON.stringify(clean)}`);
check("MVC's empty .validation-summary-valid twin is NOT a notice",
  !clean.some((n) => /validation|summary/i.test(n)) && clean.every((n) => n.length > 0),
  `got ${JSON.stringify(clean)}`);
check("page copy parked in a role=alert region is NOT a notice",
  !clean.some((n) => /scope of work/i.test(n)),
  `got ${JSON.stringify(clean)} — long blobs are prose, not messages`);
check("blank required fields are NOT a notice on this channel",
  !clean.some((n) => /required/i.test(n)),
  `got ${JSON.stringify(clean)} — that synthesis belongs to the blocked-advance channel only`);
check("a healthy page produces no notices at all",
  clean.length === 0,
  `got ${JSON.stringify(clean)}`);

// The separation is the point: the OTHER collector DOES synthesise on those same blank
// required fields. If both channels said the same thing, one of them would be noise.
const cleanBlockers = await collectValidationErrorsFrom(page);
check("the two channels are genuinely different — the blocked-advance one still synthesises required-field messages",
  cleanBlockers.length > 0 && cleanBlockers.some((n) => /required/i.test(n)),
  `got ${JSON.stringify(cleanBlockers)}`);

await browser.close();
server.close();
console.log(failures === 0 ? "portalNotice.dom.smoke: PASS" : `portalNotice.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
