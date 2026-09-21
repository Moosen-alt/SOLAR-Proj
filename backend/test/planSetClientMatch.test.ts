// THE COMPANY IS PRINTED ON THE PLAN SET, AND NOTHING WAS READING IT ONTO THE PROJECT.
//
// The operator's idea, in their words: "Most plansets have the company name on the top of
// them. Could we use that as a way to have them submitting. Then it auto assigns them to
// the right company as they come in?" Their handwritten notes ask for it from the other
// side: "Need to make company locked parse — don't have them select it themselves."
//
// The parser prompt has read the title-block contractor for a long time (llm.ts, the
// "CLIENT ONBOARDING" block) and thrown it away at the browser: applyExtraction pushed it
// into a review-flag sentence and it never reached the backend. Round C then made clientId
// REQUIRED at creation. This round is what makes that requirement painless instead of a
// chore — and what this file refuses to let regress.
//
// ---------------------------------------------------------------------------------------
// WHAT THE REAL PLAN SETS ACTUALLY CARRY — MEASURED, NOT ASSUMED
//
// Corpus: the operator's drive, L:/INFINITY SOLAR DOCS/01 - CUSTOMERS. Ten customer plan
// sets sampled (Abby Johnson, Abigail Boileau, Andrae Snegirev, Anthony Aletto, Arturo
// Olguin-Ovalle, Bilal Hilowle, Bren Trask, Brian Bartley, Brittany Reavis, Connie
// Rhinesmith), plus a full sweep of all 23 pages of
// "Bren Trask - Portland, OR/Bren Trask - Portland, OR.pdf".
//
// Every one of the ten prints the same title block and NONE of them prints a CCB number:
//
//     INFINITY HOME SOLUTIONS 6405 E MILL PLAIN VANCOUVER WA 98661
//     PHONE: 1-800-818-0598  INFINITY SOLAR.COM
//
// So the premise "Oregon plan sets print the contractor's CCB in the title block" is FALSE
// for this operator's corpus. A CCB-first-name-second resolver would have matched nothing,
// ever, on any of their 102 customer folders.
//
// Worse: the printed name scores ZERO against BOTH names on the only client on file. The
// live row is company_name "TML INTERNATIONAL LLC", dba "Infinity Solar USA"; one shared
// token out of three-vs-three clears no band in knowledgeNameMatchScore. Section 1 asserts
// that zero rather than describing it, because it is the measurement that justifies the
// phone leg — without it this round would have shipped green and been a measured no-op on
// 100% of the corpus it exists for.
//
// The FIXTURE ITSELF IS THE LIVE SHAPE: the extraction block in section 1 is the verbatim
// response from one real `extractProjectFields` call through this repo's own Claude
// provider against that Trask plan set's extracted text — values, confidences and evidence
// excerpts copied as returned. What it returned was a company name, an address and a
// phone; no contractorCcb key at all.
//
// ---------------------------------------------------------------------------------------
// THE RULE THIS FILE GUARDS
//
//   exact CCB on exactly one client   -> AUTO-ASSIGN, no prompt
//   exact phone, or a strong name     -> PRE-SELECT, evidence shown, HUMAN CONFIRMS
//   weak, or two plausible companies  -> show candidates, ASSIGN NOTHING
//   nothing                           -> offer to onboard the extracted company
//
// A phone number is exact but it is not a licence: it identifies whoever answers it this
// year, not a contractor in a state registry. So it pre-selects and never binds. The
// machine-checkable form of that rule is `requiresConfirmation === false` ONLY for
// auto_assign, asserted across every decision in section 9.
//
// THE REFUSALS ARE WEIGHTED AS HEAVILY AS THE MATCHES, because the live DB has exactly ONE
// client and all 16 projects bind to it — a happy-path match proves almost nothing here.
// Sections 3, 4, 6, 7 and 8 are the refusals, and section 3 (a second company with a
// similar name and a different CCB) is the one the whole feature risks getting wrong.
//
// LICENCE NUMBERS ARE NOT INTERCHANGEABLE. `clients` carries ccb_license_number,
// electrical_license_number and metro_city_license_number, and the live row carries all
// three (223690 / C1556 / 14838). This module compares plan-set CCB against
// ccb_license_number and NOTHING else — section 4 builds a client whose ELECTRICAL licence
// is another company's CCB digits and proves it is not chosen.
//
//   npx tsx backend/test/planSetClientMatch.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-set-client-match-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.SEED_TEST_INSTALLER = "false"; // the seeded TML installer would forge section 1's match
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { knowledgeNameMatchScore } = await import("../src/knowledgeBase");
const {
  resolveClientFromPlanSet,
  resolveClientForExtraction,
  installerIdentityFromExtraction,
  normalizeLicence,
  normalizePhone,
} = await import("../src/clientMatch");
type ParserExtractedField = import("../../shared/src/types").ParserExtractedField;
type PlanSetInstallerIdentity = import("../../shared/src/types").PlanSetInstallerIdentity;
type ClientResolution = import("../../shared/src/types").ClientResolution;

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ===========================================================================
// FIXTURE CLIENTS — created through the REAL write path (createClient), never raw SQL.
// ===========================================================================

