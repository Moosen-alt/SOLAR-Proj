// TEST HARNESS: run real historical projects from the operator's manual-work archive
// (E:\INFINITY SOLAR DOCS) through intake -> parse -> QC -> reviewer gate, and record
// ACCURACY and SPEED per stage. Read-only against the archive; writes to a COPY of the
// live DB so the real one is never polluted but the learned KB/code profiles are present.
// Never touches a portal. Run: npx tsx run-test-projects.ts [limit] [--offset N]
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ARCHIVE = "E:/INFINITY SOLAR DOCS/INFINITY SOLAR DOCS/01 - CUSTOMERS";
const LIMIT = Number(process.argv[2] || 8);
const OFFSET = Number((process.argv.find((a) => a.startsWith("--offset=")) || "--offset=0").split("=")[1]);

// Work on a COPY of the live DB: real AHJ/code knowledge, zero pollution.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "testrun-"));
const liveDb = path.resolve("backend/data/autopilot.sqlite");
const scratchDb = path.join(scratch, "test.sqlite");
if (fs.existsSync(liveDb)) fs.copyFileSync(liveDb, scratchDb);
process.env.AUTOPILOT_DB_PATH = scratchDb;
process.env.PROJECT_DOCS_DIR = path.join(scratch, "docs");
process.env.AUTOPILOT_AUTO_START = "0";   // never auto-stage against a portal
process.env.PORTAL_AUTOSEED = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("./backend/src/db");
const { extractPdfText } = await import("./backend/src/batchImport");
const { createLLMProvider } = await import("./backend/src/llm");
const { createProject, rerunQc, getProjectDetail, buildReviewerReportFor } = await import("./backend/src/repository");
const { saveProjectDocument } = await import("./backend/src/projectDocuments");

const db = await openDatabase();
const llm = createLLMProvider();

