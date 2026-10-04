// UTAH, END TO END: A SYNTHETIC PLAN SET THROUGH THE JURISDICTION CODE LOOKUP (#110).
//
// Owner request (2026-10-04): test the jurisdiction code lookup against a Utah plan set. Utah is the
// next test jurisdiction; #117 shipped its state code layer (statewide_uniform: 2021 IRC, 2023 NEC,
// 2024 IFC …, seeded) and four seeded AHJ process rows. This file walks ONE new Provo project from
// its first gate to a verified blocker, through the real job bodies and the real re-judge.
//
// The fixture (fixtures/ut-planset-synthetic.txt) is SYNTHETIC: "123 Example Way, Provo UT", an
// invented installer, no real names. Its governing-codes block states the 2018 IRC, one edition off
// Utah's 2021, so the code-basis rule has something to find. The LLM is a stub at every seam (the
// pattern of designLookupGate.test.ts); jobs are enqueued without the instant worker kick, so no job
// runs on its own and nothing reaches the network. The last check proves no model call was logged.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   AC1 a new UT project's first gate reads the fixture, queues the AHJ's design-criteria lookup
//       (the state layer is the shipped, fresh reference: nothing re-researches it, and Provo
//       inherits Utah's uniform codes), says the lookup is IN PROGRESS, and already flags the
//       2018 IRC against the seeded 2021 as a WARNING.
//   AC2 a state-layer code_research landing (stubbed, web-grounded) saves SEEDED and re-judges the
//       project: the code-basis finding stays a warning/callout (a seeded row never blocks, rule 3).
//   AC3 the AHJ's design-criteria lookup landing with a ground snow load ABOVE the fixture's adds
//       city.struct.design-criteria-below-ahj as a WARNING (unverified); a person verifying the row
//       through the verify route's own schema + save -> re-judge -> BLOCKER. (Before #110 it stayed
//       a warning: the rule read the MERGED profile's confidence, the weaker layer's, so a verified
//       AHJ row under Utah's seeded state layer never blocked. It now reads the field's own row.)
//   AC4 rule 5: the project's NEM track never resolves to a permit-platform portal for a UT AHJ
//       when the utility has no human-verified record; only that record opens one.
//       KNOWN GAP (#128, P0): Provo's own SELF-HOSTED CityView host (cvportal.provo.gov) is not
//       recognized as a permit portal and passes the NEM track today. Not pinned here; #128 owns it.
//
//   npx tsx backend/test/utahCodeLookupE2e.test.ts
import { REPO } from "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesignCriteriaResearchResult, JurisdictionCodeResearchResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utah-code-lookup-e2e-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const { enqueueJob } = await import("../src/jobQueue");
const { validate, codeProfileVerifySchema } = await import("../src/validation");
const { portalEntityEvidence } = await import("../src/portalRecipes");
const { hostFitsTrackAndEntity } = await import("../src/portalChannel");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const KEY = "sk-ant-test-never-called";
const ST = "UT";
const AHJ = "Provo";
const UTILITY = "Example Municipal Power"; // synthetic: no utility row exists for it
const UNKNOWN = "city.struct.design-criteria-unknown";
const BASIS = "city.code.basis-mismatch";
const BELOW = "city.struct.design-criteria-below-ahj";
const FIXTURE = fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", "ut-planset-synthetic.txt"), "utf8");
const AHJ_SOURCE = "https://provo.example.gov/building/design-criteria"; // invented .gov-shaped page
const STATE_SOURCE = "https://codes.example.gov/ut/state-construction-code";

// Enqueue WITHOUT the worker's instant kick (scheduledAt set): no job runs on its own, so every
// landing below happens exactly where the test says, and no provider is ever built for real.
const enqueueQuiet = (type: "code_research" | "design_criteria_research", payload: Record<string, unknown>): void => {
  enqueueJob(db, type, payload, { priority: 3, maxRetries: 2, scheduledAt: new Date().toISOString() });
};
CP.setCodeResearchEnqueuerForTests((d, payload) => { void d; enqueueQuiet("code_research", payload as unknown as Record<string, unknown>); });
CP.setDesignResearchEnqueuerForTests((d, payload) => { void d; enqueueQuiet("design_criteria_research", payload); });

