// THE ENGINEER'S LETTER BOUND INTO THE PLAN SET: TEXT SUGGESTS, A NAMED PERSON CONFIRMS (#198).
//
// A Utah city approved a packet whose last pages were an engineering firm's structural
// certification (IRC / ASCE 7 basis, per-array stress analysis, retrofits "none required",
// signed). The splitter filed those pages as doc type `structural`, the permit path resolved
// engineered from the same letter — and the submit gate then held the job twice for want of it:
//   document-inventory  MISSING "PE-stamped structural plans + sealed structural letter/calcs"
//   permit-requirements HOLD    city.struct.stamped-engineering-missing
// Four review rounds on #218 showed text matching cannot tell that letter from ordinary plan-set
// wording. Owner ruling 2026-10-08: text matching only SUGGESTS the candidate (document + page);
// only a named person's confirmation of that exact document credits it (structuralLetter.ts).
//
//   MUST-PASS    the #198-shaped packet + one confirmation: the inventory row is present ("confirmed by
//                <name> <date>", a WARNING: verify the seal), no hold, and the audit entry is written;
//   MUST-EXCLUDE with NO confirmation, every probe of review rounds 1–4 AND a genuine letter are held;
//   MUST-EXCLUDE a confirmation on document A does not credit document B (another project, or a
//                second structural document of the same project);
//   MUST-EXCLUDE a re-uploaded plan set, a re-split or replaced document, or changed bytes void it;
//   MUST-EXCLUDE a withdrawal holds again (and is audited);
//   MUST-PASS    re-running buildUtilityPackage on an unchanged plan set (a byte-identical re-cut)
//                keeps the confirmation (Helm's review at fb160321);
//   MUST-EXCLUDE a changed re-cut, or a standalone upload to the `structural` slot, voids it; deleting
//                that newer row (or a newer plan set) never revives it;
//   MUST-EXCLUDE a cut older than the newest plan set is never offered and cannot be confirmed (409);
//   PAGES        the candidate's page and page count are the PDF's (scanned pages count), and the
//                confirmed page is clamped; the audit carries the user id and the superseded id;
//   TIMING       the detector stays linear on an unbroken capital run at the 150K text cap (round 4 M4).
// The route (sign-in, cross-org 404) is pinned in structuralLetterConfirmRoute.test.ts; the card in
// structuralLetterCardRender.test.ts.
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
const { saveProjectDocument, deleteProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage } = await import("../src/docSplitter");
const { createProject, getProjectDetail, getSubmitGateReport, buildReviewerReportFor } = await import("../src/repository");
const { documentInventory } = await import("../src/requiredDocuments");
const { certificationScore } = await import("../src/permitPath");
const SL = await import("../src/structuralLetter");
const fs = await import("node:fs");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const db = await openDatabase();

// ── The detector: it RANKS, it never credits ─────────────────────────────────────────────────
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
check("detector: an engineering firm's structural certification ranks high (certifying clause + credential + heading/basis)",
  certificationScore(letterText) >= 4, String(certificationScore(letterText)));
check("detector: the letter outranks a framing sheet", certificationScore(letterText) > certificationScore("S 1.1 Sheet Name ATTACHMENT DETAIL 2x4 TRUSS AT 24 IN O.C., FLASHED STANDOFF, 5/16 LAG"));
check("detector: a scan with no text layer scores nothing", certificationScore("[no text layer]") === 0);

