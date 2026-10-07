// THE ENGINEER'S LETTER BOUND INTO THE PLAN SET IS THE STAMPED-STRUCTURAL DOCUMENT (#198).
//
// A Utah city approved a packet whose last pages were an engineering firm's structural
// certification (IRC / ASCE 7 basis, per-array stress analysis, retrofits "none required",
// signed). The splitter filed those pages as doc type `structural`, the permit path resolved
// engineered from the same letter — and the submit gate then held the job twice for want of it:
//   document-inventory  MISSING "PE-stamped structural plans + sealed structural letter/calcs"
//   permit-requirements HOLD    city.struct.stamped-engineering-missing
// The text layer cannot see a seal image, so "no stamp seen" is unknown, not absent. Operator
// ruling 2026-09-26: false stops on legitimate steps are bugs.
//
//   MUST-PASS    a plan set whose split `structural` document is an engineer's certification is
//                not held: the inventory credits the row from the split, and the stamped-engineering
//                finding is at most a warning asking a person to verify the seal;
//   MUST-EXCLUDE an engineered project with NO structural document at all is still held (both);
//   MUST-EXCLUDE a framing sheet split as `structural` (no certification text) is still held —
//                the doc type alone is not the letter (stampedEngineering.test);
//   MUST-EXCLUDE a sheet's NOTE about a letter ("STRUCTURAL LETTER: NOT PROVIDED", "required")
//                is not a letter;
//   MUST-EXCLUDE (review on #218) a sheet that CITES a letter or calcs it does not contain ("REFER TO
//                STRUCTURAL LETTER BY …", "STRUCTURAL CALCULATIONS BY OTHERS", "ATTACHMENTS PER
//                STRUCTURAL LETTER", "SEE ENGINEERING CALCULATIONS SHEET S-3"), an in-house unsealed
//                calculation sheet, and a STRUCTURAL ANALYSIS table that says to contact an engineer —
//                none of them certifies anything, end to end through the splitter and the gate.
//
// Synthetic plan sets only (pdf-lib), no real plan set or homeowner data. Browser-free.
// Run: tsx backend/test/structuralCertificationCredit.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
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
  if (!ok) { failures++; console.error(`  FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok   - ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage } = await import("../src/docSplitter");
const { createProject, getProjectDetail, getSubmitGateReport, buildReviewerReportFor } = await import("../src/repository");
const { documentInventory } = await import("../src/requiredDocuments");
const { readsAsEngineerCertification } = await import("../src/permitPath");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const db = await openDatabase();

// ── The predicate: an engineer's certification, not a note about one ─────────────────────────
const LETTER_PAGES: string[][] = [
  [
    "EXAMPLE STRUCTURAL ENGINEERS, PLLC",
    "100 Sample Avenue, Suite 1, Testville, UT 84000   (555) 010-0100",
    "STRUCTURAL CERTIFICATION",
    "Re: Rooftop photovoltaic installation, 123 Solar Way",
    "We have reviewed the existing roof framing for the proposed photovoltaic array.",
    "Design basis: IRC 2021 and ASCE 7-16. Ground snow load 43 psf, wind speed 105 mph, exposure C.",
    "Existing framing: 2x4 manufactured trusses at 24 in. o.c. with 1/2 in. OSB sheathing.",
  ],
  [
    "STRUCTURAL CALCULATIONS - ARRAY 1",
    "PV dead load 2.6 psf. Attachment spacing 48 in. max. Point load 41 lb per attachment.",
    "Truss top chord stress ratio 0.82 < 1.00 OK. Lag screw withdrawal 266 lb > 112 lb demand OK.",
    "STRUCTURAL CALCULATIONS - ARRAY 2",
    "Truss top chord stress ratio 0.79 < 1.00 OK. Retrofits: none required.",
    // A real certification cites its design code: "per ASCE 7-16" is not a pointer to another document.
    "The existing truss framing is adequate per ASCE 7-16 to support the proposed loads.",
    "Signature ______________________   Date __________",
    "Jane Example, P.E., Engineer of Record",
  ],
];
const letterText = LETTER_PAGES.flat().join("\n");
check("predicate: an engineering firm's structural certification with calcs reads as a certification",
  readsAsEngineerCertification(letterText));
// The real credential forms still credit: a licence number, and a signature block that is filled in.
const LETTER_BODY = LETTER_PAGES.flat().filter((l) => !/Jane Example/.test(l)).join("\n");
check("predicate: a licence-number credential (\"PE No. 12345\") still credits",
  readsAsEngineerCertification(`${LETTER_BODY}\nJane Example\nPE No. 12345`));
check("predicate: an engineer label with a licence field on the same line still credits",
  readsAsEngineerCertification(`${LETTER_BODY}\nPROFESSIONAL ENGINEER: LICENSE NO. 12345`));
check("predicate: an ALL-CAPS name before a dotted P.E. still credits",
  readsAsEngineerCertification(`${LETTER_BODY}\nJANE EXAMPLE, P.E.`));
check("predicate: a FILLED engineer signature block still credits",
  readsAsEngineerCertification(`${LETTER_BODY}\nREGISTERED ENGINEER SIGNATURE: Jane Example`));
check("predicate: a framing sheet's note that the letter is NOT PROVIDED is not a letter",
  !readsAsEngineerCertification(`${"ROOF FRAMING PLAN 2x6 RAFTERS AT 24 IN O.C. ATTACHMENT DETAIL FLASHED LAG. ".repeat(5)}\nSTRUCTURAL LETTER NOT PROVIDED BY ENGINEER`));
check("predicate: a note that a structural letter is REQUIRED is not a letter",
  !readsAsEngineerCertification(`${"ROOF FRAMING PLAN 2x6 RAFTERS AT 24 IN O.C. ATTACHMENT DETAIL FLASHED LAG. ".repeat(5)}\nSTRUCTURAL LETTER REQUIRED FROM ENGINEER OF RECORD`));
check("predicate: a one-line reference is not a letter", !readsAsEngineerCertification("SEE STRUCTURAL LETTER BY ENGINEER"));
check("predicate: a scan with no text layer says nothing", !readsAsEngineerCertification("[no text layer]"));

// Review probes (#218): a framing sheet plus ONE line that cites a letter / calcs it does not contain.
// Sheet-length on purpose (well past any "a letter has a body" floor): what tells these apart
// from a certification has to be what they SAY, not how long they are.
const FRAMING_NOTES = [
  "ROOF SECTION: 2x4 MANUFACTURED TRUSS TOP CHORD AT 24 IN O.C., BOTTOM CHORD 2x4, SPAN 26 FT",
  "ATTACHMENT: FLASHED STANDOFF WITH 5/16 IN LAG, 2.5 IN MIN EMBEDMENT INTO TRUSS TOP CHORD",
  "RAIL: ALUMINUM RAIL, MAX ATTACHMENT SPACING 48 IN, MAX CANTILEVER 16 IN, STAGGER ATTACHMENTS",
  "ROOF COVERING: COMPOSITION SHINGLE, ONE LAYER. ROOF SLOPE 5:12. SHEATHING 1/2 IN OSB",
  // Real plan sets say this; it also keeps every probe below within reach of an "engineer" signal.
  "RACKING: ENGINEERED RACKING SYSTEM, RAILS LISTED TO UL 2703",
];
const FRAMING_TEXT = `S 1.1 Sheet Name ATTACHMENT DETAIL\n${FRAMING_NOTES.join("\n")}\n`;
const CITING_LINES: Record<string, string> = {
  "refer to the letter": "REFER TO STRUCTURAL LETTER BY EXAMPLE STRUCTURAL ENGINEERS, PLLC FOR ATTACHMENT DESIGN",
  "calcs by others": "STRUCTURAL CALCULATIONS BY OTHERS. ENGINEERED RACKING",
  "attachments per the letter": "ATTACHMENTS PER STRUCTURAL LETTER",
  "see the calcs sheet": "SEE ENGINEERING CALCULATIONS SHEET S-3",
  "in-house unsealed calcs": "S-2 STRUCTURAL CALCULATIONS\nPV DEAD LOAD 2.6 PSF. TRUSS STRESS RATIO 0.82 < 1.00 OK. LAG WITHDRAWAL 266 LB > 112 LB OK.",
  "analysis table, contact engineer": "STRUCTURAL ANALYSIS\nMEMBER 2x4 TRUSS  SPAN 26 FT  RATIO 0.82  OK\nCONTACT ENGINEER IF FIELD CONDITIONS DIFFER",
  "adequacy without a credential": "S-2 STRUCTURAL CALCULATIONS\nTHE EXISTING ROOF FRAMING IS ADEQUATE TO SUPPORT THE PV LOADS.",
  "verify-adequacy instruction": "CONTRACTOR TO VERIFY THE EXISTING STRUCTURE IS ADEQUATE. ENGINEER OF RECORD: TBD BY OTHERS",
  // Re-review on #218: a credential that is negated or a placeholder names nobody.
  "negated PE stamp": "NO PE STAMP REQUIRED. EXISTING RAFTERS ARE ADEQUATE FOR THE ADDED PV LOAD.",
  "engineer of record: none": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: NONE",
  "engineer of record: n/a": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: N/A",
  "engineer of record: tbd": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: TBD",
  "engineer of record: blank": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: ________",
  // …and a certify/adequacy clause about something other than the existing structure is not one.
  "racking manufacturer's rating": "EXAMPLE RAIL SYSTEM IS ENGINEERED AND CERTIFIED TO UL 2703. THE RAIL IS ADEQUATE FOR 72 IN SPANS. PE GASKETS.\nLICENSED PROFESSIONAL ENGINEER REVIEWED THE RAIL SPAN TABLES",
  "unsigned title-block template": "I HEREBY CERTIFY THAT THIS PLAN WAS PREPARED BY ME OR UNDER MY DIRECT SUPERVISION AND THAT I AM A DULY LICENSED PROFESSIONAL ENGINEER UNDER THE LAWS OF THIS STATE\nSIGNATURE ________ DATE ________",
  "contractor's statement": "CONTRACTOR CERTIFIES THAT THE EXISTING ROOF FRAMING IS ADEQUATE FOR THE PV LOADS",
  // Third review on #218: a bare ", SE" / ", PE" after a comma is a compass direction or a material
  // grade, not an engineer.
  "azimuth ending in SE": "ROOF 1: TILT 20, AZIMUTH 135, SE\nEXISTING RAFTERS ARE ADEQUATE FOR THE ADDED PV LOAD.",
  "orientation SOUTH, SE": "MP1 ORIENTATION: SOUTH, SE\nEXISTING ROOF FRAMING IS ADEQUATE.",
  "HDPE conduit, PE 3408": "HDPE CONDUIT, PE 3408. EXISTING ROOF IS ADEQUATE.",
  // …and a blank signature / stamp block names nobody.
  "blank engineer signature": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nREGISTERED ENGINEER SIGNATURE: ______",
  "engineer stamp here": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nLICENSED PROFESSIONAL ENGINEER STAMP HERE",
  "engineer (sign and seal)": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nPROFESSIONAL ENGINEER (SIGN AND SEAL)",  // Fourth review on #218 (root cause: credit only a credential that NAMES someone). Blank or
  // label-only blocks in any arrangement, a dotted compass point, and a pipe grade written with "#".
  "signature blank then DATE blank": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nPROFESSIONAL ENGINEER SIGNATURE: ________ DATE: ________",
  "engineer SEAL at end of line": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nLICENSED PROFESSIONAL ENGINEER SEAL",
  "engineer SIGNATURE at end of line": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nREGISTERED ENGINEER SIGNATURE",
  "engineer STAMP / DATE": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nPROFESSIONAL ENGINEER STAMP / DATE",
  "engineer blank with blank LIC #": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nLICENSED PROFESSIONAL ENGINEER: ____ LIC #: ____",
  "engineer NAME blank": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nPROFESSIONAL ENGINEER NAME: ____",
  "dotted compass S.E.": "ROOF 1: TILT 20, AZIMUTH 135, S.E.\nEXISTING RAFTERS ARE ADEQUATE FOR THE ADDED PV LOAD.",
  "pipe grade PE #4710": "HDPE PIPE PE #4710. EXISTING ROOF IS ADEQUATE.",
};
for (const [name, line] of Object.entries(CITING_LINES)) {
  check(`MUST-EXCLUDE predicate: a framing sheet + "${name}" is not a certification`,
    !readsAsEngineerCertification(`${FRAMING_TEXT}${line}`), line);
}

// The tile rule (review on #218): with the certification on file its words ask for the seal to be
// verified — never "none is in the package … obtain the sealed engineering".
const tileProject = { id: "tile", state: "OR", ahj: "City of Testville", utility: "PGE",
  parserSnapshot: { roofMaterial: "Concrete Tile", framingType: "truss", roofRafterSpacing: 24, roofRafterSpan: 10, mounting: "Roof mount", snow: 25, deadLoad: 3, wind: "B" } } as never;
const tileFinding = (cert: boolean) => evaluateDesignCodeFindings(tileProject, null, undefined, ["plan_set", "structural"], [], cert)
  .find((x) => x.id === "city.struct.tile-stamped-engineering-missing");
const tileCert = tileFinding(true);
check("tile: with the certification on file the tile stamp finding is a warning that says to verify the seal",
  tileCert?.severity === "warning" && /verify the seal/i.test(tileCert.title) && /verify the seal/i.test(tileCert.designTeamAction ?? "")
  && !/none is in the package/i.test(tileCert.message) && !/^Obtain/i.test(tileCert.designTeamAction ?? ""),
  JSON.stringify(tileCert && { severity: tileCert.severity, title: tileCert.title, message: tileCert.message, action: tileCert.designTeamAction }));
check("tile: without it the tile stamp finding stays a blocker asking for the sealed engineering",
  tileFinding(false)?.severity === "blocker" && /none is in the package/i.test(tileFinding(false)?.message ?? ""), JSON.stringify(tileFinding(false)?.severity));

// ── The gate, through the real splitter ───────────────────────────────────────────────────────
const client = createClient(db, {
  companyName: "Letter Credit Solar LLC", legalBusinessName: "Letter Credit Solar LLC", ccbLicenseNumber: "240135",
  electricalLicenseNumber: "C1234", businessEmail: "ops@letter.test", businessPhone: "(503) 555-0142",
});
// The smoke's complete fixture (outOfStatePermitPath.test), on the engineered path in Utah.
const COMPLETE: Record<string, string> = {
  street: "123 Solar Way", zip: "84000", city: "Testville", state: "UT", ahj: "City of Testville", utility: "Rocky Mountain Power",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "Engineered (non-prescriptive)",
  framingType: "truss", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "43", deadLoad: "2.6", wind: "C", mounting: "Roof mount",
  locateCalloutText: "No locate-triggering scope found.",
  sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
  roofPlanNotesText: "Roof framing: 2x4 trusses at 24 inches on center, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to trusses.",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
  labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
  utilityDownloadChecklistText: "Utility package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
  packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
};
const SHEETS: string[][] = [
  ["PV-1 Sheet Name SITE PLAN", "FIRE ACCESS PATHWAY 36 IN, ARRAY LAYOUT"],
  ["PV-3 Sheet Name ONE-LINE DIAGRAM", "NEC 705.12 LOAD SIDE, RAPID SHUTDOWN NEC 690.12"],
  ["PV-4 Sheet Name LABELS", "WARNING LABELS", "LABEL LOCATION: MAIN SERVICE PANEL"],
  ["PV-5 Sheet Name MODULE SPEC SHEET", "Q.TRON BLK M-G2 430 W, UL 61730"],
  ["PV-6 Sheet Name INVERTER SPEC SHEET", "IQ8M MICROINVERTER, UL 1741 SB"],
];
const FRAMING: string[] = ["S 1.1 Sheet Name ATTACHMENT DETAIL", "2x4 TRUSS AT 24 IN O.C., FLASHED STANDOFF, 5/16 LAG"];
// The citing sheet in full (FRAMING_NOTES is declared with the predicate probes above).
const FRAMING_FULL: string[] = ["S 1.1 Sheet Name ATTACHMENT DETAIL", ...FRAMING_NOTES];

let seq = 0;
async function mk(extraPages: string[][]): Promise<string> {
  const d = createProject(db, { clientId: client.id, owner: `Letter Owner ${++seq}`, ...COMPLETE });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of [...SHEETS, ...extraPages]) {
    const page = pdf.addPage([792, 612]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 560 - i * 28, size: 10, font }));
  }
  saveProjectDocument(db, d.project.id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from(await pdf.save()), source: "upload",
  });
  await buildUtilityPackage(db, d.project.id, "permit");
  // Text extraction runs in the background after each save; the gate reads what it stored.
  for (let i = 0; i < 200; i++) {
    const pending = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND content_type = 'application/pdf' AND COALESCE(extracted_text, '') = ''", [d.project.id]);
    if (!pending?.n) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return d.project.id;
}

const letterRow = (pid: string) => documentInventory(db, getProjectDetail(db, pid).project).presence.find((p) => p.docType === "structural_letter");
const stampFinding = (pid: string) => buildReviewerReportFor(db, getProjectDetail(db, pid).project).findings.find((f) => f.id === "city.struct.stamped-engineering-missing");
const gate = (pid: string) => getSubmitGateReport(db, pid).checks;
const holdLabels = (pid: string): string[] => gate(pid).find((c) => c.id === "permit-requirements")?.holds?.map((h) => h.label) ?? [];

// MUST-PASS: the certification is split out of the plan set as `structural` and credited.
const withLetter = await mk([FRAMING, ...LETTER_PAGES]);
const split = db.query<{ doc_type: string; source: string }>("SELECT doc_type, source FROM project_documents WHERE project_id = ? AND doc_type = 'structural'", [withLetter]);
check("fixture: the splitter files the certification pages as a split `structural` document",
  split.length === 1 && split[0].source === "split", JSON.stringify(split));
check("fixture: the project resolves to the engineered path and owes the sealed letter", Boolean(letterRow(withLetter)), JSON.stringify(letterRow(withLetter)));
const row = letterRow(withLetter);
check("MUST-PASS: the inventory shows the stamped-structural row PRESENT, from the split",
  row?.present === true && /certification/i.test(row.via) && /structural document/i.test(row.via), JSON.stringify(row));
check("…and its words ask a person to verify the seal (unknown, not absent)", /verify the seal/i.test(row?.via ?? ""), row?.via);
const docGate = gate(withLetter).find((c) => c.id === "document-inventory");
check("MUST-PASS: the document-inventory check does not list the stamped-structural row as missing",
  !JSON.stringify(docGate?.evidence ?? []).includes("PE-stamped structural plans"), JSON.stringify(docGate?.evidence));
const f = stampFinding(withLetter);
check("MUST-PASS: the stamped-engineering finding is at most a WARNING when the packet carries the certification",
  f?.severity === "warning", JSON.stringify(f && { severity: f.severity, title: f.title }));
check("…saying to verify the seal on the structural pages", /verify the seal/i.test(f?.title ?? ""), f?.title);
check("MUST-PASS: permit-requirements holds nothing for the stamped calculation",
  !holdLabels(withLetter).some((l) => /stamped calculation|stamped engineering/i.test(l)), JSON.stringify(holdLabels(withLetter)));

// MUST-EXCLUDE: an engineered project with no structural document at all is still held.
const noStructural = await mk([]);
check("fixture: no `structural` document exists on the bare project",
  !db.get("SELECT id FROM project_documents WHERE project_id = ? AND doc_type = 'structural'", [noStructural]));
check("MUST-EXCLUDE: with no structural document the stamped-structural row is MISSING", letterRow(noStructural)?.present === false, JSON.stringify(letterRow(noStructural)));
check("MUST-EXCLUDE: …and the stamped-engineering finding is a BLOCKER", stampFinding(noStructural)?.severity === "blocker", JSON.stringify(stampFinding(noStructural)?.severity));
check("MUST-EXCLUDE: …which permit-requirements holds on",
  holdLabels(noStructural).some((l) => /stamped calculation/i.test(l)), JSON.stringify(holdLabels(noStructural)));

// MUST-EXCLUDE: a framing sheet split as `structural` is not the letter.
const framingOnly = await mk([FRAMING]);
check("fixture: the framing sheet is split as `structural`",
  Boolean(db.get("SELECT id FROM project_documents WHERE project_id = ? AND doc_type = 'structural'", [framingOnly])));
check("MUST-EXCLUDE: a framing-only structural split leaves the stamped-structural row MISSING", letterRow(framingOnly)?.present === false, JSON.stringify(letterRow(framingOnly)));
check("MUST-EXCLUDE: …and the stamped-engineering finding stays a BLOCKER", stampFinding(framingOnly)?.severity === "blocker", JSON.stringify(stampFinding(framingOnly)?.severity));

// MUST-EXCLUDE (review on #218): every probe, end to end through the splitter, the inventory, the
// reviewer and the submit gate — the sheet is split as `structural` and the job is still held.
for (const [name, line] of Object.entries(CITING_LINES)) {
  const pid = await mk([[...FRAMING_FULL, ...line.split("\n")]]);
  const split = Boolean(db.get("SELECT id FROM project_documents WHERE project_id = ? AND doc_type = 'structural'", [pid]));
  const r = letterRow(pid);
  const sev = stampFinding(pid)?.severity;
  const holds = holdLabels(pid);
  check(`MUST-EXCLUDE gate: framing sheet + "${name}" (split as structural: ${split}) — row MISSING, finding a BLOCKER, still held`,
    split && r?.present === false && sev === "blocker" && holds.some((l) => /stamped calculation/i.test(l)),
    JSON.stringify({ present: r?.present, via: r?.via, sev, holds }));
}

db.close();
if (failures) { console.error(`\nstructuralCertificationCredit: ${failures} FAILED`); process.exit(1); }
console.log("\nstructuralCertificationCredit: all checks passed");
process.exit(0);