const jobsOf = (type: string, key: string) => db.query<{ id: string; status: string }>(
  "SELECT id, status FROM job_queue WHERE job_type = ? AND payload LIKE ? ORDER BY created_at", [type, `%"profileKey":"${key}"%`],
);
const finishJob = (id: string, result: Record<string, unknown>): void => {
  const at = new Date().toISOString();
  db.run("UPDATE job_queue SET status = 'done', result = ?, finished_at = ? WHERE id = ?", [JSON.stringify(result), at, id]);
};
const report = (projectId: string) => R.buildReviewerReportFor(db, R.getProjectDetail(db, projectId).project);
const finding = (projectId: string, id: string) => report(projectId).findings.find((f) => f.id === id);
const gateRuns = (projectId: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.generated'", [projectId])?.n ?? 0);
const lastGateTrigger = (projectId: string): string =>
  String(db.get<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.generated' ORDER BY rowid DESC LIMIT 1", [projectId])?.details ?? "");
const llmCalls = (): number => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")?.n ?? 0);

const STATE_KEY = CP.codeProfileKey({ state: ST, ahj: "" });
const AHJ_KEY = CP.codeProfileKey({ state: ST, ahj: AHJ });

// The new UT project, the synthetic plan set as its uploaded document text.
const P = R.createProject(db, {
  owner: "Synthetic Homeowner", state: ST, dcKw: "8.4", acKw: "7.7", street: "123 Example Way", city: "Provo", zip: "84000",
  ahj: AHJ, utility: UTILITY,
} as never).project.id;
db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [P]);
db.run(
  "INSERT INTO project_documents (id, project_id, doc_type, original_filename, source, uploaded_at, extracted_text) VALUES (?, ?, 'plan_set', 'plan_set.pdf', 'upload', ?, ?)",
  [`doc-${P}`, P, new Date().toISOString(), FIXTURE],
);

// ─── fixture sanity: synthetic, and it says what the checks below rely on ───────────────────────
await check("fixture: synthetic (fake address, no real names) and states codes, criteria, spacing, rapid shutdown, fire pathways", () => {
  assert.match(FIXTURE, /SYNTHETIC TEST FIXTURE/);
  assert.match(FIXTURE, /123 EXAMPLE WAY, PROVO UT/);
  assert.match(FIXTURE, /GOVERNING CODES:[\s\S]*2018 IRC/);
  for (const re of [/GROUND SNOW LOAD \(Pg\) = 30 PSF/, /Vult\) = 110 MPH/, /EXPOSURE CATEGORY: C/, /RISK CATEGORY: II/, /SEISMIC DESIGN CATEGORY/, /FROST DEPTH/, /ATTACHMENT SPACING/, /RAPID SHUTDOWN/, /FIRE PATHWAYS/]) {
    assert.match(FIXTURE, re);
  }
});

// ─── AC1: the first gate ─────────────────────────────────────────────────────────────────────────
await check("AC1: Utah's shipped state layer is seeded (2021 IRC); it is fresh, and Provo inherits it (no state/AHJ code research due)", () => {
  const row = { profile: CP.getCodeProfile(db, { state: ST, ahj: "" }) };
  assert.ok(row.profile, "no UT state row: the #117 reference layer did not seed");
  assert.equal(row.profile!.confidence, "seeded");
  assert.ok(row.profile!.adoptedCodes.some((c) => c.code === "IRC" && c.edition === "2021"), "UT state layer has no 2021 IRC");
  assert.equal(CP.codeResearchDecision(db, ST, "").reason, "fresh");
  assert.equal(CP.codeResearchDecision(db, ST, AHJ).reason, "inherits_state");
});

