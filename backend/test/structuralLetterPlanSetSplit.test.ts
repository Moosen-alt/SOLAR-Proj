// AN UNTYPED PLAN SET STILL SPLITS (#198; Helm's review of #218 at a6ef1b62, the blocker).
//
// A plan set uploaded with no doc type ('(general)', the dashboard default) or as 'other' is found
// by findPlanSet's newest-PDF fallback. buildUtilityPackage re-checks the plan set before each part
// it saves (the J2 mid-split guard) by asking findPlanSet again — and that fallback picked the part
// the split had just saved. So the second save always threw 409: the split never converged, and the
// NEM staging gate was falsely held over inverter_spec. A split part is a cut OF the plan set, never
// one: the fallback skips `source = 'split'` rows.
//
// Pinned on target nem and on target permit, for both untyped shapes: the split succeeds, its parts
// are main's, every part records the untyped plan set as its source (a second split cuts the plan set
// again, never a part — main's latent re-cut-a-part bug), and the staging gate's missing list after
// the stage pass's split (ensurePlanSetSplit) is main's.
//
// THE SHIPPED PLAN SET FOR THE RECENCY CHECKS (the same review, a low). reconcileSplitParts,
// ensurePlanSetSplit and the stage pass's split step judged "already split" against the latest
// `plan_set` row by uploaded_at alone, so an alias-typed plan set (combined_plan_set…, which the
// package ships) never counted as split and was re-cut on every pass. They now ask
// shippedPlanSet — the package's and the structural-letter gate's own answer.
//
// KILL: drop `d.source !== "split"` from findPlanSet's fallback → every untyped split here 409s and
// the NEM gate holds inverter_spec; put ensurePlanSetSplit back on "latest plan_set by uploaded_at"
// → the alias-typed plan set is re-split on the second pass.
//
// Synthetic plan sets only (pdf-lib). Browser-free.
//   npx tsx backend/test/structuralLetterPlanSetSplit.test.ts
import "./_isolate"; // FIRST
import { PDFDocument, StandardFonts } from "pdf-lib";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage, ensurePlanSetSplit } = await import("../src/docSplitter");
const { createProject, getProjectDetail, stagingMissingDocuments } = await import("../src/repository");
const { documentInventory } = await import("../src/requiredDocuments");
const db = await openDatabase();

const client = createClient(db, {
  companyName: "Untyped Split Solar LLC", legalBusinessName: "Untyped Split Solar LLC", ccbLicenseNumber: "240137",
  electricalLicenseNumber: "C1236", businessEmail: "ops@untyped.test", businessPhone: "(503) 555-0144",
});
const COMPLETE: Record<string, string> = {
  street: "123 Solar Way", zip: "84000", city: "Testville", state: "UT", ahj: "City of Testville", utility: "Rocky Mountain Power",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "Engineered (non-prescriptive)",
  framingType: "truss", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "43", deadLoad: "2.6", wind: "C", mounting: "Roof mount",
};
const SHEETS: string[][] = [
  ["PV-1 Sheet Name SITE PLAN", "FIRE ACCESS PATHWAY 36 IN, ARRAY LAYOUT"],
  ["PV-3 Sheet Name ONE-LINE DIAGRAM", "NEC 705.12 LOAD SIDE, RAPID SHUTDOWN NEC 690.12"],
  ["PV-4 Sheet Name LABELS", "WARNING LABELS", "LABEL LOCATION: MAIN SERVICE PANEL"],
  ["PV-5 Sheet Name MODULE SPEC SHEET", "Q.TRON BLK M-G2 430 W, UL 61730"],
  ["PV-6 Sheet Name INVERTER SPEC SHEET", "IQ8M MICROINVERTER, UL 1741 SB"],
  ["S 1.1 Sheet Name ATTACHMENT DETAIL", "2x4 TRUSS AT 24 IN O.C., FLASHED STANDOFF, 5/16 LAG"],
];
async function planSetPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of SHEETS) {
    const page = pdf.addPage([792, 612]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 560 - i * 28, size: 10, font }));
  }
  return Buffer.from(await pdf.save());
}

