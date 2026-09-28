import type { AppDb } from "./db";
import { cecTableCount, isCecListed } from "./cecEquipment";
import { evaluateBaselineRules } from "./baselineRules";
import { id } from "./ids";
import { parseJson } from "./json";
import { fieldAliases, parserField } from "./normalize";
import { logger } from "./logger";
import { documentInventory, owedMissingDocuments, requiredListCheck } from "./requiredDocuments";
import { nowIso } from "./time";
import type { ParserPayload, ProjectRecord, QcStatus, Severity, StageDetail } from "../../shared/src/types";
import { getCodeProfile, resolveEffectiveCodeContext } from "./codeProfiles";
import { resolvePermitPath } from "./permitPath";
import { findKnowledgeForLearn } from "./knowledgeBase";
import { ensureFeeSchedulesResearched } from "./feeSchedules";
import { requiredTracks } from "./submittalTracks";
import { qcMayMoveStatus } from "./projectStage";
import { looksLikePlaceholderIdentifier } from "../../shared/src/companyFacts";

// Look up whether the AHJ for this project uses a portal platform that requires
// individual sheets to be split and uploaded separately (e.g. ProjectDox, EnerGov).
// Uses the same fuzzy, state-aware KB resolver as the learn planner
// (findKnowledgeForLearn) so operator short names / "City of X" variants still
// hit the imported row — an exact AHJ+state string match silently missed them.
function ahjRequiresSplitPages(db: AppDb, ahj: string, state: string): boolean {
  if (!ahj) return false;
  try {
    const match = findKnowledgeForLearn(db, { state, ahj });
    const platform = match.ahj?.portalPlatform || "";
    // ONLY ProjectDox ACTUALLY NEEDS PER-SHEET UPLOADS, and the splitter has said so all
    // along: "ProjectDox requires each sheet uploaded to its own document slot. Standard
    // Accela/EnerGov portals receive the FULL plan set as a single PDF (no splitting
    // needed there)" (docSplitter.ts, and server.ts repeats it). This gate matched
    // energov|etrakit|accela anyway, so it asked a person to hand-confirm a sheet mapping
    // for portals that never wanted split sheets. Measured 2026-09-22 while counting
    // operator interruptions: all three live firings were Salem (accela) and Tigard
    // (EnerGov) — every one of them a question the product's own policy says not to ask.
    return /projectdox/i.test(platform);
  } catch {
    return false; // KB table may not exist yet
  }
}

interface ProjectRow {
  id: string;
  parser_json: string;
  ahj: string | null;
  state: string | null;
  utility: string | null;
  client_id?: string | null;
}

interface Check {
  ruleId: string;
  ruleName: string;
  fieldName: string;
  severity: Severity;
  required: boolean;
  aliases?: string[];
  message: string;
}

