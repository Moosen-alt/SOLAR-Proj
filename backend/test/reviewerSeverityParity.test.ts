// ONE ANSWER TO "WHAT HOLDS THIS FILING" (issue #214; owner ruling 2026-10-05: YES).
//
// The submit gate and the correction notice folded cached vision verdicts into the reviewer's
// severities. Staging (prepareSubmission), Approve / next-step (reviewerBlockerList, which feeds
// runAutopilotApproval) and the plain reviewer report did not. A live Utah project showed 2 holds on
// the gate while 3 blockers refused staging. Every reader now goes through
// repository.reviewerGateReportFor.
//
// Fixtures are SYNTHETIC: the stage fixture's Portland/PGE job and a one-page pdf-lib plan set. No
// names, addresses or real plan sets. Verdicts are written by the PRODUCTION writer: the real vision
// pass (applyVisionToReviewerReport) with a fake LLM, as the operator's "run the gate with vision"
// and the stage_step chain do. The one exception is the DC row in check 3: the writer refuses
// measured findings, so a row written before that guard existed can only be simulated.
//
//   MUST-PASS    A high-confidence "present" verdict on a relaxable blocker
//                (city.elec.rapid-shutdown-missing) relaxes it in EVERY reader. The gate's holds, the
//                notice's holds, reviewerBlockerList, prepareSubmission's 409, getReviewerReport,
//                readStageResults and the printable packet all name the same blockers, which are the
//                vision pass's own.
//   MUST-EXCLUDE A measured finding (city.elec.dc-size-mismatch) stays a blocker in every reader, even
//                with a present/high verdict cached for its exact question. A LOW-confidence verdict
//                relaxes nothing anywhere.
//   MUST-EXCLUDE A verdict answers the question it was asked. A present/high verdict cached while
//                rapid-shutdown-missing was a micro-inverter WARNING does not relax the string-inverter
//                BLOCKER the same id becomes after an edit, with the same PDF on file.
//   MUST-EXCLUDE No production module (backend/src, scripts) reaches the raw text builder, the cached
//                fold, or a cache-only vision pass except through reviewerGateReportFor. Checked on the
//                TypeScript syntax tree, so aliases, arrows, methods and comments cannot hide a call.
//
// Run: npx tsx backend/test/reviewerSeverityParity.test.ts
import "./_isolate"; // FIRST: generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { ReviewerFinding, ReviewerReport, ReviewerVisionVerdict } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("reviewer-severity-parity");
const { db, repo } = fx;
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const docs = await import("../src/projectDocuments");
const { findPlanSetPdf } = await import("../src/pageImages");
const { applyVisionToReviewerReport, visionQuestionFor } = await import("../src/reviewerVision");
const { reviewerBlockerList } = await import("../src/nextStep");
const { readCorrectionNotice } = await import("../src/correctionNotice");

const RSD = "city.elec.rapid-shutdown-missing"; // presence rule, topic rapidShutdown: vision may relax it
const DC = "city.elec.dc-size-mismatch"; // arithmetic, in MEASURED_FINDING_IDS: vision never relaxes it

// The stage fixture names rapid shutdown in three fields and runs Enphase micros (MLPE caps RSD at a
// warning). Those three fields without the words, plus a string inverter, make RSD a text blocker. A DC
// size that misses 20 x 430 W makes the measured blocker.
const NO_RSD_WORDS = {
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A.",
  labelsText: "PV label schedule includes service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
};
const STRING_INVERTER = { invModel: "Sunny Boy SB7.7-1SP-US-41", invQty: "1" };

async function planSetPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  ["PV-1 SITE PLAN", "ROOF MOUNTED PV ARRAY", "E-1 SINGLE LINE DIAGRAM"].forEach((line, i) =>
    page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await pdf.save());
}

/** A vision model that confirms every item it is asked about, at the given confidence. */
const fakeVision = (confidence: "high" | "low") => ({
  async visionExtract(input: { prompt: string }): Promise<Record<string, unknown>> {
    if (/Read the DIMENSIONS/.test(input.prompt)) return { confidence: "low" }; // no measurement
    return { present: true, confidence, observed: "synthetic sheet shows the item", missing: "" };
  },
}) as never;

const blockersOf = (report: ReviewerReport): string[] =>
  report.findings.filter((f) => f.severity === "blocker").map((f) => f.id).sort();
