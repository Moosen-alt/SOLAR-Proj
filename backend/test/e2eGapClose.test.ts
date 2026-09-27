// E2E-GAP CLOSE (2026-09-26): the scorer's MF5 / MF6 must-fixes, the lookup-trigger predicate and
// the utility group header — each as an engine invariant on FICTIONAL jurisdictions.
//
//   MF5  OREGON CONTENT ONLY WHERE THE SPLIT EXISTS. permitPath.finalize(..., "parser"|"operator")
//        set standardReview=false regardless of state, so a PE plan set in MA / NM / PA / AZ / MN
//        produced the whole Oregon split on every surface. Outside Oregon (or a jurisdiction whose
//        own cited research names a prescriptive path) an engineered plan set is a STAMPED
//        structural review: one building application, the stamped documents attached.
//        MUST-EXCLUDE  every surface (package docs, gate, reviewer, QC rows, inventory, next step,
//                      the form finder's kind) is free of the split's strings on non-Oregon jobs;
//        MUST-PASS     the Oregon control still carries them; the stamped package is still owed;
//                      MN's QC no longer asks "prescriptive or engineered".
//   MF6  qc.ts docs.complete: PASS only when every item of the job's REQUIRED list (the per-job
//        lookup's cited documents, else a shipped profile's list) is attached; missing items are
//        named; an unknown list is "not yet confirmed", never "every document … is attached".
//        MUST-EXCLUDE  a Waltham-shaped job (cited list of 6, 0 attached) never passes.
//   TRIGGER  applicationDocs.shippedProfileIsAuthoritative: the one predicate that says whether a
//        shipped profile may skip the per-job lookup (a bare seeded row may not).
//   HEADER   dashboard.js: the utility group is headed by the track's own program, esc()'d.
//
// KILLS (each verified red with the fix removed — see the commit message):
//   K1 permitPath.finalize: standardReview ignores splitApplies         → (m1) fails on every state
//   K2 qc.ts: the permit_path check ignores standardReview               → (m3 MN) fails
//   K3 repository gate: one wording for every jurisdiction               → (m1 gate) fails
//   K4 ahjFormAuto.applicationKindForProject: kind from the bare path    → (m4) fails
//   K5 qc.ts docs.complete: the universal-set pass                        → (d1) fails
//   K6 requiredListCheck: unknown list reads as known                     → (d3) fails
//   K7 dashboard utilityGroupTitle: hard-coded header                     → (h1) fails
//
// Run: npx tsx backend/test/e2eGapClose.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PORTAL_AUTOSEED = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