// TIMING (round 4 M4): an unbroken capital run at the 150K text cap took 24s in the old NAME regex,
// and the gate ran it five times a view. Every pattern is linear now.
for (const [name, run] of Object.entries({
  "an unbroken capital run": "A".repeat(150_000),
  "capital words separated by spaces": "JANE ".repeat(30_000),
  "a capital run ending in a credential": `${"EXAMPLE".repeat(21_000)} P.E.`,
})) {
  const t0 = performance.now();
  certificationScore(run);
  const ms = performance.now() - t0;
  check(`TIMING: the detector reads ${name} at the 150K cap in under 1.5s`, ms < 1500, `${Math.round(ms)} ms`);
}

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
// Round 4 on #218 (B1–B6, M1–M3): ordinary plan-set wording that released the old auto-credit, and
// common real signatures it held. Moot as release paths — with no confirmation EVERY one is held.
const ROUND4_PROBES: Record<string, string> = {
  "B1 blank stamp then the contractor": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD. PROFESSIONAL ENGINEER STAMP EXAMPLE SOLAR, LLC",
  "B1 blank signature then the contractor licence": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD. REGISTERED ENGINEER SIGNATURE SOLAR CONTRACTOR, LIC 123456",
  "B2 engineer of record: not required": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: NOT REQUIRED",
  "B2 engineer of record: to be determined": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: TO BE DETERMINED",
  "B2 engineer of record: see attached": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: SEE ATTACHED",
  "B2 engineer of record: to follow": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: TO FOLLOW",
  "B2 engineer of record: owner builder": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: OWNER BUILDER",
  "B2 engineer of record: XXXXX XXXXX": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nENGINEER OF RECORD: XXXXX XXXXX",
  "B3 modules face S.E.": "EXISTING ROOF FRAMING IS ADEQUATE.\nMODULES FACE S.E.",
  "B3 panel on S.E. wall": "EXISTING ROOF FRAMING IS ADEQUATE.\nMAIN SERVICE PANEL ON S.E. WALL",
  "B3 quadrant address": "EXISTING ROOF FRAMING IS ADEQUATE.\n123 EXAMPLE AVE S.E.",
  "B4 attachments per P.E. letter": "EXISTING ROOF FRAMING IS ADEQUATE.\nATTACHMENTS PER P.E. LETTER",
  "B4 P.E. stamp not included": "EXISTING ROOF FRAMING IS ADEQUATE.\nP.E. STAMP NOT INCLUDED IN THIS SET",
  "B5 racking maker's rail letter": "EXAMPLE RAIL MEMBERS ARE ADEQUATE FOR 72 IN SPANS.\nThe Example Roof Mount System has been designed and evaluated per ASCE 7-16\nJane Roe, P.E.",
  "B6 contractor note + electrical engineer": "CONTRACTOR NOTE: THE EXISTING ROOF FRAMING IS ADEQUATE.\nELECTRICAL ENGINEER: John Example, P.E.",
  "M1 licence of zeros": "EXISTING ROOF STRUCTURE IS ADEQUATE FOR THE ADDED PV LOAD.\nPROFESSIONAL ENGINEER LICENSE NO. 000000",
  "M1 pipe grade PE No.": "EXISTING ROOF IS ADEQUATE.\nHDPE PIPE SDR 11, PE No. 4710",
};
// …and GENUINE letters (M2/M3 signature forms, and the #198 letter itself): held too until a person confirms.
const LETTER_BODY = LETTER_PAGES.flat().filter((l) => !/Jane Example/.test(l));
const GENUINE_SIGNATURES: Record<string, string> = {
  "M2 initial and surname": "J. Roe, P.E.",
  "M2 accented name": "Jose Nunez, P.E.",
  "M2 prepared by, all caps": "PREPARED BY JANE ROE, P.E.",
  "M2 undotted PE": "Jane Example, PE",
  "M3 professional engineer #": "Professional Engineer #12345",
};

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
const gate = (pid: string) => getSubmitGateReport(db, pid);
const holdLabels = (pid: string): string[] => gate(pid).checks.find((c) => c.id === "permit-requirements")?.holds?.map((h) => h.label) ?? [];
const structuralDocs = (pid: string) => db.query<{ id: string; source: string; stored_path: string }>(
  "SELECT id, source, stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'structural' ORDER BY uploaded_at", [pid]);
const audits = (pid: string, action: string) => db.query<{ actor_name: string; actor_type: string; details: string; created_at: string }>(
  "SELECT actor_name, actor_type, details, created_at FROM audit_logs WHERE project_id = ? AND action = ?", [pid, action]);
