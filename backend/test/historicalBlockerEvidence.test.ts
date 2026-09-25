// ONE OLD CORRECTION MUST NOT BLOCK EVERY LATER PROJECT AT AN AHJ.
//
// The 100-project load test (.probe/volume/assess_load.result.md) found Portland 0/11, Coos Bay
// 0/6, Lincoln City 0/5 and Douglas 0/5 ready — every one carrying "Historical blocker: Missing
// roof framing/span evidence", including 12 whose uploaded plan set states the framing.
//
// THE MECHANISM (historicalFailures.ts). buildHistoricalFailureReport built its project from the
// raw row, so the evidence check behind the learned blocker never saw:
//   (a) the uploaded plan-set text — getProjectDetail overlays it for the reviewer gate, this
//       module read parser_json only; and
//   (b) the parser's STRUCTURED framing fields (framingType, roofRafterSpacing, …), which were
//       not evidence sources at all (projectEvidence.sourcesFor).
// So a project whose sheets say "pre-engineered trusses @ 24 in o.c." read "missing" forever,
// and the only exit was a per-project clear.
//
// What this test holds, through the REAL write paths (createProject, addManualCorrection → the
// real classifier + learnFromCorrection, saveProjectDocument + its real PDF text extraction) and
// the REAL submit gate (getSubmitGateReport):
//   MUST-PASS    a plan set that states the framing clears the blocker for THAT project;
//   MUST-PASS    parsed framing fields clear it;
//   MUST-EXCLUDE a plan set that lacks framing (with the usual STRUCTURAL/engineer boilerplate)
//                still gets the blocker;
//   MUST-PASS    an operator acknowledges it ONCE at the AHJ → later projects there are not
//                blocked (still reminded);
//   MUST-EXCLUDE that acknowledgement does not leak to another AHJ, or to another org.
import "./_isolate";
import fs from "node:fs";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createProject, addManualCorrection, getSubmitGateReport } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const hist = await import("../src/historicalFailures");
const { persistTriage } = await import("../src/correctionAgent");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const db = await openDatabase();

const FRAMING_TITLE = "Missing roof framing/span evidence";

async function planSetPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([792, 612]);
  lines.forEach((line, i) => page.drawText(line, { x: 36, y: 560 - i * 18, size: 10, font }));
  return Buffer.from(await doc.save());
}

