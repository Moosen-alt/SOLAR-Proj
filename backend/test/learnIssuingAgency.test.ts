// THE LEARNER IS TOLD WHICH AGENCY ISSUES THE PERMIT IT IS LEARNING (agency-row item 2).
//
// Production 2026-09-27 (Jules Testperson, City of Jefferson OR): the per-job lookup says Marion
// County issues BOTH permits, but the learner only ever received city/ZIP/owner and a discipline,
// so its address-version choice fell to the Coos Bay convention (CITY row for structural) — the
// wrong agency. autoLearnPortal now puts issuingAgencyFor(project, <this learn's track>) on the
// siteIdentity the learner ranks the address grid with (portal-bot addressVersion). Every caller
// reaches a browser through autoLearnPortal — the operator's /auto-learn, the staging self-seed,
// the stale-recipe re-learn — so this is the one place.
//
// Drives the real autoLearnPortal on a scratch DB with the browser stubbed
// (setAutoLearnSeamsForTests) and reads what the stub launcher was handed.
//
// MUST-PASS  structural learn → the lookup's STRUCTURAL agency; electrical learn → the
//            ELECTRICAL agency (a lookup that splits them); no permit given → the AHJ-wide agency.
// MUST-EXCLUDE no lookup row → no agency (the learner keeps today's convention); a utility-scope
//            learn → no agency (an interconnection portal has no permit agency).
//
// KILL: autoLearn.ts siteIdentity without issuingAgency → (p1)(p2)(p3) fail.
//
// Run: npx tsx backend/test/learnIssuingAgency.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("learn-issuing-agency");
const { db } = fx;
const autoLearn = await import("../src/autoLearn");
const pp = await import("../src/permitProcess");

const ACA = "https://aca-oregon.accela.com/oregon/";
type Seen = { siteIdentity?: { city?: string; zip?: string; isElectrical?: boolean; issuingAgency?: string | null } };
let seen: Seen | null = null;
const stubLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async (input: Seen) => { seen = input; return { ...stubLearn }; }) as never });

const cite = (value: string | null, quote: string) => (value
  ? { value, sourceUrl: "https://example.gov/permits", quote, origin: "lookup" as const }
  : { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "no page named it" });
const none = () => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" });
const permit = (discipline: "structural" | "electrical", agency: string | null) => ({
  discipline, label: `${discipline} permit`, issuingAgency: cite(agency, `${agency} issues ${discipline} permits`),
  portalUrl: none(), recordType: none(), documents: none(), fee: none(),
});
function seedLookup(ahj: string, ahjWide: string | null, structural: string | null, electrical: string | null) {
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: cite(ahjWide, `${ahjWide} issues permits for ${ahj}`),
    permitStructure: { value: "separate", sourceUrl: "https://example.gov", quote: "a separate electrical permit", origin: "lookup" },
    permits: [permit("structural", structural), permit("electrical", electrical)],
  } as never) as { saved: boolean; reason?: string };
  assert.ok(saved.saved, `lookup for ${ahj} saved: ${saved.reason}`);
}
const learn = async (ahj: string, input: { scope?: "ahj" | "utility"; permitType?: "structural" | "electrical"; discipline?: string }, url = ACA) => {
  seen = null;
  const projectId = fx.newProject({ ahj, city: ahj.replace(/^City of /, ""), zip: "97352", utility: "Pacific Power" });
  await autoLearn.autoLearnPortal(db, projectId, { scope: input.scope ?? "ahj", portalUrl: url, createdBy: "operator", permitType: input.permitType, discipline: input.discipline });
  assert.ok(seen, "the stub launcher was reached");
  return (seen as Seen).siteIdentity ?? {};
};

// Jefferson's shape: the AHJ-wide answer is empty; both permits are Marion County's.
seedLookup("City of Cedarton", null, "Marion County", "Marion County");
// A split: the city issues structural, the county electrical.
seedLookup("City of Alderbrook", "City of Alderbrook", "City of Alderbrook", "Lane County");

await check("(p1) MUST-PASS: a STRUCTURAL learn hands the learner the structural permit's agency (Jefferson's shape → Marion County)", async () => {
  const id = await learn("City of Cedarton", { permitType: "structural" });
  assert.equal(id.issuingAgency, "Marion County");
  assert.equal(id.isElectrical, false);
});
await check("(p2) MUST-PASS: the track decides which permit's agency — electrical → the county, structural → the city", async () => {
  assert.equal((await learn("City of Alderbrook", { permitType: "electrical" })).issuingAgency, "Lane County");
  assert.equal((await learn("City of Alderbrook", { permitType: "structural" })).issuingAgency, "City of Alderbrook");
  // The staging self-seed passes the recipe discipline too; it is authoritative.
  assert.equal((await learn("City of Alderbrook", { permitType: "structural", discipline: "electrical" })).issuingAgency, "Lane County");
});
await check("(p3) MUST-PASS: no permit named → the AHJ-wide agency", async () => {
  assert.equal((await learn("City of Alderbrook", {})).issuingAgency, "City of Alderbrook");
});
await check("(x1) MUST-EXCLUDE: no lookup for the AHJ → no agency (the learner keeps today's convention)", async () => {
  const id = await learn("City of Nowhere", { permitType: "structural" });
  assert.ok(!id.issuingAgency, `an agency was invented: ${JSON.stringify(id.issuingAgency)}`);
});
await check("(x2) MUST-EXCLUDE: a utility-scope learn carries no permit agency", async () => {
  const id = await learn("City of Cedarton", { scope: "utility" }, "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login");
  assert.ok(!id.issuingAgency, `a utility learn was handed ${JSON.stringify(id.issuingAgency)}`);
});

finish("learnIssuingAgency");
