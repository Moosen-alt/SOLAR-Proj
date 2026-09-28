// LICENCES BY TYPE — "which licence number goes in this slot" has ONE answer (clients.licenceFor),
// read by the submit gate, the form fill and the portal overlay.
//
// The operator (2026-09-28): "Ensure we can differentiate them for the bot to pull for X states
// permit. Its putting the right numbers there. As well as it being able to have multiple companies
// with the similar data sets for those bots to pick from" / "We dont want an infinity license on kin
// projects kind of thing. Plansets also likely have some license number on them for ref too".
// A Massachusetts application prints a Construction Supervisor licence slot AND a Home Improvement
// Contractor registration slot; an electrical permit asks for the electrical contractor licence;
// every reader used to take the FIRST licence on file for the state, and the portal overlay handed
// Oregon's CCB to a "contractor licence" box in any state.
//
// Every licence number below is INVENTED (same shapes as real ones, never a real company's).
// Two companies: "Harborline Solar LLC" (licensed in OR / MA / WA / AZ) and the test company
// "Keel Test Solar" (its own NV licence only) — the second company's job must never get the
// first company's numbers, even when it has none of its own.
//
//   npx tsx backend/test/licencesByType.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ and page-images never land in the repo
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "licences-by-type-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "portal-profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const recipes = await import("../src/portalRecipes");
const checks = await import("../src/formFieldChecks");
const cm = await import("../src/clientMatch");
const { LICENCE_KINDS, canonicalLicenceKind, kindForSlot } = await import("../../shared/src/licenceKinds");
const { RecipeAdapter } = await import("../../portal-bot/src/adapters/recipeAdapter");
const db = await openDatabase();

// ---------------------------------------------------------------------------------------------
// The two companies (plus one in ANOTHER org, which must never be named).
// ---------------------------------------------------------------------------------------------
const N = {
  orCcb: "700333", orBcd: "C7333", orElectrician: "7333S", orSupervisor: "Sam Sparkwell",
  maEc: "4412-EL-B7", maCsl: "CS-765432", maHic: "198765", maCslHolder: "Casey Supervisorson",
  waContractor: "HARBOSL845QX", waEc: "HARBOEC123AB",
  azR11: "ROC 333111", azKb2: "ROC 333222",
  keelNv: "NV-0099887",
};
const harbor = clients.createClient(db, {
  companyName: "Harborline Solar LLC", legalBusinessName: "Harborline Solar LLC", businessEmail: "ops@harborline.test", businessPhone: "5035550190",
  ccbLicenseNumber: N.orCcb, ccbExpiration: "2027-03-31", electricalLicenseNumber: N.orBcd, electricianLicenseNumber: N.orElectrician, electricalSupervisorName: N.orSupervisor,
  stateLicenses: [
    { state: "MA", kind: "EC", number: N.maEc, expires: "2027-06-30" },
    { state: "MA", kind: "CSL", number: N.maCsl, expires: "08/15/2028", holder: N.maCslHolder },
    { state: "MA", kind: "HIC", number: N.maHic, expires: "2027-01-31" },
    { state: "WA", kind: "general contractor", number: N.waContractor },
    { state: "WA", kind: "Electrical", number: N.waEc },
    { state: "AZ", kind: "electrical_contractor", number: N.azR11 },
    { state: "AZ", kind: "contractor", number: N.azKb2 },
    { state: "MA", kind: "Business License", number: "BIZ-MA-1" },
  ],
});
const keel = clients.createClient(db, {
  companyName: "Keel Test Solar", legalBusinessName: "Keel Test Solar LLC", businessEmail: "ops@keel.test", businessPhone: "7025550100",
  stateLicenses: [{ state: "NV", kind: "contractor", number: N.keelNv }],
});
const OTHER_ORG = "org-licences-other";
db.run("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)", [OTHER_ORG, "another tenant", new Date().toISOString()]);
const foreignOrgCo = clients.createClient(db, { companyName: "Elsewhere Tenant Solar", stateLicenses: [{ state: "MA", kind: "HIC", number: "HIC-ELSEWHERE-9" }] }, OTHER_ORG);
const harborRow = clients.clientLicenceRow(db, harbor.id)!;
const keelRow = clients.clientLicenceRow(db, keel.id)!;
const L = clients.licenceFor;

// =============================================================================================
console.log("\nL1. THE MODEL — canonical kinds, normalised on the way in, expiry + holder kept");
await check("parseStateLicenses normalises free-text kinds and keeps expires (MM/DD/YYYY -> ISO) and holder", () => {
  const got = clients.getClient(db, harbor.id).stateLicenses ?? [];
  const byNumber = Object.fromEntries(got.map((l) => [l.number, l]));
  assert.equal(byNumber[N.maEc].kind, "electrical_contractor");
  assert.equal(byNumber[N.maCsl].kind, "construction_supervisor");
  assert.equal(byNumber[N.maCsl].expires, "2028-08-15");
  assert.equal(byNumber[N.maCsl].holder, N.maCslHolder);
  assert.equal(byNumber[N.maHic].kind, "home_improvement_contractor");
  assert.equal(byNumber[N.waContractor].kind, "contractor");
  assert.equal(byNumber[N.waEc].kind, "electrical_contractor");
  assert.equal(byNumber["BIZ-MA-1"].kind, "business_registration");
});
await check("a stored row from before (kind 'home_improvement', no expiry) keeps working; an unknown kind keeps its text", () => {
  const legacy = clients.parseStateLicenses(JSON.stringify([{ state: "pa", kind: "home_improvement", number: " PA123456 " }, { state: "TX", kind: "TDLR thing", number: "X1" }]));
  assert.deepEqual(legacy[0], { state: "PA", kind: "home_improvement_contractor", number: "PA123456" });
  assert.equal(legacy[1].kind, "TDLR thing");
});
await check("canonicalLicenceKind table", () => {
  const table: Array<[string, string]> = [["EC", "electrical_contractor"], ["electrical", "electrical_contractor"], ["CSL", "construction_supervisor"], ["Construction Supervisor", "construction_supervisor"],
    ["HIC", "home_improvement_contractor"], ["general contractor", "contractor"], ["CCB", "contractor"], ["solar", "solar_contractor"], ["master electrician", "master_electrician"],
    ["Supervising Electrician", "master_electrician"], ["business license", "business_registration"], ["UBI", "business_registration"], ["", ""], ["widget", ""]];
  for (const [raw, want] of table) assert.equal(canonicalLicenceKind(raw), want, raw);
});
await check("kindForSlot table: the slot's printed words name its licence, or 'generic', or nothing", () => {
  const table: Array<[string, string | null]> = [
    ["Licensed Construction Supervisor / License Number", "construction_supervisor"], ["CSL #", "construction_supervisor"],
    ["HIC Registration Number", "home_improvement_contractor"], ["Electrical Contractor License No.", "electrical_contractor"], ["Electrical License no", "electrical_contractor"],
    ["Supervising Electrician License no", "master_electrician"], ["Master Electrician #", "master_electrician"], ["CCB License no", "contractor"],
    ["General Contractor License", "contractor"], ["Solar Contractor License", "solar_contractor"], ["City Business License", "business_registration"],
    ["License Number", "generic"], ["Contractor License #", "generic"], ["Registration Number", "generic"], ["Email Address", null], ["Owner Name", null],
  ];
  for (const [text, want] of table) assert.equal(kindForSlot(text), want, text);
});

