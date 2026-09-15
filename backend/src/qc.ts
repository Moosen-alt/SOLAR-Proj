import type { AppDb } from "./db";
import { cecTableCount, isCecListed } from "./cecEquipment";
import { evaluateBaselineRules } from "./baselineRules";
import { id } from "./ids";
import { parseJson } from "./json";
import { fieldAliases, parserField } from "./normalize";
import { logger } from "./logger";
import { documentInventory } from "./requiredDocuments";
import { nowIso } from "./time";
import type { ParserPayload, QcStatus, Severity } from "../../shared/src/types";
import { resolveEffectiveCodeContext } from "./codeProfiles";
import { findKnowledgeForLearn } from "./knowledgeBase";

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
    return /projectdox|energov|etrakit|accela/i.test(platform);
  } catch {
    return false; // KB table may not exist yet
  }
}

interface ProjectRow {
  id: string;
  parser_json: string;
  ahj: string | null;
  state: string | null;
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
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

interface QcContext {
  db: AppDb;
  ahj: string;
  state: string;
  payload: ParserPayload;
}

function statusFor(check: Check, ctx: QcContext): QcStatus {
  const { db, ahj, state, payload } = ctx;
  const aliases = check.aliases ?? fieldAliases[check.fieldName] ?? [check.fieldName];
  const value = aliases.map((alias) => clean(payload[alias])).find(Boolean) || parserField(payload, check.fieldName);
  if (!check.required) return "pass";

  if (check.fieldName === "splitPages") {
    // Only require human review when the AHJ's portal platform needs individual
    // sheets uploaded separately (ProjectDox, EnerGov, etc.). For all other AHJs
    // (City of Portland uses a simple online upload), skip this check.
    const needsSplit = ahjRequiresSplitPages(db, ahj, state);
    if (!needsSplit) return "pass";
    if (!value || /not found|missing|upload and parse/i.test(value)) return "warning";
    return "pass";
  }

  if (check.fieldName === "permitPath") {
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
  const project = db.get<ProjectRow>("SELECT id, parser_json, ahj, state, utility, system_size_dc_kw FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new Error("Project not found.");

  const payload = parseJson<ParserPayload>(project.parser_json, {});
  const ctx: QcContext = {
    db,
    ahj: project.ahj || clean(payload.ahj) || "",
    state: project.state || clean(payload.state) || "",
    payload,
  };
  const createdAt = nowIso();
  let failCount = 0;
  let warningCount = 0;

  db.transaction(() => {
    db.run("DELETE FROM qc_results WHERE project_id = ?", [projectId]);

    for (const check of criticalChecks) {
      const qcStatus = statusFor(check, ctx);
      if (qcStatus === "fail") failCount += 1;
      if (qcStatus === "warning") warningCount += 1;

      const message = qcStatus === "pass" ? `${check.ruleName} present.` : check.message;
      db.run(
        `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), projectId, qcStatus, check.ruleId, check.ruleName, message, check.severity, createdAt],
      );

      if (qcStatus !== "pass") {
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
      const inv = documentInventory(db, {
        id: projectId,
        ahj: ctx.ahj,
        state: ctx.state,
        utility: clean((project as unknown as Record<string, unknown>).utility) || clean(payload.utility) || "",
        systemSizeDcKw: (project as unknown as Record<string, unknown>).system_size_dc_kw == null
          ? null : Number((project as unknown as Record<string, unknown>).system_size_dc_kw),
        parserSnapshot: payload,
      } as never);
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
      for (const d of inv.missingBlocking) {
        warningCount += 1;
        say("warning", "error", d.docType, d.label,
          `${String(d.why || "")} Staging will refuse without it.`.trim());
      }
      for (const d of inv.missingAdvisory) {
        warningCount += 1;
        say("warning", "warning", d.docType, d.label, String(d.why || ""));
      }
      if (!inv.missingBlocking.length && !inv.missingAdvisory.length) {
        db.run(
          `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
           VALUES (?, ?, 'pass', 'docs.complete', 'Required documents', ?, 'info', ?)`,
          [id(), projectId, `Every document this filing needs${where} is attached.`, createdAt],
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
    for (const baseline of evaluateBaselineRules(payload, codeCtx)) {
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

    const nextStatus = failCount > 0 ? "qc_failed" : "qc_passed";
    const currentStage = failCount > 0 ? "QC failed: human review required" : "QC passed: ready to stage";
    db.run("UPDATE projects SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?", [
      nextStatus,
      currentStage,
      nowIso(),
      projectId,
    ]);
  });

  return { failCount, warningCount };
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
