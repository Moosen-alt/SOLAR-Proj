// CITY OF SARATOGA SPRINGS, UT — SHIPPED SEED (issue #228).
//
// Owner request 2026-10-06 ("we need to revise Saratoga Springs; not the /201/Building page"): the
// shipped reference data had NO Saratoga Springs entry, so every new install (and any re-research)
// started from nothing — the generic Building landing page as the source, a retired solar PDF to
// chase, design criteria "unknown". Two seeded rows now ship:
//   - backend/data/reference-ahj-processes.json: the city's process (CityWorks Public Access portal,
//     paperless, no solar-specific blank; the retired solar application ids recorded so the form
//     search does not re-chase them; plans + specifications cited to /220);
//   - backend/data/reference-code-profiles.json: the AHJ row (Title 18 editions, the IFC 2018/2024
//     conflict resolved by the state statute, /213 design criteria).
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   S1 boot seeds both rows SEEDED (never verified) and cited to the city's own pages;
//   S2 hard rule 3: a person's VERIFIED row under the same key (`ut|city of saratoga springs|unknown`
//      in the KB and the code-profile table; `ut|city of saratoga springs` in the process lookups) is
//      left untouched by the seed — byte for byte;
//   S3 (utahCodeLookupE2e-style) a second project in the city runs no code or design-criteria
//      research, and its Required document set names the portal as the channel with no blocking
//      application blank and no "which application is unknown" hold.
// Synthetic projects only ("1 Example Way"); no model is ever called.
//
//   npx tsx backend/test/saratogaSpringsSeed.test.ts
import { REPO } from "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AhjProcessProfile, JurisdictionCodeProfile } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saratoga-springs-seed-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "PERMIT_PROCESS_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const KB = await import("../src/knowledgeBase");
const { enqueueJob } = await import("../src/jobQueue");
const { getPermitProcessLookup, savePermitProcessLookup } = await import("../src/permitProcess");
const { lookupRequiredList, documentInventory } = await import("../src/requiredDocuments");
const { findAhjProcessProfile } = await import("../src/processProfiles");
const { getSubmittalTracks, channelKindOf } = await import("../src/submittalTracks");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const ST = "UT";
const AHJ = "City of Saratoga Springs";
const KEY = "ut|city of saratoga springs|unknown";
const PROCESS_KEY = "ut|city of saratoga springs";
const CITY_HOST = /(^|\.)saratogasprings-ut\.gov$/;
const STATE_HOST = /^le\.utah\.gov$/;

const processFile = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8")) as { profiles: AhjProcessProfile[] };
const codeFile = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-code-profiles.json"), "utf8")) as { profiles: JurisdictionCodeProfile[] };
const procRow = processFile.profiles.find((p) => p.state === ST && p.ahj === AHJ);
const codeRow = codeFile.profiles.find((p) => p.state === ST && p.ahj === AHJ);

