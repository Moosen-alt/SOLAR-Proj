// "WHY DOES THE SLD EVIDENCE LOOK LIKE OUR PHONE NUMBER?"
//
// The operator's question on f7d7af7e's supply-side-tap callout, 2026-09-23. Four measured causes:
//
//   1. projectEvidence.matchSources cut excerpts from 70 chars BEFORE the match; on a plan sheet
//      that is the title block, so the SLD evidence opened with the company phone number.
//   2. pageImages.selectTopPagesForTopic cropped the NOTES sheet (boilerplate naming both 705.12
//      and 705.11, OCPD, rapid shutdown) instead of the 3-LINE DIAGRAM sheet — measured on 15 of
//      19 production plan sets. The sheet's own NAME now outweighs its vocabulary, tokens on every
//      page (the title block) stop counting, and the page that holds the quoted excerpt wins.
//   3. The callout said "evidence: verified" when all that was verified was that an SLD EXISTS.
//      Evidence borrowed from a finding's topic is capped at "weak" and says what it does not show.
//   4. Rule 5 door: the add-target form accepted a PacifiCorp PowerClerk URL as a PERMIT target
//      (production row 99ea32c3). It is now refused with a 400 pointing at the NEM target.
//
// Every fixture is synthetic. Run: npx tsx backend/test/evidenceSheetAndTargetGuard.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-guard-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { evidenceForTopic } = await import("../src/projectEvidence");
const { selectTopPagesForTopic } = await import("../src/pageImages");
const { buildReviewerReport } = await import("../src/reviewerEngine");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (snapshot: Record<string, unknown>, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "evidence-guard", clientId: "c", homeownerName: "Guard Probe", projectAddress: "1 Sheet St",
  city: "Testport", state: "OR", zip: "97000", ahj: "City of Testport", utility: "Test Power",
  accountNumber: "1234567890", meterNumber: "987654", systemSizeDcKw: 9, systemSizeAcKw: 7.6,
  interconnectionMethod: "Supply Breaker", status: "pending",
  parserSnapshot: { state: "OR", ahj: "City of Testport", mounting: "Roof mount", interco: "Supply Breaker", ...snapshot },
  ...over,
} as unknown as ProjectRecord);

// A title block that prints on every sheet, the way the real set's does.
const TB = "ACME SOLAR  PHONE: 1-800-555-0100  ACMESOLAR.COM  Initial Design  00 1/1/26";

