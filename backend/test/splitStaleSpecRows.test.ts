// A SPEC PART THE OLD CLASSIFIER CUT FROM THE WRONG PAGE IS WITHDRAWN, NOT KEPT (#77).
//
// Before #66 the splitter filed a WIRING CALCULATIONS sheet as inverter_spec and title-only
// EQUIPMENT SPECIFICATION cut-sheets as module_spec. #75 fixed the classifier, but projects split
// before it kept those rows: the gap check only re-cut a type with NO split row, the gate counted
// the stale rows present ("attached file"), and the hasSheets guards skipped a re-split because the
// rows existed. This fixture rebuilds that state synthetically (pdf-lib, no real plan set) and runs
// the real chain. No API key → StubLLMProvider, no network.
// Run: tsx backend/test/splitStaleSpecRows.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-stale-spec-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.AUTO_STAGE_STEPS;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, getProjectDetail } = await import("../src/repository");
const { saveProjectDocument, deleteProjectDocument, documentTypesDeletedSince } = await import("../src/projectDocuments");
const { ensurePlanSetSplit } = await import("../src/docSplitter");
const { processStageStep } = await import("../src/autoStageSteps");
const { documentInventory } = await import("../src/requiredDocuments");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   - ${label}`); return; }
  failures += 1;
  console.log(`  FAIL - ${label}${detail ? ` — ${detail}` : ""}`);
};

const client = createClient(db, { companyName: "Stale Split Solar", ccbLicenseNumber: "778899" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Stale Owner ${++n}`, street: `${n} Fixture Ln`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

// The reported set's shape (#66): a title block on every sheet, the calcs sheet's spec TABLES, and
// image cut-sheets whose only text is the title block.
type Sheet = { lines: string[]; image?: boolean };
const tb = (sheet: string, name: string) => ["SYNTH SOLAR CO  123 FIXTURE RD", `SHEET NAME: ${name}`, `SHEET NUMBER: ${sheet}`];
const SHEETS: Record<string, Sheet> = {
  sitePlan: { lines: [...tb("PV-1", "SITE PLAN"), "36\" FIRE SETBACK FROM RIDGE"] },
  sld: { lines: [...tb("PV-6", "ELECTRICAL LINE DIAGRAM"), "MICROINVERTER BRANCH CIRCUIT"] },
  calcs: { lines: [...tb("PV-7", "WIRING CALCULATIONS"), "(N) PV MODULE SPECIFICATIONS  PMAX 400 W",
    "INVERTER SPECIFICATIONS  MAX AC OUTPUT 315 VA", "CONDUCTOR AMPACITY: 10 AWG THWN-2"] },
  equip1: { lines: tb("PV-11", "EQUIPMENT SPECIFICATION"), image: true },
  equip2: { lines: tb("PV-12", "EQUIPMENT SPECIFICATION"), image: true },
  moduleSpec: { lines: tb("PV-9", "PV MODULE SPECIFICATION SHEET"), image: true },
  inverterSpec: { lines: tb("PV-10", "MICROINVERTER SPECIFICATION SHEET"), image: true },
};
const mkPdf = async (order: string[]): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const key of order) {
    const s = SHEETS[key];
    const page = pdf.addPage([1224, 792]);
    if (s.image) page.drawRectangle({ x: 40, y: 120, width: 760, height: 620, color: rgb(0.85, 0.85, 0.85) });
    s.lines.forEach((line, i) => page.drawText(line, { x: 820, y: 740 - i * 20, size: 8, font }));
  }
  return Buffer.from(await pdf.save());
};
// Cut 0-based pages out of a plan set exactly the way the splitter does (copyPages).
const cut = async (plan: Buffer, pages: number[]): Promise<Buffer> => {
  const src = await PDFDocument.load(plan);
  const out = await PDFDocument.create();
  (await out.copyPages(src, pages)).forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
};
// The split rows are timestamped by uploaded_at; keep each write strictly after the last.
const tick = () => new Promise((r) => setTimeout(r, 5));

const STALE_SET = ["sitePlan", "sld", "calcs", "equip1", "equip2"];
const rows = (pid: string) => db.query<{ id: string; doc_type: string; source: string; stored_path: string }>(
  "SELECT id, doc_type, source, stored_path FROM project_documents WHERE project_id = ? ORDER BY uploaded_at", [pid]);
const splitRows = (pid: string) => rows(pid).filter((r) => r.source === "split");

const logged: string[] = [];
const origLog = console.log;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try { return await fn(); } finally { console.log = origLog; }
};

