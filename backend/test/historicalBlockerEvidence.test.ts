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

void fs;
if (failures) { console.error(`\nhistoricalBlockerEvidence: ${failures} FAILED`); process.exit(1); }
console.log("\nhistoricalBlockerEvidence: all checks passed");
process.exit(0);