// The live row, field for field (backend/data/autopilot.sqlite, the only client on file).
const TML = createClient(db, {
  companyName: "TML INTERNATIONAL LLC",
  legalBusinessName: "TML INTERNATIONAL LLC",
  dba: "Infinity Solar USA",
  ccbLicenseNumber: "223690",
  electricalLicenseNumber: "C1556",
  metroCityLicenseNumber: "14838",
  electricianLicenseNumber: "5787S",
  businessPhone: "(800) 818-0598",
  businessEmail: "permit@infinitysolarusa.com",
  businessCity: "Vancouver",
  businessState: "WA",
});

// THE COMPANY THE LIVE DB CANNOT SUPPLY, and the entire risk of this feature: a second
// solar contractor whose name reads almost the same and whose CCB is somebody else's.
const TML_SOLAR = createClient(db, {
  companyName: "TML International Solar LLC",
  legalBusinessName: "TML International Solar LLC",
  ccbLicenseNumber: "999123",
  businessPhone: "(503) 555-0199",
});

// A name-only client: nothing exact to match on, so only the name leg can reach it.
const SUNRISE = createClient(db, {
  companyName: "Sunrise Electric Company",
  legalBusinessName: "Sunrise Electric Company",
});

// Two companies sharing one phone line — an answering service, an acquisition, a typo.
const CASCADE_A = createClient(db, {
  companyName: "Cascade Solar Co",
  legalBusinessName: "Cascade Solar Co",
  businessPhone: "(503) 555-0142",
});
const CASCADE_B = createClient(db, {
  companyName: "Cascade Solar Services LLC",
  legalBusinessName: "Cascade Solar Services LLC",
  businessPhone: "503.555.0142",
});

// THE CROSS-FIELD TRAP: this company's ELECTRICAL licence is TML's CCB number, digit for
// digit, and its name is an exact string match for the plan set in section 4. Its own CCB
// is a different number. If an electrical licence could ever satisfy a CCB test, this row
// would steal TML's jobs.
const VOLT = createClient(db, {
  companyName: "Volt Brothers Electric LLC",
  legalBusinessName: "Volt Brothers Electric LLC",
  ccbLicenseNumber: "310999",
  electricalLicenseNumber: "223690",
});

// A second tenant holding the SAME CCB. Tenant data never crosses orgs.
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [
  "org-tenant-b", "Tenant B", "full", new Date().toISOString(),
]);
const OTHER_ORG_CLIENT = createClient(db, {
  companyName: "TML INTERNATIONAL LLC",
  legalBusinessName: "TML INTERNATIONAL LLC",
  ccbLicenseNumber: "223690",
  businessPhone: "(800) 818-0598",
}, "org-tenant-b");

const DEFAULT_ORG = "org-default";
const resolve = (identity: PlanSetInstallerIdentity, orgId: string | null = DEFAULT_ORG): ClientResolution =>
  resolveClientFromPlanSet(db, identity, orgId);

const everyResolution: ClientResolution[] = [];
const record = (r: ClientResolution): ClientResolution => { everyResolution.push(r); return r; };

// ===========================================================================
// 1. THE LIVE SHAPE — a real plan set, a real extraction, and the measured gap.
// ===========================================================================
console.log("\n1. THE LIVE SHAPE (Bren Trask - Portland, OR.pdf, one real extraction)");