await check("AC1: the first gate queues the AHJ design lookup, says it is IN PROGRESS, and reads the fixture's stated values", () => {
  process.env.ANTHROPIC_API_KEY = KEY; // research is queued only with a key; the stubs below answer it
  CP.resetResearchMarkersForTests();
  R.getReviewerReport(db, P);
  assert.equal(gateRuns(P), 1);
  assert.deepEqual(jobsOf("design_criteria_research", AHJ_KEY).map((j) => j.status), ["pending"]);
  assert.deepEqual(jobsOf("code_research", STATE_KEY), [], "the fresh reference state layer was re-researched");
  const f = finding(P, UNKNOWN);
  assert.ok(f, "no design-criteria-unknown finding for an AHJ with no criteria on file");
  assert.equal(f!.severity, "callout");
  assert.match(f!.title, /lookup in progress/i);
  assert.match(f!.message, /ground snow — stated in the package: 30 psf/);
  assert.match(f!.message, /wind speed — stated in the package: 110 mph/);
  assert.equal(finding(P, BELOW), undefined, "a below-AHJ finding with no AHJ value on file");
});

await check("AC1: the plan's 2018 IRC against Utah's seeded 2021 is already a WARNING (seeded never blocks), not an installer callout", () => {
  const f = finding(P, BASIS);
  assert.ok(f, "no code-basis finding: the plan states IRC 2018 against the state's 2021");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /plan states IRC 2018 .*profile records IRC 2021/);
  assert.match(f!.message, /UT state-level code profile \(seeded/);
  assert.equal(f!.installerCallout, false);
  assert.doesNotMatch(f!.message, /NEC|IFC/, "the plan's 2023 NEC / 2024 IFC match Utah's and must not be reported");
});

// ─── AC2: the state layer's code research lands (stubbed) -> re-judge -> still a warning ─────────
await check("AC2: a stubbed, web-grounded state code_research lands SEEDED; the state re-judge keeps the basis finding a warning", async () => {
  enqueueQuiet("code_research", { state: ST, ahj: "", profileKey: STATE_KEY, reason: "older_than_180d" });
  const [job] = jobsOf("code_research", STATE_KEY);
  const stub: LLMProvider = {
    researchJurisdictionCodes: async (): Promise<JurisdictionCodeResearchResult> => ({
      provider: "claude", webGrounded: true, needsHumanVerification: true, notes: "synthetic stub",
      profile: {
        key: "", state: ST, ahj: "", confidence: "seeded", amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
        adoptedCodes: [
          { code: "IRC", edition: "2021", family: "residential", sourceUrl: STATE_SOURCE, quote: "the 2021 edition of the International Residential Code" },
          { code: "NEC", edition: "2023", family: "electrical", sourceUrl: STATE_SOURCE, quote: "the 2023 edition of the National Electrical Code" },
        ],
        researchProvenance: { webGrounded: true, method: "web_search", notes: "synthetic", at: new Date().toISOString(), searches: 2, groundedSearches: 2 },
      } as never,
    }),
  } as unknown as LLMProvider;
  delete process.env.ANTHROPIC_API_KEY; // from here every provider is a stub; the re-judge builds the no-key one
  const result = await CP.runCodeResearch(db, { state: ST, ahj: "", profileKey: STATE_KEY }, stub);
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.equal(result.confidence, "seeded", "research landed as anything but seeded (rule 3)");
  finishJob(job.id, result);
  const before = gateRuns(P);
  // The worker's own call once the job leaves 'running' (jobQueue.rejudgeAfterJurisdictionLookup).
  const rejudged = await R.rejudgeReviewerGatesAfterLookup(db, { state: ST, ahj: "", scope: "state" }, "code_research_landed", { landedMark: R.lookupLandingMark() });
  assert.deepEqual(rejudged, [P]);
  assert.equal(gateRuns(P), before + 1);
  assert.match(lastGateTrigger(P), /code_research_landed/);
  assert.equal(CP.getCodeProfile(db, { state: ST, ahj: "" })?.confidence, "seeded");
  const f = finding(P, BASIS);
  assert.ok(f, "the state landing lost the code-basis finding");
  assert.ok(f!.severity === "warning" || f!.severity === "callout", `a seeded state layer produced a ${f!.severity}`);
  assert.match(f!.message, /plan states IRC 2018/);
});

