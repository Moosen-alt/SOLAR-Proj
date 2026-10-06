// B8(c)/(d): the gate answers "which process applies?" with the packet's own predicate, and the
// boilerplate reminders (final preview, installer scope confirmation, the prescriptive upload note,
// locates on a job with no digging) are the SUBMIT CHECKLIST, not findings against this project.
//
// KILL TESTS (verified red by hand):
//   K1 reviewerEngine: keep the old "No seeded AHJ process profile matched" wording → (c1) fails.
//   K2 reviewerEngine: keep the boilerplate as findings                          → (d1) fails.
//   K3 reviewerEngine: the old locates regex                                     → (d2) fails.
//   K4 reviewerEngine: the old "no hand-verified … profile" / "(seeded, cited)" wording,
//      no sources, no code-record line (#217)                                   → (c1)-(c4) fail.
//
// Run: npx tsx backend/test/gateProcessAndBoilerplate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-boiler-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;
const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const pp = await import("../src/permitProcess");
const cp = await import("../src/codeProfiles");

let failures = 0;
const check = (name: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); } };
const report = (over: Record<string, string>) => {
  const p = repo.createProject(db, {
    owner: "Gate Owner", street: "9 Gate Rd", city: "Hollowmere", state: "OR", zip: "97352", ahj: "City of Hollowmere", utility: "Pacific Power",
    dcKw: "5", acKw: "4", roofMaterial: "Composition Shingle", locateCalloutText: "No excavation — roof mount only; no 811 callout appears.", ...over,
  } as never).project;
  return repo.buildReviewerReportFor(db, repo.getProjectDetail(db, p.id).project);
};
const titles = (r: ReturnType<typeof report>) => r.findings.map((f) => f.title);