// Verbatim from one live `extractProjectFields` call against that plan set's text.
const TRASK_EXTRACTION: Record<string, ParserExtractedField> = {
  contractorCompany: {
    value: "Infinity Home Solutions",
    confidence: 0.92,
    evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "INFINITY HOME SOLUTIONS 6405 E MILL PLAIN VANCOUVER WA 98661" },
  },
  contractorAddress: {
    value: "6405 E Mill Plain, Vancouver, WA 98661",
    confidence: 0.9,
    evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "6405 E MILL PLAIN VANCOUVER WA 98661" },
  },
  contractorPhone: {
    value: "1-800-818-0598",
    confidence: 0.9,
    evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "PHONE: 1-800-818-0598 INFINITY SOLAR.COM" },
  },
  // The homeowner's own details ride in the SAME extraction. They must never become a
  // company identity — the plan set is full of PII and only the installer block is read.
  owner: { value: "Bren Trask", confidence: 0.95 },
  homeownerPhone: { value: "(503) 555-0101", confidence: 0.8 },
  street: { value: "11739 SE Reedway St", confidence: 0.95 },
};

const traskIdentity = installerIdentityFromExtraction(TRASK_EXTRACTION);

check("the real plan set carries a company, an address and a phone — and NO CCB", () => {
  assert.equal(traskIdentity.companyName, "Infinity Home Solutions");
  assert.equal(traskIdentity.phone, "1-800-818-0598");
  assert.equal(traskIdentity.address, "6405 E Mill Plain, Vancouver, WA 98661");
  assert.equal(traskIdentity.ccbLicenseNumber, undefined,
    "a CCB appeared on a plan set that has none — the fixture has drifted off the live shape");
});

check("the homeowner's name and phone never become the installer's identity", () => {
  assert.notEqual(traskIdentity.companyName, "Bren Trask");
  assert.notEqual(traskIdentity.phone, "(503) 555-0101");
  assert.equal(normalizePhone(traskIdentity.phone), "8008180598");
});

check("THE MEASUREMENT: the printed name scores ZERO against both of the client's names", () => {
  // If this ever becomes non-zero the name leg alone would carry the real corpus and the
  // phone leg could be reconsidered. Until then, name-only would be a no-op here.
  assert.equal(knowledgeNameMatchScore("Infinity Home Solutions", "TML INTERNATIONAL LLC"), 0);
  assert.equal(knowledgeNameMatchScore("Infinity Home Solutions", "Infinity Solar USA"), 0);
});

check("the real plan set PRE-SELECTS the real client on its phone, and asks for confirmation", () => {
  const r = record(resolveClientForExtraction(db, TRASK_EXTRACTION, DEFAULT_ORG));
  assert.equal(r.decision, "preselect");
  assert.equal(r.clientId, TML.id);
  assert.equal(r.requiresConfirmation, true, "a phone match must never bind without a human");
  const phone = r.candidates[0].evidence.find((e) => e.kind === "phone");
  assert.ok(phone, "the decision carries no phone evidence — an operator cannot see why");
  assert.equal(phone!.clientField, "business_phone");
  assert.equal(phone!.planSetValue, "1-800-818-0598");
  assert.equal(phone!.clientValue, "(800) 818-0598");
  assert.match(r.explanation, /confirm/i);
  assert.ok(!r.candidates[0].evidence.some((e) => e.kind === "name"),
    "a name leg fired on a pair that scores zero");
});

// ===========================================================================
// 2. EXACT CCB -> AUTO-ASSIGN, with its evidence.
// ===========================================================================
console.log("\n2. EXACT CCB MATCH");

check("a CCB printed on the plan set assigns the client outright, no prompt", () => {
  const r = record(resolve({ companyName: "Infinity Home Solutions", ccbLicenseNumber: "CCB# 223690" }));
  assert.equal(r.decision, "auto_assign");
  assert.equal(r.clientId, TML.id);
  assert.equal(r.requiresConfirmation, false);
  const ccb = r.candidates[0].evidence.find((e) => e.kind === "ccb");
  assert.ok(ccb, "the auto-assign carries no evidence — a reviewer cannot disagree with it");
  assert.equal(ccb!.clientField, "ccb_license_number");
  assert.equal(ccb!.clientValue, "223690");
  assert.equal(ccb!.score, 100);
  assert.match(r.explanation, /TML INTERNATIONAL LLC/);
});