const rawReport = (id: string) => repo.buildReviewerReportFor(db, repo.getProjectDetail(db, id).project);
const cachedVerdict = (projectId: string, findingId: string): ReviewerVisionVerdict | null => {
  const row = db.get<{ verdict: string }>("SELECT verdict FROM reviewer_vision_cache WHERE project_id = ? AND finding_id = ?", [projectId, findingId]);
  return row ? JSON.parse(row.verdict) : null;
};

/** A project whose real plan-set PDF is the one every reader judges, with its text extracted. */
async function projectWithPlanSet(over: Record<string, string>): Promise<string> {
  const id = fx.newProject(over as never);
  const doc = docs.saveProjectDocument(db, id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: await planSetPdf(), source: "upload",
  });
  const stored = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [doc.id])!.stored_path;
  // The fixture saved a placeholder plan set a moment earlier. The newest-first lookup could tie on
  // the millisecond, so date the placeholder back (test arrangement only) and then prove the choice.
  db.run("UPDATE project_documents SET uploaded_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND id <> ?", [id, doc.id]);
  assert.equal(findPlanSetPdf(db, id), stored, "the readers would judge the placeholder, not the real plan set");
  // Text extraction lands after the upload returns; the column starts as '' (NOT NULL DEFAULT '') and
  // extraction always writes the text or "[no text layer]". Read nothing until it has landed.
  const deadline = Date.now() + 20_000;
  while (db.get("SELECT 1 FROM project_documents WHERE project_id = ? AND content_type LIKE '%pdf%' AND extracted_text = ''", [id])) {
    if (Date.now() > deadline) throw new Error("plan-set text extraction did not land within 20 s");
    await new Promise((r) => setTimeout(r, 50));
  }
  return id;
}

/** Every reader's answer to "which reviewer findings hold this filing", as sorted finding ids. */
async function readers(id: string, raw: ReviewerReport): Promise<Record<string, string[]>> {
  const idByTitle = new Map(raw.findings.map((f) => [f.title, f.id]));
  const project = repo.getProjectDetail(db, id).project;

  const permit = repo.getSubmitGateReport(db, id).checks.find((c) => c.id === "permit-requirements");
  const gateHolds = (permit?.holds ?? []).map((h) => idByTitle.get(h.label) ?? `?${h.label}`).sort();

  const notice = readCorrectionNotice(db, id);
  const noticeHolds = notice.items.filter((i) => i.weight === "hold").map((i) => i.findingId).sort();
  assert.equal(notice.counts.hold, noticeHolds.length, "the notice header disagrees with its own items");

  const approve = reviewerBlockerList(db, project).map((b) => b.code).sort();

  let refusal: { reviewerBlockers?: string[]; reviewerBlockerCount?: number } | undefined;
  let staged = false;
  try {
    await repo.prepareSubmission(db, id);
    staged = true;
  } catch (err) {
    refusal = (err as { details?: typeof refusal }).details;
    assert.ok(refusal && Array.isArray(refusal.reviewerBlockers),
      `prepareSubmission refused before the reviewer gate: ${err instanceof Error ? err.message : String(err)}`);
  }
  assert.equal(staged, false, "prepareSubmission staged a project the reviewer holds");
  const staging = refusal!.reviewerBlockers!.map((t) => idByTitle.get(t) ?? `?${t}`).sort();
  assert.equal(refusal!.reviewerBlockerCount, staging.length, "staging's title list was cut short");

  const reviewer = blockersOf(repo.getReviewerReport(db, id)); // also writes the audit row stage results need
  const stage = await repo.readStageResults(db, id);
  assert.ok(stage.reviewerReport, "readStageResults returned no reviewer report after a gate run");
  const pageLoad = blockersOf(stage.reviewerReport!);

  await repo.getReviewerReportHtml(db, id);
  const html = db.get<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.html_opened' ORDER BY rowid DESC LIMIT 1", [id]);
  const packetBlockerCount = Number(JSON.parse(html?.details ?? "{}").blockerCount);

  return { gateHolds, noticeHolds, approve, staging, reviewer, pageLoad, packetCount: [String(packetBlockerCount)] };
}

