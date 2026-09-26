// ACCELA CITIZEN ACCESS ON A CUSTOM DOMAIN (B5) AND THE RE-ENTRY MODULE (B8).
//
// B5: Columbus runs ACA at portal.columbus.gov/permits. The learner recognised ACA only by host
// (/accela\.com|citizenaccess/), so every deterministic ACA pass was off there. isAcaPage now
// also reads the page's own ACA control ids (ctl00_PlaceHolderMain…, termAccept,
// actionBarBottom, ACADialogFrame, StreetNo4Search) on an .aspx page, and remembers the host.
// B8: the drift re-entry (learner) and the "navigate to application" fallback (replay) built
// CapApplyDisclaimer.aspx?module=Building whatever the portal was. Lee County files solar under
// module=Permitting.
//
// MUST-PASS  custom-domain disclaimer page with ACA ids -> ACA; later marker-less page on the same
//            host -> ACA; Lee re-entry -> module=Permitting (from the page, or from the entry URL);
//            Columbus replay re-entry on its own domain -> /permits/Cap/CapApplyDisclaimer…Building.
// MUST-EXCLUDE a /Cap/CapHome.aspx path on a non-ACA site with ordinary ids -> not ACA; ACA ids on
//            a non-.aspx page -> not ACA; a custom-domain page with no ACA hint -> no re-entry URL.
//
// Run: npx tsx portal-bot/src/adapters/acaCustomDomain.test.ts
import assert from "node:assert/strict";
import { AutoLearnAdapter, acaApplyEntryFrom, acaModuleQuery, type ExtractedField, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
const f = (css: string, label = ""): ExtractedField => ({ selector: { css }, label, fieldType: "text" });
const fresh = () => new AutoLearnAdapter("ACA Custom Domain", planner, { maxPages: 1 }) as unknown as {
  isAcaPage(url: string, fields?: ExtractedField[]): boolean;
  acaApplyEntryUrl(url: string): string | null;
  startUrl: string;
};

check("MUST-PASS B5: Columbus's disclaimer on portal.columbus.gov/permits reads as ACA by its own ids", () => {
  const a = fresh();
  assert.equal(a.isAcaPage("https://portal.columbus.gov/permits/Cap/CapApplyDisclaimer.aspx?module=Building&TabName=Building",
    [f("#ctl00_PlaceHolderMain_termAccept", "I have read and accepted the above terms"), f("#ctl00_PlaceHolderMain_actionBarBottom_btnContinue")]), true);
  // ...and the host counts for the rest of the run (a page whose ids the extraction lost).
  assert.equal(a.isAcaPage("https://portal.columbus.gov/permits/Cap/CapEdit.aspx?module=Building", [f("", "Job Value")]), true);
});
check("MUST-PASS B5: the ids are read from label-keyed fields' fallbacks too (Lee's work location)", () => {
  const a = fresh();
  const labelled: ExtractedField = { selector: { label: "Street No.", fallbacks: [{ css: "#ctl00_PlaceHolderMain_WorkLocationEdit_txtStreetNo4Search_ChildControl0" }] }, label: "Street No.", fieldType: "text" };
  assert.equal(a.isAcaPage("https://permits.example-county.gov/aca/Cap/CapEdit.aspx", [labelled]), true);
});
check("MUST-PASS B5: accela.com / citizenaccess hosts still read as ACA with no markers", () => {
  const a = fresh();
  assert.equal(a.isAcaPage("https://aca-prod.accela.com/LEECO/Default.aspx", []), true);
  assert.equal(a.isAcaPage("https://citizenaccess.example.gov/CitizenAccess/Default.aspx", []), true);
});
check("MUST-EXCLUDE B5: a /Cap/CapHome.aspx path on a non-ACA site with ordinary controls is not ACA", () => {
  const a = fresh();
  assert.equal(a.isAcaPage("https://www.example.gov/Cap/CapHome.aspx", [f("#search", "Search"), f("#q", "Keyword")]), false);
});
check("MUST-EXCLUDE B5: ACA-looking ids on a non-.aspx page are not ACA (and do not mark the host)", () => {
  const a = fresh();
  assert.equal(a.isAcaPage("https://portal.example.gov/apps/form", [f("#ctl00_PlaceHolderMain_termAccept")]), false);
  assert.equal(a.isAcaPage("https://portal.example.gov/Cap/CapEdit.aspx", []), false);
});

check("MUST-PASS B8: the module comes from the page (Lee: Permitting, with its TabName)", () => {
  assert.equal(acaModuleQuery("https://aca-prod.accela.com/LEECO/Cap/CapHome.aspx?module=Permitting&TabName=Permitting"), "module=Permitting&TabName=Permitting");
  const a = fresh();
  assert.equal(a.acaApplyEntryUrl("https://aca-prod.accela.com/LEECO/Cap/CapHome.aspx?module=Permitting&TabName=Permitting"),
    "https://aca-prod.accela.com/LEECO/Cap/CapApplyDisclaimer.aspx?module=Permitting&TabName=Permitting");
});
check("MUST-PASS B8: a page with no module takes the run's entry URL's module; Building only as the last default", () => {
  const a = fresh();
  a.startUrl = "https://aca-prod.accela.com/LEECO/Cap/CapApplyDisclaimer.aspx?module=Permitting&TabName=Permitting";
  assert.equal(a.acaApplyEntryUrl("https://aca-prod.accela.com/LEECO/Cap/CapDetail.aspx"),
    "https://aca-prod.accela.com/LEECO/Cap/CapApplyDisclaimer.aspx?module=Permitting&TabName=Permitting");
  assert.equal(acaModuleQuery("https://x.accela.com/Y/Cap/CapHome.aspx", ""), "module=Building");
});
check("MUST-PASS B8 replay: Lee's Dashboard re-enters Permitting from the recipe's entry URL", () => {
  assert.equal(acaApplyEntryFrom("https://aca-prod.accela.com/LEECO/Dashboard.aspx", { entryUrl: "https://aca-prod.accela.com/LEECO/Cap/CapApplyDisclaimer.aspx?module=Permitting&TabName=Permitting" }),
    "https://aca-prod.accela.com/LEECO/Cap/CapApplyDisclaimer.aspx?module=Permitting&TabName=Permitting");
  // Unchanged for the portal it was written for.
  assert.equal(acaApplyEntryFrom("https://aca-oregon.accela.com/oregon/Dashboard.aspx"), "https://aca-oregon.accela.com/oregon/Cap/CapApplyDisclaimer.aspx?module=Building");
});
check("MUST-PASS B5 replay: Columbus's own domain re-enters its Building disclaimer when the recipe was recorded on ACA", () => {
  assert.equal(acaApplyEntryFrom("https://portal.columbus.gov/permits/Dashboard.aspx",
    { entryUrl: "https://portal.columbus.gov/permits/Cap/CapApplyDisclaimer.aspx?module=Building&TabName=Building", aca: true }),
  "https://portal.columbus.gov/permits/Cap/CapApplyDisclaimer.aspx?module=Building&TabName=Building");
  assert.equal(acaApplyEntryFrom("https://portal.columbus.gov/Permits/Cap/CapHome.aspx?module=Building", { aca: true }),
    "https://portal.columbus.gov/Permits/Cap/CapApplyDisclaimer.aspx?module=Building");
});
check("MUST-EXCLUDE B5 replay: a custom-domain page with no ACA hint, or a non-.aspx page, gets no re-entry URL", () => {
  assert.equal(acaApplyEntryFrom("https://portal.columbus.gov/permits/Dashboard.aspx"), null);
  assert.equal(acaApplyEntryFrom("https://portal.example.gov/apps/home", { aca: true }), null);
});

if (failures) { console.error(`\n${failures} aca-custom-domain check(s) FAILED.`); process.exit(1); }
console.log("\nAll aca-custom-domain checks passed.");