// ─── AC3: the AHJ's design lookup lands above the fixture -> warning; verified -> blocker ─────────
await check("AC3: the stubbed AHJ lookup lands Pg 40 psf (fixture 30) -> below-AHJ WARNING after the re-judge; the row is seeded", async () => {
  const [job] = jobsOf("design_criteria_research", AHJ_KEY);
  const stub = { researchDesignCriteria: async (): Promise<DesignCriteriaResearchResult> => ({
    provider: "claude", webGrounded: true, notes: "synthetic stub",
    values: [{ criterion: "groundSnowLoadPsf", value: 40, sourceUrl: AHJ_SOURCE, quote: "Ground snow load Pg = 40 psf" }],
  }) } as unknown as LLMProvider;
  const result = await CP.runDesignCriteriaResearch(db, { state: ST, ahj: AHJ, profileKey: AHJ_KEY }, stub);
  finishJob(job.id, result);
  const before = gateRuns(P);
  const rejudged = await R.rejudgeReviewerGatesAfterLookup(db, { state: ST, ahj: AHJ }, "design_criteria_research_landed", { landedMark: R.lookupLandingMark() });
  assert.deepEqual(rejudged, [P]);
  assert.equal(gateRuns(P), before + 1);
  assert.equal(CP.ownCodeProfileRow(db, ST, AHJ)?.profile.confidence, "seeded", "the lookup's values did not land seeded (rule 3)");
  const f = finding(P, BELOW);
  assert.ok(f, "Pg 30 stated against the AHJ's 40, but no below-AHJ finding");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /Ground snow load: stated 30 psf .* requires 40 psf/);
  assert.doesNotMatch(finding(P, UNKNOWN)?.message ?? "", /ground snow load .*being looked up/, "the gate still says the ground snow lookup is in progress");
});

await check("AC3: a person verifies Provo's row (the verify route's schema + save) -> re-judge -> below-AHJ BLOCKER", async () => {
  const own = CP.ownCodeProfileRow(db, ST, AHJ)!.profile;
  // What PUT /api/code-profiles/verify receives from the KB card: the row as the person confirmed it.
  const body = validate(codeProfileVerifySchema, {
    state: ST, ahj: AHJ,
    adoptedCodes: own.adoptedCodes, amendments: own.amendments,
    designCriteria: { groundSnowLoadPsf: 40, sourceUrl: AHJ_SOURCE }, prescriptive: own.prescriptive,
    fireSetbacks: own.fireSetbacks, citations: own.citations,
  });
  CP.saveVerifiedCodeProfile(db, {
    key: "", confidence: "verified", updatedAt: "",
    state: body.state, ahj: body.ahj,
    adoptedCodes: body.adoptedCodes, amendments: body.amendments,
    designCriteria: body.designCriteria, prescriptive: body.prescriptive,
    fireSetbacks: body.fireSetbacks.map((x) => ({ ...x })), citations: body.citations,
  }, "synthetic.reviewer@example.com");
  assert.equal(CP.ownCodeProfileRow(db, ST, AHJ)?.profile.confidence, "verified");
  const before = gateRuns(P);
  const rejudged = await R.rejudgeReviewerGatesAfterLookup(db, { state: ST, ahj: AHJ }, "design_criteria_research_landed", { landedMark: R.lookupLandingMark() });
  assert.deepEqual(rejudged, [P]);
  assert.equal(gateRuns(P), before + 1);
  const f = finding(P, BELOW);
  assert.ok(f, "the verified row lost the below-AHJ finding");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.message, /requires 40 psf/);
  assert.match(f!.message, /AHJ value from the Provo \(UT\) code profile \(human-verified by synthetic\.reviewer@example\.com/);
  // Verifying Provo's criteria verified nothing about Utah's editions: the basis line stays a warning.
  assert.equal(finding(P, BASIS)?.severity, "warning", "verifying the AHJ's criteria hardened the seeded state editions");
});