/** Held exactly as main holds it: row MISSING, finding a BLOCKER, a permit-requirements hold. */
const heldLikeMain = (pid: string) => {
  const r = letterRow(pid); const sev = stampFinding(pid)?.severity; const holds = holdLabels(pid);
  return { ok: r?.present === false && sev === "blocker" && holds.some((l) => /stamped calculation/i.test(l)), detail: JSON.stringify({ present: r?.present, via: r?.via, sev, holds }) };
};
const released = (pid: string) => {
  const r = letterRow(pid); const f = stampFinding(pid); const holds = holdLabels(pid);
  const inv = gate(pid).checks.find((c) => c.id === "document-inventory");
  return {
    ok: r?.present === true && r.warning === "verify the seal" && /confirmed by Jane Example \d{4}-\d{2}-\d{2}/.test(r.via) && /verify the seal/i.test(r.via)
      && f?.severity === "warning" && /verify the seal/i.test(f.title)
      && !holds.some((l) => /stamped calculation|stamped engineering/i.test(l))
      && inv?.status !== "pass" && !JSON.stringify(inv?.evidence ?? []).includes("MISSING (required): PE-stamped"),
    detail: JSON.stringify({ present: r?.present, via: r?.via, warning: r?.warning, sev: f?.severity, holds, inv: inv?.status }),
  };
};
const confirmAs = (pid: string, documentId: string, page = 1) => SL.confirmStructuralLetter(db, pid, { documentId, page, confirmedBy: "Jane Example", userId: "user-jane" });

// ── MUST-PASS: the #198-shaped packet clears with ONE confirmation ───────────────────────────
const withLetter = await mk([FRAMING, ...LETTER_PAGES]);
const split = structuralDocs(withLetter);
check("fixture: the splitter files the certification pages as a split `structural` document",
  split.length === 1 && split[0].source === "split", JSON.stringify(split));
check("fixture: the project resolves to the engineered path and owes the sealed letter", Boolean(letterRow(withLetter)), JSON.stringify(letterRow(withLetter)));
// No confirmation: exactly main — held — even though this IS the engineer's letter.
const before = heldLikeMain(withLetter);
check("MUST-EXCLUDE: the genuine #198 letter with NO confirmation is held exactly as on main", before.ok, before.detail);
const card = gate(withLetter).structuralLetter;
check("the gate carries the candidate: the split structural document, at a letter page",
  card?.candidate?.documentId === split[0].id && (card?.candidate?.score ?? 0) >= 3 && (card?.candidate?.page ?? 0) >= 1 && card?.confirmation === null,
  JSON.stringify(card));
const conf = await confirmAs(withLetter, split[0].id, card?.candidate?.page ?? 1);
const after = released(withLetter);
check("MUST-PASS: one confirmation → row present (\"confirmed by Jane Example <date>\", a warning: verify the seal), no hold", after.ok, after.detail);
const confirmedAudit = audits(withLetter, "structural_letter.confirmed");
const ca = confirmedAudit[0] ? JSON.parse(confirmedAudit[0].details) as { documentId?: string; page?: number; userId?: string } : {};
check("MUST-PASS: …and the audit entry says who, when, which document and page",
  confirmedAudit.length === 1 && confirmedAudit[0].actor_name === "Jane Example" && confirmedAudit[0].actor_type === "human"
  && ca.documentId === split[0].id && ca.page === conf.page && ca.userId === "user-jane" && Boolean(confirmedAudit[0].created_at), JSON.stringify(confirmedAudit));
check("the gate card shows the standing confirmation", gate(withLetter).structuralLetter?.confirmation?.confirmedBy === "Jane Example");

// ── MUST-EXCLUDE: a withdrawal holds again ────────────────────────────────────────────────────
SL.withdrawStructuralLetterConfirmation(db, withLetter, "Jane Example");
const withdrawn = heldLikeMain(withLetter);
check("MUST-EXCLUDE: a withdrawn confirmation holds again, exactly as main", withdrawn.ok, withdrawn.detail);
const wa = audits(withLetter, "structural_letter.withdrawn");
check("…and the withdrawal is audited (who, document, page)",
  wa.length === 1 && wa[0].actor_name === "Jane Example" && (JSON.parse(wa[0].details) as { documentId?: string }).documentId === split[0].id, JSON.stringify(wa));