/** Assert every reader names `expected`; the packet audit carries the count only. */
function assertAllReaders(got: Record<string, string[]>, expected: string[], what: string): void {
  for (const [reader, value] of Object.entries(got)) {
    if (reader === "packetCount") assert.deepEqual(value, [String(expected.length)], `packet blocker count vs ${what}`);
    else assert.deepEqual(value, expected, `${reader}: ${JSON.stringify(value)} vs ${what} ${JSON.stringify(expected)}`);
  }
}

console.log("reviewer severity parity: one answer to what holds a filing (#214)");

// 1-2: a present/HIGH verdict.
let highId = "";
let highRaw: ReviewerReport | null = null;
let highVision: string[] = [];
await check("1. setup: the raw report holds on RSD and DC; the vision pass (present/high) relaxes RSD only", async () => {
  highId = await projectWithPlanSet({ ...NO_RSD_WORDS, ...STRING_INVERTER, dcKw: "10.0" });
  highRaw = rawReport(highId);
  assert.ok(blockersOf(highRaw).includes(RSD) && blockersOf(highRaw).includes(DC), `raw: ${blockersOf(highRaw).join(", ")}`);
  highVision = blockersOf(await applyVisionToReviewerReport(db, fakeVision("high"), highRaw));
  assert.ok(!highVision.includes(RSD) && highVision.includes(DC), `vision pass: ${highVision.join(", ")}`);
  const row = cachedVerdict(highId, RSD);
  assert.equal(row?.confidence, "high", "the RSD verdict is not in the cache: the readers would prove nothing");
  assert.equal(row?.question, visionQuestionFor(highRaw.findings.find((f) => f.id === RSD)!), "the cached verdict does not record its question");
});
await check("2. MUST-PASS every reader: the vision-relaxed RSD no longer holds; the same blockers as the vision pass", async () => {
  assert.ok(highRaw, "setup failed");
  const got = await readers(highId, highRaw!);
  for (const [reader, value] of Object.entries(got)) if (reader !== "packetCount") {
    assert.ok(!value.includes(RSD), `${reader} still holds on the vision-relaxed RSD`);
    assert.ok(value.includes(DC), `${reader} dropped the measured DC blocker`);
  }
  assertAllReaders(got, highVision, "the vision pass");
});

// 3: a verdict cached for the MEASURED finding's exact question. The writer refuses measured findings
// (needsVision), so this simulates a row from before that guard. The measured guard must hold on read\n// (needsVision / visionMayRelax, then applyVerdict's own belt-and-braces).
await check("3. MUST-EXCLUDE a present/high verdict for DC's exact question still relaxes nothing: DC holds everywhere", async () => {
  assert.ok(highRaw, "setup failed");
  const dc = highRaw!.findings.find((f) => f.id === DC)!;
  const sig = db.get<{ source_sig: string }>("SELECT source_sig FROM reviewer_vision_cache WHERE project_id = ? AND finding_id = ?", [highId, RSD])!.source_sig;
  const verdict: ReviewerVisionVerdict = { checked: true, present: true, confidence: "high", page: 1, observed: "synthetic", note: "synthetic legacy row", question: visionQuestionFor(dc) };
  db.run("INSERT INTO reviewer_vision_cache (project_id, finding_id, source_sig, verdict, created_at) VALUES (?, ?, ?, ?, ?)",
    [highId, DC, sig, JSON.stringify(verdict), new Date().toISOString()]);
  const got = await readers(highId, highRaw!);
  for (const [reader, value] of Object.entries(got)) if (reader !== "packetCount") assert.ok(value.includes(DC), `${reader} relaxed the measured DC`);
  assertAllReaders(got, highVision, "the vision pass");
});

// 4: a present/LOW verdict.
await check("4. MUST-EXCLUDE a low-confidence verdict relaxes nothing: every reader holds on the raw text blockers", async () => {
  const id = await projectWithPlanSet({ ...NO_RSD_WORDS, ...STRING_INVERTER, dcKw: "10.0" });
  const raw = rawReport(id);
  assert.ok(blockersOf(raw).includes(RSD));
  assert.deepEqual(blockersOf(await applyVisionToReviewerReport(db, fakeVision("low"), raw)), blockersOf(raw), "the vision pass relaxed on low confidence");
  assert.equal(cachedVerdict(id, RSD)?.confidence, "low", "the low verdict is not in the cache: the readers would prove nothing");
  const got = await readers(id, raw);
  for (const [reader, value] of Object.entries(got)) if (reader !== "packetCount") assert.ok(value.includes(RSD), `${reader} relaxed on a low-confidence verdict`);
  assertAllReaders(got, blockersOf(raw), "raw");
});

