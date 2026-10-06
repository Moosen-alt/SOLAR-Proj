// ONE ANSWER TO "WHAT HOLDS THIS FILING" (issue #214; owner ruling 2026-10-05: YES).
//
// The submit gate and the correction notice folded cached vision verdicts into the reviewer's
// severities. Staging (prepareSubmission), Approve / next-step (reviewerBlockerList, which feeds
// runAutopilotApproval) and the plain reviewer report did not. A live Utah project showed 2 holds on
// the gate while 3 blockers refused staging. Every reader now goes through
// repository.reviewerGateReportFor.
//
// Fixtures are SYNTHETIC: the stage fixture's Portland/PGE job and a one-page pdf-lib plan set. No
// names, addresses or real plan sets. The cache is written by the PRODUCTION writer: the real vision
// pass (applyVisionToReviewerReport) with a fake LLM, as the operator's "run the gate with vision"
// does.
//
//   MUST-PASS    A high-confidence "present" verdict on a relaxable blocker
//                (city.elec.rapid-shutdown-missing) relaxes it in EVERY reader. The gate's holds, the
//                notice's holds, reviewerBlockerList, prepareSubmission's 409, getReviewerReport and
//                readStageResults all name the same blockers, which are the vision pass's own.
//   MUST-EXCLUDE A measured finding (city.elec.dc-size-mismatch) stays a blocker in every reader,
//                even with a "present/high" verdict. A LOW-confidence verdict relaxes nothing anywhere.
//   MUST-EXCLUDE No production module reaches the raw text builder (buildReviewerReportFor), or folds
//                cached verdicts itself, except through reviewerGateReportFor. Only the full vision
//                pass starts from the raw report.
//
// Run: npx tsx backend/test/reviewerSeverityParity.test.ts
import "./_isolate"; // FIRST: generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewerReport } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("reviewer-severity-parity");
const { db, repo } = fx;
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const docs = await import("../src/projectDocuments");
const { applyVisionToReviewerReport } = await import("../src/reviewerVision");
const { reviewerBlockerList } = await import("../src/nextStep");
const { readCorrectionNotice } = await import("../src/correctionNotice");

const RSD = "city.elec.rapid-shutdown-missing"; // presence rule, topic rapidShutdown: vision may relax it
const DC = "city.elec.dc-size-mismatch"; // arithmetic, in MEASURED_FINDING_IDS: vision never relaxes it

// The stage fixture names rapid shutdown in three fields and runs Enphase micros (MLPE caps RSD at a
// warning). A string inverter and those three fields without the words make RSD a text blocker; a DC
// size that misses 20 x 430 W makes the measured blocker.
const PROJECT = {
  invModel: "Sunny Boy SB7.7-1SP-US-41", invQty: "1", dcKw: "10.0",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A.",
  labelsText: "PV label schedule includes service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
};

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

/** A project whose vision cache the real vision pass has written. Returns the raw text blockers
 *  and the vision pass's own blockers: the answer every reader must give. */
async function projectWithVerdicts(confidence: "high" | "low") {
  const id = fx.newProject(PROJECT as never);
  // The fixture already saved a placeholder plan set. Newest-first lookup must find the real PDF,
  // so give it a later upload time.
  await new Promise((r) => setTimeout(r, 20));
  docs.saveProjectDocument(db, id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: await planSetPdf(), source: "upload",
  });
  // Text extraction lands after the upload returns. Read nothing until it has, or two readers would
  // judge different text. The column starts as '' (NOT NULL DEFAULT ''); extraction always writes
  // either the text or "[no text layer]".
  const deadline = Date.now() + 20_000;
  while (db.get("SELECT 1 FROM project_documents WHERE project_id = ? AND content_type LIKE '%pdf%' AND extracted_text = ''", [id])) {
    if (Date.now() > deadline) throw new Error("plan-set text extraction did not land within 20 s");
    await new Promise((r) => setTimeout(r, 50));
  }
  const project = repo.getProjectDetail(db, id).project;
  const raw = repo.buildReviewerReportFor(db, project);
  const vision = await applyVisionToReviewerReport(db, fakeVision(confidence), raw);
  return { id, raw, rawBlockers: blockersOf(raw), visionBlockers: blockersOf(vision) };
}