check("the CCB label and its punctuation are not part of the number", () => {
  for (const printed of ["223690", "CCB 223690", "CCB# 223690", "ccb #223690", "CCB-223690"]) {
    assert.equal(normalizeLicence(printed), "223690", `"${printed}" did not normalise`);
    const r = resolve({ companyName: "Anything At All", ccbLicenseNumber: printed });
    assert.equal(r.decision, "auto_assign", `"${printed}" failed to match`);
    assert.equal(r.clientId, TML.id);
  }
});

check("a CCB match beats a perfect name match on a DIFFERENT company", () => {
  // The name is an exact string match for TML_SOLAR; the CCB belongs to TML.
  const r = record(resolve({ companyName: "TML International Solar LLC", ccbLicenseNumber: "223690" }));
  assert.equal(r.decision, "auto_assign");
  assert.equal(r.clientId, TML.id, "the name out-voted the licence — a filing under the wrong CCB");
  assert.ok(!r.candidates.some((c) => c.clientId === TML_SOLAR.id),
    "the contradicted company is still offered as a candidate");
});

// ===========================================================================
// 3. THE REFUSAL THAT MATTERS: a similarly-named company with a DIFFERENT CCB.
// ===========================================================================
console.log("\n3. SIMILAR NAME, DIFFERENT CCB — THE REFUSAL");

check("a plan-set CCB held by NOBODY assigns nothing, however well the name reads", () => {
  // "TML International Solar LLC" is an exact name match for TML_SOLAR (100) and a 70 on
  // TML. Both are disqualified: neither holds CCB 555000.
  assert.equal(knowledgeNameMatchScore("TML International Solar LLC", "TML International Solar LLC"), 100);
  const r = record(resolve({ companyName: "TML International Solar LLC", ccbLicenseNumber: "555000" }));
  assert.equal(r.decision, "none", "a company with somebody else's licence number was matched anyway");
  assert.equal(r.clientId, null);
  assert.deepEqual(r.candidates, [], "a contradicted licence still produced candidates");
});

check("a contradicted CCB disqualifies the client even when the phone also matches", () => {
  // Everything about this says TML — the real phone, the real name — except the licence.
  const r = record(resolve({
    companyName: "TML INTERNATIONAL LLC",
    ccbLicenseNumber: "999123",
    phone: "1-800-818-0598",
  }));
  assert.notEqual(r.clientId, TML.id, "an exact-but-wrong licence lost to the phone and the name");
  assert.equal(r.decision, "auto_assign");
  assert.equal(r.clientId, TML_SOLAR.id, "the company that actually holds CCB 999123 was not chosen");
});

check("a strong name with no CCB PRE-SELECTS and shows the near-miss, it does not bind", () => {
  const r = record(resolve({ companyName: "TML INTERNATIONAL LLC" }));
  assert.equal(r.decision, "preselect");
  assert.equal(r.clientId, TML.id);
  assert.equal(r.requiresConfirmation, true, "a name match bound a client with no human in the loop");
  const name = r.candidates[0].evidence.find((e) => e.kind === "name");
  assert.equal(name!.score, 100);
  assert.equal(name!.clientField, "company_name");
  assert.ok(r.candidates.some((c) => c.clientId === TML_SOLAR.id),
    "the similarly-named second company was hidden from the operator");
});

// ===========================================================================
// 4. LICENCE NUMBERS ARE NOT INTERCHANGEABLE.
// ===========================================================================
console.log("\n4. LICENCE FIELD DISCIPLINE");

check("a client whose ELECTRICAL licence is another company's CCB is not chosen by it", () => {
  // VOLT's name matches exactly (100) and its electrical_license_number is literally
  // "223690". The plan set prints CCB 223690, which TML holds.
  const r = record(resolve({ companyName: "Volt Brothers Electric LLC", ccbLicenseNumber: "223690" }));
  assert.equal(r.clientId, TML.id, "an electrical licence satisfied a CCB test");
  assert.equal(r.decision, "auto_assign");
  assert.ok(!r.candidates.some((c) => c.clientId === VOLT.id),
    "the company with the colliding electrical licence is still a candidate");
});