// ---------------------------------------------------------------------------------------------
console.log("\n1. THE EXCERPT LEADS WITH THE EVIDENCE");
// ---------------------------------------------------------------------------------------------
await check("MUST PASS: a title-block-first page yields an excerpt that starts at the sheet name", () => {
  const p = mk({ planSetExtractedText: `${TB}  3-LINE DIAGRAM  PV MODULE RATING @ STC  MAX POWER-POINT CURRENT  (N) AC COMBINER PANEL` });
  const hit = evidenceForTopic(p, "sld").hits[0];
  assert.ok(hit, "no sld hit");
  assert.match(hit.excerpt, /^3-LINE DIAGRAM PV MODULE RATING/, `excerpt: ${hit.excerpt}`);
  assert.doesNotMatch(hit.excerpt, /PHONE|1-800|ACMESOLAR/, `title block leaked: ${hit.excerpt}`);
});
await check("MUST EXCLUDE: the excerpt still carries what follows the match, and the topic stays high", () => {
  const p = mk({ planSetExtractedText: `${TB}  3-LINE DIAGRAM  PV MODULE RATING @ STC  (N) AC COMBINER PANEL` });
  const ev = evidenceForTopic(p, "sld");
  assert.match(ev.hits[0].excerpt, /AC COMBINER PANEL/);
  assert.equal(ev.confidence, "high");
});
await check("MUST PASS: a single-spaced title block with no boundary still yields an excerpt starting at the match", () => {
  const p = mk({ planSetExtractedText: "PHONE: 1-800-555-0100 ACMESOLAR.COM Initial Design 00 1/1/26 3-LINE DIAGRAM PV MODULE RATING @ STC" });
  const hit = evidenceForTopic(p, "sld").hits[0];
  assert.match(hit.excerpt, /^3-LINE DIAGRAM/, hit.excerpt);
});
await check("MUST EXCLUDE: a sentence that opens just before the match is kept whole, and a sheet ref reaches the hint", () => {
  const p = mk({ planSetExtractedText: "ELECTRICAL. SEE SHEET E-1.1 SINGLE LINE DIAGRAM FOR THE POINT OF INTERCONNECTION." });
  const hit = evidenceForTopic(p, "sld").hits[0];
  assert.match(hit.excerpt, /^SEE SHEET E-1\.1 SINGLE LINE DIAGRAM/, hit.excerpt);
  assert.match(hit.pageHint, /SHEET E-1\.1/i, `pageHint: ${hit.pageHint}`);
});
await check("MUST EXCLUDE: 'One Line Diagram (SLD)' keeps the words before the SLD hit, and the topic stays high", () => {
  // Measured on a production test row: /\bSLD\b/ hits first, and starting AT it dropped
  // "Diagram" from the excerpt and the sld topic from high to medium.
  const p = mk({ planSetExtractedText: "Not a real submission. Sample project TEST — One Line Diagram (SLD) Generated as TEST DATA." });
  const ev = evidenceForTopic(p, "sld");
  assert.match(ev.hits[0].excerpt, /^One Line Diagram \(SLD\)/, ev.hits[0].excerpt);
  assert.equal(ev.confidence, "high");
});
await check("MUST PASS: the excerpt stops at a page break instead of quoting the next sheet's title block", () => {
  const p = mk({ planSetExtractedText: `${TB}  DESIGN CRITERIA  SNOW LOAD: 16 PSF\n${TB}  PLOT PLAN` });
  const hit = evidenceForTopic(p, "structuralLoads").hits[0];
  assert.equal(hit.excerpt, "SNOW LOAD: 16 PSF");
});

// ---------------------------------------------------------------------------------------------
console.log("\n2. THE DIAGRAM SHEET, NOT THE NOTES SHEET");
// ---------------------------------------------------------------------------------------------
const COVER = `${TB}  COVER  SHEET INDEX  PV 0.0: COVER  E 1.1: 3-LINE DIAGRAM  E 1.2: NOTES  PV 1.0: PLOT PLAN`;
// Boilerplate that names every interconnection option — the E 1.2 shape.
const NOTES = `${TB}  NOTES  ELECTRICAL NOTES: 1. INTERCONNECTION PER NEC 705.12 LOAD SIDE BREAKER OR 705.11 SUPPLY SIDE TAP. `
  + "2. RAPID SHUTDOWN PER 690.12. 3. OCPD SIZED PER INVERTER OUTPUT. 4. MAIN SERVICE PANEL BREAKER SPACE.";
const DIAGRAM = `${TB}  3-LINE DIAGRAM  PV MODULE RATING @ STC  (N) AC COMBINER PANEL  (E) MAIN SERVICE PANEL 200A  `
  + "20A OCPD  INVERTER OUTPUT  ELECTRICAL NOTES:  1. CONDUCTORS COPPER";
const SET = [COVER, NOTES, DIAGRAM];