let refused = "";
try { SL.withdrawStructuralLetterConfirmation(db, withLetter, "Jane Example"); } catch (e) { refused = String((e as { status?: number }).status); }
check("withdrawing with nothing standing is refused (409)", refused === "409", refused);

// ── MUST-EXCLUDE: a confirmation on document A does not credit document B ─────────────────────
const other = await mk([FRAMING, ...LETTER_PAGES]);
await confirmAs(withLetter, split[0].id);
check("fixture: project A is credited again after re-confirming", released(withLetter).ok, released(withLetter).detail);
const otherHeld = heldLikeMain(other);
check("MUST-EXCLUDE: A's confirmation does not credit project B's identical letter", otherHeld.ok, otherHeld.detail);
let cross = "";
try { await SL.confirmStructuralLetter(db, other, { documentId: split[0].id, confirmedBy: "Jane Example" }); } catch (e) { cross = String((e as { status?: number }).status); }
check("MUST-EXCLUDE: confirming project A's document on project B is 404, and B stays held", cross === "404" && heldLikeMain(other).ok, cross);
// Two structural documents on ONE project: the confirmed one goes away; the other is not credited.
const docB = saveProjectDocument(db, withLetter, { docType: "structural", filename: "letter-b.pdf", contentType: "application/pdf",
  buffer: fs.readFileSync(split[0].stored_path), source: "upload" });
deleteProjectDocument(db, withLetter, split[0].id);
const bHeld = heldLikeMain(withLetter);
check("MUST-EXCLUDE: deleting confirmed document A voids it — document B (same letter) is not credited", bHeld.ok, bHeld.detail);
check("…and the card says the confirmation no longer covers what is on file, and offers B",
  /replaced or re-split/.test(gate(withLetter).structuralLetter?.voided?.reason ?? "") && gate(withLetter).structuralLetter?.candidate?.documentId === docB.id,
  JSON.stringify(gate(withLetter).structuralLetter));

// ── MUST-EXCLUDE: a re-upload, a re-split, or changed bytes void it ───────────────────────────
const reup = await mk([FRAMING, ...LETTER_PAGES]);
await confirmAs(reup, structuralDocs(reup)[0].id);
check("fixture: the re-upload project is credited after its confirmation", released(reup).ok, released(reup).detail);
await new Promise((r) => setTimeout(r, 5));
const planRow = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set'", [reup])!;
saveProjectDocument(db, reup, { docType: "plan_set", filename: "plan-set-rev1.pdf", contentType: "application/pdf", buffer: fs.readFileSync(planRow.stored_path), source: "upload" });
const reupHeld = heldLikeMain(reup);
check("MUST-EXCLUDE: re-uploading the plan set voids the confirmation — held again", reupHeld.ok, reupHeld.detail);
check("…with the reason on the card", /new plan set/.test(gate(reup).structuralLetter?.voided?.reason ?? ""), JSON.stringify(gate(reup).structuralLetter?.voided));

const resplit = await mk([FRAMING, ...LETTER_PAGES]);
const firstCut = structuralDocs(resplit)[0];
await confirmAs(resplit, firstCut.id);
deleteProjectDocument(db, resplit, firstCut.id);
db.run("DELETE FROM audit_logs WHERE project_id = ? AND action = 'project.document_deleted'", [resplit]); // a re-cut, not a person's ruling against the type
await buildUtilityPackage(db, resplit, "permit");
const recut = structuralDocs(resplit);
check("fixture: the re-split cut a new structural document", recut.length === 1 && recut[0].id !== firstCut.id, JSON.stringify(recut));
const resplitHeld = heldLikeMain(resplit);
check("MUST-EXCLUDE: a re-split document (new id) is not covered — held again", resplitHeld.ok, resplitHeld.detail);

const changed = await mk([FRAMING, ...LETTER_PAGES]);
const changedDoc = structuralDocs(changed)[0];
await confirmAs(changed, changedDoc.id);
fs.appendFileSync(changedDoc.stored_path, "\n% replaced bytes\n");
const changedHeld = heldLikeMain(changed);
check("MUST-EXCLUDE: a replaced document (same id, new bytes) is not covered — held again", changedHeld.ok, changedHeld.detail);