check("an electrical licence on the plan set is not a matching key at all", () => {
  // Through the REAL mapper, not a hand-built identity: the bug this guards against is a
  // non-CCB licence being carried INTO the ccb slot, which a pre-built identity hides.
  // (An earlier version of this check called the resolver directly and a mutation that
  // mapped contractorElectricalLicense onto ccbLicenseNumber sailed straight through it.)
  const r = record(resolveClientForExtraction(db, {
    contractorCompany: { value: "Nothing Alike Energy", confidence: 0.9 },
    contractorElectricalLicense: { value: "223690", confidence: 0.9 },   // TML's CCB digits
    contractorMetroCityLicense: { value: "14838", confidence: 0.9 },     // TML's metro licence
    contractorElectricianLicense: { value: "5787S", confidence: 0.9 },   // a PERSON, not a company
  }, DEFAULT_ORG));
  assert.equal(r.installer.ccbLicenseNumber, undefined,
    "a non-CCB licence number was carried into the CCB slot");
  assert.equal(r.installer.electricalLicenseNumber, "223690");
  assert.equal(r.decision, "none", "a non-CCB licence number matched a client");
  assert.equal(r.clientId, null);
  assert.deepEqual(r.candidates, []);
});

check("every licence evidence entry names ccb_license_number and nothing else", () => {
  for (const r of everyResolution) {
    for (const c of r.candidates) {
      for (const e of c.evidence) {
        if (e.kind === "ccb") {
          assert.equal(e.clientField, "ccb_license_number",
            `a ccb match reported field ${e.clientField}`);
        }
      }
    }
  }
});

// ===========================================================================
// 5. NAME-ONLY STRONG MATCH -> PRE-SELECTED, NOT BOUND.
// ===========================================================================
console.log("\n5. NAME-ONLY STRONG MATCH");

check("a strong name and nothing else pre-selects, with the score in the evidence", () => {
  assert.equal(knowledgeNameMatchScore("Sunrise Electric", "Sunrise Electric Company"), 82);
  const r = record(resolve({ companyName: "Sunrise Electric" }));
  assert.equal(r.decision, "preselect");
  assert.equal(r.clientId, SUNRISE.id);
  assert.equal(r.requiresConfirmation, true);
  assert.equal(r.candidates[0].evidence[0].kind, "name");
  assert.equal(r.candidates[0].evidence[0].score, 82);
  assert.equal(r.candidates[0].evidence[0].planSetValue, "Sunrise Electric");
  assert.equal(r.candidates[0].evidence[0].clientValue, "Sunrise Electric Company");
});

// ===========================================================================
// 6. TWO PLAUSIBLE CANDIDATES -> NOTHING ASSIGNED, BOTH SHOWN.
// ===========================================================================
console.log("\n6. AMBIGUITY");

check("two companies on one phone line assign nothing and are both shown", () => {
  const r = record(resolve({ companyName: "Cascade Solar", phone: "(503) 555-0142" }));
  assert.equal(r.decision, "candidates");
  assert.equal(r.clientId, null, "an ambiguous match still bound a client");
  assert.equal(r.requiresConfirmation, true);
  const ids = r.candidates.map((c) => c.clientId).sort();
  assert.deepEqual(ids, [CASCADE_A.id, CASCADE_B.id].sort());
  for (const c of r.candidates) assert.ok(c.reason.length > 0, "a candidate was shown with no reason");
});

check("a weak partial name assigns nothing but still shows who it partly matched", () => {
  // 70 — meaningful-token overlap ("volt","brothers" out of three), below the strong band.
  // A roofing company that shares two words with an electrical contractor is exactly the
  // shape that must be shown and never bound, even as the ONLY candidate.
  assert.equal(knowledgeNameMatchScore("Volt Brothers Roofing", "Volt Brothers Electric LLC"), 70);
  const r = record(resolve({ companyName: "Volt Brothers Roofing" }));
  assert.equal(r.decision, "candidates");
  assert.equal(r.clientId, null, "a weak name match bound a client");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].clientId, VOLT.id);
  assert.equal(r.candidates[0].strong, false, "a 70 was marked strong");
  assert.equal(r.candidates[0].evidence[0].score, 70);
});

// ===========================================================================
// 7. NO COMPANY, AND NO MATCH — the picker is simply required, as Round C left it.
// ===========================================================================
console.log("\n7. NOTHING TO GO ON");