const criticalChecks: Check[] = [
  { ruleId: "critical.homeowner", ruleName: "Homeowner name", fieldName: "homeownerName", required: true, severity: "blocker", message: "Enter the homeowner's full legal name as it should appear on the permit. Read it off the plan-set title block or the utility bill account holder." },
  { ruleId: "critical.address", ruleName: "Service address", fieldName: "projectAddress", required: true, severity: "blocker", message: "Enter the install/service address (street, city, ZIP). Confirm it matches both the plan-set title block and the utility bill service address." },
  { ruleId: "critical.utility", ruleName: "Utility", fieldName: "utility", required: true, severity: "blocker", message: "Enter the electric utility company (e.g. PGE, Pacific Power). This sets the NEM/interconnection path, so it must match the bill." },
  { ruleId: "critical.ahj", ruleName: "AHJ", fieldName: "ahj", required: true, severity: "blocker", message: "Enter the permitting authority — the city or county (the AHJ). This decides which permit forms and portal are used." },
  { ruleId: "critical.account", ruleName: "Account number", fieldName: "accountNumber", required: true, severity: "blocker", message: "Enter the utility account number EXACTLY as printed on the bill — never guess it. A wrong number stalls the interconnection application." },
  { ruleId: "critical.meter", ruleName: "Meter number", fieldName: "meterNumber", required: true, severity: "blocker", message: "Enter the meter number and confirm it matches across the plan set, utility bill, and meter photo." },
  { ruleId: "critical.dc_kw", ruleName: "System size DC", fieldName: "systemSizeDcKw", required: true, severity: "blocker", message: "Enter the DC system size in kW (modules × wattage ÷ 1000). Read it off the plan-set system specs / title block." },
  { ruleId: "critical.ac_kw", ruleName: "System size AC", fieldName: "systemSizeAcKw", required: true, severity: "blocker", message: "Enter the AC system size in kW (the inverters' combined continuous AC output). Read it off the plan-set system specs / title block." },
  { ruleId: "critical.module_make", ruleName: "Module make", fieldName: "moduleMake", required: true, severity: "blocker", message: "Enter the PV module manufacturer (e.g. ZNShine, Qcells). Read it off the module spec sheet or the equipment schedule." },
  { ruleId: "critical.module_model", ruleName: "Module model", fieldName: "moduleModel", required: true, severity: "blocker", message: "Enter the PV module model number exactly as on the spec sheet/equipment schedule (it must match the submitted module spec)." },
  { ruleId: "critical.module_wattage", ruleName: "Module wattage", fieldName: "moduleWattage", required: true, severity: "blocker", message: "Enter the per-module wattage in watts (e.g. 440). Read it off the module model/spec sheet." },
  { ruleId: "critical.module_qty", ruleName: "Module quantity", fieldName: "moduleQty", required: true, severity: "blocker", message: "Enter the number of modules. Confirm it matches the equipment schedule and the roof-plane layout count." },
  { ruleId: "critical.inverter_model", ruleName: "Inverter or microinverter model", fieldName: "inverterModel", required: true, severity: "blocker", message: "Enter the inverter or microinverter model number exactly as on the spec sheet (e.g. AP Systems DS3-L). It must match the submitted inverter spec." },
  { ruleId: "critical.inverter_qty", ruleName: "Inverter quantity", fieldName: "inverterQty", required: true, severity: "blocker", message: "Enter the number of inverters/microinverters. For microinverters this is usually one per module (or per pair) — confirm against the SLD." },
  { ruleId: "critical.inverter_output", ruleName: "Inverter output", fieldName: "inverterOutput", required: true, severity: "blocker", message: "Enter the inverter's rated continuous AC output current in amps (per the datasheet). For microinverters, the system total = per-unit × quantity. Used for the PV breaker sizing." },
  { ruleId: "critical.interconnection", ruleName: "Interconnection method", fieldName: "interconnectionMethod", required: true, severity: "blocker", message: "Enter the interconnection method from the SLD/3-line — e.g. 'load-side breaker', 'line-side / supply-side tap', or 'load-side at main panel'. This drives the 120% busbar check." },
  { ruleId: "critical.bus", ruleName: "MSP bus rating", fieldName: "busRating", required: true, severity: "blocker", message: "Enter the main service panel busbar rating in amps (e.g. 200). Read it off the SLD/panel schedule — needed for the 705.12 120% calc." },
  { ruleId: "critical.main_breaker", ruleName: "Main breaker rating", fieldName: "mainBreaker", required: true, severity: "blocker", message: "Enter the main breaker rating in amps (e.g. 200). Read it off the SLD/panel schedule — needed for the 705.12 120% calc." },
  { ruleId: "critical.pv_breaker", ruleName: "PV breaker/OCPD", fieldName: "pvBreaker", required: true, severity: "blocker", message: "Enter the backfed PV breaker / OCPD size in amps (e.g. 40). Read it off the SLD — it must be ≥ 1.25 × the inverter output current and pass the 120% rule." },
  { ruleId: "critical.permit_path", ruleName: "Permit path", fieldName: "permitPath", required: true, severity: "warning", message: "Confirm the permit path: type 'prescriptive' (standard residential solar plan) or 'engineered' (PE-stamped structural/calcs required). This decides which application set the AHJ expects." },
  { ruleId: "critical.locates", ruleName: "Required locates", fieldName: "locates", required: true, severity: "warning", message: "Utility locates: does this system require underground conduit or trenching? If roof-mount with no digging, type 'N/A - roof mount, no excavation'. If trenching is needed, type '811 call required before dig' or note the plan-set callout. This is a warning, not a blocker — it just needs a value so the reviewer can confirm." },
  { ruleId: "critical.required_files", ruleName: "Required files", fieldName: "splitPages", required: true, severity: "warning", message: "Confirm the plan-set sheets are correctly identified for splitting (SLD, site/plot plan, structural, module/inverter specs, labels). Type 'confirmed' once the sheet mapping looks right, or note any missing sheet." },
];