let seq = 0;
async function untypedProject(docType: string): Promise<{ pid: string; planSetId: string }> {
  const d = createProject(db, { clientId: client.id, owner: `Untyped Owner ${++seq}`, ...COMPLETE });
  const saved = saveProjectDocument(db, d.project.id, {
    docType, filename: "plan-set.pdf", contentType: "application/pdf", buffer: await planSetPdf(), source: "upload",
  });
  return { pid: d.project.id, planSetId: saved.id };
}
const splitRows = (pid: string) => db.query<{ doc_type: string; source_document_id: string }>(
  "SELECT doc_type, source_document_id FROM project_documents WHERE project_id = ? AND source = 'split' AND doc_type <> 'utility_package_zip' ORDER BY uploaded_at, rowid", [pid]);
const statusOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "ok"; } catch (e) { return String((e as { status?: number }).status ?? (e as Error).message); }
};

// What main produces for this plan set (recorded by running this test's calls on origin/main, which
// has no mid-split re-check): the parts each target cuts, and the staging gate's missing list after
// the stage pass's split.
const MAIN_PARTS: Record<string, string[]> = {
  nem: ["sld", "site_plan", "inverter_spec"],
  permit: ["sld", "site_plan", "structural", "inverter_spec", "labels"],
};
const MAIN_GATE: Record<string, string[]> = {
  nem: [],
  permit: ["module_spec"], // this synthetic module sheet reads as no spec page on main too
};
const SHEET_TYPES = ["sld", "site_plan", "structural", "module_spec", "inverter_spec"];

for (const docType of ["", "other"]) {
  const shape = docType ? `'${docType}'` : "'(general)'";
  for (const target of ["nem", "permit"] as const) {
    // buildUtilityPackage — the build-package route.
    const a = await untypedProject(docType);
    let parts: string[] = [];
    const status = await statusOf(buildUtilityPackage(db, a.pid, target).then((r) => { parts = r.parts.map((p) => p.docType); }));
    check(`${shape} plan set, target ${target}: the split succeeds (no 409) and cuts main's parts`,
      status === "ok" && JSON.stringify(parts) === JSON.stringify(MAIN_PARTS[target]), `${status} ${JSON.stringify(parts)}`);
    check(`${shape} plan set, target ${target}: every part records the untyped plan set as its source`,
      splitRows(a.pid).length > 0 && splitRows(a.pid).every((r) => r.source_document_id === a.planSetId), JSON.stringify(splitRows(a.pid)));
    // A second split cuts the plan set again, never one of its parts.
    const again = await statusOf(buildUtilityPackage(db, a.pid, target));
    check(`${shape} plan set, target ${target}: a second split cuts the plan set again, never a part`,
      again === "ok" && splitRows(a.pid).every((r) => r.source_document_id === a.planSetId), `${again} ${JSON.stringify(splitRows(a.pid))}`);

    // ensurePlanSetSplit then the staging gate — prepareSubmission's order.
    const b = await untypedProject(docType);
    const ensured = await statusOf(ensurePlanSetSplit(db, b.pid, target, SHEET_TYPES));
    const track = target === "nem" ? "nem" : "building";
    const missing = stagingMissingDocuments(documentInventory(db, getProjectDetail(db, b.pid).project), track)
      .map((d) => d.docType).filter((t) => t === "meter_photo" || SHEET_TYPES.includes(t));
    check(`${shape} plan set, target ${target}: the stage pass's split succeeds and the staging gate matches main`,
      ensured === "ok" && JSON.stringify(missing) === JSON.stringify(MAIN_GATE[target]), `${ensured} ${JSON.stringify(missing)}`);
  }
}

// An alias-typed plan set: split once, then the stage pass's guard sees it as split (a type this
// plan set never yields — module_spec here — does not re-cut it on every pass).
{
  const d = createProject(db, { clientId: client.id, owner: `Alias Owner ${++seq}`, ...COMPLETE });
  saveProjectDocument(db, d.project.id, {
    docType: "combined_plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: await planSetPdf(), source: "upload",
  });
  const first = await ensurePlanSetSplit(db, d.project.id, "permit", SHEET_TYPES);
  const second = await ensurePlanSetSplit(db, d.project.id, "permit", SHEET_TYPES);
  check("alias-typed plan set: the first pass splits it, the second sees it as split and does not re-cut",
    first.split === true && second.split === false && splitRows(d.project.id).filter((r) => r.doc_type === "sld").length === 1,
    `${JSON.stringify(first)} ${JSON.stringify(second)} ${splitRows(d.project.id).length}`);
}

if (failures) { console.error(`\nstructuralLetterPlanSetSplit: ${failures} failure(s)`); process.exit(1); }
console.log("\nstructuralLetterPlanSetSplit: all checks passed");
process.exit(0);