check("a plan set that names no installer suggests nothing and names no client", () => {
  const r = record(resolve({}));
  assert.equal(r.decision, "none");
  assert.equal(r.clientId, null);
  assert.deepEqual(r.candidates, []);
  assert.ok(!r.explanation.includes("TML"), "the explanation named a client it did not match");
  assert.match(r.explanation, /pick the client/i);
});

check("an unknown company does NOT get pre-assigned just because clients exist", () => {
  // The live DB has ONE client and 16 projects on it, so "the only candidate" is a trap.
  const r = record(resolve({ companyName: "Zephyr Roofing & Solar Inc", phone: "(971) 555-0000" }));
  assert.equal(r.decision, "none", "an unrelated company was matched to an existing client");
  assert.equal(r.clientId, null);
  assert.deepEqual(r.candidates, []);
  assert.match(r.explanation, /Zephyr Roofing & Solar Inc/);
});

check("the no-match door carries the extracted details for onboarding", () => {
  const r = record(resolveClientForExtraction(db, {
    contractorCompany: { value: "Zephyr Roofing & Solar Inc", confidence: 0.9 },
    contractorPhone: { value: "(971) 555-0000", confidence: 0.9 },
    contractorAddress: { value: "88 NW Zephyr Way, Bend, OR 97701", confidence: 0.8 },
    contractorCcb: { value: "", confidence: 0.9 },
  }, DEFAULT_ORG));
  assert.equal(r.decision, "none");
  assert.equal(r.installer.companyName, "Zephyr Roofing & Solar Inc");
  assert.equal(r.installer.phone, "(971) 555-0000");
  assert.equal(r.installer.address, "88 NW Zephyr Way, Bend, OR 97701");
  assert.equal(r.installer.ccbLicenseNumber, undefined, "an empty CCB became a value");
});

check("a value the model flagged as low confidence is not used as an identity", () => {
  const r = record(resolveClientForExtraction(db, {
    contractorCompany: { value: "TML INTERNATIONAL LLC", confidence: 0.2 },
    contractorCcb: { value: "223690", confidence: 0.1 },
  }, DEFAULT_ORG));
  assert.equal(r.decision, "none", "a 0.1-confidence CCB auto-assigned a client");
  assert.equal(r.clientId, null);
});

// ===========================================================================
// 8. TENANCY — a company suggestion must never reach across orgs.
// ===========================================================================
console.log("\n8. TENANCY");

check("an exact CCB on ANOTHER org's client is invisible to this org", () => {
  const r = record(resolve({ companyName: "TML INTERNATIONAL LLC", ccbLicenseNumber: "223690" }, "org-tenant-b"));
  assert.equal(r.clientId, OTHER_ORG_CLIENT.id, "tenant B could not reach its own client");
  const fromDefault = record(resolve({ companyName: "TML INTERNATIONAL LLC", ccbLicenseNumber: "223690" }, DEFAULT_ORG));
  assert.equal(fromDefault.clientId, TML.id);
  assert.ok(!fromDefault.candidates.some((c) => c.clientId === OTHER_ORG_CLIENT.id),
    "another tenant's client was offered as a candidate — a cross-company data error");
});

check("reading across every org (null) refuses to auto-assign a shared CCB", () => {
  const r = record(resolve({ companyName: "TML INTERNATIONAL LLC", ccbLicenseNumber: "223690" }, null));
  assert.equal(r.decision, "candidates", "a superadmin read auto-assigned across two tenants");
  assert.equal(r.clientId, null);
  assert.ok(r.candidates.length >= 2);
});

// ===========================================================================
// 9. THE INVARIANT, ACROSS EVERY DECISION THIS FILE PRODUCED.
// ===========================================================================
console.log("\n9. INVARIANTS ACROSS EVERY DECISION");