/** Every reader's answer to "which reviewer findings hold this filing", as sorted finding ids. */
async function readers(id: string, raw: ReviewerReport): Promise<Record<string, string[]>> {
  const idByTitle = new Map(raw.findings.map((f) => [f.title, f.id]));
  const project = repo.getProjectDetail(db, id).project;

  const gate = repo.getSubmitGateReport(db, id);
  const permit = gate.checks.find((c) => c.id === "permit-requirements");
  const gateHolds = (permit?.holds ?? []).map((h) => idByTitle.get(h.label) ?? `?${h.label}`).sort();

  const notice = readCorrectionNotice(db, id);
  const noticeHolds = notice.items.filter((i) => i.weight === "hold").map((i) => i.findingId).sort();
  assert.equal(notice.counts.hold, noticeHolds.length, "notice header count disagrees with its own items");

  const approve = reviewerBlockerList(db, project).map((b) => b.code).sort();

  let staging: string[] = [];
  try {
    await repo.prepareSubmission(db, id);
    assert.fail("prepareSubmission staged a project the reviewer holds");
  } catch (err) {
    const details = (err as { details?: { reviewerBlockers?: string[] } }).details;
    assert.ok(details && Array.isArray(details.reviewerBlockers),
      `prepareSubmission refused before the reviewer gate: ${err instanceof Error ? err.message : String(err)}`);
    staging = details.reviewerBlockers.map((t) => idByTitle.get(t) ?? `?${t}`).sort();
  }

  const reviewer = blockersOf(repo.getReviewerReport(db, id)); // also writes the audit row stage results need
  const stage = await repo.readStageResults(db, id);
  assert.ok(stage.reviewerReport, "readStageResults returned no reviewer report after a gate run");
  const pageLoad = blockersOf(stage.reviewerReport!);

  return { gateHolds, noticeHolds, approve, staging, reviewer, pageLoad };
}

console.log("reviewer severity parity: one answer to what holds a filing (#214)");

const high = await projectWithVerdicts("high");
await check("precondition: the raw text report holds on both the relaxable and the measured blocker", () => {
  assert.ok(high.rawBlockers.includes(RSD), `raw blockers: ${high.rawBlockers.join(", ")}`);
  assert.ok(high.rawBlockers.includes(DC), `raw blockers: ${high.rawBlockers.join(", ")}`);
});
await check("precondition: the vision pass (present/high) relaxed RSD and kept the measured DC blocker", () => {
  assert.ok(!high.visionBlockers.includes(RSD), `vision pass blockers: ${high.visionBlockers.join(", ")}`);
  assert.ok(high.visionBlockers.includes(DC));
});
const highReaders = await readers(high.id, high.raw);
for (const [reader, got] of Object.entries(highReaders)) {
  await check(`MUST-PASS ${reader}: the vision-relaxed RSD no longer holds; the same blockers as the vision pass`, () => {
    assert.deepEqual(got, high.visionBlockers, `${reader}: ${JSON.stringify(got)} vs vision pass ${JSON.stringify(high.visionBlockers)}`);
  });
}
await check("MUST-EXCLUDE the measured DC mismatch still holds in every reader despite a present/high verdict", () => {
  for (const [reader, got] of Object.entries(highReaders)) assert.ok(got.includes(DC), `${reader} dropped the measured blocker`);
});

const low = await projectWithVerdicts("low");
const lowReaders = await readers(low.id, low.raw);
await check("MUST-EXCLUDE a low-confidence verdict relaxes nothing: every reader holds on the raw text blockers", () => {
  assert.ok(low.rawBlockers.includes(RSD));
  assert.deepEqual(low.visionBlockers, low.rawBlockers, "the vision pass relaxed on a low-confidence verdict");
  for (const [reader, got] of Object.entries(lowReaders)) {
    assert.deepEqual(got, low.rawBlockers, `${reader}: ${JSON.stringify(got)} vs raw ${JSON.stringify(low.rawBlockers)}`);
  }
});

// ONE DOOR. A reader that builds the raw text report or folds cached verdicts itself is how the split
// came back. Scan production code for those calls outside the allowed functions.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ALLOWED: Record<string, Set<string>> = {
  buildReviewerReportFor: new Set(["repository.ts:reviewerGateReportFor", "repository.ts:getReviewerReportWithVision"]),
  applyCachedVisionVerdicts: new Set(["repository.ts:reviewerGateReportFor"]),
};
function enclosingFunction(source: string, index: number): string {
  const before = source.slice(0, index);
  const all = [...before.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)];
  return all.length ? all[all.length - 1][1] : "(top level)";
}
await check("MUST-EXCLUDE no production reader reaches the raw builder or the cached-verdict fold except through reviewerGateReportFor", () => {
  const offenders: string[] = [];
  const files = fs.readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 50, `scanned only ${files.length} files under ${SRC}`);
  for (const rel of files) {
    const source = fs.readFileSync(path.join(SRC, rel), "utf8");
    const code = source.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n"); // comments name them freely
    for (const name of Object.keys(ALLOWED)) {
      for (const m of code.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
        const at = m.index ?? 0;
        if (/function\s+$/.test(code.slice(Math.max(0, at - 20), at))) continue; // its own declaration
        const fn = enclosingFunction(code, at);
        if (!ALLOWED[name].has(`${path.basename(rel)}:${fn}`)) offenders.push(`${name}( in ${rel} (function ${fn})`);
      }
    }
    // A call (not the declaration's `cacheOnly?:` option) asking the async pass for cached verdicts only.
    if (/applyVisionToReviewerReport\([^;]*\{\s*cacheOnly:\s*true/.test(code)) offenders.push(`a cache-only vision pass in ${rel}: read reviewerGateReportFor instead`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n         "));
});

finish("reviewerSeverityParity");