// =============================================================================================
console.log("\nL2. licenceFor — the one answer, by kind, state, track and company");
await check("MUST-PASS MA: a CSL slot, a HIC slot and an electrical slot each get their OWN number", () => {
  assert.equal(L(harborRow, "MA", { slotText: "Licensed Construction Supervisor / License Number" }).number, N.maCsl);
  assert.equal(L(harborRow, "MA", { slotText: "HIC Registration Number" }).number, N.maHic);
  assert.equal(L(harborRow, "MA", { slotText: "Electrical Contractor License No." }).number, N.maEc);
});
await check("MUST-EXCLUDE MA: the HIC slot never gets the CSL number; the CSL slot never the HIC; neither the Oregon CCB", () => {
  assert.notEqual(L(harborRow, "MA", { slotText: "HIC Registration Number" }).number, N.maCsl);
  assert.notEqual(L(harborRow, "MA", { slotText: "CSL #" }).number, N.maHic);
  for (const slot of ["License Number", "CCB License no", "Contractor License #"]) for (const track of ["building", "electrical", "combo", null]) {
    assert.notEqual(L(harborRow, "MA", { slotText: slot, track }).number, N.orCcb, `${slot} / ${track}`);
  }
});
await check("MA generic slot by track: building -> contractor, then CSL (no MA contractor on file); electrical -> EC", () => {
  const b = L(harborRow, "MA", { slotText: "License Number", track: "building" });
  assert.equal(b.number, N.maCsl); assert.equal(b.kind, "construction_supervisor"); assert.equal(b.expires, "2028-08-15"); assert.equal(b.holder, N.maCslHolder);
  assert.equal(L(harborRow, "MA", { slotText: "License Number", track: "electrical" }).number, N.maEc);
  assert.equal(L(harborRow, "MA", { slotText: "License Number", track: "mpu" }).number, N.maEc, "a main-panel upgrade is an electrical permit");
});
await check("WA: a building generic slot -> the contractor registration; an electrical slot -> the electrical contractor licence", () => {
  assert.equal(L(harborRow, "WA", { slotText: "License #", track: "building" }).number, N.waContractor);
  assert.equal(L(harborRow, "WA", { slotText: "License #", track: "electrical" }).number, N.waEc);
  assert.equal(L(harborRow, "WA", { slotText: "License #", track: "combo" }).number, N.waContractor, "combo: the building list first");
});
await check("MUST-EXCLUDE: an electrical permit NEVER takes a general contractor's number (WA company with only a contractor registration)", () => {
  const onlyGc = { state_licenses_json: JSON.stringify([{ state: "WA", kind: "contractor", number: "GC-ONLY-1" }]) };
  const a = L(onlyGc, "WA", { slotText: "License #", track: "electrical" });
  assert.equal(a.number, "");
  assert.match(a.reason, /no WA electrical contractor licence on file/);
});
await check("AZ: R-11 (electrical) vs KB-2 (contractor) by track", () => {
  assert.equal(L(harborRow, "AZ", { track: "electrical" }).number, N.azR11);
  assert.equal(L(harborRow, "AZ", { track: "building" }).number, N.azKb2);
});
await check("unknown track: several candidates -> \"\" with the candidates named; one candidate -> it", () => {
  const a = L(harborRow, "MA", { slotText: "License Number", track: "nem" });
  assert.equal(a.number, "");
  assert.equal(a.candidates.length, 3, JSON.stringify(a.candidates));
  assert.ok(a.candidates.some((c) => c.includes(N.maCsl)) && a.candidates.some((c) => c.includes(N.maHic)) && a.candidates.some((c) => c.includes(N.maEc)));
  assert.equal(L(keelRow, "NV", { slotText: "License Number", track: null }).number, N.keelNv);
});
await check("MUST-EXCLUDE: business_registration is never offered as a contractor licence — only to a slot that asks for it", () => {
  const bizOnly = { state_licenses_json: JSON.stringify([{ state: "MA", kind: "business_registration", number: "BIZ-ONLY" }]) };
  for (const track of ["building", "electrical", "combo", null]) assert.equal(L(bizOnly, "MA", { slotText: "License #", track }).number, "", String(track));
  assert.ok(!L(harborRow, "MA", { track: null }).candidates.some((c) => c.includes("BIZ-MA-1")));
  assert.equal(L(harborRow, "MA", { slotText: "City Business License" }).number, "BIZ-MA-1");
});
await check("Oregon unchanged: the named columns (CCB / BCD electrical / supervising electrician + name)", () => {
  assert.equal(L(harborRow, "OR", "contractor").number, N.orCcb);
  assert.equal(L(harborRow, "OR", "contractor").label, "CCB");
  assert.equal(L(harborRow, "OR", "electrical_contractor").number, N.orBcd);
  assert.equal(L(harborRow, "OR", "master_electrician").number, N.orElectrician);
  assert.equal(L(harborRow, "OR", "master_electrician").holder, N.orSupervisor);
  const gate = clients.contractorLicenceForState(harborRow, "OR");
  assert.equal(gate.number, N.orCcb); assert.equal(gate.oregon, true); assert.equal(gate.label, "CCB");
});
await check("ONE licence-state answer (clients.licenceJobState): a spelled-out 'Oregon' is OR at every licence door; blank is OR; 'Massachusetts' is MA", () => {
  // project.state is stored as the parser/intake wrote it (normalize.ts does not code it), and a
  // spelled-out state read as "OREGON" named no licence on file: the gate blocked, the CCB went blank.
  assert.equal(clients.licenceJobState("Oregon"), "OR");
  assert.equal(clients.licenceJobState(""), "OR");
  assert.equal(clients.licenceJobState("Massachusetts"), "MA");
  assert.equal(L(harborRow, "Oregon", "contractor").number, N.orCcb);
  const gate = clients.contractorLicenceForState(harborRow, "Oregon");
  assert.equal(gate.number, N.orCcb); assert.equal(gate.oregon, true);
  assert.equal(clients.licenceOverlay(harborRow, { state: "Oregon", track: null }).ccbLicenseNumber, N.orCcb);
  assert.notEqual(clients.licenceOverlay(harborRow, { state: "Massachusetts", track: "building" }).ccbLicenseNumber, N.orCcb);
});
await check("a state with none on file -> \"\" (never the CCB, never another state's number)", () => {
  for (const st of ["TX", "NV", "CA"]) for (const track of ["building", "electrical", "combo", null]) {
    const a = L(harborRow, st, { slotText: "License #", track });
    assert.equal(a.number, "", `${st}/${track}`);
  }
  assert.equal(clients.contractorLicenceForState(harborRow, "TX").number, "");
});
await check("TWO COMPANIES: Keel's MA job never gets Harborline's numbers, though Keel has none of its own; no client -> \"\"", () => {
  for (const need of ["contractor", "construction_supervisor", "home_improvement_contractor", "electrical_contractor", "master_electrician"] as const) {
    assert.equal(L(keelRow, "MA", need).number, "", need);
  }
  for (const track of ["building", "electrical", "combo", null]) assert.equal(L(keelRow, "MA", { slotText: "License #", track }).number, "");
  assert.equal(L(null, "MA", "construction_supervisor").number, "");
  assert.match(L(null, "MA", "construction_supervisor").reason, /no client/);
  assert.equal(L({}, "OR", "contractor").number, "", "an empty row is no client (no default client, ever)");
});
await check("licenseState moves the named columns to that state (and off Oregon)", () => {
  const ia = { electrical_license_number: "EL111111MA", license_state: "IA" };
  assert.equal(L(ia, "IA", { track: "electrical" }).number, "EL111111MA");
  assert.equal(L(ia, "OR", "electrical_contractor").number, "");
});
await check("two different numbers of ONE kind in one state are ambiguous (named), never the first silently", () => {
  const two = { state_licenses_json: JSON.stringify([{ state: "MA", kind: "EC", number: "EC-1" }, { state: "MA", kind: "EC", number: "EC-2" }]) };
  const a = L(two, "MA", "electrical_contractor");
  assert.equal(a.number, "");
  assert.equal(a.candidates.length, 2);
});

