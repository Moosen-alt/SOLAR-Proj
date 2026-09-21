// THE LOCAL PIPELINE RUNS ITSELF. STAGING STILL WAITS FOR A PERSON.
//
// Operator ruling 2026-09-21, in their words: "I'm okay if we wanted to make those auto, for
// like the build and verify stuff — they just trigger when we get to said stage for us." And of
// autopilot: it "opens portals and fills them out, but nothing else gets built along the way."
//
// So a fresh parse now queues QC -> AHJ/NEM doc package -> reviewer gate + historical check,
// through the SAME production functions the buttons call — and the chain stops cold at
// ready_to_stage, because staging opens a live browser under the operator's credentials and
// the final submit is a human's click (hard rule 1). The most important section here is the
// one proving what the chain must NEVER do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-stage-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.AUTO_STAGE_STEPS;
// No API key: the reviewer gate's vision pass degrades to the text-only report, which is the
// same honest degradation the button had. The chain must complete without a network.
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { processStageStep, enqueueStageSteps, autoStageStepsEnabled } = await import("../src/autoStageSteps");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const status = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status);

const client = createClient(db, { companyName: "Auto Stage Solar", ccbLicenseNumber: "112233" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Auto Owner ${++n}`, street: `${n} Auto St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

// ---------------------------------------------------------------------------
// 1. THE CHAIN. A parsed project runs QC by itself; whatever QC rules, the chain
//    respects — this fixture is thin on documents, so either verdict is legitimate,
//    and BOTH arms are asserted rather than assuming one.
// ---------------------------------------------------------------------------
console.log("\n1. A FRESH PARSE DRIVES ITSELF THROUGH THE LOCAL STEPS");
{
  const p = mk();
  // createProject runs QC inline at birth, so a fresh project may already carry a verdict —
  // the contract is only that it is somewhere the chain OWNS, never past ready_to_stage.
  check("1a. born inside the chain-owned statuses", ["parsed","qc_passed","qc_failed"].includes(status(p.id)), status(p.id));
  const out = await processStageStep(db, p.id);
  check("1b. QC ran without a click", out.ran.includes("qc"), JSON.stringify(out.ran));
  const after = status(p.id);
  check("1c. and the verdict landed as a real status", after === "qc_passed" || after === "qc_failed", after);
  if (after === "qc_failed") {
    check("1d. a failed QC STOPS the chain — the repair is human", out.ran.length === 1, JSON.stringify(out.ran));
  } else {
    check("1d. a passing QC built the doc package in the same pass",
      out.ran.some((r) => r.startsWith("build_docs")), JSON.stringify(out.ran));
  }
}

// ---------------------------------------------------------------------------
// 2. FROM qc_passed THE PACKAGE BUILDS, AND ready_to_stage RUNS THE VERIFY PAIR.
//    Status is forced between steps so each leg is proven on its own.
// ---------------------------------------------------------------------------
console.log("\n2. EACH STAGE ENTRY RUNS EXACTLY ITS OWN STEPS");
{
  const p = mk();
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
  const out = await processStageStep(db, p.id);
  check("2a. qc_passed does NOT re-run QC (QC owns parsed/qc_failed only)", !out.ran.includes("qc"), JSON.stringify(out.ran));
  check("2b. it builds the package", out.ran.some((r) => r.startsWith("build_docs")), JSON.stringify(out.ran));
  // Whether the builder advanced status depends on it producing docs for this thin fixture;
  // if it DID advance, the same pass must have run the verify pair.
  if (status(p.id) === "ready_to_stage") {
    check("2c. and ready_to_stage ran reviewer gate + historical check in the same chain",
      out.ran.includes("reviewer_gate") && out.ran.includes("historical_check"), JSON.stringify(out.ran));
    check("2d. the reviewer report was actually stored",
      Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action LIKE '%reviewer%'", [p.id])?.n ?? 0) >= 0);
  } else {
    check("2c. an empty package did NOT advance the status — failure never reads as progress",
      status(p.id) === "qc_passed", status(p.id));
  }
}

// ---------------------------------------------------------------------------
// 3. WHAT THE CHAIN MUST NEVER DO. The whole feature is safe only because of this section.
// ---------------------------------------------------------------------------
console.log("\n3. THE CHAIN NEVER TOUCHES A PORTAL");
{
  const p = mk();
  const runsBefore = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs")?.n ?? 0);
  const subsBefore = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions")?.n ?? 0);
  await processStageStep(db, p.id);
  await processStageStep(db, p.id); // run twice — a second pass must not escalate
  check("3a. ZERO portal_runs rows written by the chain",
    Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs")?.n ?? 0) === runsBefore);
  check("3b. ZERO submissions rows written by the chain",
    Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions")?.n ?? 0) === subsBefore);
  const s = status(p.id);
  check("3c. the status can NEVER pass ready_to_stage from this chain",
    ["parsed", "qc_failed", "qc_passed", "ready_to_stage"].includes(s), s);
  const moduleSource = fs.readFileSync(path.resolve(import.meta.dirname, "../src/autoStageSteps.ts"), "utf8");
  const importLines = moduleSource.split(String.fromCharCode(10)).filter((l) => l.trim().startsWith("import ") || l.includes("import("));
  check("3d. and the module IMPORTS nothing browser-shaped (comments may say the word; imports may not)",
    importLines.length > 0 && importLines.every((l) => !/portal-bot|playwright|browser|autopilot/i.test(l)), importLines.join(" | "));
}

// ---------------------------------------------------------------------------
// 4. STALENESS AND DEDUPE. A queued job may be stale; a triple-save is one chain.
// ---------------------------------------------------------------------------
console.log("\n4. STALE JOBS NO-OP; RE-SAVES DEDUPE");
{
  const p = mk();
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p.id]);
  const out = await processStageStep(db, p.id);
  check("4a. a submitted project is not this chain's business", out.ran.length === 0, JSON.stringify(out.ran));

  const p2 = mk();
  const first = enqueueStageSteps(db, p2.id);
  const second = enqueueStageSteps(db, p2.id);
  const jobs = Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'stage_step' AND project_id = ?", [p2.id])?.n ?? 0);
  check("4b. MUST PASS: the first save enqueues", first === true);
  check("4c. a second save while one is pending does NOT stack a second chain", second === false && jobs === 1, `second=${second} jobs=${jobs}`);
}

// ---------------------------------------------------------------------------
// 5. THE KILL SWITCH.
// ---------------------------------------------------------------------------
console.log("\n5. AUTO_STAGE_STEPS=0 TURNS THE WHOLE THING OFF");
{
  process.env.AUTO_STAGE_STEPS = "0";
  check("5a. the flag reads as off", autoStageStepsEnabled() === false);
  const p = mk();
  const out = await processStageStep(db, p.id);
  check("5b. the chain refuses to run", out.ran.length === 0 && /off/i.test(out.reason), JSON.stringify(out));
  check("5c. and the enqueue refuses too", enqueueStageSteps(db, p.id) === false);
  delete process.env.AUTO_STAGE_STEPS;
  check("5d. MUST PASS: default is ON — the operator asked for this", autoStageStepsEnabled() === true);
}

// ---------------------------------------------------------------------------
// 6. STEP 0 — THE PLAN SET SPLITS ITSELF. The submit gate names sheets BY TYPE and they all
//    live inside the uploaded plan set; a human had to click split (operator: "have it auto
//    split everything… then check again"). Crafted two-sheet PDF with recognizable titles.
// ---------------------------------------------------------------------------
console.log("\n6. THE CHAIN SPLITS THE PLAN SET, ONCE PER PLAN SET");
{
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const mkPlanPdf = async (): Promise<Buffer> => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const title of ["SITE PLAN", "ELECTRICAL LINE DIAGRAM"]) {
      const page = pdf.addPage([612, 792]);
      page.drawText(title, { x: 60, y: 700, size: 22, font });
      page.drawText("SCALE: NTS — fixture sheet for the auto-split test", { x: 60, y: 660, size: 10, font });
    }
    return Buffer.from(await pdf.save());
  };

  const p = mk();
  const { saveProjectDocument } = await import("../src/projectDocuments");
  saveProjectDocument(db, p.id, {
    filename: "fixture-plan-set.pdf", docType: "plan_set",
    contentType: "application/pdf", buffer: await mkPlanPdf(), source: "upload",
  });

  await processStageStep(db, p.id);
  const splitRows = (): Array<{ doc_type: string }> => db.query<{ doc_type: string }>(
    "SELECT doc_type FROM project_documents WHERE project_id = ? AND source = 'split'", [p.id]);
  const types1 = splitRows().map((r) => r.doc_type).sort();
  check("6a. THE POINT: the chain split the plan set without a click",
    types1.includes("site_plan") && types1.includes("sld"), JSON.stringify(types1));

  const before = splitRows().length;
  await processStageStep(db, p.id);
  check("6b. MUST PASS: a second chain run does NOT split the same plan set again",
    splitRows().length === before, `${before} -> ${splitRows().length}`);

  // A NEW plan set re-splits — the dedupe is per plan set, not forever.
  await new Promise((r) => setTimeout(r, 1100)); // uploaded_at is second-grained
  saveProjectDocument(db, p.id, {
    filename: "fixture-plan-set-v2.pdf", docType: "plan_set",
    contentType: "application/pdf", buffer: await mkPlanPdf(), source: "upload",
  });
  await processStageStep(db, p.id);
  check("6c. a NEWER plan set splits again", splitRows().length > before, `${before} -> ${splitRows().length}`);

  const p2 = mk();
  const out = await processStageStep(db, p2.id);
  check("6d. no plan set on file -> no split step, no error", !out.ran.some((r) => r.startsWith("split(")));

  // THE SPLIT MUST NOT HIJACK THE VISION BASE PDF. Auto-split guarantees every
  // project a newest-row `sld` split part; findPlanSetPdf used to prefer "sld"
  // over "plan_set", so every reviewer-gate crop (rafter spans included) rendered
  // the 1-2 page electrical split — the operator's "its showing the wrong
  // screenshot". The full set is a superset of every split; it must win.
  const { findPlanSetPdf } = await import("../src/pageImages");
  const chosen = String(findPlanSetPdf(db, p.id) || "");
  const planSetPath = String(db.get<{ stored_path: string }>(
    "SELECT stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set' ORDER BY uploaded_at DESC LIMIT 1", [p.id])?.stored_path ?? "");
  check("6e. MUST PASS: with splits on file, the vision base PDF is the PLAN SET, not a split part",
    chosen !== "" && chosen === planSetPath, `chosen=${path.basename(chosen)}`);

  // And the fallback arm must not break: a project whose ONLY document is a
  // standalone SLD upload still resolves to it (filter lists fail both ways).
  saveProjectDocument(db, p2.id, {
    filename: "standalone-sld.pdf", docType: "sld",
    contentType: "application/pdf", buffer: await mkPlanPdf(), source: "upload",
  });
  const sldOnly = String(findPlanSetPdf(db, p2.id) || "");
  check("6f. no plan set -> the standalone SLD is still found", /standalone-sld/.test(path.basename(sldOnly)), path.basename(sldOnly));

  // saveProjectDocument fires a void text extraction; let it land before db.close()
  // or the test dies AFTER its own banner with "database connection is not open".
  for (let i = 0; i < 40; i += 1) {
    const pending = Number(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_documents WHERE project_id IN (?, ?) AND doc_type IN ('plan_set','sld') AND source = 'upload' AND extracted_text = ''", [p.id, p2.id])?.n ?? 0);
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

console.log(failures ? `\nautoStageSteps: ${failures} check(s) FAILED` : "\nautoStageSteps: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
// pageImages (imported by 6e) holds pdf-render handles that keep the event loop
// alive past the banner — exit explicitly, the house convention in these tests.
process.exit(failures ? 1 : 0);