// The plan set is the PDF named like the folder ("Abby Johnson - Happy Valley, OR.pdf").
// Fall back to the largest PDF, which is the plan set in every sampled folder.
function pickPlanSet(dir: string): string | null {
  const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => ({ f, full: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
  if (!pdfs.length) return null;
  const owner = path.basename(dir).split(" - ")[0].toLowerCase().replace(/[^a-z]/g, "");
  const named = pdfs.filter((p) => p.f.toLowerCase().replace(/[^a-z]/g, "").startsWith(owner));
  const pool = named.length ? named : pdfs;
  return pool.sort((a, b) => b.size - a.size)[0].full;
}

// GROUND TRUTH from the folder name: "Dennis Moore - Falls City OR" -> owner/city/state.
function groundTruth(folder: string): { owner: string; city: string; state: string } {
  const [ownerRaw, locRaw = ""] = folder.split(" - ");
  const loc = locRaw.replace(/,/g, " ").trim().split(/\s+/);
  const state = (loc[loc.length - 1] || "").toUpperCase();
  return { owner: ownerRaw.trim(), city: loc.slice(0, -1).join(" ").trim(), state: /^[A-Z]{2}$/.test(state) ? state : "" };
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const val = (fields: Record<string, { value?: string }>, k: string) => String(fields?.[k]?.value ?? "").trim();

const folders = fs.readdirSync(ARCHIVE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "COMPLETED" && d.name.includes(" - "))
  .map((d) => d.name).sort().slice(OFFSET, OFFSET + LIMIT);

const results: Record<string, unknown>[] = [];
for (const folder of folders) {
  const dir = path.join(ARCHIVE, folder);
  const gt = groundTruth(folder);
  const row: Record<string, unknown> = { folder, gt };
  const t0 = Date.now();
  try {
    const planSet = pickPlanSet(dir);
    if (!planSet) { row.error = "no PDF in folder"; results.push(row); continue; }
    row.planSet = path.basename(planSet);

    const tExtract = Date.now();
    const planText = await extractPdfText(planSet, 30);
    row.msExtract = Date.now() - tExtract;
    row.planTextChars = planText.length;
    if (planText.length < 200) row.warn = "little/no text layer (scanned?)";

    const tLlm = Date.now();
    const ex = await llm.extractProjectFields({ planText, defaultState: gt.state || "OR" });
    row.msLlm = Date.now() - tLlm;
    row.provider = ex.provider;
    const f = ex.fields as Record<string, { value?: string }>;
    row.lowConfidence = ex.lowConfidenceFields?.length ?? 0;

    const got = {
      owner: val(f, "owner") || val(f, "homeownerName"),
      street: val(f, "street") || val(f, "projectAddress"),
      city: val(f, "city"), state: val(f, "state"), zip: val(f, "zip"),
      ahj: val(f, "ahj"), utility: val(f, "utility"),
      dcKw: val(f, "dcKw"), acKw: val(f, "acKw"),
      moduleMake: val(f, "moduleMake"), moduleModel: val(f, "moduleModel"),
      // Microinverter systems (Enphase / APsystems) report pvMicro* instead of inv*.
      invMake: val(f, "invMake") || val(f, "pvMicroMake") || val(f, "inverterMake"),
      invModel: val(f, "invModel") || val(f, "pvMicroModel") || val(f, "inverterModel"),
      moduleQty: val(f, "moduleQty"), mainBreaker: val(f, "mainBreaker"), busRating: val(f, "busRating"),
    };
    row.got = got;
    // ACCURACY vs the folder name (the one ground truth we can trust for every project).
    row.ownerMatch = Boolean(got.owner) && norm(got.owner).includes(norm(gt.owner).slice(0, 6));
    row.cityMatch = Boolean(got.city) && norm(got.city) === norm(gt.city);
    row.stateMatch = got.state.toUpperCase() === gt.state;
    // COMPLETENESS of the fields a permit/NEM filing actually needs.
    const required = ["owner", "street", "city", "state", "zip", "ahj", "utility", "dcKw", "moduleMake", "moduleModel", "invMake", "invModel", "moduleQty"];
    row.missing = required.filter((k) => !String((got as Record<string, string>)[k] || "").trim());

    const payload: Record<string, unknown> = { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v?.value ?? ""])) };
    payload.owner = got.owner || gt.owner;
    payload.city = payload.city || gt.city;
    payload.state = payload.state || gt.state;
    const detail = createProject(db, payload as never);
    row.projectId = detail.project.id;

    saveProjectDocument(db, detail.project.id, {
      docType: "plan_set", filename: path.basename(planSet),
      contentType: "application/pdf", buffer: fs.readFileSync(planSet), source: "upload",
    });

    const tQc = Date.now();
    rerunQc(db, detail.project.id);
    row.msQc = Date.now() - tQc;
    const after = getProjectDetail(db, detail.project.id);
    row.qcFails = after.qcResults.filter((q) => q.qcStatus === "fail").length;
    row.qcWarns = after.qcResults.filter((q) => q.qcStatus === "warning").length;

    const tRev = Date.now();
    const report = buildReviewerReportFor(db, after.project);
    row.msReviewer = Date.now() - tRev;
    const blockers = report.findings.filter((x) => x.severity === "blocker");
    row.blockers = blockers.length;
    row.blockerTitles = blockers.map((b) => `${b.id}: ${b.message ?? b.title}`).slice(0, 8);
    row.atReviewGate = blockers.length === 0;
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  }
  row.msTotal = Date.now() - t0;
  results.push(row);
  const r = row as Record<string, unknown>;
  console.log(`${folder} | ${r.msTotal}ms (llm ${r.msLlm ?? "-"}ms) | owner=${r.ownerMatch} city=${r.cityMatch} state=${r.stateMatch} | missing=${(r.missing as string[] | undefined)?.length ?? "-"} | blockers=${r.blockers ?? "-"} ${r.error ? "| ERR " + r.error : ""}`);
}

const out = path.resolve("data/test-run-report.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, results }, null, 2));
console.log(`\nreport: ${out}`);
try { db.close(); } catch { /* ignore */ }
process.exit(0);