export interface QcRunResult {
  failCount: number;
  warningCount: number;
  /** False when QC recorded its results but left the lifecycle columns alone: the status is one
   *  qcMayMoveStatus refuses (operator `blocked`, or at/after Submit), or the verdict changed
   *  nothing (see runQcForProject). */
  statusWritten: boolean;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

interface QcContext {
  db: AppDb;
  projectId: string;
  ahj: string;
  state: string;
  payload: ParserPayload;
  /** Memo: resolvePermitPath's standardReview for this job (see permitPathStandardReview). */
  standardReview?: boolean;
}

/**
 * OUTSIDE A SPLIT JURISDICTION THERE IS NO PATH TO CONFIRM (permitPath.ts, e2e-gap close
 * 2026-09-26). "Confirm the permit path: prescriptive or engineered" was asked of a Minneapolis job
 * and became its next step — Oregon's question. Resolved from the jurisdiction's own prescriptive
 * limits when it has a code profile (a jurisdiction whose research names a prescriptive path keeps
 * the question); read-only — never resolvePermitPathForProject, which enqueues research from inside
 * QC's transaction.
 */
function permitPathStandardReview(ctx: QcContext): boolean {
  if (ctx.standardReview !== undefined) return ctx.standardReview;
  let standardReview = false;
  try {
    const limits = getCodeProfile(ctx.db, { state: ctx.state, ahj: ctx.ahj })?.prescriptive;
    standardReview = resolvePermitPath({ state: ctx.state, ahj: ctx.ahj, parserSnapshot: ctx.payload } as never, { limits }).standardReview;
  } catch { standardReview = false; }
  ctx.standardReview = standardReview;
  return standardReview;
}

// WAITING ON THE CUSTOMER'S BILL IS A WAIT, NOT A FAILURE.
//
// The account and meter numbers are printed on the customer's utility bill (the meter number
// also on the meter). A plan set does not carry them. New-AHJ e2e test (2026-09-26): QC on a plan
// set alone failed 7 of 7 projects on these two fields, and qc_failed stopped the whole chain —
// the permit side included, which never needs them. With no bill and no meter photo on file,
// the missing value is a NAMED WAIT (warning, advisory review item) and the rest of the chain
// runs. Once a bill or meter photo IS on file and the value is still missing, it is a real
// failure again: something read the document and could not find it.
export const WAITING_ON_BILL_ISSUE_TYPE = "Waiting on the customer's utility bill";
const BILL_FIELDS = new Set(["accountNumber", "meterNumber"]);

/** A utility bill or a meter photo is on file for this project. */
export function customerBillOnFile(db: AppDb, projectId: string): boolean {
  try {
    const row = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND doc_type IN ('utility_bill', 'meter_photo')",
      [projectId],
    );
    return Number(row?.n ?? 0) > 0;
  } catch {
    // No documents table: nothing is on file, which is the wait.
    return false;
  }
}

function waitingOnBillMessage(check: Check): string {
  const what = check.fieldName === "meterNumber" ? "meter number (on the bill, or read off a meter photo)" : "account number";
  return `Waiting on the customer's utility bill — the ${what} is read from it, never typed from memory. `
    + "Upload the bill (or send the customer an intake request). Only the interconnection (NEM) application needs it; the permit side proceeds meanwhile.";
}