// =============================================================================================
console.log("\nL4. THE PORTAL OVERLAY — state- and track-aware, every licence key present");
const JOB = { utility: "Test Electric", account: "ACCT-1", meter: "M-1", dcKw: "7.2", acKw: "6.0", jobValue: "20000" };
const mk = (clientId: string, state: string, extra: Record<string, unknown> = {}) => repo.createProject(db, {
  clientId, owner: `Owner ${state} ${Math.random().toString(36).slice(2, 6)}`, street: "12 Elm St", city: state === "OR" ? "Salem" : "Townsville", state,
  zip: state === "OR" ? "97301" : state === "MA" ? "02451" : "98001", ahj: `City of Townsville ${state}`, ...JOB, ...extra,
} as never).project;
const maJobA = mk(harbor.id, "MA");
const waJobA = mk(harbor.id, "WA");
const orJobA = mk(harbor.id, "OR");
const maJobKeel = mk(keel.id, "MA");
const fv = (p: { id: string }, track: string | null) => recipes.resolveRecipeFieldValues(db, repo.getProjectDetail(db, p.id).project, "accela", track);
await check("MUST-PASS MA building job: ccbLicenseNumber = the generic-by-track licence (CSL), its expiry; CSL / HIC / EC keys", () => {
  const v = fv(maJobA, "building");
  assert.equal(v.ccbLicenseNumber, N.maCsl);
  assert.equal(v.ccbExpiration, "2028-08-15");
  assert.equal(v.constructionSupervisorLicenseNumber, N.maCsl);
  assert.equal(v.homeImprovementLicenseNumber, N.maHic);
  assert.equal(v.homeImprovementLicenseExpiration, "2027-01-31");
  assert.equal(v.electricalLicenseNumber, N.maEc);
});
await check("MUST-EXCLUDE MA: no Oregon number reaches any key (CCB, BCD, supervising electrician and name)", () => {
  const v = fv(maJobA, "building");
  const all = JSON.stringify(v);
  for (const n of [N.orCcb, N.orBcd, N.orElectrician, N.orSupervisor]) assert.ok(!all.includes(n), `MA job carries ${n}`);
  assert.equal(v.electricianLicenseNumber, "", "present and blank — no MA master electrician on file");
  assert.equal(v.electricalSupervisorName, "");
});
await check("WA electrical job: ccbLicenseNumber = the WA electrical contractor licence, never the WA contractor registration", () => {
  const v = fv(waJobA, "electrical");
  assert.equal(v.ccbLicenseNumber, N.waEc);
  assert.equal(v.electricalLicenseNumber, N.waEc);
  assert.ok(!JSON.stringify(v).includes(N.waContractor));
  assert.equal(fv(waJobA, "building").ccbLicenseNumber, N.waContractor);
});
await check("Oregon job unchanged: the named columns on every track", () => {
  for (const track of ["building", "electrical", "combo", "nem", null]) {
    const v = fv(orJobA, track);
    assert.equal(v.ccbLicenseNumber, N.orCcb); assert.equal(v.ccbExpiration, "2027-03-31");
    assert.equal(v.electricalLicenseNumber, N.orBcd); assert.equal(v.electricianLicenseNumber, N.orElectrician); assert.equal(v.electricalSupervisorName, N.orSupervisor);
  }
});
await check("TWO COMPANIES: Keel's MA job carries every licence key BLANK — none of Harborline's numbers", () => {
  const v = fv(maJobKeel, "building");
  for (const k of clients.LICENCE_OVERLAY_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(v, k) && v[k] === "", `${k}=${JSON.stringify(v[k])}`);
  const all = JSON.stringify(v);
  for (const n of Object.values(N)) if (n !== N.keelNv) assert.ok(!all.includes(n), `Keel's job carries ${n}`);
});
await check("the new keys are described for auto-learn (CSL / HIC and their expirations)", () => {
  for (const k of ["constructionSupervisorLicenseNumber", "constructionSupervisorLicenseExpiration", "homeImprovementLicenseNumber", "homeImprovementLicenseExpiration"]) {
    assert.ok(recipes.RECIPE_FIELD_DESCRIPTIONS[k], k);
  }
  assert.equal(recipes.dateFieldForLiteral("CSL Expiration Date", "2028-08-15"), "constructionSupervisorLicenseExpiration");
  assert.equal(recipes.dateFieldForLiteral("HIC Registration Expiration Date", "2027-01-31"), "homeImprovementLicenseExpiration");
  assert.equal(recipes.dateFieldForLiteral("License Expiration Date", "2027-01-31"), "ccbExpiration");
});

