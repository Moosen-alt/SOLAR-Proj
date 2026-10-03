// A STATE ISSUER'S APPLICATION (issue #53, after #45 routed NM trade permits to the state CID).
// Valencia County / the Village of Los Lunas only review zoning and the site plan; the state
// Construction Industries Division issues the building AND electrical permits on ONE application.
// The document gate demanded two CID forms the finder never looked for on the state's site, and
// dropped the county's own review application. Pins, synthetic project, no network, no model:
//   - the required set = the LOCAL review application (the AHJ's own, the prerequisite step) + ONE
//     CID application that satisfies both the building and the electrical requirement — never two;
//   - the form finder looks for CID's form on the ISSUER's site (rld.nm.gov), and a not_found names
//     the issuer and the reason; no fabricated URL (the state rule's form is seeded, url "");
//   - Albuquerque (a full-service city) is unchanged.
//   npx tsx backend/test/nmStateIssuerForms.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-issuer-forms-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { requiredApplicationDocs, applicationDocContext } = await import("../src/requiredDocuments");
const { formAuthorityFor, issuingAgencyDocumentList } = await import("../src/applicationDocsAgency");
const { stateIssuerFormFor, stateRulesFor } = await import("../src/permitProcess");
const auto = await import("../src/ahjFormAuto");
import type { ProjectRecord } from "../../shared/src/types";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

const project = (ahj: string, city: string, snapshot: Record<string, unknown> = {}): ProjectRecord =>
  ({
    id: `p-${city.toLowerCase().replace(/\W+/g, "-")}`, homeownerName: "Example Owner", projectAddress: "100 Example Rd", city, state: "NM", zip: "87000", ahj,
    utility: "Example Utility", parserSnapshot: { projectDescriptionText: "Install roof-mounted PV system, 12 modules.", ...snapshot },
  }) as unknown as ProjectRecord;
const CID = /Construction Industries Division/;
const valencia = project("Valencia County", "Los Lunas");
const rows = (p: ProjectRecord) => requiredApplicationDocs(p, applicationDocContext(p));

await check("Valencia County: ONE CID application, satisfying both the building and the electrical requirement", () => {
  const cid = rows(valencia).filter((r) => CID.test(r.label));
  assert(cid.length === 1, `CID rows: ${JSON.stringify(cid.map((r) => r.label))}`);
  const docTypes = [cid[0].docType, ...(cid[0].altDocTypes ?? [])];
  assert(docTypes.includes("building_application") && docTypes.includes("electrical_application"), JSON.stringify(docTypes));
  assert(!docTypes.includes("permit_application"), "the local review's generic slot must not satisfy CID's application");
  assert(!rows(valencia).some((r) => r.docType === "electrical_application"), "a second (electrical) CID row was demanded");
  assert(cid[0].blocking, "CID's application is still owed (blocking)");
});
await check("Valencia County: the county's own review application stays required, under the prerequisite step", () => {
  const local = rows(valencia).filter((r) => r.docType === "permit_application");
  assert(local.length === 1, JSON.stringify(rows(valencia).map((r) => r.label)));
  assert(/Valencia County/.test(local[0].label) && !CID.test(local[0].label), local[0].label);
  assert(/zoning|site/i.test(local[0].label) && /before|first/i.test(local[0].why), `${local[0].label} / ${local[0].why}`);
  assert(local[0].blocking, "the local review application is blocking as before #45");
});
await check("whose forms: the generic slot is the AHJ's (local review), the building/electrical slots CID's", () => {
  assert(formAuthorityFor(valencia, "permit_application").name === "Valencia County", formAuthorityFor(valencia, "permit_application").name);
  assert(CID.test(formAuthorityFor(valencia, "building_application").name), "building slot");
  assert(CID.test(formAuthorityFor(valencia, "electrical_application").name), "electrical slot");
});
await check("the job's own list names ONE CID application (never two) and the county's review application", () => {
  const items = issuingAgencyDocumentList(valencia)?.items ?? [];
  const cid = items.filter((i) => i.role === "application" && CID.test(String(i.agency)));
  assert(cid.length === 1, JSON.stringify(items.map((i) => i.text)));
  assert(cid[0].docTypes.includes("building_application") && cid[0].docTypes.includes("electrical_application"), JSON.stringify(cid[0].docTypes));
  assert(items.some((i) => i.docTypes.includes("permit_application") && /Valencia County/.test(i.text)), JSON.stringify(items.map((i) => i.text)));
});
await check("the state rule's form is seeded on the state site with NO fabricated URL (rule 3)", () => {
  const form = stateIssuerFormFor(valencia);
  assert(form, "no state issuer form");
  assert(form!.url === "", `a form URL was set without confirmation: ${form!.url}`);
  assert(/^https:\/\/www\.rld\.nm\.gov\//.test(form!.searchUrl) && /^https:\/\/www\.rld\.nm\.gov\//.test(form!.sourceUrl), form!.searchUrl);
  assert(form!.origin === "state_rule" && /CID form URL not confirmed/.test(form!.notFound), form!.notFound);
  assert(form!.tracks.includes("building") && form!.tracks.includes("electrical"), JSON.stringify(form!.tracks));
  assert(stateRulesFor("NM").stateTradeIssuer?.issuerForm?.url === "", "seed carries a URL");
});

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("a state issuer's form must not call a model"); } }) as never;
await check("find-ahj-form for CID's slot looks on the ISSUER's site; not_found names CID and the reason", async () => {
  const res = await auto.ensureAhjFormTemplate(db, noModel, valencia, "building_application", { allowResearch: false });
  assert(res.status === "not_found", JSON.stringify(res));
  assert(CID.test(res.message) && /rld\.nm\.gov/.test(res.message) && /CID form URL not confirmed/.test(res.message), res.message);
  assert(!res.sourceUrl, `a URL was attempted: ${res.sourceUrl}`);
  const urls = res.message.match(/https?:\/\/[^\s),;]+/g) ?? [];
  assert(urls.every((u) => /^https:\/\/www\.rld\.nm\.gov\//.test(u)), `a non-state URL in the message: ${urls.join(", ")}`);
});
await check("the pass asks for the local application + ONE CID application, never a second CID form", async () => {
  const pass = await auto.ensureAhjFormsForProject(db, noModel, valencia, { allowResearch: false });
  assert(pass.neededTypes.includes("permit_application") && pass.neededTypes.includes("building_application"), JSON.stringify(pass.neededTypes));
  assert(!pass.neededTypes.includes("electrical_application"), JSON.stringify(pass.neededTypes));
});
await check("a manufactured home (MHD) carries no CID form", () => {
  assert(stateIssuerFormFor(project("Valencia County", "Los Lunas", { structureTypeOverride: "manufactured" })) === null, "MHD got CID's form");
});
await check("Albuquerque (full-service city): unchanged — no state form, no CID row, the generic slot is the city's", () => {
  const abq = project("Albuquerque", "Albuquerque");
  assert(stateIssuerFormFor(abq) === null, "state form for Albuquerque");
  assert(!rows(abq).some((r) => CID.test(r.label)), JSON.stringify(rows(abq)));
  assert(formAuthorityFor(abq, "permit_application").name === "Albuquerque", "authority");
  assert(issuingAgencyDocumentList(abq) === null, "agency list for Albuquerque");
});

if (failures) { console.error(`\n${failures} NM state-issuer form check(s) FAILED.`); process.exit(1); }
console.log("\nAll NM state-issuer form checks passed.");
process.exit(0);