// ── Helm's review at fb160321: what ships is what was confirmed ───────────────────────────────
// The splitter only APPENDS (buildUtilityPackage — the build-package route, auto-stage's repair
// re-split), and the package ships the NEWEST `structural` row. So a newer row voids the
// confirmation unless it is the same cut again (split, same newest plan set, same sha256).
const { createHash } = await import("node:crypto");
const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const reasonOf = (pid: string) => gate(pid).structuralLetter?.voided?.reason ?? "";

// MUST-PASS: re-running buildUtilityPackage on an unchanged plan set keeps the confirmation.
const rerun = await mk([FRAMING, ...LETTER_PAGES]);
const rerunCut = structuralDocs(rerun)[0];
await confirmAs(rerun, rerunCut.id);
// Past a second boundary: a PDF's save-time date has one-second grain, so a cut that stamps it
// would differ from the first cut here.
await new Promise((r) => setTimeout(r, 1100));
await buildUtilityPackage(db, rerun, "permit");
await buildUtilityPackage(db, rerun, "all");
const rerunDocs = structuralDocs(rerun);
check("fixture: the re-runs appended byte-identical structural cuts",
  rerunDocs.length === 3 && new Set(rerunDocs.map((d) => sha(d.stored_path))).size === 1, JSON.stringify(rerunDocs.map((d) => d.id)));
const rerunOk = released(rerun);
check("MUST-PASS: re-running buildUtilityPackage on an unchanged plan set keeps the confirmation", rerunOk.ok, rerunOk.detail);

// MUST-EXCLUDE: a changed re-cut (a classifier change cutting different pages) voids it…
const recutChanged = await mk([FRAMING, ...LETTER_PAGES]);
await confirmAs(recutChanged, structuralDocs(recutChanged)[0].id);
await new Promise((r) => setTimeout(r, 5));
const onePage = await PDFDocument.create();
const f1 = await onePage.embedFont(StandardFonts.Helvetica);
onePage.addPage([792, 612]).drawText(LETTER_PAGES[0][0], { x: 40, y: 560, size: 10, font: f1 });
const changedCut = saveProjectDocument(db, recutChanged, { docType: "structural", filename: "plan-set - Structural.pdf", contentType: "application/pdf",
  buffer: Buffer.from(await onePage.save()), source: "split" });
const recutHeld = heldLikeMain(recutChanged);
check("MUST-EXCLUDE: a re-split that cut a DIFFERENT structural document voids the confirmation — held again", recutHeld.ok, recutHeld.detail);
check("…with the reason on the card", /re-split cut a different/.test(reasonOf(recutChanged)), reasonOf(recutChanged));
// …and deleting that newer cut does not revive it (the void is stamped on the row).
deleteProjectDocument(db, recutChanged, changedCut.id);
const notRevived = heldLikeMain(recutChanged);
check("MUST-EXCLUDE: deleting the newer cut does not silently revive the voided confirmation", notRevived.ok, notRevived.detail);

// …a standalone upload to the slot voids it, even with the very same bytes…
const standalone = await mk([FRAMING, ...LETTER_PAGES]);
const standaloneCut = structuralDocs(standalone)[0];
await confirmAs(standalone, standaloneCut.id);
await new Promise((r) => setTimeout(r, 5));
saveProjectDocument(db, standalone, { docType: "structural", filename: "framing-sheet.pdf", contentType: "application/pdf",
  buffer: fs.readFileSync(standaloneCut.stored_path), source: "upload" });
const standaloneHeld = heldLikeMain(standalone);
check("MUST-EXCLUDE: a standalone upload to the `structural` slot voids the confirmation — held again", standaloneHeld.ok, standaloneHeld.detail);
check("…with the reason on the card", /newer document was filed/.test(reasonOf(standalone)), reasonOf(standalone));