// 5: a verdict to a different question.
await check("5. MUST-EXCLUDE a verdict cached for the micro-inverter WARNING does not relax the string-inverter BLOCKER the same id becomes", async () => {
  // Enphase micros, named so isMlpeDesign recognizes them. The fixture's bare "IQ8M" is not matched by
  // MLPE_INVERTER_BRANDS (/\biq\s?[678]\b/ needs a boundary after the digit); that is filed with #213.
  const id = await projectWithPlanSet({ ...NO_RSD_WORDS, invModel: "Enphase IQ8M-72-2-US", invQty: "20", dcKw: "10.0" });
  const before = rawReport(id);
  const warning = before.findings.find((f) => f.id === RSD);
  assert.equal(warning?.severity, "warning", "with micro-inverters RSD should be a warning");
  await applyVisionToReviewerReport(db, fakeVision("high"), before);
  assert.equal(cachedVerdict(id, RSD)?.present, true, "no verdict was cached for the warning");
  // The real edit door (PUT /api/projects/:id); the PDF is untouched. The canonical aliases are sent
  // too, because updateProject does not re-derive them from invModel yet (#225).
  repo.updateProject(db, id, { ...STRING_INVERTER, inverterModel: STRING_INVERTER.invModel, inverterQuantity: STRING_INVERTER.invQty } as never);
  const after = rawReport(id);
  const blocker = after.findings.find((f) => f.id === RSD)!;
  assert.equal(blocker.severity, "blocker", "with a string inverter RSD should be a blocker");
  assert.notEqual(visionQuestionFor(blocker), visionQuestionFor(warning!), "the two findings ask the same question: this case proves nothing");
  const got = await readers(id, after);
  for (const [reader, value] of Object.entries(got)) if (reader !== "packetCount") assert.ok(value.includes(RSD), `${reader} relaxed the blocker on the warning's verdict`);
  assertAllReaders(got, blockersOf(after), "raw");
});

// 6: one door, checked on the syntax tree.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.resolve(HERE, "../src"), path.resolve(HERE, "../../scripts")];
// Identifier occurrences allowed per file (declarations, imports and calls all count). Anything not
// listed must be 0. Raise a number only with the reason beside it.
const ALLOWED: Record<string, Record<string, number>> = {
  // the declaration; reviewerGateReportFor's body; getReviewerReportWithVision (the full vision pass
  // starts from the text report)
  buildReviewerReportFor: { "repository.ts": 3 },
  // the declaration and its fallback inside applyVisionToReviewerReport; repository's import and the
  // one call in reviewerGateReportFor
  applyCachedVisionVerdicts: { "reviewerVision.ts": 2, "repository.ts": 2 },
  // the engine itself; repository.buildReviewerReportFor (import + call); reviewPacks, the standalone
  // review product, which reviews an uploaded package, not a project's filing (import + call)
  buildReviewerReport: { "reviewerEngine.ts": 1, "repository.ts": 2, "reviewPacks.ts": 2 },
  // asking the async pass for cached verdicts only: the gate's readers use reviewerGateReportFor
  cacheOnly: { "reviewerVision.ts": Infinity },
};
function identifierCounts(file: string): Map<string, number> {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    // Own keys only: `in` would also match toString, constructor and every other Object.prototype name.
    if (ts.isIdentifier(node) && Object.hasOwn(ALLOWED, node.text)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}
await check("6. MUST-EXCLUDE no production module reaches the raw builder, the cached fold or a cache-only pass outside the one door", () => {
  const files = ROOTS.flatMap((root) => fs.readdirSync(root, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".ts") && !/\.test\.ts$|\.d\.ts$/.test(f)).map((f) => path.join(root, f)));
  assert.ok(files.length > 100, `scanned only ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    for (const [name, n] of identifierCounts(file)) {
      const limit = ALLOWED[name][path.basename(file)] ?? 0;
      if (n > limit) offenders.push(`${name} x${n} in ${path.relative(path.resolve(HERE, "../.."), file)} (allowed ${limit})`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n         "));
});

finish("reviewerSeverityParity");