// --- the recipe adapter's cross-project literal guard, two companies ----------------------------
interface Log { fills: Array<{ target: string; value: string }> }
function fakePage(log: Log): unknown {
  const held = new Map<string, string>();   // what each control holds, so a fill "holds" on read-back
  const loc = (target: string): Record<string, unknown> => {
    const l: Record<string, unknown> = {
      first: () => l, nth: () => l, count: async () => 1, isVisible: async () => true, isEnabled: async () => true, isEditable: async () => true,
      waitFor: async () => undefined, scrollIntoViewIfNeeded: async () => undefined, click: async () => undefined, check: async () => undefined,
      fill: async (v: string) => { held.set(target, String(v)); log.fills.push({ target, value: String(v) }); }, type: async (v: string) => { held.set(target, String(v)); log.fills.push({ target, value: String(v) }); },
      selectOption: async (v: unknown) => { log.fills.push({ target, value: typeof v === "string" ? v : String((v as { label?: string })?.label ?? "") }); },
      press: async () => undefined, inputValue: async () => held.get(target) ?? "", textContent: async () => "", innerText: async () => "", getAttribute: async () => null,
      evaluate: async () => "", allInnerTexts: async () => [], setInputFiles: async () => undefined, dispatchEvent: async () => undefined,
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }), locator: () => l, elementHandle: async () => null, focus: async () => undefined, blur: async () => undefined,
    };
    return l;
  };
  const page: Record<string, unknown> = {
    url: () => "https://portal.test/app", title: async () => "Application", goto: async () => undefined, waitForLoadState: async () => undefined,
    reload: async () => undefined, waitForTimeout: async () => undefined, isClosed: () => false, bringToFront: async () => undefined,
    keyboard: { press: async () => undefined }, frames: () => [], evaluate: async () => "", screenshot: async () => Buffer.from(""), content: async () => "<html></html>",
    getByRole: (r: string, o?: { name?: string }) => loc(`role:${r}:${o?.name ?? ""}`), getByLabel: (lbl: string) => loc(`label:${lbl}`),
    getByPlaceholder: (p: string) => loc(`placeholder:${p}`), getByTestId: (t: string) => loc(`testId:${t}`), getByText: () => ({ ...loc("text"), count: async () => 0 }),
    locator: (css: string) => loc(`css:${css}`), $$eval: async () => [],
  };
  page.frameLocator = () => page;
  page.context = () => ({ pages: () => [page] });
  return page;
}
const replay = async (project: { id: string }, track: string, steps: unknown[]): Promise<Log> => {
  const log: Log = { fills: [] };
  const detail = repo.getProjectDetail(db, project.id).project;
  const recipe = { id: "r-lic", scopeType: "ahj", profileKey: "ma|townsville|", state: "MA", ahj: "City of Townsville MA", utility: "", portalPlatform: "",
    portalUrl: "https://portal.test/app", status: "complete", version: 1, steps, createdBy: "test", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), notes: "" };
  const adapter = new RecipeAdapter(recipe as never, recipes.resolveRecipeFieldValues(db, detail, "accela", track), {});
  (adapter as unknown as { page: unknown }).page = fakePage(log);
  (adapter as unknown as { opened: unknown }).opened = { context: { pages: () => [(adapter as unknown as { page: unknown }).page] } };
  const res = await adapter.fillApplication(detail);
  if (process.env.LIC_DEBUG) console.log(JSON.stringify(res).slice(0, 1500));
  return log;
};
// Steps LEARNED on Harborline's MA job: recorded literals are Harborline's numbers.
const LEARNED_STEPS = [
  { action: "fill", selector: { label: "CSL #" }, field: "constructionSupervisorLicenseNumber", value: N.maCsl },
  { action: "fill", selector: { label: "Contractor License Number" }, field: "ccbLicenseNumber", value: N.maCsl },
  { action: "fill", selector: { label: "HIC Reg #" }, value: N.maHic },   // an UNBOUND literal under a licence label no PROJECT_DATA word covers
  { action: "fill", selector: { label: "Permit Name" }, value: "Solar PV System Installation" },   // portal vocabulary must still replay
];
// One step per run (the adapter's page-drift check reads a fake page's labels as absent when a
// section records several fields — crossProjectReplay.test runs one step at a time for the same reason).
const replayEach = async (project: { id: string }, track: string): Promise<string[]> => {
  const typed: string[] = [];
  for (const step of LEARNED_STEPS) typed.push(...(await replay(project, track, [step])).fills.map((f) => f.value));
  return typed;
};
await check("MUST-PASS: Harborline's own replay fills its own numbers", async () => {
  const typed = await replayEach(maJobA, "building");
  assert.ok(typed.includes(N.maCsl), JSON.stringify(typed));
});
await check("MUST-EXCLUDE (two companies): the recipe replayed on Keel's MA job types NONE of Harborline's licences; portal vocabulary still replays", async () => {
  const typed = await replayEach(maJobKeel, "building");
  for (const n of [N.maCsl, N.maHic, N.maEc]) assert.ok(!typed.includes(n), `Keel's filing typed ${n}: ${JSON.stringify(typed)}`);
  assert.ok(typed.includes("Solar PV System Installation"), JSON.stringify(typed));
});
await check("a recorded licence literal binds to the key its label names (CSL), not the equal-valued ccbLicenseNumber", () => {
  const v = fv(maJobA, "building");
  const out = recipes.convertLiteralsToBoundFields([{ action: "fill", selector: { label: "Construction Supervisor License" }, value: N.maCsl } as never], v);
  assert.equal((out.steps[0] as { field?: string }).field, "constructionSupervisorLicenseNumber", JSON.stringify(out));
  assert.equal(out.ambiguous.length, 0);
  // A bare "License Number" literal equals both ccbLicenseNumber (generic -> CSL on a building job)
  // and the CSL key; it binds the generic key (the label names no kind) — never left ambiguous,
  // which would refuse the recipe's promotion.
  const bare = recipes.convertLiteralsToBoundFields([{ action: "fill", selector: { label: "License Number" }, value: N.maCsl } as never], v);
  assert.equal((bare.steps[0] as { field?: string }).field, "ccbLicenseNumber", JSON.stringify(bare));
  assert.equal(bare.ambiguous.length, 0);
  const elec = recipes.convertLiteralsToBoundFields([{ action: "fill", selector: { label: "Electrical License" }, value: N.maEc } as never], fv(maJobA, "electrical"));
  assert.equal((elec.steps[0] as { field?: string }).field, "electricalLicenseNumber", JSON.stringify(elec));
});