// A synthetic process reference: one bare seeded row (structure unknown) and one whose words settle
// the structure — for the trigger predicate. Every other AHJ below has no shipped profile.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gap-close-"));
const profile = (o: Record<string, unknown>) => ({
  state: "NM", ahj: "", submissionMethod: "", timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false,
  requiresStructuralStamp: false, requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false,
  requiresSolarChecklist: false, requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false,
  requiresFloodplainCheck: false, requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "(test)", ...o,
});
const REFERENCE = path.join(tmp, "reference-ahj-processes.json");
fs.writeFileSync(REFERENCE, JSON.stringify({ profiles: [
  profile({ ahj: "Bernal County", submissionMethod: "In-person: appointment only", requiresElectricianSign: true }),
  profile({ ahj: "Tres Alamos", submissionMethod: "Email", reviewerNotes: "Apply for the building and electrical permits separately." }),
] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = REFERENCE;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { createProject, getSubmitGateReport, getProjectDetail } = await import("../src/repository");
const { computeNextStep } = await import("../src/nextStep");
const { runQcForProject } = await import("../src/qc");
const { resolvePermitPath, resolveStampRequirement, permitPathCallout } = await import("../src/permitPath");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { buildApplicationDocumentPackage, shippedProfileIsAuthoritative, shippedProfileNeedsPerJobLookup } = await import("../src/applicationDocs");
const { documentInventory, requiredApplicationDocs, applicationDocContext, requiredListCheck, requirementSlots } = await import("../src/requiredDocuments");
const { applicationKindForProject } = await import("../src/ahjFormAuto");
const permitProcess = await import("../src/permitProcess");
const db = await openDatabase();

const client = createClient(db, {
  companyName: "Gap Close Solar LLC", legalBusinessName: "Gap Close Solar LLC", ccbLicenseNumber: "240136",
  electricalLicenseNumber: "C1235", businessEmail: "ops@gapclose.test", businessPhone: "(503) 555-0143",
});
// The smoke's complete fixture, with an ENGINEERED (PE-stamped) plan set: the parser says so and a
// sealed letter is provided (hasStampedStructuralEvidence reads structuralCalcText).
const COMPLETE: Record<string, string> = {
  street: "123 Solar Way", zip: "99999",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invMake: "SolarEdge", invModel: "SE7600H-US", invQty: "1", invOutputW: "7600",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "engineered",
  framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B", mounting: "Roof mount",
  stampRecommendation: "Stamped structural required — PE-sealed structural letter provided: existing framing adequate, no upgrades required.",
  locateCalloutText: "No locate-triggering scope found.",
  sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
  roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
  structuralCalcText: "PE-sealed structural letter provided: existing framing adequate, no upgrades required. Dead load 3.2 psf, ground snow 25 psf, wind exposure B.",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
  labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  utilityDownloadChecklistText: "Utility package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
  packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
};
type Juris = { state: string; city: string; ahj: string; utility: string };
const NON_OREGON: Juris[] = [
  { state: "MA", city: "Weston Mills", ahj: "City of Weston Mills", utility: "Weston Mills Electric" },
  { state: "NM", city: "Bernal", ahj: "Bernal County", utility: "Bernal Electric Cooperative" },
  { state: "PA", city: "Elk Hollow", ahj: "City of Elk Hollow", utility: "Elk Hollow Power" },
  { state: "AZ", city: "Saguaro Ridge", ahj: "City of Saguaro Ridge", utility: "Saguaro Ridge Power District" },
  { state: "MN", city: "Lakeshore", ahj: "City of Lakeshore", utility: "Lakeshore Energy" },
  { state: "IA", city: "Cedar Bluffs", ahj: "City of Cedar Bluffs", utility: "Cedar Bluffs Light & Power" },
  // Florida's seeded state profile carries allowedWindExposures ["B","C","D"] — design-criteria data
  // that used to switch baselineRules' "for the prescriptive path" screens on by itself.
  { state: "FL", city: "Palmetto Shores", ahj: "City of Palmetto Shores", utility: "Palmetto Shores Electric" },
];
const OREGON: Juris = { state: "OR", city: "Coos Bay", ahj: "City of Coos Bay", utility: "Pacific Power" };
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% ${label}\n`, "utf8");
let seq = 0;
const mk = (j: Juris, over: Record<string, string> = {}, docs: string[] = ["plan_set", "structural_letter"]): string => {
  const d = createProject(db, { clientId: client.id, owner: `Gap Owner ${++seq}`, ...COMPLETE, ...j, ...over });
  for (const docType of docs) {
    saveProjectDocument(db, d.project.id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: pdf(docType), source: "upload" });
  }
  return d.project.id;
};

// THE SPLIT'S OWN WORDS — none may appear on a non-Oregon surface. The negated "no
// prescriptive-vs-engineered choice" (hyphenated) is allowed: outOfStatePermitPath pins it.
const OREGON_SPLIT = /non-?\s*prescriptive|do not upload the prescriptive|mutually exclusive|prescriptive vs\.? engineered|prescriptive or engineered|prescriptive\s*\/\s*structural|upload only the (structural|prescriptive) application|the prescriptive (route|application|one)|prescriptive (route|path)\b|renewable[- ]energy|choose prescriptive|structural \/ engineered|prescriptive application|prescriptive solar/i;
const textOf = (v: unknown): string => JSON.stringify(v ?? "");
const hit = (s: string): string => { const m = OREGON_SPLIT.exec(s); return m ? `…${s.slice(Math.max(0, m.index - 80), m.index + 120)}…` : ""; };

function surfaces(pid: string): Record<string, string> {
  const project = getProjectDetail(db, pid).project;
  const pkg = buildApplicationDocumentPackage(project, client);
  const out: Record<string, string> = {};
  for (const doc of pkg.docs) out[`package:${doc.id}`] = `${doc.title}\n${doc.markdown}`;
  out["package:permitType"] = pkg.permitType;
  out["package:basis"] = pkg.permitPath.basis.join(" ");
  for (const c of getSubmitGateReport(db, pid).checks) out[`gate:${c.id}`] = textOf({ title: c.title, requirement: c.requirement, evidence: c.evidence, nextAction: c.nextAction });
  for (const f of buildReviewerReport(project).findings) out[`reviewer:${f.id}`] = textOf({ title: f.title, message: f.message, cityFeedback: f.cityFeedback, designTeamAction: f.designTeamAction, evidenceNeeded: f.evidenceNeeded });
  runQcForProject(db, pid);
  for (const r of db.query<{ rule_id: string; message: string }>("SELECT rule_id, message FROM qc_results WHERE project_id = ?", [pid])) out[`qc:${r.rule_id}`] = r.message;
  for (const p of documentInventory(db, project).presence) out[`inventory:${p.docType}`] = `${p.label} — ${p.why}`;
  const step = computeNextStep(db, pid);
  out["nextStep"] = textOf(step);
  out["callout"] = permitPathCallout(resolvePermitPath(project));
  return out;
}

// ── MF5 ────────────────────────────────────────────────────────────────────────────────────
console.log("\nMF5 — Oregon content only where the split exists");
for (const j of NON_OREGON) {
  const pid = mk(j);
  const project = getProjectDetail(db, pid).project;
  const res = resolvePermitPath(project);
  check(`(m0) ${j.state}: a PE plan set resolves engineered + standardReview (stamped review), with the stamped package still owed`,
    res.path === "engineered" && res.standardReview === true && res.needsEngineeredDocs === true && resolveStampRequirement(project).required === true,
    textOf({ path: res.path, standardReview: res.standardReview, needs: res.needsEngineeredDocs, stamp: resolveStampRequirement(project) }));
  const s = surfaces(pid);
  const offenders = Object.entries(s).filter(([, text]) => OREGON_SPLIT.test(text));
  check(`(m1) MUST-EXCLUDE ${j.state} (${j.ahj}): no surface carries the split's words (${Object.keys(s).length} surfaces swept)`,
    offenders.length === 0, offenders.map(([k, text]) => `${k}: ${hit(text)}`).join("\n     "));
  const gate = getSubmitGateReport(db, pid).checks.find((c) => c.id === "permit-path");
  check(`(m1 gate) ${j.state}: the permit-path check passes as a stamped structural review, not "confirmed (prescriptive vs engineered)"`,
    gate?.status === "pass" && /stamped structural review/i.test(gate.title), textOf(gate));
  const stampedFinding = buildReviewerReport(project).findings.find((f) => f.id === "reviewer.permit-path.stamped-review");
  check(`(m2) ${j.state}: the reviewer states the stamped review and asks for the stamped documents by the AHJ's building application`,
    Boolean(stampedFinding) && /building application/i.test(stampedFinding!.message) && !buildReviewerReport(project).findings.some((f) => f.id === "reviewer.permit-path.engineered"),
    textOf(stampedFinding));
  const qcPath = db.get<{ qc_status: string; message: string }>("SELECT qc_status, message FROM qc_results WHERE project_id = ? AND rule_id = 'critical.permit_path'", [pid]);
  check(`(m3) ${j.state}: QC's permit-path check passes with no path to confirm`, qcPath?.qc_status === "pass" && /no path choice/i.test(qcPath.message), textOf(qcPath));
  check(`(m4) ${j.state}: the form finder is not steered at "the STRUCTURAL one, not the prescriptive one" (no application kind)`,
    applicationKindForProject(project) === null && requiredApplicationDocs(project, applicationDocContext(project)).every((r) => !r.applicationKind));
  check(`(m5) ${j.state}: the package builds ONE building worksheet and the stamped-document collection, no chooser and no prescriptive application`,
    (() => { const ids = buildApplicationDocumentPackage(project, client).docs.map((d) => d.id); return ids.includes("structural") && ids.includes("engineered-docs") && !ids.includes("path-chooser") && !ids.includes("prescriptive-application"); })(),
    buildApplicationDocumentPackage(project, client).docs.map((d) => d.id).join(","));
}
// MN held-out: a plan set with NO path signal and no microinverters — the question QC asked.
{
  const pid = mk({ state: "MN", city: "Lakeshore", ahj: "City of Lakeshore", utility: "Lakeshore Energy" },
    { permitPath: "", stampRecommendation: "", structuralCalcText: "Dead load 3.2 psf, ground snow 25 psf." }, ["plan_set"]);
  runQcForProject(db, pid);
  const qcPath = db.get<{ qc_status: string; message: string }>("SELECT qc_status, message FROM qc_results WHERE project_id = ? AND rule_id = 'critical.permit_path'", [pid]);
  const step = computeNextStep(db, pid);
  check("(m3 MN) MUST-EXCLUDE: a Minnesota job with no path signal is not asked 'prescriptive or engineered' — QC passes the check and the next step never says it",
    qcPath?.qc_status === "pass" && !/prescriptive or engineered/i.test(textOf(step)) && !OREGON_SPLIT.test(textOf(step)), `${textOf(qcPath)} ${textOf(step).slice(0, 300)}`);
  const pending = db.query<{ field_name: string }>("SELECT field_name FROM human_review_items WHERE project_id = ? AND status = 'pending'", [pid]).map((r) => r.field_name);
  check("…and no pending review item asks for the permit path", !pending.includes("permitPath"), pending.join(","));
}
// The Oregon control: the split is Oregon's and stays.
{
  const pid = mk(OREGON);
  const project = getProjectDetail(db, pid).project;
  const res = resolvePermitPath(project);
  check("(m6) MUST-PASS Oregon: an engineered plan set is the engineered path of the split (not a standard review)", res.path === "engineered" && res.standardReview === false && res.needsEngineeredDocs === true, textOf(res));
  const s = surfaces(pid);
  check("(m6) MUST-PASS Oregon: the manifest still says the applications are mutually exclusive and not to upload the prescriptive one",
    /mutually exclusive/i.test(s["package:manifest"] || "") && /do not upload the prescriptive application/i.test(s["package:manifest"] || ""), (s["package:manifest"] || "").slice(0, 400));
  check("(m6) MUST-PASS Oregon: the gate check is 'Permit path confirmed (prescriptive vs engineered)'", /prescriptive vs engineered/i.test(s["gate:permit-path"] || ""), s["gate:permit-path"]);
  check("(m6) MUST-PASS Oregon: the reviewer's engineered-path finding is unchanged", Boolean(s["reviewer:reviewer.permit-path.engineered"]) && /upload ONLY the structural application/i.test(s["reviewer:reviewer.permit-path.engineered"]));
  check("(m6) MUST-PASS Oregon: the form finder is steered at the structural application", applicationKindForProject(project) === "structural");
  const orUnknown = mk(OREGON, { permitPath: "", stampRecommendation: "", structuralCalcText: "", framingType: "", roofRafterSpacing: "", roofRafterSpan: "", snow: "", deadLoad: "", wind: "", mounting: "" }, ["plan_set"]);
  const qcPath = db.get<{ qc_status: string }>("SELECT qc_status FROM qc_results WHERE project_id = ? AND rule_id = 'critical.permit_path'", [orUnknown]);
  check("(m6) MUST-PASS Oregon: a job with no path signal is still asked to confirm its path", qcPath?.qc_status === "warning", textOf(qcPath));
}
// baselineRules: an exposure LIST alone (Florida's seeded ["B","C","D"]) is design-criteria data, not
// a prescriptive path — the "for the prescriptive path" screens run only from a researched path or a
// numeric structural limit; a researched "no prescriptive path" switches them all off.
{
  const { evaluateBaselineRules } = await import("../src/baselineRules");
  const { buildCodeContext } = await import("../src/codeProfiles");
  const ctxOf = (prescriptive: Record<string, unknown>) => buildCodeContext("FL", "City of Palmetto Shores", {
    key: "fl|city of palmetto shores|unknown", state: "FL", ahj: "City of Palmetto Shores", confidence: "seeded",
    adoptedCodes: [{ code: "NEC", edition: "2020" }], amendments: [], designCriteria: {}, prescriptive, fireSetbacks: [], citations: [], updatedAt: "",
  } as never);
  const payload = { ...COMPLETE, state: "FL", ahj: "City of Palmetto Shores", utility: "Palmetto Shores Electric", wind: "D", snow: "50" } as never;
  const ids = (p: Record<string, unknown>) => evaluateBaselineRules(payload, ctxOf(p)).map((r) => r.ruleId);
  check("(m8) MUST-EXCLUDE: an exposure list alone never raises a 'prescriptive wind exposure' screen outside Oregon",
    !ids({ allowedWindExposures: ["B", "C"] }).some((id) => /prescriptive/.test(id)), ids({ allowedWindExposures: ["B", "C"] }).join(","));
  check("(m8) MUST-PASS: a researched prescriptive path, or a numeric limit (Idaho's 40 psf), still runs the screens",
    ids({ allowedWindExposures: ["B", "C"], hasPrescriptivePath: true }).includes("fl-prescriptive-wind-exposure") && ids({ maxGroundSnowPsf: 40 }).includes("fl-prescriptive-snow"));
  check("(m8) MUST-EXCLUDE: a researched 'publishes no prescriptive path' switches every screen off",
    !ids({ hasPrescriptivePath: false, maxGroundSnowPsf: 40, allowedWindExposures: ["B", "C"] }).some((id) => /prescriptive/.test(id)));
}
// A jurisdiction whose OWN research names a prescriptive path keeps the split (any state).
{
  const r = resolvePermitPath({ state: "FL", ahj: "City of Palmetto Shores", parserSnapshot: { ...COMPLETE } } as never, { limits: { hasPrescriptivePath: true, maxRafterSpacingIn: 24 } });
  check("(m7) MUST-PASS: a researched prescriptive path outside Oregon keeps the split for an engineered plan set", r.path === "engineered" && r.standardReview === false, textOf(r));
}

// ── MF6 ────────────────────────────────────────────────────────────────────────────────────
console.log("\nMF6 — docs.complete reads the job's own required list");
const cited = <T>(value: T, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const none = (why = "not searched") => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
const WALTHAM_LIST = [
  "Building permit application signed by the owner of record and the construction supervisor",
  "Workers' compensation affidavit or insurance binder",
  "Waste debris form",
  "Copy of the CSL and HIC licenses",
  "Pre- and post-installation affidavit by the engineer of record",
  "Letter stamped by an engineer in regards to electrical, wind, load and attachments",
];
const docsRow = (label: string, docs: string[], url: string) => ({
  discipline: "structural", label, issuingAgency: none(), portalUrl: none(), recordType: none(), fee: none(),
  documents: cited(docs, url, docs[0]),
});
{
  const j = { state: "MA", city: "Harbor Glen", ahj: "City of Harbor Glen", utility: "Harbor Glen Electric" };
  const url = "https://www.harborglen-ma.gov/building/solar";
  permitProcess.savePermitProcessLookup(db, { state: j.state, ahj: j.ahj, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(),
    permits: [docsRow("Building permit", WALTHAM_LIST, url)] } as never);
  const pid = mk(j, {}, ["plan_set", "structural_letter"]);
  runQcForProject(db, pid);
  const row = db.get<{ qc_status: string; message: string }>("SELECT qc_status, message FROM qc_results WHERE project_id = ? AND rule_id = 'docs.complete'", [pid]);
  check("(d1) MUST-EXCLUDE: a Waltham-shaped job (cited list of 6, none attached) never passes docs.complete",
    row?.qc_status === "warning" && !/^Every document/i.test(row.message) && !/is attached\.$/i.test(row.message), textOf(row));
  check("…and the row names the missing items and the list's source",
    /Workers' compensation affidavit/.test(row?.message || "") && /Waste debris form/.test(row?.message || "") && /per-job process lookup/.test(row?.message || "") && row!.message.includes(url), textOf(row));
  check("…an item no slot can hold is said so (it is not attached, and cannot be by a slot)", /no document slot holds this/.test(row?.message || ""), textOf(row));
  const list = requiredListCheck(db, getProjectDetail(db, pid).project, documentInventory(db, getProjectDetail(db, pid).project));
  check("…the engineer's letter on the list IS satisfied by the attached structural letter (item-level presence works)",
    list.items.find((i) => /Letter stamped by an engineer/.test(i.text))?.present === true, textOf(list.items));
}
{
  // A cited list every item of which maps to a slot, all attached → PASS, naming the list.
  const j = { state: "PA", city: "Millbrook", ahj: "City of Millbrook", utility: "Millbrook Power" };
  const url = "https://www.millbrookpa.gov/permits/solar";
  permitProcess.savePermitProcessLookup(db, { state: j.state, ahj: j.ahj, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(),
    permits: [docsRow("Building permit", ["Plan set", "Site plan showing setbacks and the array", "Single-line electrical diagram", "Module and inverter specification sheets", "Stamped structural letter"], url)] } as never);
  const pid = mk(j, {}, ["plan_set", "structural_letter", "module_spec", "inverter_spec"]);
  runQcForProject(db, pid);
  const row = db.get<{ qc_status: string; message: string }>("SELECT qc_status, message FROM qc_results WHERE project_id = ? AND rule_id = 'docs.complete'", [pid]);
  check("(d2) MUST-PASS: a cited list whose every item is attached passes, and the row says whose list it is",
    row?.qc_status === "pass" && /Every document on the required list/.test(row.message) && row.message.includes(url), textOf(row));
  // The agency adds an item whose slot is empty → the same job is a warning naming exactly that item.
  permitProcess.savePermitProcessLookup(db, { state: j.state, ahj: j.ahj, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(),
    permits: [docsRow("Building permit", ["Plan set", "Site plan showing setbacks and the array", "Single-line electrical diagram", "Module and inverter specification sheets", "Stamped structural letter", "Copy of the current utility bill"], url)] } as never);
  runQcForProject(db, pid);
  const row2 = db.get<{ qc_status: string; message: string }>("SELECT qc_status, message FROM qc_results WHERE project_id = ? AND rule_id = 'docs.complete'", [pid]);
  check("…and with an unattached item on the list the row is a warning naming that item alone",
    row2?.qc_status === "warning" && /1 of 6 missing/.test(row2.message) && /utility bill/.test(row2.message) && !/Plan set;/.test(row2.message), textOf(row2));
}
{
  // No lookup, no shipped profile: the list is unknown — never "every document … is attached".
  const pid = mk({ state: "PA", city: "Elk Hollow", ahj: "City of Elk Hollow", utility: "Elk Hollow Power" }, {}, ["plan_set", "structural_letter", "module_spec", "inverter_spec"]);
  runQcForProject(db, pid);
  const row = db.get<{ qc_status: string; message: string }>("SELECT qc_status, message FROM qc_results WHERE project_id = ? AND rule_id = 'docs.complete'", [pid]);
  check("(d3) MUST-EXCLUDE: with no known list the row says the list is not yet confirmed, and never 'every document … is attached'",
    row?.qc_status === "warning" && /not yet confirmed/i.test(row.message) && !/every document/i.test(row.message), textOf(row));
}
{
  // A hand-written profile's own list counts as a list (Marion County: path-scoped items).
  const pid = mk({ state: "OR", city: "Keizer", ahj: "Marion County", utility: "PGE" }, {}, ["plan_set", "structural_letter", "module_spec", "inverter_spec"]);
  const project = getProjectDetail(db, pid).project;
  const list = requiredListCheck(db, project, documentInventory(db, project));
  check("(d4) MUST-PASS: a hand-written profile's list is a known list (Oregon control), prescriptive-only items skipped on the engineered path",
    list.source === "profile" && list.items.some((i) => i.skipped && /prescriptive-path item/.test(i.skipped)), textOf(list));
  check("(d5) requirement prose maps to the slot that holds it",
    requirementSlots("Plan set and specifications")[0] === "plan_set" && requirementSlots("One set of stamped plans")[0] === "structural_letter"
    && requirementSlots("Wires Department electrical permit application")[0] === "electrical_application" && requirementSlots("Fee receipt").length === 0);
}

// ── TRIGGER PREDICATE ──────────────────────────────────────────────────────────────────────
console.log("\nTRIGGER — is the shipped profile authoritative?");
const projectLike = (o: Record<string, unknown>) => ({
  id: `t-${++seq}`, clientId: null, state: "NM", ahj: "", city: "", utility: "Mesa Electric", homeownerName: "Owner", projectAddress: "1 Way", zip: "87500",
  systemSizeDcKw: 6, systemSizeAcKw: 5, parserSnapshot: {}, status: "parsed", ...o,
}) as never;
check("(t1) a bare seeded row ('In-person: appointment only') is NOT authoritative — the per-job lookup must run",
  shippedProfileIsAuthoritative(projectLike({ ahj: "Bernal County", city: "Bernal" })) === false && shippedProfileNeedsPerJobLookup(projectLike({ ahj: "Bernal County", city: "Bernal" })) === true);
check("(t2) a seeded row whose words settle the structure IS authoritative", shippedProfileIsAuthoritative(projectLike({ ahj: "Tres Alamos", city: "Tres Alamos" })) === true);
check("(t3) an AHJ with no shipped profile at all is not authoritative", shippedProfileIsAuthoritative(projectLike({ ahj: "Ojo Caliente County", city: "Ojo Caliente" })) === false);
check("(t4) a hand-written application profile (Oregon) is authoritative", shippedProfileIsAuthoritative(projectLike({ state: "OR", ahj: "Marion County", city: "Keizer", utility: "PGE" })) === true);

// ── UTILITY GROUP HEADER ───────────────────────────────────────────────────────────────────
console.log("\nHEADER — the utility group is headed by the track's own program");
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const lift = (name: string): string => {
    const m = new RegExp(`^function ${name}\\(`, "m").exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find ${name}`);
    let i = dashboard.indexOf("{", dashboard.indexOf(")", m.index));
    let depth = 0;
    for (; i < dashboard.length; i++) {
      const ch = dashboard[i];
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    return dashboard.slice(m.index, i);
  };
  // eslint-disable-next-line no-new-func
  const lib = new Function(`${lift("esc")}\n${lift("utilityGroupTitle")}\nreturn { esc, utilityGroupTitle };`)() as { esc: (s: string) => string; utilityGroupTitle: (t: unknown[]) => string };
  const title = (label: string) => lib.utilityGroupTitle([{ type: "nem", category: "utility", label }]);
  check("(h1) MUST-PASS: a net-metering track heads the group 'Utility — net metering (NEM) / interconnection'",
    title("Utility net metering (NEM) / interconnection") === "Utility — net metering (NEM) / interconnection", title("Utility net metering (NEM) / interconnection"));
  check("(h2) an export-credit (net billing) program is said as such", /export credit/.test(title("Utility interconnection + export credit (net billing — not net metering)")), title("Utility interconnection + export credit (net billing — not net metering)"));
  check("(h3) interconnection-only says no utility net metering", /interconnection only \(no utility net metering\)/.test(title("Utility interconnection only (no utility net metering)")));
  check("(h4) an unconfirmed program says so; the card's program name after ' — ' is not repeated in the header",
    /not yet confirmed/.test(title("Utility interconnection application (net-metering program not yet confirmed)")) && title("Utility net metering (NEM) / interconnection — Small PV Program") === "Utility — net metering (NEM) / interconnection");
  check("(h5) MUST-EXCLUDE: a label that is not the utility's (older server, permit label) falls back to the neutral 'interconnection', never 'Net Metering (NEM)'",
    title("AHJ permit") === "Utility — interconnection" && lib.utilityGroupTitle([]) === "Utility — interconnection");
  // The group title is drawn through esc(): the renderer's group() escapes what it is given.
  check("(h6) the group head is esc()'d in renderSubmittalTracks", /track-group-head">\$\{esc\(title\)\}/.test(dashboard));
}

if (failures) { console.error(`\ne2eGapClose: ${failures} FAILED`); process.exit(1); }
console.log("\ne2eGapClose: all checks passed");
process.exit(0);