// …and a re-uploaded plan set that is then deleted does not revive it either.
const planGone = await mk([FRAMING, ...LETTER_PAGES]);
await confirmAs(planGone, structuralDocs(planGone)[0].id);
await new Promise((r) => setTimeout(r, 5));
const planGoneRow = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set'", [planGone])!;
const rev1 = saveProjectDocument(db, planGone, { docType: "plan_set", filename: "plan-set-rev1.pdf", contentType: "application/pdf", buffer: fs.readFileSync(planGoneRow.stored_path), source: "upload" });
deleteProjectDocument(db, planGone, rev1.id);
const planGoneHeld = heldLikeMain(planGone);
check("MUST-EXCLUDE: deleting the newer plan set does not silently revive the voided confirmation", planGoneHeld.ok, planGoneHeld.detail);

// MUST-EXCLUDE (medium): a cut of a superseded plan set is never offered and cannot be confirmed.
const stale = await mk([FRAMING, ...LETTER_PAGES]);
const staleCut = structuralDocs(stale)[0];
await new Promise((r) => setTimeout(r, 5));
const stalePlan = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set'", [stale])!;
saveProjectDocument(db, stale, { docType: "plan_set", filename: "plan-set-rev1.pdf", contentType: "application/pdf", buffer: fs.readFileSync(stalePlan.stored_path), source: "upload" });
check("MUST-EXCLUDE: a cut older than the newest plan set is not offered as the candidate",
  gate(stale).structuralLetter?.candidate === null, JSON.stringify(gate(stale).structuralLetter?.candidate));
let staleStatus = "";
try { await confirmAs(stale, staleCut.id); } catch (e) { staleStatus = String((e as { status?: number }).status); }
const staleHeld = heldLikeMain(stale);
check("MUST-EXCLUDE: confirming a cut older than the newest plan set is refused (409), nothing written, still held",
  staleStatus === "409" && staleHeld.ok && db.query("SELECT id FROM structural_letter_confirmations WHERE project_id = ?", [stale]).length === 0,
  `${staleStatus} ${staleHeld.detail}`);
// Re-splitting the new plan set offers the new cut, and that one can be confirmed.
await buildUtilityPackage(db, stale, "permit");
const freshCut = structuralDocs(stale).find((d) => d.id !== staleCut.id);
check("…the re-split of the newest plan set is the candidate, and confirming it releases the hold",
  Boolean(freshCut) && gate(stale).structuralLetter?.candidate?.documentId === freshCut?.id
  && (await confirmAs(stale, freshCut!.id)).documentId === freshCut?.id && released(stale).ok, released(stale).detail);

// Pages come from the PDF, not from extracted text: scanned (empty) pages still count, and the
// confirmed page is clamped into the document.
const scanned = await mk([]);
const scanPdf = await PDFDocument.create();
const scanFont = await scanPdf.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 4; i++) scanPdf.addPage([612, 792]);
const last = scanPdf.addPage([612, 792]);
LETTER_PAGES[0].forEach((line, i) => last.drawText(line, { x: 40, y: 740 - i * 24, size: 10, font: scanFont }));
const scanDoc = saveProjectDocument(db, scanned, { docType: "structural", filename: "scanned-letter.pdf", contentType: "application/pdf", buffer: Buffer.from(await scanPdf.save()), source: "upload" });
for (let i = 0; i < 200; i++) {
  if (db.get<{ t: string }>("SELECT extracted_text AS t FROM project_documents WHERE id = ?", [scanDoc.id])?.t) break;
  await new Promise((r) => setTimeout(r, 25));
}
const scanCand = SL.structuralLetterCandidate(db, scanned);
check("pages: four scanned pages then the letter → pageCount 5, page 5 (extracted text collapses the blank pages)",
  scanCand?.documentId === scanDoc.id && scanCand.pageCount === 5 && scanCand.page === 5, JSON.stringify(scanCand));
const clamped = await confirmAs(scanned, scanDoc.id, 999);
const clampedLow = await confirmAs(scanned, scanDoc.id, -3);
check("pages: a confirmed page is clamped into 1..pageCount", clamped.page === 5 && clampedLow.page === 1, `${clamped.page} ${clampedLow.page}`);
const supersede = audits(scanned, "structural_letter.confirmed").map((a) => JSON.parse(a.details) as { userId?: string; confirmationId?: string; supersededConfirmationId?: string });
check("audit: the confirm carries the user id, and a superseding confirm names the confirmation it superseded",
  supersede.length === 2 && supersede.every((a) => a.userId === "user-jane") && !supersede[0].supersededConfirmationId
  && supersede[1].supersededConfirmationId === clamped.id, JSON.stringify(supersede));