// =============================================================================================
console.log("\nL3. THE FORM FILL — typed sources, the printed caption's kind, the holder, one number per slot");
async function licenceBlank(boxes: Array<{ name: string; caption: string }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const p: PDFPage = doc.addPage([612, 792]);
  const form = doc.getForm();
  // Names that AGREE with the caption printed under them calibrate the form's caption side (below).
  const all = [{ name: "Owner Name", caption: "Owner Name" }, { name: "Business Address", caption: "Business Address" }, { name: "Business Phone", caption: "Business Phone" }, ...boxes];
  all.forEach((b, i) => {
    const y = 740 - i * 40;
    form.createTextField(b.name).addToPage(p, { x: 40, y, width: 300, height: 12 });
    p.drawText(b.caption, { x: 42, y: y - 10, size: 9, font });
  });
  return doc.save();
}
// SHIFTED names: every licence widget's NAME is its neighbour's; the printed caption is what it is.
const SHIFTED = [
  { name: "Company Name", caption: "Licensed Construction Supervisor / License Number" },
  { name: "License Number", caption: "HIC Registration Number" },
  { name: "Registration Number", caption: "Electrical Contractor License No." },
  { name: "Supervisor Name", caption: "Licensed Construction Supervisor" },
  { name: "Expiry", caption: "CSL Expiration Date" },
];
const SHIFTED_BLANK = await licenceBlank(SHIFTED);
// A stale map with the WRONG licence sources on each (what the old mapper produced).
const STALE_MAP = {
  formName: "Residential Application", sourceUrl: "", fillMode: "acroform" as const, preserveInteractive: true, notes: "",
  textFields: {
    "Owner Name": "project.homeownerName",
    "Company Name": "client.stateLicence.home_improvement_contractor",
    "License Number": "client.stateContractorLicense",
    "Registration Number": "client.stateContractorLicense",
    "Supervisor Name": "computed.applicantSignerName",
    "Expiry": "client.stateLicence.home_improvement_contractor.expires",
  },
  checkboxes: {},
};
const store = (ahj: string, bytes: Uint8Array, map: Record<string, unknown>, formType = "building_application", state = "MA") =>
  auto.storeAhjFormTemplate(db, { ahjName: ahj, state, formType, filename: "Residential Application.pdf", bytes, map: map as never });
