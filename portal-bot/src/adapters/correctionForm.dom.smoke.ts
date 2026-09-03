// THE FORM NEXT TO THE ONE YOU WANT CANCELS THE PROJECT.
//
// PacifiCorp suspended APP-111681 and put two forms on the project's landing page, adjacent,
// in the same table, with byte-identical Begin buttons:
//
//     PP - Suspended - Changes Needed From Customer     [Begin]   <- reopens it for correction
//     PP - Cancellation Form                            [Begin]   <- ends the interconnection
//
// Only the NAME separates them. Choosing by position here is the wrong-permit-type mistake
// and the rebate-programme mistake in a third costume, and it is the worst of the three: a
// correction cycle costs days, a cancelled interconnection costs the project.
//
// The most dangerous moment is AFTER a successful resubmission. The correction form moves to
// "Previously Submitted" with a View button, and the only form left carrying a Begin button
// on the whole page is the cancellation form. Anything that reaches for "the button that can
// be clicked" cancels the customer's interconnection at exactly the moment the work went
// right. That second state is the heart of this test.
//
// Fixture structure/classes were read off the live logged-in DOM for APP-111681.
//   npx tsx portal-bot/src/adapters/correctionForm.dom.smoke.ts
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  CORRECTION_REFUSE,
  chooseCorrectionForm,
  correctionFormSelector,
  isRefusal,
  scanProjectForms,
} from "./correctionForm";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "powerclerk-project-forms.html"), "utf8");

// Serve each state on its own page so a scan sees only that state's DOM.
const only = (id: string): string => {
  const open = `<div id="${id}">`;
  const start = FIXTURE.indexOf(open);
  const end = id === "suspended" ? FIXTURE.indexOf('<div id="submitted">') : FIXTURE.length;
  return `<!doctype html><html><body>${FIXTURE.slice(start, end)}</body></html>`;
};

const OTHER_VENDOR = `<!doctype html><html><body>
  <div class="card">
    <div class="card-header">Current Forms</div>
    <table><tbody>
      <tr><td>Deficiency Response - More Information Required
        <button type="button" style="height:26px;width:70px">Continue</button></td><td>In Progress</td></tr>
      <tr><td>Request to Withdraw Application
        <button type="button" style="height:26px;width:70px">Begin</button></td><td>New Form</td></tr>
    </tbody></table>
  </div>
</body></html>`;

const AMBIGUOUS = `<!doctype html><html><body>
  <div class="card">
    <div class="card-header">Current Forms</div>
    <table><tbody>
      <tr><td>Suspended - Changes Needed (Electrical)
        <button type="button" style="height:26px;width:70px">Begin</button></td><td>New Form</td></tr>
      <tr><td>Suspended - Changes Needed (Structural)
        <button type="button" style="height:26px;width:70px">Begin</button></td><td>New Form</td></tr>
    </tbody></table>
  </div>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url || "";
  res.writeHead(200, { "content-type": "text/html" });
  if (u.includes("submitted")) return res.end(only("submitted"));
  if (u.includes("othervendor")) return res.end(OTHER_VENDOR);
  if (u.includes("ambiguous")) return res.end(AMBIGUOUS);
  return res.end(only("suspended"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this shim every page.evaluate
// throws ReferenceError and the caller's .catch turns it into "found nothing".
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

// ---------------------------------------------------------------------------
// 1. Suspended: the correction form and the cancellation form, side by side.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/suspended`);
const suspendedRows = await page.evaluate(scanProjectForms);
console.log(`   suspended state offers: ${JSON.stringify(suspendedRows.map((r) => `${r.name} [${r.action}]`))}`);

check("both Current Forms rows are found, with their sections",
  suspendedRows.some((r) => /Cancellation/i.test(r.name) && r.section === "Current Forms") &&
  suspendedRows.some((r) => /Suspended/i.test(r.name) && r.section === "Current Forms"),
  JSON.stringify(suspendedRows.map((r) => [r.name, r.section])));

const picked = chooseCorrectionForm(suspendedRows);
check("THE CHOICE: the correction form is selected, not the cancellation form",
  !isRefusal(picked) && /Suspended - Changes Needed/i.test(picked.row.name),
  isRefusal(picked) ? `refused: ${picked.why}` : `picked "${picked.row.name}"`);