// ─── the shipped data itself ─────────────────────────────────────────────────────────────────────
await check("reference: one seeded Saratoga Springs process row — portal channel, no solar blank, retired ids noted, cited", () => {
  assert.ok(procRow, "no City of Saratoga Springs row in reference-ahj-processes.json");
  assert.match(procRow!.sourceSheet, /seeded/i);
  assert.match(procRow!.reviewerNotes, /NOT verified/);
  assert.match(procRow!.submissionMethod, /CityWorks Public Access portal/i);
  assert.doesNotMatch(procRow!.submissionMethod, /https?:\/\//i, "hard rule 5: a bare URL is not the method");
  // No PDF blank expected: no application flag for the gate or the form search to demand.
  assert.equal(procRow!.requiresBuildingPermitApplication, false);
  assert.equal(procRow!.requiresElectricalPermitApplication, false);
  assert.equal(procRow!.requiresSolarChecklist, false);
  for (const id of ["View/152", "View/12292"]) assert.ok(procRow!.otherRequirements.includes(id) && procRow!.reviewerNotes.includes(id), `retired solar application ${id} recorded`);
  assert.match(procRow!.otherRequirements, /View\/8000\)?: a scanned image PDF/, "the generic blank is recorded as scanned");
  const d = procRow!.documents!;
  assert.equal(d.observedAt, "2026-10-06");
  assert.match(new URL(d.sourceUrl).hostname, CITY_HOST);
  assert.ok(d.items.length > 0 && d.quote.length >= 20);
  for (const u of procRow!.reviewerNotes.match(/https:\/\/[^\s;]+/g) ?? []) assert.match(new URL(u).hostname, CITY_HOST, u);
  assert.doesNotMatch(JSON.stringify(procRow), /\/201\/Building"/, "the generic landing page is never the documents source");
});

await check("reference: one seeded AHJ code row — Title 18 editions, IFC conflict resolved by 15A-5-103, /213 criteria", () => {
  assert.ok(codeRow, "no City of Saratoga Springs row in reference-code-profiles.json");
  assert.equal(codeRow!.confidence, "seeded");
  const ed = (code: string) => codeRow!.adoptedCodes.find((c) => c.code === code)?.edition;
  assert.deepEqual([ed("IBC"), ed("IRC"), ed("NEC"), ed("IECC"), ed("IFC")], ["2024", "2021", "2023", "2024", "2024"]);
  for (const c of codeRow!.adoptedCodes) {
    assert.match(new URL(c.sourceUrl!).hostname, CITY_HOST, `${c.code} cites the city's Title 18`);
    assert.ok((c.quote ?? "").length > 20, `${c.code} quotes Title 18`);
  }
  const ifc = codeRow!.adoptedCodes.find((c) => c.code === "IFC")!;
  assert.match(ifc.notes ?? "", /2018 Edition/);
  assert.match(ifc.notes ?? "", /15A-5-103/);
  assert.deepEqual(
    { ...codeRow!.designCriteria, sourceUrl: undefined },
    { groundSnowLoadPsf: 31, windSpeedMph: 103, seismicDesignCategory: "D2", frostDepthIn: 30, sourceUrl: undefined },
  );
  assert.match(codeRow!.designCriteria.sourceUrl ?? "", /\/213\/Design-Criteria$/);
  assert.ok(codeRow!.citations.some((c) => /103 \[51\]/.test(c.label)), "the wind value is recorded verbatim with its note");
  for (const c of codeRow!.citations) assert.match(new URL(c.sourceUrl).hostname, new RegExp(`${CITY_HOST.source}|${STATE_HOST.source}`));
});

// ─── S1: boot seeds both, seeded ─────────────────────────────────────────────────────────────────
await check("S1: boot seeds the code row SEEDED with the /213 criteria, the KB row SEEDED, the cited checklist SEEDED", () => {
  const own = CP.ownCodeProfileRow(db, ST, AHJ);
  assert.ok(own, "boot did not seed the AHJ code row");
  assert.equal(own!.key, KEY);
  assert.equal(own!.profile.confidence, "seeded");
  assert.equal(own!.profile.designCriteria.groundSnowLoadPsf, 31);
  assert.equal(own!.profile.designCriteria.windSpeedMph, 103);
  const kb = KB.findKnowledgeForLearn(db, { state: ST, ahj: AHJ }).ahj;
  assert.ok(kb, "no KB row");
  assert.equal(kb!.confidence, "seeded");
  assert.ok(!kb!.verifiedAt);
  assert.match(kb!.portalName, /CityWorks Public Access portal/i);
  const lk = getPermitProcessLookup(db, ST, AHJ)!;
  assert.ok(lk, "no seeded permit-process lookup");
  assert.equal(lk.confidence, "seeded");
  const got = lookupRequiredList({ state: ST, ahj: AHJ });
  assert.deepEqual(got.items, procRow!.documents!.items);
  assert.equal(got.sourceUrl, procRow!.documents!.sourceUrl);
});

// ─── S3: a second project in the city — no research; the portal is the channel; no blank hold ────
// Enqueue WITHOUT the worker's instant kick: nothing runs on its own, nothing reaches the network.
const queued: string[] = [];
CP.setCodeResearchEnqueuerForTests((d, payload) => { queued.push(`code_research:${JSON.stringify(payload)}`); enqueueJob(d, "code_research", payload as never, { scheduledAt: new Date().toISOString() }); });
CP.setDesignResearchEnqueuerForTests((d, payload) => { queued.push(`design_criteria_research:${JSON.stringify(payload)}`); enqueueJob(d, "design_criteria_research", payload, { scheduledAt: new Date().toISOString() }); });
const newProject = (n: number): string => {
  const id = R.createProject(db, {
    owner: `Synthetic Homeowner ${n}`, state: ST, dcKw: "8.4", acKw: "7.7", street: `${n} Example Way`, city: "Saratoga Springs", zip: "84000",
    ahj: AHJ, utility: "Example Utility",
  } as never).project.id;
  db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [id]);
  return id;
};
const researchJobs = (): number => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE job_type IN ('code_research','design_criteria_research')")?.n ?? 0);

