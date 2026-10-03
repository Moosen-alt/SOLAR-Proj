// THE SITE PLAN IS SPLIT AS A SITE PLAN, EVEN WHEN ITS LEGEND TALKS ABOUT RAFTERS (#29).
//
// Live run: the submit gate held "Missing before staging — Site / plot plan with fire access +
// escape pathways (attach it or split it out of the plan set)" while the log said the plan set
// had split into 5 parts. The sheet PV 1.0 "EQUIPMENT LAYOUT & SITE PLAN" carried its roof legend
// ("= RAFTER"), a "ROOF SECTION(S)" block and a "TRUSS SIZE & SPACING" note — three structural
// hits against two site-plan hits, so the winner-take-all classifier filed it as structural and no
// site_plan part was ever written. This fixture rebuilds that page synthetically (pdf-lib, no real
// plan set) and runs the real chain from qc_passed. No API key → StubLLMProvider, no network.
// Run: tsx backend/test/splitSitePlan.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-site-plan-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.AUTO_STAGE_STEPS;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, getProjectDetail, getSubmitGateReport } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage } = await import("../src/docSplitter");
const { processStageStep } = await import("../src/autoStageSteps");
const { documentInventory, owedMissingDocuments } = await import("../src/requiredDocuments");
const { extractPdfPages } = await import("../src/batchImport");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   - ${label}`); return; }
  failures += 1;
  console.log(`  FAIL - ${label}${detail ? ` — ${detail}` : ""}`);
};

const client = createClient(db, { companyName: "Split Fixture Solar", ccbLicenseNumber: "445566" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Split Owner ${++n}`, street: `${n} Fixture Ln`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

// Each page is a list of text lines drawn top-down — the title-block text a real sheet carries.
const SHEETS: Record<string, string[]> = {
  cover: ["PV 0.0 COVER", "GENERAL NOTES AND PROJECT DATA", "SHEET INDEX: PV 1.0 SITE PLAN, S 1.1, E 1.1, E 1.3"],
  structural: ["S 1.1 STRUCTURAL ATTACHMENT DETAIL", "MOUNT DETAIL - LAG INTO RAFTER", "ROOF SECTION A"],
  sitePlan: [
    "PV 1.0 EQUIPMENT LAYOUT & SITE PLAN",
    "LEGEND:  = RAFTER    = FIRE PATHWAY    = PV MODULE",
    "36\" FIRE SETBACK FROM RIDGE (HATCHED)",
    "ROOF SECTION(S): ROOF 1 - 22 DEG PITCH",
    "TRUSS SIZE & SPACING: 2X4 @ 24\" O.C.",
  ],
  sld: ["E 1.1 ELECTRICAL LINE DIAGRAM", "MICROINVERTER BRANCH CIRCUIT"],
  labels: ["E 1.3 WARNING LABELS", "LABEL LOCATION PER NEC 690"],
  moduleSpec: ["PV MODULE SPECIFICATION SHEET"],
  inverterSpec: ["MICROINVERTER SPECIFICATION SHEET"],
};
const mkPlanPdf = async (order: Array<keyof typeof SHEETS>): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const key of order) {
    const page = pdf.addPage([792, 612]);
    SHEETS[key].forEach((line, i) => page.drawText(line, { x: 40, y: 560 - i * 28, size: 12, font }));
  }
  return Buffer.from(await pdf.save());
};
const FULL: Array<keyof typeof SHEETS> = ["cover", "structural", "sitePlan", "sld", "labels", "moduleSpec", "inverterSpec"];
const SITE_PAGE = 3, STRUCT_PAGE = 2;

const splitRows = (pid: string) => db.query<{ doc_type: string; stored_path: string }>(
  "SELECT doc_type, stored_path FROM project_documents WHERE project_id = ? AND source = 'split' ORDER BY uploaded_at DESC", [pid]);

// Capture the chain's log lines (logger writes info to console.log).
const logged: string[] = [];
const origLog = console.log;
const captureLog = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try { return await fn(); } finally { console.log = origLog; }
};