check("...and it explains why, so a filing is never reopened for an unreadable reason",
  !isRefusal(picked) && picked.why.length > 20 && /cancel/i.test(picked.why),
  isRefusal(picked) ? "" : picked.why);

check("the cancellation form is refused by NAME, before any scoring",
  CORRECTION_REFUSE.test("PP - Cancellation Form") && !CORRECTION_REFUSE.test("PP - Suspended - Changes Needed From Customer"));

// The recorded selector must not be able to resolve to the cancellation row.
if (!isRefusal(picked)) {
  const sel = correctionFormSelector(picked.row);
  check("the choice is recorded by the form's NAME, never its position",
    sel.text === "PP - Suspended - Changes Needed From Customer",
    JSON.stringify(sel));
  const clicked = await page.locator(`[data-al-cform="${picked.row.key}"]`).first()
    .click({ timeout: 5000 }).then(() => true).catch(() => false);
  check("the chosen row's own control is clickable via its learn-time tag", clicked);
}

// ---------------------------------------------------------------------------
// 2. THE DANGEROUS STATE — after a successful resubmission.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/submitted`);
const afterRows = await page.evaluate(scanProjectForms);
console.log(`   post-submission offers: ${JSON.stringify(afterRows.map((r) => `${r.name} [${r.action}]`))}`);

const beginnable = afterRows.filter((r) => /^begin$/i.test(r.action));
check("setup: the ONLY form with a Begin button is now the cancellation form",
  beginnable.length === 1 && /Cancellation/i.test(beginnable[0].name),
  JSON.stringify(beginnable.map((r) => r.name)));

const afterPick = chooseCorrectionForm(afterRows);
check("THE REGRESSION THAT MATTERS: nothing is chosen — the interconnection is not cancelled",
  isRefusal(afterPick),
  isRefusal(afterPick) ? "" : `picked "${afterPick.row.name}" — this would CANCEL the project`);

check("...and the refusal names the cancellation form as the reason",
  isRefusal(afterPick) && /cancel|withdraw/i.test(afterPick.why),
  isRefusal(afterPick) ? afterPick.why : "");

check("the already-submitted correction form is not mistaken for a way back in (it is View-only)",
  isRefusal(afterPick) || !/Suspended/i.test((afterPick as { row: { name: string } }).row.name));

// ---------------------------------------------------------------------------
// 3. Another vendor's wording, and the withdrawal trap alongside it.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/othervendor`);
const otherPick = chooseCorrectionForm(await page.evaluate(scanProjectForms));
check("a differently-worded correction form is still recognised (Deficiency Response)",
  !isRefusal(otherPick) && /Deficiency Response/i.test(otherPick.row.name),
  isRefusal(otherPick) ? `refused: ${otherPick.why}` : `picked "${otherPick.row.name}"`);

check("...and 'Request to Withdraw Application' is never chosen",
  isRefusal(otherPick) || !/Withdraw/i.test(otherPick.row.name));

// ---------------------------------------------------------------------------
// 4. Two plausible correction forms: refuse rather than guess.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/ambiguous`);
const ambiguous = chooseCorrectionForm(await page.evaluate(scanProjectForms));
check("two correction-shaped forms are refused, not guessed between",
  isRefusal(ambiguous) && /refusing rather than guessing/i.test(ambiguous.why),
  isRefusal(ambiguous) ? ambiguous.why : `picked "${ambiguous.row.name}"`);

check("...and the refusal lists what was offered, so a human can act on it",
  isRefusal(ambiguous) && ambiguous.offered.length === 2,
  isRefusal(ambiguous) ? JSON.stringify(ambiguous.offered) : "");

// ---------------------------------------------------------------------------
// 5. A page with no forms at all.
// ---------------------------------------------------------------------------
await page.setContent(`<!doctype html><body><h1>Dashboard</h1><p>No applications were found</p></body>`);
const empty = chooseCorrectionForm(await page.evaluate(scanProjectForms));
check("a page with no form list yields a refusal, never a stray click", isRefusal(empty));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} correction-form check(s) FAILED.`); process.exit(1); }
console.log("\nAll correction-form checks passed (real Chromium, PowerClerk's captured structure).");
process.exit(0);