await check("S3: neither project's first gate queues code or design-criteria research (the seed answered it)", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called"; // research is queued only with a key
  try {
    CP.resetResearchMarkersForTests();
    assert.equal(CP.codeResearchDecision(db, ST, AHJ).action, "skip", "the AHJ's codes are re-researched");
    for (const n of [1, 2]) {
      const pid = newProject(n);
      const report = R.getReviewerReport(db, pid);
      assert.ok(report, `project ${n}: a gate ran`);
      const unknown = report.findings.find((f) => f.id === "city.struct.design-criteria-unknown");
      assert.doesNotMatch(unknown?.title ?? "", /lookup in progress/i, `project ${n}: the gate still waits on a lookup`);
    }
    assert.deepEqual(queued, [], "research was queued for a seeded city");
    assert.equal(researchJobs(), 0);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

await check("S3: the second project's Required document set names the CityWorks portal and holds on no application blank", () => {
  const pid = newProject(3);
  const project = R.getProjectDetail(db, pid).project;
  assert.equal(findAhjProcessProfile(project)?.ahj, AHJ);
  const permitTracks = getSubmittalTracks(db, project).filter((t) => t.category === "permit");
  assert.ok(permitTracks.length > 0, "no permit track");
  for (const t of permitTracks) {
    assert.match(t.channel, /CityWorks Public Access portal/i, `${t.type}: channel ${t.channel}`);
    assert.equal(channelKindOf({ channel: t.channel, portalUrl: "" }), "portal", `${t.type}: channel kind`);
  }
  const inv = documentInventory(db, project);
  const appTypes = new Set(["building_application", "permit_application", "electrical_application", "prescriptive_checklist"]);
  assert.deepEqual(inv.missingBlocking.filter((m) => appTypes.has(m.docType)).map((m) => m.label), [], "a blocking application blank");
  assert.equal(inv.applicationSetUnknown, undefined, "the 'which application' hold is raised for a cited city");
});

CP.setCodeResearchEnqueuerForTests(null);
CP.setDesignResearchEnqueuerForTests(null);

// ─── S2: hard rule 3 — a person's verified row is never touched by the seed ───────────────────────
await check("S2 (rule 3): a pre-existing VERIFIED ut|city of saratoga springs|unknown code row survives a reseed unchanged", () => {
  db.run("DELETE FROM jurisdiction_code_profiles WHERE profile_key = ?", [KEY]);
  CP.saveVerifiedCodeProfile(db, {
    key: "", confidence: "verified", updatedAt: "", state: ST, ahj: AHJ,
    adoptedCodes: [{ code: "IRC", edition: "2021", sourceUrl: "https://example.gov/verified" }],
    amendments: [], designCriteria: { groundSnowLoadPsf: 44, windSpeedMph: 115, sourceUrl: "https://example.gov/verified" },
    prescriptive: {}, fireSetbacks: [], citations: [{ label: "verified by a person", sourceUrl: "https://example.gov/verified" }],
  }, "synthetic.reviewer@example.com");
  const before = db.get<Record<string, unknown>>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [KEY]);
  assert.equal(before?.confidence, "verified");
  CP.seedReferenceCodeProfiles(db);
  assert.deepEqual(db.get<Record<string, unknown>>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [KEY]), before);
  assert.equal(CP.ownCodeProfileRow(db, ST, AHJ)!.profile.designCriteria.groundSnowLoadPsf, 44);
});

// The KB row's rule-3 contract is upsertKnowledge's: a person's verified SCALAR facts and verification
// stamp are never replaced by a seeded write (notes are segment-merged at every confidence, by design).
await check("S2 (rule 3): a VERIFIED KB row keeps its verified facts through a reseed; a VERIFIED process lookup is untouched", () => {
  const now = new Date().toISOString();
  KB.saveVerifiedAhjProfile(db, {
    state: ST, ahj: AHJ, portalName: "Verified portal words", portalUrl: "https://permits.example.gov/verified",
    submissionMethod: "Verified method", requiredDocuments: ["Verified document"], notes: "verified note", verifiedBy: "test-person",
  });
  const facts = "profile_key, portal_name, portal_url, submission_method, required_documents_json, confidence, verified_at, verified_by";
  const kbBefore = db.get<Record<string, unknown>>(`SELECT ${facts} FROM permit_utility_knowledge WHERE profile_key = ?`, [KEY]);
  assert.ok(kbBefore?.verified_at, "no KB row to verify");
  assert.equal(kbBefore?.portal_name, "Verified portal words");
  const notesBefore = String(db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE profile_key = ?", [KEY])?.notes);
  const verifiedLookup = {
    state: ST, ahj: AHJ,
    issuingAgency: { value: "Saratoga Springs Building", sourceUrl: "https://example.gov/v", quote: "verified", origin: "lookup" as const },
    permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "none" },
    permits: [], lookedUpAt: now, model: "test-model", confidence: "verified" as const,
  };
  savePermitProcessLookup(db, verifiedLookup as never, { verifiedBy: "test-person" });
  const lkBefore = db.get<Record<string, unknown>>("SELECT * FROM permit_process_lookups WHERE profile_key = ?", [PROCESS_KEY]);
  assert.ok(lkBefore?.verified_at, "the process lookup did not save verified");
  KB.seedInitialKnowledgeBase(db);
  assert.deepEqual(db.get<Record<string, unknown>>(`SELECT ${facts} FROM permit_utility_knowledge WHERE profile_key = ?`, [KEY]), kbBefore, "the KB row's verified facts changed");
  assert.ok(String(db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE profile_key = ?", [KEY])?.notes).startsWith(notesBefore), "a verified note segment was dropped or reordered");
  assert.deepEqual(db.get<Record<string, unknown>>("SELECT * FROM permit_process_lookups WHERE profile_key = ?", [PROCESS_KEY]), lkBefore, "the process lookup changed");
});

await check("no model call: llm_calls is empty after the whole run", () => {
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")?.n ?? 0), 0);
});

db.close();
if (failures) { console.error(`\n${failures} Saratoga Springs seed check(s) failed`); process.exit(1); }
console.log("\nall Saratoga Springs seed checks passed");
process.exit(0);