const readText = async (file: string) => { const f = (await PDFDocument.load(fs.readFileSync(file))).getForm(); return (n: string) => f.getTextField(n).getText() ?? ""; };
const fillWith = async (ahj: string, project: { id: string }, tag: string, state = "MA") => {
  const t = forms.loadStoredTemplates(db, ahj, state)[0];
  const ctx = forms.buildContext(db, repo.getProjectDetail(db, project.id).project);
  ctx.signatures = { applicant: { bytes: new Uint8Array(), mime: "image/png", widthPx: 1, heightPx: 1, name: "Avery Applicant" } };
  const out = path.join(tmp, `${tag}.pdf`);
  const res = await forms.fillLoadedForm(t.def, t.bytes, ctx, out);
  return { text: await readText(out), items: res.operatorItems ?? [] };
};
store("City of Shiftfield", SHIFTED_BLANK, STALE_MAP);
const maShiftA = mk(harbor.id, "MA", { ahj: "City of Shiftfield" });
const shifted = await fillWith("City of Shiftfield", maShiftA, "shifted-a");
await check("MUST-PASS unverified map: each licence slot takes the licence its CAPTION names (CSL, HIC, EC) whatever it was bound to", () => {
  assert.equal(shifted.text("Company Name"), N.maCsl);
  assert.equal(shifted.text("License Number"), N.maHic);
  assert.equal(shifted.text("Registration Number"), N.maEc);
});
await check("MUST-EXCLUDE: the HIC slot never carries the CSL number, the CSL slot never the HIC, the EC slot never a contractor number", () => {
  assert.notEqual(shifted.text("License Number"), N.maCsl);
  assert.notEqual(shifted.text("Company Name"), N.maHic);
  assert.ok(![N.maCsl, N.maHic, N.orCcb].includes(shifted.text("Registration Number")));
});
await check("the licence-holder NAME slot takes the CSL holder — never the applicant signer; the expiry is the CSL's", () => {
  assert.equal(shifted.text("Supervisor Name"), N.maCslHolder);
  assert.notEqual(shifted.text("Supervisor Name"), "Avery Applicant");
  assert.equal(shifted.text("Expiry"), "2028-08-15");
});
await check("rule 3: the SAME map, human-VERIFIED, is filled as written (the caption does not re-bind a verified source)", async () => {
  // A person verifies it (the same write PATCH /api/ahj-templates/:id/verify makes).
  const vid = store("City of Verifiedfield", SHIFTED_BLANK, STALE_MAP);
  const vmap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [vid])!.field_map);
  db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify({ ...vmap, verified: true, verifiedAt: "2026-09-28T12:00:00.000Z" }), vid]);
  const v = await fillWith("City of Verifiedfield", mk(harbor.id, "MA", { ahj: "City of Verifiedfield" }), "verified-a");
  assert.equal(v.text("Company Name"), N.maHic, "bound to the HIC source by a person — written as bound");
  assert.equal(v.text("Supervisor Name"), "Avery Applicant", "a verified binding is the person's call");
});
const keelShift = mk(keel.id, "MA", { ahj: "City of Shiftfield", planSetInstaller: { companyName: "Harborline Solar", licences: [N.maCsl] } });
const keelFill = await fillWith("City of Shiftfield", keelShift, "shifted-keel");
await check("TWO COMPANIES on a form: Keel's MA job leaves every licence slot BLANK — never Harborline's numbers", () => {
  for (const n of ["Company Name", "License Number", "Registration Number", "Supervisor Name", "Expiry"]) {
    assert.equal(keelFill.text(n), "", n);
  }
});
await check("each blank licence slot is a NAMED operator item: which licence is missing, for this client", () => {
  const items = keelFill.items.join(" | ");
  assert.ok(keelFill.items.some((i) => /^Licensed Construction Supervisor \/ License Number \(no MA construction supervisor licence on file for this client/.test(i)), items);
  assert.ok(keelFill.items.some((i) => /^HIC Registration Number \(no MA home improvement contractor registration on file for this client/.test(i)), items);
  assert.ok(keelFill.items.some((i) => /^Electrical Contractor License No\. \(no MA electrical contractor licence on file for this client/.test(i)), items);
});
await check("L5b: the blank slot's item names the plan set's printed number as a REFERENCE — it is never filled", () => {
  assert.ok(keelFill.items.some((i) => i.includes(`the plan set prints ${N.maCsl}`) && i.includes("Keel Test Solar's licences")), keelFill.items.join(" | "));
});
await check("L5a: the plan set's licence is another company's -> a named warning on the fill (the client is never switched)", () => {
  assert.ok(keelFill.items.some((i) => /The plan set's licence CS-765432 \(Harborline Solar LLC\) belongs to another company, not Keel Test Solar/.test(i)), keelFill.items.join(" | "));
  assert.equal(repo.getProjectDetail(db, keelShift.id).project.clientId, keel.id);
});

// ONE NUMBER, ONE SLOT: two generic captions on one form.
const TWO_GENERIC = await licenceBlank([{ name: "Lic A", caption: "License Number" }, { name: "Lic B", caption: "Registration Number" }]);
store("City of Twinfield", TWO_GENERIC, { formName: "Residential Application", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, notes: "", checkboxes: {},
  textFields: { "Lic A": "client.stateContractorLicense", "Lic B": "client.stateContractorLicense" } });
const twin = await fillWith("City of Twinfield", mk(harbor.id, "MA", { ahj: "City of Twinfield" }), "twin");
await check("MUST-EXCLUDE: one licence number never fills two licence slots that do not say which licence — both blank and named", () => {
  assert.equal(twin.text("Lic A"), "");
  assert.equal(twin.text("Lic B"), "");
  assert.ok(twin.items.some((i) => /^License Number \(the same licence number as Registration Number/.test(i)), twin.items.join(" | "));
});
store("City of Onefield", await licenceBlank([{ name: "Lic A", caption: "License Number" }]), { formName: "Electrical Permit Application", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, notes: "", checkboxes: {},
  textFields: { "Lic A": "client.stateContractorLicense" } }, "electrical_application");
await check("MUST-PASS: a single generic slot fills by the FORM's track (an electrical application -> the EC; a building one -> the CSL)", async () => {
  const e = await fillWith("City of Onefield", mk(harbor.id, "MA", { ahj: "City of Onefield" }), "one-elec");
  assert.equal(e.text("Lic A"), N.maEc);
  store("City of Buildfield", await licenceBlank([{ name: "Lic A", caption: "License Number" }]), { formName: "Building Permit Application", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, notes: "", checkboxes: {},
    textFields: { "Lic A": "client.stateContractorLicense" } }, "building_application");
  const b = await fillWith("City of Buildfield", mk(harbor.id, "MA", { ahj: "City of Buildfield" }), "one-bld");
  assert.equal(b.text("Lic A"), N.maCsl);
  store("City of Waelec", await licenceBlank([{ name: "Lic A", caption: "License Number" }]), { formName: "Electrical Permit Application", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, notes: "", checkboxes: {},
    textFields: { "Lic A": "client.stateContractorLicense" } }, "electrical_application", "WA");
  const w = await fillWith("City of Waelec", mk(harbor.id, "WA", { ahj: "City of Waelec" }), "wa-elec", "WA");
  assert.equal(w.text("Lic A"), N.waEc, "WA electrical form: the EC, never the contractor registration");
});

console.log("\n   the mapper — typed sources offered by NAME, the caption rebinds at map time too");
await check("the mapper is offered the typed sources (names + descriptions only; never a number — rule 2)", () => {
  const offered = auto.fieldSourcesForState("MA").join("\n");
  for (const s of ["client.stateLicence.construction_supervisor", "client.stateLicence.home_improvement_contractor", "client.stateLicence.electrical_contractor",
    "client.stateLicence.master_electrician", "client.stateLicence.construction_supervisor.holder", "client.stateLicence.contractor.expires"]) assert.ok(offered.includes(s), s);
  assert.ok(!offered.includes("client.stateLicence.business_registration"), "a business registration is never offered as a licence source");
  for (const n of Object.values(N)) assert.ok(!offered.includes(n), `a number reached the mapper: ${n}`);
});
await check("sanitizeAcroMap: a licence source of another kind is rebound to the caption's kind; the holder slot to the holder", () => {
  const widgets = SHIFTED.map((b) => ({ name: b.name, type: "PDFTextField", caption: b.caption }));
  const out = checks.sanitizeAcroMap({ widgets, items: [], state: "MA", textFields: { ...STALE_MAP.textFields }, checkboxes: {} });
  assert.equal(out.textFields["Company Name"], "client.stateLicence.construction_supervisor");
  assert.equal(out.textFields["License Number"], "client.stateLicence.home_improvement_contractor");
  assert.equal(out.textFields["Registration Number"], "client.stateLicence.electrical_contractor");
  assert.equal(out.textFields["Supervisor Name"], "client.stateLicence.construction_supervisor.holder");
  assert.equal(out.textFields["Expiry"], "client.stateLicence.construction_supervisor.expires");
});

console.log("\n   Oregon forms — the same values as before, and no other state's licence ever");
await check("curated Oregon forms (Coos Bay / Marion E-01 / Marion B-01S) fill the named columns for a company that ALSO holds MA/WA/AZ licences", async () => {
  const { CURATED_AHJ_FORMS } = await import("../src/curatedAhjForms");
  const llm = new Proxy({}, { get() { throw new Error("curated forms never call a model"); } }) as never;
  const files: Record<string, string> = { "coos bay|electrical_application": "coos-electrical.pdf", "marion county|electrical_application": "marion-e-01.pdf", "marion county|building_application": "marion-b-01s.pdf" };
  let licenceFields = 0;
  for (const src of CURATED_AHJ_FORMS) {
    const file = files[`${src.ahj}|${src.formType}`];
    if (!file) continue;
    const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", file)));
    await auto.acquireFromBytes(db, llm, { ahj: src.ahj, state: "OR", formType: src.formType, formName: src.formName, bytes, sourceUrl: src.url });
    const t = forms.loadStoredTemplates(db, src.ahj, "OR").find((x) => x.def.formName === src.formName)!;
    const ctx = forms.buildContext(db, repo.getProjectDetail(db, mk(harbor.id, "OR", { ahj: src.ahj }).id).project);
    const out = path.join(tmp, `or-${file}`);
    await forms.fillLoadedForm(t.def, t.bytes, ctx, out);
    const f = (await PDFDocument.load(fs.readFileSync(out))).getForm();
    const want: Record<string, string> = { "client.ccbLicenseNumber": N.orCcb, "client.electricalLicenseNumber": N.orBcd, "client.electricianLicenseNumber": N.orElectrician, "client.electricalSupervisorName": N.orSupervisor };
    for (const [name, source] of Object.entries(t.def.textFields)) {
      if (!want[source]) continue;
      licenceFields++;
      assert.equal(f.getTextField(name).getText() ?? "", want[source], `${file}: ${name}`);
    }
    const allText = f.getFields().filter((x) => "getText" in x).map((x) => (x as unknown as { getText(): string | undefined }).getText() ?? "").join(" ");
    for (const n of [N.maEc, N.maCsl, N.maHic, N.waContractor, N.waEc, N.azR11, N.azKb2]) assert.ok(!allText.includes(n), `${file} carries ${n}`);
  }
  assert.ok(licenceFields >= 5, `only ${licenceFields} licence fields were checked`);
});

console.log("\n   the package cover sheet names the same licences (Oregon unchanged)");
await check("an MA job's cover sheet lists the MA licences by type — never 'CCB: <Oregon number>'; an OR job's still reads CCB", async () => {
  const { buildApplicationDocumentPackage } = await import("../src/applicationDocs");
  const text = (p: { id: string }) => buildApplicationDocumentPackage(repo.getProjectDetail(db, p.id).project, clients.getClient(db, harbor.id)).docs.map((d) => d.markdown).join("\n");
  const ma = text(maJobA);
  assert.ok(ma.includes(`MA construction supervisor licence: ${N.maCsl}`) && ma.includes(`MA electrical contractor licence: ${N.maEc}`), ma.slice(0, 600));
  assert.ok(!ma.includes(N.orCcb) && !ma.includes(N.orBcd), "an Oregon number on an MA cover sheet");
  const or = text(orJobA);
  assert.ok(or.includes(`CCB: ${N.orCcb}`) && or.includes(`Electrical license: ${N.orBcd}`));
});

// =============================================================================================
console.log("\nTHE SUBMIT GATE — per permit track, and the plan set's licence");
const gateCheck = (p: { id: string }) => repo.getSubmitGateReport(db, p.id).checks.find((c) => c.id === "submitting-client")!;
await check("an MA job with three MA licences is NOT 'no licence on file': each permit track names the licence it takes", () => {
  const c = gateCheck(maJobA);
  assert.equal(c.status, "pass", JSON.stringify(c.evidence));
  assert.ok(c.evidence.some((e) => e.includes(N.maCsl) || e.includes(N.maEc)), JSON.stringify(c.evidence));
  assert.ok(!c.evidence.join(" ").includes(N.orCcb));
});
await check("Keel's MA job: a WARNING naming what is missing — never Harborline's number, never a CCB demand", () => {
  const c = gateCheck(maJobKeel);
  assert.equal(c.status, "warning");
  const words = `${c.evidence.join(" ")} ${c.nextAction}`;
  for (const n of Object.values(N)) assert.ok(!words.includes(n), `gate names ${n}`);
  assert.ok(!/\bCCB\b/.test(words), words);
});
await check("the plan set's licence is another client's -> the gate's client check WARNS and names the other company", () => {
  const c = gateCheck(keelShift);
  assert.equal(c.status, "warning");
  assert.ok(c.evidence.some((e) => /belongs to another company/.test(e) && e.includes("Harborline Solar LLC")), JSON.stringify(c.evidence));
  assert.match(c.nextAction, /right company/);
});
await check("MUST-EXCLUDE: a plan set printing the project's OWN licence raises nothing; another ORG's company is never named", () => {
  const own = mk(harbor.id, "MA", { planSetInstaller: { companyName: "Harborline Solar", licences: [N.maCsl] } });
  assert.equal(cm.planSetLicenceWarning(db, repo.getProjectDetail(db, own.id).project), null);
  const foreign = mk(keel.id, "MA", { planSetInstaller: { companyName: "Elsewhere", licences: ["HIC-ELSEWHERE-9"] } });
  assert.equal(cm.planSetLicenceWarning(db, repo.getProjectDetail(db, foreign.id).project), null, "another tenant's company must never be named");
  assert.ok(foreignOrgCo.id);
});
await check("MUST-EXCLUDE: the plan set's printed licence is never a fill value — not in the portal value map, not in any form slot", () => {
  const v = fv(keelShift, "building");
  assert.ok(!JSON.stringify(v).includes(N.maCsl), "the plan-set licence reached the recipe value map");
  assert.equal(typeof repo.getProjectDetail(db, keelShift.id).project.parserSnapshot?.planSetInstaller, "object", "kept as an object (value maps skip objects)");
  const parserPage = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const build = parserPage.slice(parserPage.indexOf("function buildSystemPayload()"), parserPage.indexOf("function buildSystemPayload()") + 9000);
  assert.match(build, /payload\.planSetInstaller = \{ companyName: clean\(sc\.contractorCompany\), licences: printedLicences \}/, "the parser page persists the title-block licence as an object");
});
await check("an EIN-shaped plan-set number is never a licence reference", () => {
  assert.deepEqual(cm.planSetPrintedLicences({ planSetInstaller: { licences: ["42-0845774", N.maCsl] } }), [N.maCsl]);
});

// =============================================================================================
console.log("\nONE LIST: the dashboard's kinds match the shared list");
await check("frontend LICENCE_KIND_OPTIONS == shared LICENCE_KINDS (kind, label, person)", () => {
  const js = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
  const m = /^const LICENCE_KIND_OPTIONS = (\[[\s\S]*?\]);/m.exec(js);
  assert.ok(m, "LICENCE_KIND_OPTIONS not found in dashboard.js");
  // eslint-disable-next-line no-new-func
  const list = new Function(`return ${m![1]};`)() as Array<{ kind: string; label: string; person: boolean }>;
  assert.deepEqual(list, LICENCE_KINDS.map((k) => ({ kind: k.kind, label: k.label, person: k.person })));
});

// =============================================================================================
console.log("\nL6. THE CLIENTS EDITOR — the REAL dashboard functions, lifted; a save never wipes licences");
{
  const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  /** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance (feeTracksDisplay's lift). */
  const lift = (name: string): string => {
    const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
    const m = re.exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find ${name}`);
    const isConst = m[0].startsWith("const");
    let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
    let depth = 0;
    for (; i < dashboard.length; i++) {
      const ch = dashboard[i];
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    return dashboard.slice(m.index, i) + (isConst ? ";" : "");
  };
  const NAMES = ["esc", "LICENCE_KIND_OPTIONS", "stateLicencesFromClient", "licenceKindIsPerson", "stateLicenceRowHtml", "stateLicencesPayload", "withStateLicences"];
  // eslint-disable-next-line no-new-func
  const ui = new Function(`${NAMES.map(lift).join("\n\n")}\nreturn { ${NAMES.join(", ")} };`)() as Record<string, (...a: unknown[]) => any>;
  // The client exactly as GET /api/clients hands it to the page.
  const asServed = () => JSON.parse(JSON.stringify(clients.getClient(db, harbor.id)));
  const stored = () => clients.getClient(db, harbor.id).stateLicenses ?? [];
  const before = stored();
  await check("MUST-PASS: edit only the phone and save — every stored licence (kind, number, expiry, holder) is still there", () => {
    const drafts = ui.stateLicencesFromClient(asServed());
    const payload = ui.withStateLicences({ companyName: "Harborline Solar LLC", phone: "5035550199" }, drafts, harbor.id, harbor.id);
    assert.equal(payload.stateLicenses.length, before.length);
    clients.updateClient(db, harbor.id, payload);
    assert.deepEqual(stored(), before);
    assert.equal(clients.getClient(db, harbor.id).phone, "5035550199");
  });
  await check("MUST-EXCLUDE: a list NOT loaded from this client is never sent — the stored licences survive the save", () => {
    const payload = ui.withStateLicences({ companyName: "Harborline Solar LLC" }, [], "some-other-client", harbor.id);
    assert.ok(!("stateLicenses" in payload));
    clients.updateClient(db, harbor.id, payload);
    assert.deepEqual(stored(), before);
  });
  await check("an added row (state, type, number, expires, holder) round-trips; a half-filled row is an error, never dropped silently", () => {
    const drafts = ui.stateLicencesFromClient(asServed());
    drafts.push({ state: "ma", kind: "master_electrician", number: "ME-5550001", expires: "2029-02-28", holder: "Morgan Voltz" });
    clients.updateClient(db, harbor.id, ui.withStateLicences({}, drafts, harbor.id, harbor.id));
    const added = stored().find((l) => l.number === "ME-5550001");
    assert.deepEqual(added, { state: "MA", kind: "master_electrician", number: "ME-5550001", expires: "2029-02-28", holder: "Morgan Voltz" });
    assert.equal(L(clients.clientLicenceRow(db, harbor.id), "MA", "master_electrician").holder, "Morgan Voltz");
    const bad = ui.stateLicencesPayload([{ state: "M", kind: "contractor", number: "X1" }, { state: "WA", kind: "", number: "X2" }, { state: "", kind: "", number: "" }]);
    assert.equal(bad.errors.length, 2, JSON.stringify(bad.errors));
    assert.equal(bad.list.length, 0);
  });
  await check("the row escapes every stored value (rule: esc() everything interpolated); an unknown stored kind is shown, not changed", () => {
    const html = ui.stateLicenceRowHtml({ state: "MA", kind: "TDLR thing", number: "<img src=x onerror=alert(1)>", expires: "", holder: "\"><script>x</script>" }, 0);
    assert.ok(!html.includes("<img src=x") && !html.includes("<script>"), html);
    assert.ok(html.includes("&lt;img"));
    assert.ok(html.includes("TDLR thing - pick a type"));
    assert.ok(/data-sl="holder"[^>]*disabled/.test(html), "the holder box is for person licences");
    assert.ok(!/data-sl="holder"[^>]*disabled/.test(ui.stateLicenceRowHtml({ state: "MA", kind: "construction_supervisor", number: "1", expires: "", holder: "" }, 1)));
  });
  await check("removing every row and saving clears the list (an explicit empty list is the operator's answer)", () => {
    clients.updateClient(db, keel.id, ui.withStateLicences({}, [], keel.id, keel.id));
    assert.deepEqual(clients.getClient(db, keel.id).stateLicenses, []);
  });
}

db.close();
console.log(failures ? `\nlicencesByType: ${failures} FAILED, ${passed} passed` : `\nlicencesByType: all ${passed} checks passed — one answer per slot by kind, state, track and company; Oregon unchanged; no company's licence on another's job`);
process.exit(failures ? 1 : 0);