async function attachPlanSet(projectId: string, lines: string[]): Promise<void> {
  const doc = saveProjectDocument(db, projectId, { docType: "plan_set", filename: "plans.pdf", contentType: "application/pdf", buffer: await planSetPdf(lines) });
  // Extraction is the real background extractor; wait for its write.
  for (let i = 0; i < 200; i++) {
    const row = db.get<{ extracted_text?: string | null }>("SELECT extracted_text FROM project_documents WHERE id = ?", [doc.id]);
    if (row?.extracted_text) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("plan-set text extraction never finished");
}

type Payload = Parameters<typeof createProject>[1];
const mk = (owner: string, over: Record<string, unknown> = {}, orgId?: string): string => createProject(db, {
  owner, address: `${Math.floor(Math.random() * 9000) + 100} SE Test St`, city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PGE", dcKw: "6.0", acKw: "5.0", mounting: "Roof mount",
  ...over,
} as Payload, ...(orgId ? [orgId] as [string] : [])).project.id;

const historicalBlockers = (projectId: string): string[] => {
  const check = getSubmitGateReport(db, projectId).checks.find((c) => c.id === "permit-requirements");
  return (check?.evidence ?? []).filter((line) => line.startsWith("Historical blocker:"));
};
const blockedByFraming = (projectId: string): boolean => historicalBlockers(projectId).some((line) => line.includes(FRAMING_TITLE));
const framingItem = (projectId: string) => hist.buildHistoricalFailureReport(db, projectId, null).checklist.find((i) => i.title === FRAMING_TITLE);

// ── The old correction at Portland ────────────────────────────────────────────────────────
// Intake (real regex classifier) → the correction agent's triage (persistTriage, the real writer
// the agent uses) re-derives the learned failure row from its root cause — the path production's
// "roof framing" rows came through. No LLM: the triage RESULT is the fixture, its writer is real.
const CORRECTION_TEXT = "Plan review correction: provide the roof framing — rafter size, spacing and span — and the structural calculations for the array.";
const learnFramingCorrection = (projectId: string): void => {
  const correction = addManualCorrection(db, projectId, CORRECTION_TEXT).corrections[0];
  persistTriage(db, { correctionId: correction.id, projectId }, {
    bucket: "B_designer_fix",
    rootCause: "Missing roof framing / rafter span evidence",
    requiredAction: "Show rafter or truss size, spacing and span on the structural sheet.",
    actions: ["Send to the designer"], proposals: [],
  });
};
const oldProject = mk("Old Correction Owner");
learnFramingCorrection(oldProject);
const learned = db.query<{ root_cause: string; ahj: string }>("SELECT root_cause, ahj FROM historical_failure_examples");
check("SETUP: the correction was learned as a historical failure at Portland", learned.length >= 1 && learned.some((r) => /portland/i.test(r.ahj)), JSON.stringify(learned));

// A plan set with NO framing information — but the ordinary STRUCTURAL / engineer boilerplate
// every real set carries. This is the MUST-EXCLUDE fixture: boilerplate is not framing evidence.
const NO_FRAMING_SHEETS = [
  "SHEET PV-1 SITE PLAN: array location, fire access pathways and setbacks shown.",
  "SHEET E-1 ELECTRICAL LINE DIAGRAM: 200A bus, 175A main, 40A PV breaker. Enphase IQ8PLUS-72-2-US.",
  "STRUCTURAL NOTES: installer to verify all field conditions before installation.",
  "Do not scale drawings. Do not reproduce without the written approval of the engineer.",
];
const FRAMING_SHEETS = [
  ...NO_FRAMING_SHEETS,
  "SHEET S-1 ROOF SECTION: Roof framing: pre-engineered trusses, 2x4 top chord at 24 in o.c., clear span 11 ft 6 in, DF-L No.2.",
];

// ── MUST-EXCLUDE: a plan set that lacks the framing still gets the blocker ────────────────
const noFraming = mk("No Framing Owner");
await attachPlanSet(noFraming, NO_FRAMING_SHEETS);
check("MUST-EXCLUDE: a plan set without roof framing (boilerplate only) is still blocked by the historical correction",
  blockedByFraming(noFraming), JSON.stringify(historicalBlockers(noFraming)));
check("…and its checklist item reads MISSING", framingItem(noFraming)?.status === "missing", String(framingItem(noFraming)?.status));

// ── MUST-PASS: plan-set evidence clears it for THAT project ────────────────────────────────
const withSheets = mk("Framing Sheets Owner");
await attachPlanSet(withSheets, FRAMING_SHEETS);
check("MUST-PASS: a plan set that STATES the roof framing clears the historical blocker for that project",
  !blockedByFraming(withSheets), JSON.stringify(historicalBlockers(withSheets)));
check("…and the checklist item is satisfied (present), citing the sheet", framingItem(withSheets)?.status === "present"
  && (framingItem(withSheets)?.evidence ?? []).some((l) => /truss/i.test(l)), JSON.stringify(framingItem(withSheets)));

// ── MUST-PASS: the parser's structured framing fields clear it ─────────────────────────────
const withFields = mk("Framing Fields Owner", { framingType: "truss", roofRafterSpacing: "24", roofRafterSpan: "11.5" });
check("MUST-PASS: parsed framing fields (truss @ 24 in o.c., 11.5 ft span) clear the historical blocker",
  !blockedByFraming(withFields), JSON.stringify(historicalBlockers(withFields)));
const typeOnly = mk("Framing Type Only Owner", { framingType: "truss" });
check("…a member type with no size/spacing/span is a lead, not proof: it is not MISSING, and not PRESENT either",
  framingItem(typeOnly)?.status === "needs_review", String(framingItem(typeOnly)?.status));
const junkField = mk("Framing Unknown Owner", { framingType: "unknown" });
check("MUST-EXCLUDE: a framing field that says 'unknown' is not evidence", blockedByFraming(junkField), JSON.stringify(historicalBlockers(junkField)));

// ── MF1 (D1 verification): the dimension must belong to the MEMBER ─────────────────────────
// Every plan set has a clause that names a rafter while describing the ATTACHMENT; its fastener
// size and attachment spacing used to read as "framing shown" (present/high) and cleared the
// learned blocker. A sheet title or "to be verified" named a member and read needs_review, which
// the gate does not block on. Through the real PDF extraction, like the fixtures above.
const MF1_EXCLUDE: Array<[string, string[]]> = [
  ["a lag-screw attachment detail", ["ATTACHMENT DETAIL: 5/16\" x 4\" SS LAG SCREW INTO RAFTER, 2.5\" MIN EMBEDMENT, FLASHED."]],
  ["rails attached to rafters @ 48\" o.c.", ["RAILS ATTACHED TO RAFTERS WITH L-FOOT MOUNTS @ 48\" O.C. MAX."]],
  ["standoffs lagged to rafters @ 48 in o.c.", ["Racking attachment detail shows flashed standoffs lagged to rafters @ 48 in o.c."]],
  ["a 3/8 x 5 lag into the rafters", ["ATTACHMENT: rafters, 3/8 x 5 lag, 2 per foot."]],
  ["a sheet title only", ["SHEET INDEX: PV-1 SITE PLAN, PV-2 ROOF PLAN, PV-3 ROOF FRAMING PLAN, E-1 SLD"]],
  ["'existing roof framing to be verified'", ["EXISTING ROOF FRAMING TO BE VERIFIED BY INSTALLER PRIOR TO INSTALL."]],
];
for (const [label, lines] of MF1_EXCLUDE) {
  const pid = mk(`MF1 Exclude ${label}`);
  await attachPlanSet(pid, [...NO_FRAMING_SHEETS, ...lines]);
  check(`MF1 MUST-EXCLUDE: ${label} keeps the learned framing blocker`, blockedByFraming(pid) && framingItem(pid)?.status === "missing",
    `${framingItem(pid)?.status} ${JSON.stringify(historicalBlockers(pid))}`);
}
const memberDims = mk("MF1 Member Dimensions Owner");
await attachPlanSet(memberDims, [...NO_FRAMING_SHEETS, "ROOF FRAMING: 2x6 rafters @ 24\" o.c., 10 ft span.", "ATTACHMENT DETAIL: 5/16\" x 4\" SS LAG SCREW INTO RAFTER, FLASHED."]);
check("MF1 MUST-PASS: '2x6 rafters @ 24\" o.c., 10 ft span' clears the learned blocker (the lag detail beside it does not spoil it)",
  !blockedByFraming(memberDims) && framingItem(memberDims)?.status === "present", `${framingItem(memberDims)?.status} ${JSON.stringify(historicalBlockers(memberDims))}`);
const mixedLine = mk("MF1 Mixed Line Owner");
await attachPlanSet(mixedLine, [...NO_FRAMING_SHEETS, "2X6 RAFTERS @ 24\" O.C., ATTACH RAILS W/ 5/16\" LAGS"]);
check("MF1 MUST-PASS: framing and attachment on ONE line — the member's part still counts",
  !blockedByFraming(mixedLine), JSON.stringify(historicalBlockers(mixedLine)));

// ── AHJ-level acknowledgement: once, by an operator ─────────────────────────────────────────
const signature = framingItem(noFraming)?.sourceCauseSignature ?? "";
check("SETUP: the blocker carries a cause signature", Boolean(signature));
const ack = hist.acknowledgeHistoricalBlocker(db, { projectId: noFraming, signature, actor: "ops@example.test", note: "Portland accepts the framing note on the structural sheet." }, null);
check("the acknowledgement names the AHJ it applies to", /portland/i.test(ack.ahj) && ack.state === "OR", JSON.stringify(ack));
const audit = db.query<{ action: string; details: string }>("SELECT action, details FROM audit_logs WHERE action LIKE 'historical_blocker.%'");
check("the acknowledgement is recorded on the audit trail with the org and AHJ", audit.length === 1 && /City of Portland/.test(audit[0].details) && /org-default/.test(audit[0].details), JSON.stringify(audit));
check("MUST-PASS: after the AHJ-level acknowledgement the SAME project is no longer blocked", !blockedByFraming(noFraming), JSON.stringify(historicalBlockers(noFraming)));
const later = mk("Later Portland Owner");
await attachPlanSet(later, NO_FRAMING_SHEETS);
check("MUST-PASS: a LATER project at the same AHJ is not blocked either (acknowledged once, not per project)",
  !blockedByFraming(later), JSON.stringify(historicalBlockers(later)));
check("…but it is still REMINDED: the item stays in the checklist, saying who acknowledged it",
  framingItem(later)?.status === "missing" && /acknowledged/i.test(framingItem(later)?.why ?? ""), JSON.stringify(framingItem(later)));
const permitReq = getSubmitGateReport(db, later).checks.find((c) => c.id === "permit-requirements");
check("…and the gate row is a WARNING about it, never a pass that forgets it", permitReq?.status !== "pass", String(permitReq?.status));

// ── MUST-EXCLUDE: the acknowledgement stays at its AHJ and in its org ──────────────────────
const salem = mk("Salem Owner", { city: "Salem", zip: "97301", ahj: "City of Salem" });
await attachPlanSet(salem, NO_FRAMING_SHEETS);
check("SETUP: a Salem project on the same utility matches the Portland correction",
  (hist.buildHistoricalFailureReport(db, salem, null).topRejectionCauses ?? []).some((c) => c.signature === signature && c.count > 0));
check("MUST-EXCLUDE: Portland's acknowledgement does not clear the blocker at ANOTHER AHJ", blockedByFraming(salem), JSON.stringify(historicalBlockers(salem)));

const ORG_B = "org-bbbb2222";
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [ORG_B, ORG_B, new Date().toISOString()]);
const orgBOld = mk("Org B Old Owner", {}, ORG_B);
learnFramingCorrection(orgBOld);
const orgBNew = mk("Org B New Owner", {}, ORG_B);
await attachPlanSet(orgBNew, NO_FRAMING_SHEETS);
check("MUST-EXCLUDE: org A's acknowledgement at Portland does not clear ORG B's own Portland blocker",
  blockedByFraming(orgBNew), JSON.stringify(historicalBlockers(orgBNew)));