// A project as the pre-#66 classifier left it: the plan set, then split rows newer than it — the
// site plan and SLD right, inverter_spec = the calcs sheet, module_spec = the two cut-sheets.
const staleProject = async () => {
  const p = mk();
  const plan = await mkPdf(STALE_SET);
  saveProjectDocument(db, p.id, { filename: "stale-plan.pdf", docType: "plan_set", contentType: "application/pdf", buffer: plan, source: "upload" });
  await tick();
  const parts: Array<[string, number[]]> = [["site_plan", [0]], ["sld", [1]], ["inverter_spec", [2]], ["module_spec", [3, 4]]];
  for (const [docType, pages] of parts) {
    saveProjectDocument(db, p.id, { filename: `old - ${docType}.pdf`, docType, contentType: "application/pdf", buffer: await cut(plan, pages), source: "split" });
  }
  // …and the package ZIP built from them (any bytes: only its row matters here).
  saveProjectDocument(db, p.id, { filename: "old - all package.zip", docType: "utility_package_zip", contentType: "application/zip", buffer: Buffer.from("PK\x05\x06" + "\0".repeat(18), "binary"), source: "split" });
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
  return { p, plan };
};
const presence = (pid: string, docType: string) =>
  documentInventory(db, getProjectDetail(db, pid).project).presence.find((d) => d.docType === docType);

// ---------------------------------------------------------------------------
console.log("\n1. A PRE-#66 inverter_spec (THE CALCS SHEET) AND module_spec (CUT-SHEETS) ARE WITHDRAWN");
{
  const { p } = await staleProject();
  const before = splitRows(p.id);
  check("1a. precondition: the stale inverter_spec counts as attached", /attached file/.test(presence(p.id, "inverter_spec")?.via ?? ""), JSON.stringify(presence(p.id, "inverter_spec")));
  await quiet(() => processStageStep(db, p.id));
  const after = splitRows(p.id);
  check("1b. THE POINT: no inverter_spec row is left", !after.some((r) => r.doc_type === "inverter_spec"), after.map((r) => r.doc_type).join(","));
  check("1c. no module_spec row is left", !after.some((r) => r.doc_type === "module_spec"), after.map((r) => r.doc_type).join(","));
  const inv = presence(p.id, "inverter_spec");
  check("1d. the gate reports the inverter spec as not present", !!inv && !inv.present, JSON.stringify(inv));
  const keep = (t: string) => before.find((r) => r.doc_type === t)?.id;
  check("1e. the right site_plan and sld rows are untouched",
    after.some((r) => r.id === keep("site_plan")) && after.some((r) => r.id === keep("sld")), after.map((r) => `${r.doc_type}:${r.id}`).join(","));
  const stalePaths = before.filter((r) => r.doc_type.endsWith("_spec")).map((r) => r.stored_path);
  check("1f. the withdrawn files are gone from disk", stalePaths.every((f) => !fs.existsSync(f)));
  check("1f2. the package ZIP that bundled them is withdrawn too", !after.some((r) => r.doc_type === "utility_package_zip"), after.map((r) => r.doc_type).join(","));
  check("1g. a withdrawal is NOT a person's deletion (it must not block a later re-cut)",
    documentTypesDeletedSince(db, p.id, "1970").size === 0, [...documentTypesDeletedSince(db, p.id, "1970")].join(","));
  // A second pass: nothing left to withdraw, nothing to re-cut.
  const count = rows(p.id).length;
  const o2 = await quiet(() => processStageStep(db, p.id));
  check("1h. a second pass neither re-splits nor writes", !o2.ran.some((r) => r.startsWith("split(")) && rows(p.id).length === count, `${count} -> ${rows(p.id).length} ${JSON.stringify(o2.ran)}`);
}

// ---------------------------------------------------------------------------
console.log("\n2. A HAND-UPLOADED inverter_spec IS NEVER TOUCHED");
{
  const { p, plan } = await staleProject();
  await tick();
  // A person attached the calcs page themselves, under inverter_spec — their call, not ours.
  const hand = saveProjectDocument(db, p.id, { filename: "my-inverter.pdf", docType: "inverter_spec", contentType: "application/pdf", buffer: await cut(plan, [2]), source: "upload" });
  const handPath = rows(p.id).find((r) => r.id === hand.id)!.stored_path;
  await quiet(() => processStageStep(db, p.id));
  check("2a. the hand upload's row is still there", rows(p.id).some((r) => r.id === hand.id));
  check("2b. and its file is still on disk", fs.existsSync(handPath));
  check("2c. the stale SPLIT inverter_spec beside it is withdrawn", !splitRows(p.id).some((r) => r.doc_type === "inverter_spec"));
  const inv = presence(p.id, "inverter_spec");
  check("2d. the gate counts the person's upload", !!inv?.present && /attached file/.test(inv.via), JSON.stringify(inv));
}