check("only an exact CCB match may bind without confirmation", () => {
  assert.ok(everyResolution.length >= 15, `only ${everyResolution.length} decisions were exercised`);
  let autos = 0;
  for (const r of everyResolution) {
    if (r.requiresConfirmation === false) {
      autos++;
      assert.equal(r.decision, "auto_assign", `decision "${r.decision}" claimed it needs no confirmation`);
      const winner = r.candidates.find((c) => c.clientId === r.clientId);
      assert.ok(winner?.evidence.some((e) => e.kind === "ccb"),
        "a client was bound without a human on evidence that is not a CCB licence match");
    }
    if (r.decision === "candidates" || r.decision === "none") {
      assert.equal(r.clientId, null, `decision "${r.decision}" still carried a clientId`);
    }
    if (r.decision === "auto_assign" || r.decision === "preselect") {
      assert.ok(r.clientId, `decision "${r.decision}" carried no clientId`);
      assert.ok(r.candidates.some((c) => c.clientId === r.clientId),
        "the chosen client is absent from the candidate list, so its evidence is unreachable");
    }
    for (const c of r.candidates) {
      assert.ok(c.evidence.length > 0, "a candidate was produced with no evidence at all");
    }
  }
  assert.ok(autos > 0, "no auto-assign was exercised — the invariant passed vacuously");
});

// ===========================================================================
// 10. PRODUCTION WIRING — a resolver nothing calls is the bug.
// ===========================================================================
console.log("\n10. PRODUCTION WIRING");

const server = fs.readFileSync(path.resolve(process.cwd(), "backend/src/server.ts"), "utf8");
const parser = fs.readFileSync(path.resolve(process.cwd(), "frontend/parser.html"), "utf8");

check("the resolver is called from the real parse route, org-scoped", () => {
  const route = server.slice(server.indexOf('app.post("/api/parser/llm-extract"'));
  const body = route.slice(0, route.indexOf("app.post(", 10));
  assert.match(body, /resolveClientForExtraction\(/,
    "the parse route does not call the resolver — it has no production caller");
  assert.match(body, /reqOrgFilter\(db, req\)/,
    "the resolver is called without the request's org filter — another tenant's client could be suggested");
  assert.match(body, /clientResolution/);
});

check("no NEW top-level /api path was added for this (Round 6 deny-by-default)", () => {
  assert.ok(!/app\.(get|post|put|delete)\("\/api\/client-match/.test(server),
    "a new top-level route appeared — it must be scoped or justified in routeScope.test.ts");
  assert.ok(!/app\.(get|post|put|delete)\("\/api\/plan-set/.test(server));
});

check("the parser page consumes the resolution and gates the save on confirmation", () => {
  assert.match(parser, /applyClientResolution\(/, "the parser page ignores the resolution");
  assert.match(parser, /t\.clientResolution/, "the resolution is never read off the parse response");
  assert.match(parser, /function pendingClientConfirmation\(/,
    "nothing gates the save on a suggestion the human has not confirmed");
  assert.match(parser, /if \(!existingId && pendingClientConfirmation\(clientId\)\) \{/,
    "saveToSystem no longer refuses an unconfirmed plan-set suggestion");
  // Round C's requirement is untouched: a new project still needs a client, both in the
  // gate and in the save path.
  assert.match(parser, /const blocked = missing \|\| unconfirmed/);
  assert.match(parser, /if \(!existingId && !clientId\) \{/);
  // THE ENFORCEMENT, NOT THE COMMENT ABOVE IT. This asserted the presence of the
  // "A PROJECT MAY NOT BE BORN WITHOUT A CLIENT" comment, which survives the deletion
  // of the code it describes: removing the whole guard left this check green. Read the
  // create handler's own body instead, the way routeScope.test.ts does.
  const create = server.slice(server.indexOf('app.post("/api/projects"'));
  const createBody = create.slice(0, create.indexOf('app.put("/api/projects/:id"'));
  assert.match(createBody, /if \(!clientId\)[\s\S]{0,500}HttpError\(400/,
    "Round C's create-time client requirement is gone — the auto-assign fills that field, it must never become a second door around it");
});

check("nothing the model read out of a PDF is interpolated into innerHTML", () => {
  const start = parser.indexOf("function renderClientMatchPanel");
  const end = parser.indexOf("function splitInstallerAddress");
  assert.ok(start > 0 && end > start, "the client-match panel renderer moved or vanished");
  const panel = parser.slice(start, end);
  assert.ok(!/innerHTML/.test(panel),
    "the client-match panel writes innerHTML — plan-set text is LLM-read PDF content");
  assert.match(panel, /textContent/);
});

console.log(failures === 0 ? "\nplanSetClientMatch: all checks passed" : `\nplanSetClientMatch: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