check("(c1) MUST-PASS: an Oregon AHJ with no profile says the STATEWIDE profile was applied (a callout, not a warning)", () => {
  const r = report({});
  const f = r.findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.match(f.title, /^City of Hollowmere permit process \(who issues, single or separate permits, portal, forms\): Oregon statewide profile applied; no City of Hollowmere-specific process record \(per-job lookup found none\)$/);
  assert.equal(f.severity, "callout");
  assert.match(f.message, /Adopted code editions are a separate record \(jurisdiction code profile\)/);
});
check("(c2) MUST-EXCLUDE: outside Oregon, with no profile and no lookup, the warning stands", () => {
  const f = report({ state: "WA", zip: "98000", ahj: "City of Hollowmere WA" }).findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.equal(f.title, "City of Hollowmere WA permit process (who issues, single or separate permits, portal, forms): not in the shipped reference file and the per-job lookup found none");
  assert.equal(f.severity, "warning");
});
check("(c3) with a per-job lookup, the gate names it and its agency", () => {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Brightwater", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: "Marion County", sourceUrl: "https://example.gov/issuer", quote: "Marion County issues", origin: "lookup" },
    permitStructure: { value: "separate", sourceUrl: "https://example.gov/structure", quote: "separate electrical permit", origin: "lookup" },
    permits: [{
      discipline: "electrical", label: "Residential Electrical",
      issuingAgency: { value: "Marion County", sourceUrl: "https://example.gov/issuer", quote: "Marion County issues", origin: "lookup" },
      portalUrl: { value: "https://permits.example.gov", sourceUrl: "https://example.gov/apply", quote: "apply online", origin: "lookup" },
      recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup" },
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "no forms page" },
      fee: { value: null, sourceUrl: "", quote: "", origin: "lookup" },
    }] as never,
  });
  const f = report({ ahj: "City of Brightwater", city: "Brightwater" }).findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.equal(f.title, "City of Brightwater permit process (who issues, single or separate permits, portal, forms): per-job lookup found it (seeded, not yet verified); not in the shipped reference file");
  assert.doesNotMatch(f.title, /hand-verified|seeded, cited/);
  assert.match(f.message, /Issuing agency: Marion County \(source: https:\/\/example\.gov\/issuer\)\./);
  assert.match(f.message, /Permit structure: separate \(source: https:\/\/example\.gov\/structure\)\./);
  assert.match(f.message, /Residential Electrical portal: https:\/\/permits\.example\.gov \(source: https:\/\/example\.gov\/apply\)\./);
  assert.match(f.message, /Residential Electrical forms: not found\. Verify the 1 not-found item\(s\) before submittal\./);
});
check("(c4) #217: a VERIFIED code profile with no process profile is named as the separate record it is — never 'no hand-verified profile'", () => {
  cp.saveVerifiedCodeProfile(db, {
    key: "", state: "UT", ahj: "City of Saltmere", confidence: "verified", adoptedCodes: [{ code: "IRC", edition: "2021" }], amendments: [],
    designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [{ label: "Saltmere building code page", sourceUrl: "https://example.gov/codes" }], updatedAt: "",
  } as never, "op@test");
  pp.savePermitProcessLookup(db, {
    state: "UT", ahj: "City of Saltmere", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: "City of Saltmere", sourceUrl: "https://example.gov/saltmere", quote: "the City issues", origin: "lookup" },
    permitStructure: { value: "combo", sourceUrl: "https://example.gov/saltmere", quote: "one permit", origin: "lookup" }, permits: [],
  });
  const f = report({ state: "UT", zip: "84000", ahj: "City of Saltmere", city: "Saltmere", utility: "Rocky Mountain Power" }).findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.doesNotMatch(f.title, /hand-verified/);
  assert.match(f.title, /permit process .*per-job lookup found it \(seeded, not yet verified\)/);
  assert.match(f.message, /Adopted code editions are a separate record \(jurisdiction code profile\): verified \(City of Saltmere's code profile\); verifying it does not clear this finding\./);
  assert.match(f.message, /source: https:\/\/example\.gov\/saltmere/);
});
check("(d1) MUST-EXCLUDE: final-preview / installer-scope / prescriptive-upload reminders are not findings — they are on the submit checklist", () => {
  const r = report({});
  for (const t of ["Final AHJ preview is required", "Installer pre-submittal scope confirmation", "Prescriptive path"]) assert.ok(!titles(r).includes(t), `${t} is still a finding`);
  const reqs = r.finalSubmitGate.requirements.join(" | ");
  assert.match(reqs, /Final AHJ preview/);
  assert.match(reqs, /Installer pre-submittal scope confirmation/);
  assert.equal(r.finalSubmitGate.finalSubmitButtonAloneIsEnough, false);
});
check("(d2) MUST-EXCLUDE: 'No excavation — roof mount only' is not a locates finding; real digging still is", () => {
  assert.ok(!titles(report({})).includes("Locates/utility coordination"));
  assert.ok(titles(report({ locateCalloutText: "Trench 40 ft from array to MSP; call 811 before digging." })).includes("Locates/utility coordination"));
});

check("(u1) the module listing read from the datasheet's IMAGE counts as package evidence; without it the module listing is asked for", () => {
  const listingMsg = (r: ReturnType<typeof report>) => r.findings.filter((f) => /UL listing/.test(f.title)).map((f) => f.message).join(" ");
  assert.match(listingMsg(report({})), /module listing \(UL 61730 or UL 1703\)/, "MUST-PASS: nothing read → asked for");
  const read = report({ moduleListingAgency: "UL", moduleListingAgencyEvidence: "module datasheet (vision read): UL 61730-1 & UL 61730-2" });
  assert.doesNotMatch(listingMsg(read), /module listing \(UL 61730 or UL 1703\)/, "the datasheet's own printed marks were read");
});

if (failures) { console.error(`\n${failures} gate check(s) failed.`); process.exit(1); }
console.log("\nAll gate process/boilerplate checks passed.");
process.exit(0);