// ---------------------------------------------------------------------------
console.log("\n1. THE CHAIN FROM qc_passed CUTS A site_plan PART THAT HOLDS THE SITE-PLAN PAGE");
const p = mk();
saveProjectDocument(db, p.id, {
  filename: "fixture-plan-set.pdf", docType: "plan_set", contentType: "application/pdf",
  buffer: await mkPlanPdf(FULL), source: "upload",
});
db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
const out = await captureLog(() => processStageStep(db, p.id));
check("1a. the chain ran the split step", out.ran.some((r) => r.startsWith("split(")), JSON.stringify(out.ran));
const siteRow = splitRows(p.id).find((r) => r.doc_type === "site_plan");
check("1b. THE POINT: a split row with doc_type='site_plan' exists", !!siteRow, JSON.stringify(splitRows(p.id).map((r) => r.doc_type)));
const siteText = siteRow ? (await extractPdfPages(siteRow.stored_path, 10)).join("\n") : "";
check("1c. and it is the PV 1.0 site-plan page", /EQUIPMENT LAYOUT & SITE PLAN/.test(siteText) && /FIRE PATHWAY/.test(siteText), siteText.slice(0, 120));
check("1d. the split log names what was not produced (none missing here)",
  logged.some((l) => /plan set split automatically/.test(l) && /missing=none/.test(l)), logged.filter((l) => /split/.test(l)).join(" | "));

// ---------------------------------------------------------------------------
console.log("\n2. THE GATE NO LONGER OWES A SITE PLAN");
{
  const project = getProjectDetail(db, p.id).project;
  const inv = documentInventory(db, project);
  const sp = inv.presence.find((d) => d.docType === "site_plan");
  check("2a. inventory: site_plan present via an attached file", !!sp?.present && /attached file/.test(sp.via), JSON.stringify(sp));
  const owed = owedMissingDocuments(db, project, inv).owed;
  check("2b. owedMissingDocuments has no site_plan", !owed.some((d) => d.docType === "site_plan"), owed.map((d) => d.docType).join(","));
  const gate = getSubmitGateReport(db, p.id);
  // A blocker's nextAction, or a MISSING evidence line, naming the site plan. ("File attached:
  // Site / plot plan" in the evidence is the inventory reporting it PRESENT — that is the point.)
  const owedSite = gate.checks.filter((c) => c.status === "blocker").flatMap((c) => [c.nextAction, ...c.evidence.filter((e) => /^MISSING/i.test(e))])
    .filter((t) => /Site \/ plot plan/i.test(t));
  check("2c. the submit gate is not blocked on the site plan", owedSite.length === 0, owedSite.join(" | ").slice(0, 300));
  check("2d. nextAction does not ask for a Site / plot plan", !/Site \/ plot plan/i.test(gate.nextAction), gate.nextAction);
}

// ---------------------------------------------------------------------------
console.log("\n3. NO REGRESSION ON THE OTHER SHEETS (same fixture)");
{
  const pkg = await buildUtilityPackage(db, p.id, "all");
  const pages = (t: string) => pkg.parts.find((x) => x.docType === t)?.pages ?? [];
  check("3a. site_plan is exactly the site-plan page", JSON.stringify(pages("site_plan")) === JSON.stringify([SITE_PAGE]), JSON.stringify(pages("site_plan")));
  check("3b. structural still holds the S 1.1 page — and not the site plan",
    pages("structural").includes(STRUCT_PAGE) && !pages("structural").includes(SITE_PAGE), JSON.stringify(pages("structural")));
  check("3c. sld is one page", pages("sld").length === 1, JSON.stringify(pages("sld")));
  check("3d. module_spec is one page", pages("module_spec").length === 1, JSON.stringify(pages("module_spec")));
  check("3e. inverter_spec is one page", pages("inverter_spec").length === 1, JSON.stringify(pages("inverter_spec")));
  check("3f. missingDocTypes lacks site_plan", !pkg.missingDocTypes.includes("site_plan"), pkg.missingDocTypes.join(","));
  check("3g. missingSheetTypes is empty", pkg.missingSheetTypes.length === 0, pkg.missingSheetTypes.join(","));
  check("3h. only the cover/index page is unclassified", JSON.stringify(pkg.unclassifiedPages) === "[1]", JSON.stringify(pkg.unclassifiedPages));
}