function statusFor(check: Check, ctx: QcContext): QcStatus {
  const { db, ahj, state, payload } = ctx;
  const aliases = check.aliases ?? fieldAliases[check.fieldName] ?? [check.fieldName];
  const value = aliases.map((alias) => clean(payload[alias])).find(Boolean) || parserField(payload, check.fieldName);
  if (!check.required) return "pass";
  if (BILL_FIELDS.has(check.fieldName) && !value && !customerBillOnFile(db, ctx.projectId)) return "warning";

  if (check.fieldName === "splitPages") {
    // Only require human review when the AHJ's portal platform needs individual
    // sheets uploaded separately (ProjectDox, EnerGov, etc.). For all other AHJs
    // (City of Portland uses a simple online upload), skip this check.
    const needsSplit = ahjRequiresSplitPages(db, ahj, state);
    if (!needsSplit) return "pass";
    if (!value || /not found|missing|upload and parse/i.test(value)) return "warning";
    return "pass";
  }

  // LOCATES ARE DERIVABLE FOR A ROOF MOUNT WITH NOTHING BURIED.
  //
  // The check's own instruction tells the operator what to type: "If roof-mount with no
  // digging, type 'N/A - roof mount, no excavation'." Everything in that sentence is already
  // on the project — the mounting is a parsed field and the plan set says whether anything
  // is trenched — so asking a person to transcribe it is asking them to read our own data
  // back to us. Measured 2026-09-22 across 100 simulated projects drawn at the live book's
  // field rates: this was the ONLY remaining interruption in the whole local pipeline, 13
  // of 13.
  //
  // IT STILL ASKS WHENEVER DIGGING IS POSSIBLE. A ground or pole mount always asks — those
  // genuinely trench. So does any project whose plan text mentions trenching, excavation,
  // boring, or an underground run, even on a roof mount: the design may carry a buried
  // conduit to a detached structure, and an 811 call missed is a real-world hazard, not a
  // paperwork nuisance. Silence about mounting also asks, because an unknown must not read
  // as "nothing is buried".
  if (check.fieldName === "locates" && !value) {
    const mounting = clean(payload.mounting).toLowerCase();
    const roofMounted = /roof/.test(mounting) && !/ground|pole|carport|canopy/.test(mounting);
    const planText = `${clean(payload.planSetExtractedText)} ${clean(payload.splitPagesText)} ${clean(payload.sitePlanNotesText)}`.toLowerCase();
    const mightDig = /trench|excavat|boring|directional bore|underground (?:conduit|run|feeder|service)|buried/.test(planText);
    if (roofMounted && !mightDig) return "pass";
    return "warning";
  }

  if (check.fieldName === "permitPath") {
    // One building application, no prescriptive-or-engineered choice: nothing to confirm.
    if (permitPathStandardReview(ctx)) return "pass";
    // Microinverter systems are always prescriptive path for residential; auto-pass.
    const hasMicro = Boolean(clean(payload.pvMicroModel) || clean(payload.pvMicroMake));
    const engineered = /engineer/i.test(value || "");
    if (hasMicro && !engineered) return "pass";
    if (!value) return "warning";
    if (/review|manual/i.test(value)) return "warning";
    return "pass";
  }

  if (!value) return check.severity === "warning" ? "warning" : "fail";
  if (check.fieldName === "locates") {
    if (/not run|waiting/i.test(value)) return "warning";
    // Roof mount with no excavation — locates are not applicable.
    if (/no excavation|roof.mount only|n\/a.*roof|roof.*n\/a|no.*trench|no.*dig/i.test(value)) return "pass";
  }
  return "pass";
}