// ---------------------------------------------------------------------------
console.log("\n3. CORRECT SPEC ROWS: NO CHURN ACROSS TWO STAGE PASSES");
{
  const p = mk();
  saveProjectDocument(db, p.id, { filename: "good-plan.pdf", docType: "plan_set", contentType: "application/pdf",
    buffer: await mkPdf(["sitePlan", "sld", "calcs", "moduleSpec", "inverterSpec"]), source: "upload" });
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
  const o1 = await quiet(() => processStageStep(db, p.id));
  check("3a. the first pass splits", o1.ran.some((r) => r.startsWith("split(")), JSON.stringify(o1.ran));
  const ids = rows(p.id).map((r) => r.id).join(",");
  check("3b. it cut an inverter_spec and a module_spec", ["inverter_spec", "module_spec"].every((t) => splitRows(p.id).some((r) => r.doc_type === t)));
  for (const pass of [2, 3]) {
    const o = await quiet(() => processStageStep(db, p.id));
    check(`3c. pass ${pass}: no re-split, no row added or removed`, !o.ran.some((r) => r.startsWith("split(")) && rows(p.id).map((r) => r.id).join(",") === ids, JSON.stringify(o.ran));
  }
}

// ---------------------------------------------------------------------------
console.log("\n4. THE STAGE / LEARN GUARD RE-SPLITS ONLY WHEN THE CLASSIFIER'S ANSWER CHANGED (#75 review)");
{
  // A set whose only spec pages are title-only cut-sheets: module_spec / inverter_spec never get a
  // split row, so the old `hasSheets` guard re-split the package on every stage pass.
  const p = mk();
  saveProjectDocument(db, p.id, { filename: "title-only.pdf", docType: "plan_set", contentType: "application/pdf",
    buffer: await mkPdf(STALE_SET), source: "upload" });
  const r1 = await ensurePlanSetSplit(db, p.id, "nem", ["sld", "site_plan", "inverter_spec"]);
  check("4a. the first call splits (nothing split yet)", r1.split, JSON.stringify(r1));
  const count = rows(p.id).length;
  const r2 = await ensurePlanSetSplit(db, p.id, "nem", ["sld", "site_plan", "inverter_spec"]);
  check("4b. THE POINT: the second call does not re-split", !r2.split && rows(p.id).length === count, `${count} -> ${rows(p.id).length} ${JSON.stringify(r2)}`);
  const stale = await staleProject();
  const r3 = await ensurePlanSetSplit(db, stale.p.id, "permit", ["sld", "site_plan", "structural", "module_spec", "inverter_spec"]);
  check("4c. on a stale project the guard withdraws the wrong spec rows", r3.withdrawn.includes("inverter_spec") && !splitRows(stale.p.id).some((r) => r.doc_type === "inverter_spec"), JSON.stringify(r3));
}

// ---------------------------------------------------------------------------
console.log("\n5. A SPEC PART A PERSON DELETED IS NOT RE-CUT");
{
  const p = mk();
  saveProjectDocument(db, p.id, { filename: "deleted-spec.pdf", docType: "plan_set", contentType: "application/pdf",
    buffer: await mkPdf(["sitePlan", "sld", "moduleSpec", "inverterSpec"]), source: "upload" });
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
  await quiet(() => processStageStep(db, p.id));
  const row = splitRows(p.id).find((r) => r.doc_type === "inverter_spec");
  if (row) deleteProjectDocument(db, p.id, row.id);
  const o = await quiet(() => processStageStep(db, p.id));
  check("5a. MUST-EXCLUDE: no re-split and no inverter_spec re-cut",
    !o.ran.some((r) => r.startsWith("split(")) && !splitRows(p.id).some((r) => r.doc_type === "inverter_spec"), JSON.stringify(o.ran));
}

// ---------------------------------------------------------------------------
console.log("\n6. A STALE PART WHOSE TYPE THE CLASSIFIER DOES FIND IS RE-CUT WITH THE RIGHT PAGE");
{
  const { extractPdfPages } = await import("../src/batchImport");
  const p = mk();
  const plan = await mkPdf([...STALE_SET, "moduleSpec"]);
  saveProjectDocument(db, p.id, { filename: "recut-plan.pdf", docType: "plan_set", contentType: "application/pdf", buffer: plan, source: "upload" });
  await tick();
  for (const [docType, pages] of [["site_plan", [0]], ["sld", [1]], ["module_spec", [3, 4]]] as Array<[string, number[]]>) {
    saveProjectDocument(db, p.id, { filename: `old - ${docType}.pdf`, docType, contentType: "application/pdf", buffer: await cut(plan, pages), source: "split" });
  }
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
  const o = await quiet(() => processStageStep(db, p.id));
  check("6a. the chain re-split", o.ran.some((r) => r.startsWith("split(")), JSON.stringify(o.ran));
  const mods = splitRows(p.id).filter((r) => r.doc_type === "module_spec");
  const text = mods.length === 1 ? (await extractPdfPages(mods[0].stored_path, 10)).join("\n") : "";
  check("6b. one module_spec row, and it is the named PV MODULE SPECIFICATION SHEET",
    /PV MODULE SPECIFICATION SHEET/.test(text) && !/EQUIPMENT SPECIFICATION/.test(text), `${mods.length} row(s): ${text.slice(0, 120)}`);
}

db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} stale-spec-row check(s) FAILED.`); process.exit(1); }
console.log("\nAll stale-spec-row checks passed.");
process.exit(0);