// ─── AC4: rule 5 — the NEM track never resolves to the UT AHJ's permit portal ────────────────────
// Synthetic tenants on the platforms Utah's seeded rows name (Accela, iWorQ, CitizenServe).
const UT_PERMIT_PORTALS = [
  "https://aca-prod.accela.com/EXAMPLEUT/Default.aspx",
  "https://portal.iworq.net/EXAMPLEUT/permits/600",
  "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&ctzPagePrefix=Portal_&installationID=99999",
];

await check("AC4 (rule 5): with no verified utility record, the NEM track refuses a UT permit-platform portal (track_conflict)", () => {
  const entity = portalEntityEvidence(db, { scope: "utility", state: ST, name: UTILITY });
  assert.ok(entity);
  assert.deepEqual(entity!.verifiedPermitPlatformPortals, [], "a synthetic utility gained a verified permit portal");
  for (const url of UT_PERMIT_PORTALS) {
    for (const source of ["kb", "research", "recipe", "operator"] as const) {
      const fit = hostFitsTrackAndEntity("nem", entity, url, source);
      assert.equal(fit.fits, false, `${url} (${source}) opened on the NEM track: ${fit.reason}`);
      assert.equal(fit.code, "track_conflict");
    }
    // Control: the same portal is fine on the project's permit track.
    assert.equal(hostFitsTrackAndEntity("building", portalEntityEvidence(db, { scope: "ahj", state: ST, name: AHJ }), url, "research").fits, true, `${url} refused on the permit track`);
  }
});

await check("AC4 (rule 5): the AHJ's seeded KB row never opens its portal on the NEM track; only the utility's own VERIFIED record does", () => {
  const url = UT_PERMIT_PORTALS[0];
  const now = new Date().toISOString();
  // A SEEDED utility row naming the city's permit portal: still refused.
  db.run(
    "INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, confidence, first_seen_at, last_learned_at, updated_at) VALUES (?, ?, ?, '', ?, ?, 'seeded', ?, ?, ?)",
    ["kb-ut-synthetic-utility", `${ST.toLowerCase()}||example municipal power`, ST, UTILITY, url, now, now, now],
  );
  assert.equal(hostFitsTrackAndEntity("nem", portalEntityEvidence(db, { scope: "utility", state: ST, name: UTILITY }), url, "kb").fits, false, "a SEEDED utility row opened a permit portal on the NEM track");
  // A person verifies that the utility takes its application there: the one carve-out.
  db.run("UPDATE permit_utility_knowledge SET verified_at = ?, confidence = 'verified' WHERE id = ?", [now, "kb-ut-synthetic-utility"]);
  const verified = portalEntityEvidence(db, { scope: "utility", state: ST, name: UTILITY });
  assert.deepEqual(verified!.verifiedPermitPlatformPortals, [url]);
  assert.equal(hostFitsTrackAndEntity("nem", verified, url, "kb").fits, true, "the verified carve-out did not open the named portal");
  // ... and only that tenant: another tenant on the same host stays refused.
  assert.equal(hostFitsTrackAndEntity("nem", verified, "https://aca-prod.accela.com/OTHERUT/Default.aspx", "kb").fits, false, "the carve-out went host-wide");
});

// ─── no model was called anywhere above ──────────────────────────────────────────────────────────
await check("no model call: llm_calls is empty after the whole run", () => {
  assert.equal(llmCalls(), 0);
});

CP.setCodeResearchEnqueuerForTests(null);
CP.setDesignResearchEnqueuerForTests(null);
delete process.env.ANTHROPIC_API_KEY;

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall Utah code-lookup e2e checks passed");
process.exit(0);