await check("MUST PASS: with no excerpt at all, the sheet NAMED 3-LINE DIAGRAM beats the keyword-stuffed NOTES sheet", () => {
  assert.equal(selectTopPagesForTopic(SET, "sld", "", "", 1)[0], 3, `ranking ${selectTopPagesForTopic(SET, "sld", "", "", 3)}`);
});
await check("MUST PASS: with the new evidence excerpt, the diagram page is the crop", () => {
  const excerpt = evidenceForTopic(mk({ planSetExtractedText: SET.join("\n") }), "sld").hits[0].excerpt.slice(0, 160);
  assert.equal(selectTopPagesForTopic(SET, "sld", "Uploaded plan set text", excerpt, 1)[0], 3, excerpt);
});
await check("MUST PASS: when the diagram's name did not extract as its own run, a sheet NAMED notes still does not win", () => {
  const merged = `${TB} E 1.1 3-LINE DIAGRAM PV MODULE RATING @ STC (E) MAIN SERVICE PANEL 200A 20A OCPD INVERTER OUTPUT`;
  assert.equal(selectTopPagesForTopic([COVER, NOTES, merged], "sld", "", "", 1)[0], 3, `ranking ${selectTopPagesForTopic([COVER, NOTES, merged], "sld", "", "", 3)}`);
});
await check("MUST EXCLUDE: the index entry '3-LINE DIAGRAM' on the cover is not a sheet named that", () => {
  const ranking = selectTopPagesForTopic([COVER, NOTES], "sld", "", "", 2);
  assert.notEqual(ranking[0], 1, `cover ranked first: ${ranking}`);
});
await check("MUST EXCLUDE: a NOTES-named sheet is not penalised for a non-diagram topic", () => {
  const framingNotes = `${TB}  NOTES  STRUCTURAL NOTES: RAFTER 2X6 @ 24" O.C. SPAN 12 FT, TRUSS BEARING WALL`;
  const plot = `${TB}  PLOT PLAN  PROPERTY LINE  DRIVEWAY`;
  assert.equal(selectTopPagesForTopic([plot, framingNotes], "roofFraming", "", "", 1)[0], 2);
});
await check("MUST EXCLUDE: a one-page set still scores its page (nothing is 'on every page' there)", () => {
  assert.deepEqual(selectTopPagesForTopic([DIAGRAM], "sld", "", "3-LINE DIAGRAM PV MODULE RATING", 3), [1]);
});
// Title-block tokens used to fill the excerpt-overlap cap (8) on every page, so the tokens that
// actually located the page could add nothing. roofFraming has no sheet-name rule, so this
// isolates the every-page discount.
await check("MUST PASS: title-block words in an excerpt no longer drown the words that locate the page", () => {
  const TB8 = "ACME SOLAR PHONE CONTACT INITIAL DESIGN REVISION DRAWN CHECKED PROJECT";
  const a = `${TB8}  ROOF PLAN  RAFTER LAYOUT  TRUSS  FRAMING`;
  const b = `${TB8}  ROOF SECTION  RAFTER  PURLIN BRACE KNEEWALL CEILING JOIST`;
  const excerpt = `${TB8} RAFTER PURLIN BRACE KNEEWALL CEILING JOIST`;
  assert.equal(selectTopPagesForTopic([a, b], "roofFraming", "", excerpt, 1)[0], 2, `ranking ${selectTopPagesForTopic([a, b], "roofFraming", "", excerpt, 2)}`);
});
// The cover carries both the sheet index (-8) and the design criteria. The excerpt quotes the
// cover; the page holding the quote is the crop, not the plot plan with more load keywords.
await check("MUST PASS: the page holding the quoted excerpt wins over a keyword-richer page", () => {
  const cover = `${TB}  SHEET INDEX  PV 0.0 COVER  PV 1.0 PLOT PLAN  DESIGN CRITERIA  SNOW LOAD: 16 PSF`;
  const plot = `${TB}  PLOT PLAN  ROOF SLOPE 18 DEG  DEAD LOAD 2.44 PSF  WIND ZONE`;
  const excerpt = evidenceForTopic(mk({ planSetExtractedText: [cover, plot].join("\n") }), "structuralLoads").hits[0].excerpt.slice(0, 160);
  assert.equal(selectTopPagesForTopic([cover, plot], "structuralLoads", "Uploaded plan set text", excerpt, 1)[0], 1, `excerpt ${excerpt}`);
});