let crossed = "";
try { hist.acknowledgeHistoricalBlocker(db, { projectId: orgBNew, signature, actor: "x" }, "org-default"); crossed = "wrote"; }
catch (err) { crossed = String((err as { status?: number }).status ?? err); }
check("MUST-EXCLUDE: a caller in another org cannot acknowledge for this project (404)", crossed === "404", crossed);
let unknownSig = "";
try { hist.acknowledgeHistoricalBlocker(db, { projectId: later, signature: "not a real signature", actor: "x" }, null); unknownSig = "wrote"; }
catch (err) { unknownSig = String((err as { status?: number }).status ?? err); }
check("MUST-EXCLUDE: a signature that is not one of this project's learned blockers is refused", unknownSig === "404", unknownSig);

// ── Revoke: the acknowledgement is a human decision a human can take back ──────────────────
hist.revokeHistoricalBlockerAcknowledgement(db, { projectId: later, signature, actor: "ops@example.test" }, null);
check("after a revoke, the Portland projects are blocked again", blockedByFraming(later) && blockedByFraming(noFraming), JSON.stringify(historicalBlockers(later)));
check("…and the plan-set evidence still clears the project that HAS it", !blockedByFraming(withSheets));

// ── MF1 at a STANDARD-REVIEW AHJ (TX): nothing else backstops the framing there ─────────────
// In Oregon the prescriptive-span reviewer check still catches a set with no rafter numbers; at a
// standard-review AHJ (FL/TX/UT/CA — the prospects) the learned blocker is the only thing between
// an attachment-only set and ready_to_stage. The smoke's complete fixture, moved to Austin.
{
  const { createClient } = await import("../src/clients");
  const { computeNextStep } = await import("../src/nextStep");
  const txClient = createClient(db, {
    companyName: "Framing TX Solar LLC", legalBusinessName: "Framing TX Solar LLC", ccbLicenseNumber: "240135",
    electricalLicenseNumber: "C1234", businessEmail: "ops@ftx.test", businessPhone: "(512) 555-0142",
  });
  const noSplit = "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12";
  const COMPLETE_TX: Record<string, string> = {
    street: "123 Solar Way", city: "Austin", state: "TX", zip: "78701", ahj: "City of Austin", utility: "Austin Energy",
    account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
    moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
    interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE",
    framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B", mounting: "Roof mount",
    locateCalloutText: "No locate-triggering scope found.",
    sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
    roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
    structuralCalcText: "Rooftop PV structural check complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
    electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
    labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
    splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
    utilityDownloadChecklistText: "Utility package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
    packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
  };
  let txSeq = 0;
  const mkTx = (over: Record<string, string> = {}): string => {
    const pid = createProject(db, { clientId: txClient.id, owner: `TX Framing Owner ${++txSeq}`, ...COMPLETE_TX, street: `${200 + txSeq} Congress Ave`, ...over } as Payload).project.id;
    saveProjectDocument(db, pid, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% plan set\n", "utf8"), source: "upload" });
    return pid;
  };
  const reviewerFramingBlocker = (pid: string): boolean => (getSubmitGateReport(db, pid).checks.find((c) => c.id === "permit-requirements")?.evidence ?? [])
    .some((l) => l.startsWith("Roof framing information missing"));
  const txControl = mkTx();
  check("SETUP (TX): the complete fixture reaches ready_to_stage at City of Austin before any correction", computeNextStep(db, txControl).key === "ready_to_stage", computeNextStep(db, txControl).key);
  learnFramingCorrection(mkTx());
  const noMemberFields = { framingType: "", roofRafterSpacing: "", roofRafterSpan: "", structuralCalcText: "", splitPagesText: noSplit };
  const txAttachOnly = mkTx({ ...noMemberFields, roofPlanNotesText: "Racking attachment detail shows flashed standoffs lagged to rafters @ 48 in o.c." });
  check("MF1 MUST-EXCLUDE (TX gate): an attachment-only set is blocked by the learned framing blocker, never ready_to_stage",
    blockedByFraming(txAttachOnly) && computeNextStep(db, txAttachOnly).key !== "ready_to_stage"
    && getSubmitGateReport(db, txAttachOnly).checks.find((c) => c.id === "permit-requirements")?.status === "blocker",
    `${computeNextStep(db, txAttachOnly).key} ${JSON.stringify(historicalBlockers(txAttachOnly))}`);
  const txSheetTitle = mkTx({ ...noMemberFields, roofPlanNotesText: "SHEET INDEX: PV-1 SITE PLAN, PV-2 ROOF PLAN, PV-3 ROOF FRAMING PLAN, E-1 SLD. Racking per manufacturer." });
  check("MF1 MUST-EXCLUDE (TX gate): a framing SHEET TITLE is not framing — the learned blocker stays and the gate stays blocked",
    blockedByFraming(txSheetTitle) && computeNextStep(db, txSheetTitle).key !== "ready_to_stage",
    `${computeNextStep(db, txSheetTitle).key} ${JSON.stringify(historicalBlockers(txSheetTitle))}`);
  const txMembers = mkTx({ ...noMemberFields, roofPlanNotesText: "Roof framing: 2x6 rafters @ 24\" o.c., 10 ft span. Racking attachment detail shows flashed standoffs lagged to rafters @ 48 in o.c." });
  check("MF1 MUST-PASS (TX gate): '2x6 rafters @ 24\" o.c., 10 ft span' clears the learned blocker AND the reviewer's framing finding",
    !blockedByFraming(txMembers) && !reviewerFramingBlocker(txMembers) && computeNextStep(db, txMembers).key === "ready_to_stage",
    `${computeNextStep(db, txMembers).key} ${JSON.stringify(getSubmitGateReport(db, txMembers).checks.filter((c) => c.status === "blocker").map((c) => c.evidence))}`);
  // The parser's STRUCTURED framing (framingType + spacing + span, no framing sentence in any
  // text field) clears the LEARNED blocker. The reviewer's own "Roof framing information missing"
  // (codeReviewRules.ts city.struct.framing-missing) reads only the text fields (designText) and
  // never the parsed framing fields, so it still fires here — a pre-existing gap in a file this
  // change does not own (see the close report's open issues), not something this test pins.
  const txParsed = mkTx({ roofPlanNotesText: "Racking per manufacturer.", structuralCalcText: "", splitPagesText: noSplit });
  check("MF1 MUST-PASS (TX gate): parsed framingType + spacing + span clear the learned blocker as well",
    !blockedByFraming(txParsed) && framingItem(txParsed)?.status === "present",
    `${framingItem(txParsed)?.status} ${JSON.stringify(historicalBlockers(txParsed))}`);
}

void fs;
if (failures) { console.error(`\nhistoricalBlockerEvidence: ${failures} FAILED`); process.exit(1); }
console.log("\nhistoricalBlockerEvidence: all checks passed");
process.exit(0);
