import type { AppDb } from "./db";
import { evaluateBaselineRules } from "./baselineRules";
import { id } from "./ids";
import { parseJson } from "./json";
import { fieldAliases, parserField } from "./normalize";
import { nowIso } from "./time";
import type { ParserPayload, QcStatus, Severity } from "../../shared/src/types";

// Look up whether the AHJ for this project uses a portal platform that requires
// individual sheets to be split and uploaded separately (e.g. ProjectDox, EnerGov).
function ahjRequiresSplitPages(db: AppDb, ahj: string, state: string): boolean {
  if (!ahj) return false;
  const row = db.get<{ portal_platform: string | null }>(
    "SELECT portal_platform FROM permit_utility_knowledge WHERE ahj = ? AND state = ? ORDER BY updated_at DESC LIMIT 1",
    [ahj, state],
  );
  if (!row?.portal_platform) return false;
  return /projectdox|energov|etrakit|accela/i.test(row.portal_platform);
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
  { ruleId: "critical.homeowner", ruleName: "Homeowner name", fieldName: "homeownerName", required: true, severity: "blocker", message: "Homeowner name must be verified before staging." },
  { ruleId: "critical.address", ruleName: "Service address", fieldName: "projectAddress", required: true, severity: "blocker", message: "Service address must be verified before staging." },
  { ruleId: "critical.utility", ruleName: "Utility", fieldName: "utility", required: true, severity: "blocker", message: "Utility must be verified before staging." },
  { ruleId: "critical.ahj", ruleName: "AHJ", fieldName: "ahj", required: true, severity: "blocker", message: "AHJ/city/county must be verified before staging." },
  { ruleId: "critical.account", ruleName: "Account number", fieldName: "accountNumber", required: true, severity: "blocker", message: "Utility account number must not be guessed." },
  { ruleId: "critical.meter", ruleName: "Meter number", fieldName: "meterNumber", required: true, severity: "blocker", message: "Meter number must be verified against plan/UB/photo." },
  { ruleId: "critical.dc_kw", ruleName: "System size DC", fieldName: "systemSizeDcKw", required: true, severity: "blocker", message: "DC system size must be present." },
  { ruleId: "critical.ac_kw", ruleName: "System size AC", fieldName: "systemSizeAcKw", required: true, severity: "blocker", message: "AC system size must be present." },
  { ruleId: "critical.module_make", ruleName: "Module make", fieldName: "moduleMake", required: true, severity: "blocker", message: "Module make must be present." },
  { ruleId: "critical.module_model", ruleName: "Module model", fieldName: "moduleModel", required: true, severity: "blocker", message: "Module model must be present." },
  { ruleId: "critical.module_wattage", ruleName: "Module wattage", fieldName: "moduleWattage", required: true, severity: "blocker", message: "Module wattage must be present." },
  { ruleId: "critical.module_qty", ruleName: "Module quantity", fieldName: "moduleQty", required: true, severity: "blocker", message: "Module quantity must be present." },
  { ruleId: "critical.inverter_model", ruleName: "Inverter or microinverter model", fieldName: "inverterModel", required: true, severity: "blocker", message: "Inverter or microinverter model must be present." },
  { ruleId: "critical.inverter_qty", ruleName: "Inverter quantity", fieldName: "inverterQty", required: true, severity: "blocker", message: "Inverter quantity must be present." },
  { ruleId: "critical.inverter_output", ruleName: "Inverter output", fieldName: "inverterOutput", required: true, severity: "blocker", message: "Inverter output must be present." },
  { ruleId: "critical.interconnection", ruleName: "Interconnection method", fieldName: "interconnectionMethod", required: true, severity: "blocker", message: "Interconnection method must be verified." },
  { ruleId: "critical.bus", ruleName: "MSP bus rating", fieldName: "busRating", required: true, severity: "blocker", message: "MSP bus rating must be present." },
  { ruleId: "critical.main_breaker", ruleName: "Main breaker rating", fieldName: "mainBreaker", required: true, severity: "blocker", message: "Main breaker rating must be present." },
  { ruleId: "critical.pv_breaker", ruleName: "PV breaker/OCPD", fieldName: "pvBreaker", required: true, severity: "blocker", message: "PV breaker/OCPD must be present." },
  { ruleId: "critical.permit_path", ruleName: "Permit path", fieldName: "permitPath", required: true, severity: "warning", message: "Permit path should be reviewed before staging." },
  { ruleId: "critical.locates", ruleName: "Required locates", fieldName: "locates", required: true, severity: "warning", message: "Utility locates: does this system require underground conduit or trenching? If roof-mount with no digging, type 'N/A - roof mount, no excavation'. If trenching is needed, type '811 call required before dig' or note the plan-set callout. This is a warning, not a blocker — it just needs a value so the reviewer can confirm." },
  { ruleId: "critical.required_files", ruleName: "Required files", fieldName: "splitPages", required: true, severity: "warning", message: "Split page mapping should be reviewed before staging." },
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
  const project = db.get<ProjectRow>("SELECT id, parser_json, ahj, state FROM projects WHERE id = ?", [projectId]);
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

    const packetReadiness = clean(payload.packetReadinessText);
    if (/MISSING/i.test(packetReadiness)) {
      warningCount += 1;
      db.run(
        `INSERT INTO qc_results (id, project_id, qc_status, rule_id, rule_name, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), projectId, "warning", "packet.readiness", "Packet readiness", "Packet readiness includes missing items from the parser.", "warning", createdAt],
      );
    }

    for (const baseline of evaluateBaselineRules(payload)) {
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
    // Exception: a BLOCKER that is STILL failing after being approved/edited means the
    // value never populated the field — re-open it so it's fixable again instead of
    // silently trapping progress. Respect an explicit 'reject' and never churn warnings.
    if (reopenIfResolved && (existing.status === "approved" || existing.status === "edited")) {
      db.run("UPDATE human_review_items SET status = 'pending', notes = ?, updated_at = ? WHERE id = ?", [notes, nowIso(), existing.id]);
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