// ---------------------------------------------------------------------------------------------
console.log("\n3. TOPIC EVIDENCE IS NOT EVIDENCE OF THE FINDING'S ASK");
// ---------------------------------------------------------------------------------------------
const SLD_TEXT = `${TB}  3-LINE DIAGRAM  POINT OF INTERCONNECTION SUPPLY BREAKER  RAPID SHUTDOWN PER 690.12  PV MODULE RATING`;
await check("MUST PASS: the supply-side-tap callout is not 'verified' by an SLD that merely exists", () => {
  const f = buildReviewerReport(mk({ planSetExtractedText: SLD_TEXT })).findings.find((x) => x.id === "city.elec.supply-side-tap");
  assert.ok(f, "supply-side-tap did not fire");
  assert.equal(evidenceForTopic(mk({ planSetExtractedText: SLD_TEXT }), "sld").confidence, "high", "fixture must carry HIGH sld evidence");
  assert.equal(f!.evidenceStatus, "weak", `status ${f!.evidenceStatus}`);
  const item = f!.evidenceFound?.find((e) => e.kind === "source_excerpt");
  assert.ok(item, "no source excerpt attached");
  assert.match(item!.label, /^SLD found — supply-side tap detail.* not verified$/, item!.label);
  assert.doesNotMatch(item!.note, /strong supporting/i, item!.note);
});
await check("MUST EXCLUDE: with no SLD at all the borrowed status stays 'missing', not 'weak'", () => {
  const f = buildReviewerReport(mk({ planSetExtractedText: "" })).findings.find((x) => x.id === "city.elec.supply-side-tap");
  assert.equal(f?.evidenceStatus, "missing");
});
await check("MUST EXCLUDE: a finding that carries its OWN evidence keeps its own 'verified'", () => {
  const f = buildReviewerReport(mk({
    permitPath: "prescriptive",
    structuralCalcText: "Structure: HUD manufactured home. Framing: 2x2 manufactured trusses @ 24\" o.c.",
    planSetExtractedText: SLD_TEXT,
  })).findings.find((x) => x.id === "city.struct.manufactured-home-prescriptive");
  assert.ok(f, "manufactured-home finding did not fire");
  assert.equal(f!.evidenceStatus, "verified");
});

// ---------------------------------------------------------------------------------------------
console.log("\n4. RULE 5 AT THE ADD-TARGET DOOR");
// ---------------------------------------------------------------------------------------------
const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const db = await openDatabase();
const pid = R.createProject(db, {
  owner: "Door Owner", state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
  street: "1 Door Way", city: "Testport", zip: "97000", ahj: "City of Testport", utility: "Pacific Power",
} as never).project.id;
const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/MvcProjects/ProjectDetails";
const ACCELA = "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx";
const targets = (): Array<{ target_type: string; portal_url: string }> =>
  db.query("SELECT target_type, portal_url FROM permit_check_targets WHERE project_id = ?", [pid]);

await check("MUST PASS: a PowerClerk URL as a PERMIT target is refused with a 400 naming the NEM target, and nothing is written", () => {
  const before = targets().length;
  const knowledgeBefore = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge")?.n ?? 0);
  let err: unknown;
  try {
    R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "building", portalUrl: POWERCLERK, applicationNumber: "APP-1" });
  } catch (e) { err = e; }
  assert.ok(err, "the utility URL was accepted as a permit target");
  assert.equal((err as { status?: number }).status, 400);
  assert.match((err as Error).message, /Public status URL/);
  assert.equal(targets().length, before, "a row was written");
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge")?.n ?? 0), knowledgeBefore, "the refused URL was learned");
});
await check("MUST EXCLUDE: the same PowerClerk URL as the NEM target is accepted", () => {
  R.createPermitCheckTarget(db, pid, { targetType: "nem", portalUrl: POWERCLERK, applicationNumber: "NEM-1" });
  assert.ok(targets().some((t) => t.target_type === "nem" && t.portal_url === POWERCLERK));
});
await check("MUST EXCLUDE: an AHJ portal as a permit target is accepted — including one whose query merely names a utility", () => {
  R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "building", portalUrl: ACCELA, applicationNumber: "187-26-000999-STR" });
  R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "electrical", portalUrl: `${ACCELA}?ref=pacificpower.net`, applicationNumber: "187-26-000998-ELE" });
  assert.equal(targets().filter((t) => t.target_type === "permit").length, 2);
});
await check("MUST PASS: the reuse path cannot overwrite an existing permit target's URL with a utility portal", () => {
  let refused = false;
  try {
    R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "building", portalUrl: POWERCLERK, applicationNumber: "187-26-000999-STR" });
  } catch { refused = true; }
  assert.ok(refused, "refusal skipped on the update path");
  assert.ok(targets().every((t) => t.target_type !== "permit" || !t.portal_url.includes("powerclerk")), JSON.stringify(targets()));
});

if (failures) { console.error(`\n${failures} evidence/target guard test(s) failed.`); process.exit(1); }
console.log("\nAll evidence/target guard tests passed.");