SL.withdrawStructuralLetterConfirmation(db, scanned, "Jane Example", "user-jane");
const wd = audits(scanned, "structural_letter.withdrawn").map((a) => JSON.parse(a.details) as { userId?: string });
check("audit: the withdraw carries the user id", wd.length === 1 && wd[0].userId === "user-jane", JSON.stringify(wd));

// ── MUST-EXCLUDE: an engineered project with no structural document has nothing to confirm ────
const noStructural = await mk([]);
check("fixture: no `structural` document exists on the bare project", structuralDocs(noStructural).length === 0);
const bare = heldLikeMain(noStructural);
check("MUST-EXCLUDE: with no structural document the job is held", bare.ok, bare.detail);
check("…and the card offers no candidate", gate(noStructural).structuralLetter?.candidate === null, JSON.stringify(gate(noStructural).structuralLetter));

// The tile rule: with a confirmation its words ask for the seal to be verified — never "none is in
// the package … obtain the sealed engineering"; without one it stays a blocker.
const tileProject = { id: "tile", state: "OR", ahj: "City of Testville", utility: "PGE",
  parserSnapshot: { roofMaterial: "Concrete Tile", framingType: "truss", roofRafterSpacing: 24, roofRafterSpan: 10, mounting: "Roof mount", snow: 25, deadLoad: 3, wind: "B" } } as never;
const tileFinding = (cert: { confirmedBy: string; confirmedAt: string } | null) => evaluateDesignCodeFindings(tileProject, null, undefined, ["plan_set", "structural"], [], cert)
  .find((x) => x.id === "city.struct.tile-stamped-engineering-missing");
const tileCert = tileFinding({ confirmedBy: "Jane Example", confirmedAt: "2026-10-08T12:00:00.000Z" });
check("tile: with a confirmation the tile stamp finding is a warning that says to verify the seal, naming who confirmed",
  tileCert?.severity === "warning" && /verify the seal/i.test(tileCert.title) && /Jane Example 2026-10-08/.test(tileCert.message)
  && !/none is in the package/i.test(tileCert.message) && !/^Obtain/i.test(tileCert.designTeamAction ?? ""),
  JSON.stringify(tileCert && { severity: tileCert.severity, title: tileCert.title, message: tileCert.message }));
check("tile: without one the tile stamp finding stays a blocker asking for the sealed engineering",
  tileFinding(null)?.severity === "blocker" && /none is in the package/i.test(tileFinding(null)?.message ?? ""), JSON.stringify(tileFinding(null)?.severity));

// ── MUST-EXCLUDE: with no confirmation, every probe of rounds 1–4 and every genuine letter is held ──
// End to end through the splitter, the inventory, the reviewer and the submit gate.
const probes: Array<[string, string[]]> = [
  ...Object.entries(CITING_LINES).map(([n, l]): [string, string[]] => [`round 1–4 "${n}"`, [...FRAMING_FULL, ...l.split("\n")]]),
  ...Object.entries(ROUND4_PROBES).map(([n, l]): [string, string[]] => [`round 4 "${n}"`, [...FRAMING_FULL, ...l.split("\n")]]),
  ...Object.entries(GENUINE_SIGNATURES).map(([n, sig]): [string, string[]] => [`genuine letter "${n}"`, [...LETTER_BODY, sig]]),
];
for (const [name, lines] of probes) {
  const pid = await mk([lines]);
  const hasSplit = structuralDocs(pid).length > 0;
  const h = heldLikeMain(pid);
  check(`MUST-EXCLUDE gate, no confirmation: ${name} (split as structural: ${hasSplit}) — held exactly as main`, hasSplit && h.ok, h.detail);
}

db.close();
if (failures) { console.error(`\nstructuralCertificationCredit: ${failures} FAILED`); process.exit(1); }
console.log("\nstructuralCertificationCredit: all checks passed");
process.exit(0);