export function runQcForProject(db: AppDb, projectId: string): QcRunResult {
  const project = db.get<ProjectRow>("SELECT id, parser_json, ahj, state, utility, system_size_dc_kw, client_id FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new Error("Project not found.");

  const payload = parseJson<ParserPayload>(project.parser_json, {});
  const ctx: QcContext = {
    db,
    projectId,
    ahj: project.ahj || clean(payload.ahj) || "",
    state: project.state || clean(payload.state) || "",
    payload,
  };
  const createdAt = nowIso();
  let failCount = 0;
  let warningCount = 0;
  let statusWritten = false;

  db.transaction(() => {
    db.run("DELETE FROM qc_results WHERE project_id = ?", [projectId]);

    for (const check of criticalChecks) {
      const qcStatus = statusFor(check, ctx);
      if (qcStatus === "fail") failCount += 1;
      if (qcStatus === "warning") warningCount += 1;

      const waitingOnBill = qcStatus === "warning" && check.severity === "blocker" && BILL_FIELDS.has(check.fieldName);
      const message = qcStatus === "pass"
        ? (check.fieldName === "permitPath" && permitPathStandardReview(ctx)
          ? "Permit path: standard structural review — this jurisdiction files one building application, so there is no path choice to confirm."
          : `${check.ruleName} present.`)
        : waitingOnBill ? waitingOnBillMessage(check) : check.message;
      db.run(
        `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), projectId, qcStatus, check.ruleId, check.ruleName, message, waitingOnBill ? "warning" : check.severity, createdAt],
      );

      if (BILL_FIELDS.has(check.fieldName) && qcStatus !== "pass") {
        // The review item says which it is NOW: a wait (advisory — the gate does not count it as
        // pending critical work) or, once a bill is on file, the ordinary blocker.
        const issueType = waitingOnBill ? WAITING_ON_BILL_ISSUE_TYPE : check.ruleName;
        ensureReviewItem(db, projectId, check.fieldName, issueType, parserField(payload, check.fieldName), message, qcStatus === "fail");
        db.run(
          "UPDATE human_review_items SET issue_type = ?, notes = ?, updated_at = ? WHERE project_id = ? AND field_name = ? AND status = 'pending'",
          [issueType, message, nowIso(), projectId, check.fieldName],
        );
      } else if (qcStatus !== "pass") {
        // Re-open a still-failing BLOCKER (qcStatus "fail") even if it was previously
        // resolved — otherwise an approval that didn't populate the field leaves QC
        // failing with no item to fix (a silent trap). Warnings are not re-opened.
        ensureReviewItem(db, projectId, check.fieldName, check.ruleName, parserField(payload, check.fieldName), message, qcStatus === "fail");
      } else {
        // A check that now passes (e.g. splitPages/permitPath no longer applicable
        // for this AHJ, or a value got filled) should clear any stale pending item
        // it left behind on a prior run — otherwise it lingers in Human Review.
        resolvePendingReviewItem(db, projectId, check.fieldName);
      }
    }

    // THE DOCUMENTS THIS AHJ WILL WANT, ASKED AT QC INSTEAD OF AT THE PORTAL.
    //
    // documentInventory already knew exactly what a Coos Bay structural filing needs, and the
    // staging gate already refuses without it. It just ran too late: two real permits came back
    // "Intake Requirements Needed" — one wanting a PE-stamped structural, one wanting a plan
    // review fee — and the operator found out from the city rather than from us. By staging time
    // the plan set is weeks old and a sealed letter means going back to the designer; QC runs the
    // day the plan set lands, which is when there is still time to ask.
    //
    // SAME INVENTORY, read earlier — deliberately not a second list. Two lists that can disagree
    // is how the portal ends up being the thing that tells you.
    try {
      const qcProject = {
        id: projectId,
        ahj: ctx.ahj,
        state: ctx.state,
        utility: clean((project as unknown as Record<string, unknown>).utility) || clean(payload.utility) || "",
        systemSizeDcKw: (project as unknown as Record<string, unknown>).system_size_dc_kw == null
          ? null : Number((project as unknown as Record<string, unknown>).system_size_dc_kw),
        parserSnapshot: payload,
      } as never;
      const inv = documentInventory(db, qcProject);
      // ONE QUESTION, ONE PREDICATE: what the operator OWES (owedMissingDocuments — the submit
      // gate's, Stage's and the packet screen's answer). A form the staging-time fill produces
      // from a stored template is not "not attached — staging will refuse without it": staging
      // fills it. It is said as a pass row instead of vanishing.
      const gateDocs = owedMissingDocuments(db, qcProject, inv);
      const where = ctx.ahj ? ` for ${ctx.ahj}` : "";
      const say = (status: string, severity: string, docType: string, label: string, why: string) => {
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id(), projectId, status, `docs.${docType}`, "Required document", `${label} is not attached${where}. ${why}`.trim(), severity, createdAt],
        );
      };
      // WARNING, NOT FAIL — surface early, block late. Making a missing document fail QC changes
      // FLOW CONTROL, not just visibility: qc_failed blocks staging and autopilot, so every
      // project would stall at QC the moment it is parsed, before anyone has had a chance to
      // attach anything. The hard refusal already exists at staging and stays there. This exists
      // so an operator SEES, on the day the plan set lands, what this AHJ is going to want.
      for (const d of gateDocs.owed) {
        warningCount += 1;
        say("warning", "error", d.docType, d.label,
          `${String(d.why || "")} Staging will refuse without it.`.trim());
      }
      for (const d of gateDocs.filledAtStaging) {
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'pass', ?, 'Required document', ?, 'info', ?)`,
          [id(), projectId, `docs.${d.docType}`, `${d.label}: filled at staging${where} — the form's template is on file; staging fills it and offers it to any upload slot that asks for it (check the portal's attachment list before submitting).`, createdAt],
        );
      }
      // Stage downloads (or researches) and fills it before it counts (gates-proper C1) — said as a
      // pass row, never "not attached — staging will refuse without it".
      for (const d of gateDocs.acquiredAtStaging) {
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'pass', ?, 'Required document', ?, 'info', ?)`,
          [id(), projectId, `docs.${d.docType}`, `${d.label}: Stage downloads and fills it${where} (${gateDocs.acquiredVia.get(d)?.via === "research" ? "form research on the open cooldown" : `from ${gateDocs.acquiredVia.get(d)?.sourceUrl || "its published source"}`}) — if the download fails, Stage stops and names it.`, createdAt],
        );
      }
      for (const d of inv.missingAdvisory) {
        warningCount += 1;
        say("warning", "warning", d.docType, d.label, String(d.why || ""));
      }
      // THE JOB'S OWN REQUIRED LIST, NOT THE UNIVERSAL SET (MF6, e2e-gap close 2026-09-26). This
      // row passed with "Every document this filing needs for Waltham City is attached" while the
      // city's cited six had none on file. PASS only when every item the AHJ's list names is
      // attached; a missing item is named; an unknown list is said to be unknown — never
      // "every document ... is attached" on a list nobody has confirmed.
      const list = requiredListCheck(db, qcProject, inv);
      const filledNote = gateDocs.filledAtStaging.length
        ? ` Filled at staging from a stored template: ${gateDocs.filledAtStaging.map((d) => d.label).join("; ")}.`
        : "";
      if (list.source === "unknown") {
        warningCount += 1;
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'warning', 'docs.complete', 'Required documents', ?, 'warning', ?)`,
          [id(), projectId,
            `The list of documents this filing needs${where} is not yet confirmed — no cited per-job process lookup and no shipped profile names it. ${!gateDocs.owed.length && !inv.missingAdvisory.length ? "The universal set (plan set, site plan, SLD, specs) is attached; " : ""}confirm the AHJ's own submittal list before staging.${filledNote}`,
            createdAt],
        );
      } else if (list.missing.length) {
        warningCount += 1;
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'warning', 'docs.complete', 'Required documents', ?, 'warning', ?)`,
          [id(), projectId,
            `Not every document on the required list${where} is attached (${list.missing.length} of ${list.items.length} missing, list from ${list.sourceLabel}): ${list.missing.map((m) => m.docTypes.length ? m.text : `${m.text} (no document slot holds this — attach it as an additional document)`).join("; ")}.${filledNote}`,
            createdAt],
        );
      } else if (!gateDocs.owed.length && !inv.missingAdvisory.length) {
        const applied = list.items.filter((i) => !i.skipped).length;
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'pass', 'docs.complete', 'Required documents', ?, 'info', ?)`,
          [id(), projectId,
            `Every document on the required list${where} is attached (${applied} item${applied === 1 ? "" : "s"}, list from ${list.sourceLabel}).${filledNote}`,
            createdAt],
        );
      }
    } catch (err) {
      // Never let a document check break QC itself — QC failing closed on an inventory error
      // would stop work for a reason that has nothing to do with the plan set.
      logger.warn("qc", "document inventory check failed", { projectId, err: err instanceof Error ? err.message : String(err) });
    }

    const packetReadiness = clean(payload.packetReadinessText);
    if (/MISSING/i.test(packetReadiness)) {
      warningCount += 1;
      db.run(
        `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), projectId, "warning", "packet.readiness", "Packet readiness", "Packet readiness includes missing items from the parser.", "warning", createdAt],
      );
    }

    // Jurisdiction-adopted code context: any state/county with recorded prescriptive
    // limits gets the baseline screens (data-driven); Oregon behavior unchanged.
    const codeCtx = resolveEffectiveCodeContext(db, clean(payload.state), clean(payload.ahj));
    // THE PROJECT'S OWN CLIENT'S STANDARD DISCONNECT PART, so the plan-set cross-check can fire
    // (leak sweep 2026-09-28: nothing ever put it in this payload, so the check was dead code while
    // the portal filing used the part). Read from the project's own client row — never another's.
    // The project's utility and state stand in only where the parser left them blank, so the one
    // utility identity (utilityIdentity) can answer for a project the parser did not fully read.
    const clientId = clean(project.client_id);
    const std = clientId
      ? db.get<{ standard_disconnect_make?: string | null; standard_disconnect_model?: string | null }>(
        "SELECT standard_disconnect_make, standard_disconnect_model FROM clients WHERE id = ?", [clientId])
      : undefined;
    // A PLACEHOLDER ON THE CLIENT RECORD IS NAMED HERE, the day the job is parsed (leak sweep
    // 2026-09-28): the portal filing leaves a placeholder licence / docket / registration blank
    // (portalRecipes, clients.clientStagingOverlay — companyFacts.looksLikePlaceholderIdentifier),
    // and this row is where the operator learns why. The ICC docket only matters on an Illinois job.
    // Never prints the value — only which field on the client record to correct.
    if (clientId) {
      const ids = db.get<Record<string, unknown>>(
        "SELECT ccb_license_number, electrical_license_number, electrician_license_number, metro_city_license_number, docket_number FROM clients WHERE id = ?", [clientId]);
      const isIl = clean(project.state || payload.state).toUpperCase() === "IL";
      const fields: Array<[string, string]> = [
        ["ccb_license_number", "contractor licence number"], ["electrical_license_number", "electrical licence number"],
        ["electrician_license_number", "supervising electrician licence number"], ["metro_city_license_number", "metro / city licence number"],
        ...(isIl ? [["docket_number", "ICC docket number"] as [string, string]] : []),
      ];
      for (const [col, what] of fields) {
        if (!looksLikePlaceholderIdentifier(ids?.[col])) continue;
        warningCount += 1;
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'warning', ?, 'Client record placeholder', ?, 'warning', ?)`,
          [id(), projectId, `client.placeholder-identifier.${col}`,
            `The client record's ${what} looks like a test / placeholder value, not a real identifier. Correct it on the client record — the portal filing leaves it blank until then.`,
            createdAt],
        );
      }
    }
    const baselinePayload: ParserPayload = {
      ...payload,
      ...(clean(payload.state) ? {} : project.state ? { state: project.state } : {}),
      ...(clean(payload.utility) ? {} : project.utility ? { utility: project.utility } : {}),
      ...(clean(std?.standard_disconnect_model) ? { standardDisconnectModel: clean(std?.standard_disconnect_model), standardDisconnectMake: clean(std?.standard_disconnect_make) } : {}),
    };
    for (const baseline of evaluateBaselineRules(baselinePayload, codeCtx)) {
      if (baseline.qcStatus === "fail") failCount += 1;
      if (baseline.qcStatus === "warning") warningCount += 1;
      db.run(
        `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id(),
          projectId,
          baseline.qcStatus,
          baseline.ruleId,
          baseline.ruleName,
          baseline.message,
          baseline.severity,
          createdAt,
        ],
      );

      if (baseline.qcStatus === "fail" || baseline.severity === "blocker") {
        ensureReviewItem(
          db,
          projectId,
          baseline.fieldName || baseline.ruleId,
          baseline.ruleName,
          baseline.fieldName ? parserField(payload, baseline.fieldName) : "",
          baseline.message,
          baseline.qcStatus === "fail",
        );
      }
    }

    // CEC LISTING CHECK (ADVISORY — warning rows only, never a blocker, never
    // changes qc_failed/qc_passed). Silent when the table has never been synced.
    try {
      if (cecTableCount(db) > 0) {
        const checks: Array<["module" | "inverter", string, string]> = [
          ["module", "cec.module_listed", clean(payload.moduleModel)],
          ["inverter", "cec.inverter_listed", clean(payload.invModel) || clean(payload.pvMicroModel)],
        ];
        for (const [kind, ruleId, model] of checks) {
          if (!model || isCecListed(db, kind, model)) continue;
          warningCount += 1;
          db.run(
            `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
             VALUES (?, ?, 'warning', ?, ?, ?, 'warning', ?)`,
            [id(), projectId, ruleId, `CEC listing: ${kind}`,
             `${kind === "module" ? "Module" : "Inverter"} model "${model}" was not found on the CEC solar equipment list. Verify the spec sheet / spelling — portals that load equipment from the CEC listing may reject it. Advisory only, not a blocker.`,
             createdAt],
          );
        }
      }
    } catch { /* CEC table optional — advisory check must never break QC */ }

    // QC MAY JUDGE AT ANY STATUS; IT MAY MOVE ONLY WHAT qcMayMoveStatus ALLOWS, AND ONLY WHEN
    // ITS VERDICT CHANGES SOMETHING.
    //
    // This UPDATE used to run unconditionally, and QC is re-run from doors that do not care
    // where the project is: Run QC, the workflow view, a project edit, humanVerify, a correction
    // apply and Segment A. So a filed project (ready_for_issue, issued, handoff_ready) was
    // rewritten to qc_passed and carried on to ready_to_stage while its tracks still read filed,
    // and an operator's `blocked` hold was silently lifted by the next edit. Which statuses QC
    // may move is ONE predicate in projectStage.ts — not re-derived here.
    //
    // WITHIN that leg, a pass never DEMOTES. `ready_to_stage` means "verified AND the packet is
    // built"; a re-run that still passes (humanVerify, an edit, Segment A's rerunQc) used to
    // write it back to qc_passed and reset stage_detail — the reviewer gate's
    // `reviewer_gate_approved` included — so the chain rebuilt, and a stage run began from a
    // project that read as un-reviewed. So: a FAIL is written from any movable status (the news
    // is real); a PASS is written only from parsed / qc_failed; a verdict that matches the
    // status already held leaves the row — status, stage_detail, prose — exactly as it is.
    // Everything QC recorded above is kept either way.
    const currentStatus = String(db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "") as ProjectRecord["status"];
    if (!qcMayMoveStatus(currentStatus)) return;
    const verdict: "qc_failed" | "qc_passed" = failCount > 0 ? "qc_failed" : "qc_passed";
    if (verdict === currentStatus) return;
    if (verdict === "qc_passed" && currentStatus !== "parsed" && currentStatus !== "qc_failed") return;
    statusWritten = true;
    const nextStatus = verdict;
    const currentStage = failCount > 0 ? "QC failed: human review required" : "QC passed: ready to stage";
    db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
      nextStatus,
      currentStage,
      // The enum tracks the same verdict as the prose above it and is derived from the same
      // failCount, so the two can never disagree about what QC decided.
      (failCount > 0 ? "qc_failed" : "qc_passed") satisfies StageDetail,
      nowIso(),
      projectId,
    ]);
  });

  // THE FEE THIS FILING WILL COST, ASKED AT QC — the same day-the-plan-set-lands
  // moment the document demands above moved to. If the fee table cannot answer for
  // a track this project files, queue background research (a JOB, like
  // code_research — never a synchronous LLM call here) so the fee sheet starts
  // quoting the published schedule instead of the labelled estimate. Fire-and-
  // forget and best-effort: the helper owns every dedupe/backoff/eligibility rule,
  // and research must never break or slow QC itself. Outside the transaction
  // above on purpose — the enqueue is its own write, not part of QC's results.
  try {
    const utility = clean(project.utility) || clean(payload.utility) || "";
    // requiredTracks reads exactly these fields (ahj/city/state for the
    // application profile match, utility for the NEM track, parserSnapshot for
    // MPU scope) — the same derivation the tracks panel and autopilot use, so
    // what research is asked for and what later gets filed cannot disagree.
    const projectLike = {
      id: projectId,
      state: ctx.state,
      ahj: ctx.ahj,
      city: clean(payload.city) || "",
      utility,
      parserSnapshot: payload,
    } as unknown as ProjectRecord;
    // THE PER-JOB PROCESS LOOKUP FIRST (permitProcessLookup): an AHJ with no process of its own
    // gets agency / structure / portal / record type / documents / fees looked up, cited, seeded.
    // When it is queued, fee research waits for it — the lookup job re-triggers fee research once it
    // knows WHICH agency charges (the fee researcher, asked about City of Jefferson, read Marion
    // County's $67.25, reported found:false and stored nothing).
    void (async () => {
      const { ensurePermitProcessLookedUp } = await import("./permitProcessLookup");
      const queued = await ensurePermitProcessLookedUp(db, projectLike as never);
      const tracks = requiredTracks(projectLike);
      await ensureFeeSchedulesResearched(db, projectLike, queued ? tracks.filter((t) => t === "nem") : tracks);
    })().catch(() => null);
  } catch (err) {
    logger.warn("qc", "fee-research trigger failed", { projectId, err: err instanceof Error ? err.message : String(err) });
  }

  return { failCount, warningCount, statusWritten };
}

// Auto-resolve a still-pending review item for a check that now passes. Only
// touches 'pending' rows — an explicit human approve/edit/reject is left alone.
function resolvePendingReviewItem(db: AppDb, projectId: string, fieldName: string): void {
  db.run(
    "UPDATE human_review_items SET status = 'approved', notes = 'Auto-resolved: QC check passed.', updated_at = ? WHERE project_id = ? AND field_name = ? AND status = 'pending'",
    [nowIso(), projectId, fieldName],
  );
}

function ensureReviewItem(
  db: AppDb,
  projectId: string,
  fieldName: string,
  issueType: string,
  parserValue: string,
  notes: string,
  reopenIfResolved = false,
): void {
  // Dedupe against ANY existing item for this field — not just pending ones.
  // If the coordinator already approved/edited/rejected this field, re-running
  // QC must NOT resurrect it as a new pending item (that trapped the submit gate).
  const existing = db.get<{ id: string; status: string }>(
    `SELECT id, status FROM human_review_items
     WHERE project_id = ? AND field_name = ?
     LIMIT 1`,
    [projectId, fieldName],
  );
  if (existing) {
    // Exception: a BLOCKER that is STILL failing after being approved/edited/rejected
    // means the field is still empty — re-open it so it's fixable again instead of
    // silently trapping progress. (A rejected REQUIRED blocker would otherwise wedge
    // the whole project with no way to enter a value.) Re-opening also refreshes the
    // shown value to whatever is currently on file so a saved-but-still-failing entry
    // isn't blanked. Warnings are never churned — rejecting a warning is a valid skip.
    if (reopenIfResolved && existing.status !== "pending") {
      db.run("UPDATE human_review_items SET status = 'pending', parser_value = ?, notes = ?, updated_at = ? WHERE id = ?", [parserValue, notes, nowIso(), existing.id]);
    }
    return;
  }

  const ts = nowIso();
  db.run(
    `INSERT INTO human_review_items
       (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id(), projectId, issueType, fieldName, parserValue, "", "", "pending", notes, ts, ts],
  );
}