// ---------------------------------------------------------------------------
console.log("\n4. A PLAN SET WITH NO SITE SHEET SAYS SO IN THE SPLIT LOG");
{
  const q = mk();
  saveProjectDocument(db, q.id, {
    filename: "no-site.pdf", docType: "plan_set", contentType: "application/pdf",
    buffer: await mkPlanPdf(["cover", "structural", "sld", "moduleSpec"]), source: "upload",
  });
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [q.id]);
  logged.length = 0;
  await captureLog(() => processStageStep(db, q.id));
  const line = logged.find((l) => /plan set split automatically/.test(l)) ?? "";
  check("4a. the log line names missing=…site_plan…", /missing=[^ ]*site_plan/.test(line), line);
  check("4b. and the unclassified pages", /unclassifiedPages=1\b/.test(line), line);
}

// ---------------------------------------------------------------------------
console.log("\n5. RE-SPLIT ON REPAIR: A PROJECT SPLIT BY THE OLD SCORING GETS ITS SITE PLAN");
{
  const r = mk();
  const planBytes = await mkPlanPdf(FULL);
  saveProjectDocument(db, r.id, {
    filename: "old-split.pdf", docType: "plan_set", contentType: "application/pdf", buffer: planBytes, source: "upload",
  });
  // What the old classifier left behind: split rows newer than the plan set, the site plan
  // folded into structural, no site_plan row.
  for (const docType of ["structural", "sld", "module_spec", "inverter_spec", "labels"]) {
    saveProjectDocument(db, r.id, { filename: `old - ${docType}.pdf`, docType, contentType: "application/pdf", buffer: planBytes, source: "split" });
  }
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [r.id]);
  check("5a. precondition: no site_plan row", !splitRows(r.id).some((x) => x.doc_type === "site_plan"));
  const o1 = await captureLog(() => processStageStep(db, r.id));
  check("5b. MUST PASS: the chain re-split instead of deduping", o1.ran.some((x) => x.startsWith("split(")), JSON.stringify(o1.ran));
  check("5c. a site_plan split row now exists", splitRows(r.id).some((x) => x.doc_type === "site_plan"));
  const before = splitRows(r.id).length;
  const o2 = await captureLog(() => processStageStep(db, r.id));
  check("5d. a second run does not re-split again (the gap is closed)",
    !o2.ran.some((x) => x.startsWith("split(")) && splitRows(r.id).length === before, `${before} -> ${splitRows(r.id).length} ${JSON.stringify(o2.ran)}`);
}

// ---------------------------------------------------------------------------
console.log("\n6. THE PLAN-SET FALLBACK READS THE PARSER PAGE'S REAL split-map FORMAT");
{
  // parser.html writes "02 Site + plot plan: 2, 3" (no "page" word) — the fallback required
  // "page" and so never fired on a real parse. A "missing" line must still not count.
  const s = mk();
  saveProjectDocument(db, s.id, {
    filename: "unsplit.pdf", docType: "plan_set", contentType: "application/pdf",
    buffer: await mkPlanPdf(["cover"]), source: "upload",
  });
  const base = getProjectDetail(db, s.id).project;
  const withMap = (text: string) => ({ ...base, parserSnapshot: { ...(base.parserSnapshot || {}), splitPagesText: text } });
  const siteOf = (text: string) => documentInventory(db, withMap(text)).presence.find((d) => d.docType === "site_plan");
  const hit = siteOf("01 SLD / 3-line: 5\n02 Site + plot plan: 2, 3\n03 Module specs: missing");
  check("6a. \"02 Site + plot plan: 2, 3\" counts as in the plan set", !!hit?.present && hit.via === "in plan set", JSON.stringify(hit));
  const miss = siteOf("01 SLD / 3-line: 5\n02 Site + plot plan: missing");
  check("6b. \"02 Site + plot plan: missing\" does not", !miss?.present, JSON.stringify(miss));
}

db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} split-site-plan check(s) FAILED.`); process.exit(1); }
console.log("\nAll split-site-plan checks passed.");
process.exit(0);
