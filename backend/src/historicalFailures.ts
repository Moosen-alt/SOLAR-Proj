import type {
  CorrectionBucket,
  HistoricalChecklistItem,
  HistoricalFailureCause,
  HistoricalFailureReport,
  ParserPayload,
  ProjectRecord,
  ProjectStatus,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { HttpError } from "./httpError";
import { parseJson, text } from "./json";
import { normalizeTokens } from "./normalize";
import { extractProjectFeatureTags, knowledgeProfileKey } from "./knowledgeBase";
import {
  allProjectEvidenceText,
  evidenceForTopic,
  evidenceLines,
  historicalTopicForTitle,
  requirementsForTopic,
  statusFromEvidence,
} from "./projectEvidence";
import { nowIso } from "./time";
import { buildApplicationDocumentPackage } from "./applicationDocs";
import { planSetTextForProject } from "./projectDocuments";
import { addAuditLog } from "./audit";

type Row = Record<string, unknown>;

function projectFromRow(row: Row): ProjectRecord {
  return {
    id: text(row.id),
    clientId: row.client_id == null ? null : text(row.client_id),
    homeownerName: text(row.homeowner_name),
    projectAddress: text(row.project_address),
    city: text(row.city),
    state: text(row.state),
    zip: text(row.zip),
    ahj: text(row.ahj),
    utility: text(row.utility),
    accountNumber: text(row.account_number),
    meterNumber: text(row.meter_number),
    systemSizeDcKw: row.system_size_dc_kw == null ? null : Number(row.system_size_dc_kw),
    systemSizeAcKw: row.system_size_ac_kw == null ? null : Number(row.system_size_ac_kw),
    totalExportKw: row.total_export_kw == null ? null : Number(row.total_export_kw),
    interconnectionMethod: text(row.interconnection_method),
    status: text(row.status) as ProjectStatus,
    currentStage: text(row.current_stage),
    parserConfidenceSummary: text(row.parser_confidence_summary),
    parserSnapshot: parseJson<ParserPayload>(text(row.parser_json), {}),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function signatureFor(row: Row): string {
  return normalizeTokens(`${text(row.correction_bucket)} ${text(row.root_cause)} ${text(row.required_action)}`) || normalizeTokens(text(row.sample));
}

/** The checklist title for a learned cause. The title picks the EVIDENCE TOPIC the project is
 *  checked against (historicalTopicForTitle), so it reads the classified root cause and required
 *  action ONLY — never the raw correction sample. Free text choosing the topic is how "Provide the
 *  necessary rafter span calculations" became a battery item: "necessary" matched a bare /ess/. */
export const APPLICATION_FORM_TITLE = "Missing or incomplete application form";
export function titleForCause(cause: string, action: string): string {
  const haystack = `${cause} ${action}`.toLowerCase();
  if (/account/.test(haystack)) return "Missing account verification";
  if (/meter.*photo|photo.*meter|meter picture/.test(haystack)) return "Incorrect or missing meter photo";
  if (/one.line|single line|sld|3.line/.test(haystack)) return "Missing one-line / SLD note";
  if (/1741|inverter settings|smart inverter/.test(haystack)) return "Missing inverter settings evidence";
  if (/battery|powerwall|\bess\b|backup/.test(haystack)) return "Battery/Powerwall mode mismatch";
  if (/fire|pathway|setback/.test(haystack)) return "Missing fire pathway evidence";
  if (/rafter|truss|span|structural/.test(haystack)) return "Missing roof framing/span evidence";
  if (/signature|owner authorization/.test(haystack)) return "Missing signature / owner authorization";
  // The import taxonomy's "Electrical / Labels/Placards" (knowledgeBase correctionTaxonomy): the
  // plan set's label/placard schedule is an evidence topic we already read.
  if (/label|placard/.test(haystack)) return "Missing label / placard schedule";
  // "Documentation / Application Form": answered by the application package's own missing-field
  // check (statusFor below), not by a second evidence regex.
  if (/application form/.test(haystack)) return APPLICATION_FORM_TITLE;
  return cause || action || "Unclassified historical correction";
}

function scoreTags(projectTags: Set<string>, row: Row, project: ProjectRecord): number {
  const rowTags = new Set(parseJson<string[]>(text(row.feature_tags_json), []));
  let score = 0;
  if (text(row.utility).toLowerCase() && text(row.utility).toLowerCase() === project.utility.toLowerCase()) score += 35;
  if (text(row.ahj).toLowerCase() && text(row.ahj).toLowerCase() === (project.ahj || project.city).toLowerCase()) score += 25;
  if (text(row.state).toLowerCase() && text(row.state).toLowerCase() === project.state.toLowerCase()) score += 10;
  for (const tag of rowTags) {
    if (projectTags.has(tag)) {
      if (tag.startsWith("battery:") || tag.startsWith("scope:ess")) score += 18;
      else if (tag.startsWith("utility_family:") || tag.startsWith("portal:")) score += 12;
      else if (tag.startsWith("interco:")) score += 10;
      else score += 5;
    }
  }
  return score;
}

function groupedCauses(rows: Row[], projectTags: Set<string>, project: ProjectRecord): HistoricalFailureCause[] {
  const map = new Map<string, HistoricalFailureCause>();
  for (const row of rows) {
    const score = scoreTags(projectTags, row, project);
    if (score < 35) continue;
    const signature = signatureFor(row);
    const rootCause = text(row.root_cause) || "Historical correction";
    const requiredAction = text(row.required_action) || "Verify and correct before submittal.";
    const sample = text(row.sample);
    const existing = map.get(signature);
    if (existing) {
      existing.count += 1;
      continue;
    }
    map.set(signature, {
      signature,
      title: titleForCause(rootCause, requiredAction),
      count: 1,
      correctionBucket: text(row.correction_bucket) as CorrectionBucket | "",
      rootCause,
      requiredAction,
      sample,
      // Severity, like the title, from the classification only: a page label in the sample
      // ("Residential Structural Record") must not mint a blocker.
      severity: /account|meter|one.line|single line|sld|structural|rafter|truss|fire|pathway/i.test(`${rootCause} ${requiredAction}`)
        ? "blocker"
        : "warning",
    });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 8);
}

function fallbackCauses(project: ProjectRecord): HistoricalFailureCause[] {
  const all = allProjectEvidenceText(project);
  const out: HistoricalFailureCause[] = [];
  const push = (title: string, rootCause: string, requiredAction: string, sample: string) => {
    out.push({
      signature: normalizeTokens(`${title} ${rootCause}`),
      title,
      count: 0,
      correctionBucket: "A_we_fix",
      rootCause,
      requiredAction,
      sample,
      severity: "warning",
    });
  };
  if (/pacific|pacificorp/i.test(project.utility)) {
    push("Missing account verification", "Pacific Power account/meter data is commonly rejected when it is not verified.", "Verify utility bill account and service/meter data before PowerClerk staging.", "Pacific Power / NEM precheck");
    push("Incorrect or missing meter photo", "Pacific Power customer generation packages commonly require meter evidence.", "Confirm the meter photo is present, legible, and matches the parsed meter number.", "Pacific Power / meter photo precheck");
    push("Missing inverter settings evidence", "Pacific Power packages commonly need inverter settings / UL 1741 SB evidence.", "Confirm inverter settings evidence is included in the utility upload package.", "Pacific Power / inverter settings precheck");
  }
  if (/powerwall|tesla|battery|\bESS\b/i.test(all)) {
    push("Battery/Powerwall mode mismatch", "Battery projects fail when backup/non-backup mode is inconsistent between plan set, utility notes, and portal fields.", "Confirm Powerwall/ESS mode, backup panel scope, export setting, and utility notes all agree.", "ESS / Powerwall precheck");
  }
  push("Missing one-line / SLD note", "Utility and AHJ reviews commonly require an explicit one-line/SLD with interconnection and equipment notes.", "Confirm the SLD/one-line is mapped, current, and includes interconnection and rapid shutdown notes.", "Universal NEM/AHJ precheck");
  return out.slice(0, 5);
}

// Documents the autopilot does NOT produce — the homeowner, installer, engineer, or
// utility provides them with the package (signed owner authorization, customer/owner
// signature, notarized forms, proof of ownership, fee payment). These must never read
// as "MISSING" gaps the service has to fix; they're advisory reminders only.
const OUT_OF_SCOPE = /signature|owner authorization|customer authorization|notar|proof of ownership|\bdeed\b|\bhoa\b|fee payment|\bpay (the )?fee/i;
function isOutOfScopeItem(title: string, ...extra: string[]): boolean {
  return OUT_OF_SCOPE.test(`${title} ${extra.join(" ")}`.toLowerCase());
}

function statusFor(project: ProjectRecord, title: string, cause?: HistoricalFailureCause): HistoricalChecklistItem["status"] {
  if (isOutOfScopeItem(title, cause?.rootCause || "", cause?.requiredAction || "")) return "external";
  // ONE PREDICATE: the application package already knows which of its fields are missing
  // (buildApplicationDocumentPackage().missingFields — the same list that gates the package).
  if (title === APPLICATION_FORM_TITLE) return applicationFormMissingFields(project).length ? "missing" : "present";
  const topic = historicalTopicForTitle(title);
  if (!topic) return "needs_review";
  return statusFromEvidence(evidenceForTopic(project, topic));
}

function checklistFromCauses(project: ProjectRecord, causes: HistoricalFailureCause[]): HistoricalChecklistItem[] {
  const map = new Map<string, HistoricalChecklistItem>();
  for (const cause of causes) {
    const title = cause.title;
    const status = statusFor(project, title, cause);
    const external = status === "external";
    map.set(cause.signature, {
      id: cause.signature,
      status,
      title,
      why: external
        ? "Provided by the installer/homeowner with the package — not produced by this service."
        : cause.count
          ? `Seen in ${cause.count} similar historical rejection/delay record(s).`
          : "Baseline prevention item for this project type.",
      action: external
        ? "Confirm the installer/homeowner includes this in the submittal package."
        : cause.requiredAction,
      evidence: evidenceForTitle(project, title),
      sourceCauseSignature: cause.signature,
    });
  }
  return [...map.values()];
}

function applicationFormMissingFields(project: ProjectRecord): string[] {
  return buildApplicationDocumentPackage(project).missingFields;
}

function evidenceForTitle(project: ProjectRecord, title: string): string[] {
  if (title === APPLICATION_FORM_TITLE) {
    const missing = applicationFormMissingFields(project);
    return missing.length
      ? [`Application package is missing: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}`]
      : ["Application package has every field it needs."];
  }
  const topic = historicalTopicForTitle(title);
  if (!topic) return ["Corrected document or verified portal field"];
  const check = evidenceForTopic(project, topic);
  return [
    ...requirementsForTopic(topic).map((item) => `Required: ${item}`),
    ...evidenceLines(check),
  ];
}

function summarySubject(project: ProjectRecord, tags: string[]): string {
  const bits = [project.utility || "Unknown utility"];
  if (tags.includes("battery:powerwall")) bits.push("Powerwall");
  else if (tags.includes("scope:ess")) bits.push("ESS");
  if (/line/i.test(project.interconnectionMethod)) bits.push("line-side");
  return bits.join(" + ");
}

/**
 * The historical-failure risk report for ONE project.
 *
 * `orgId` is the CALLER's scope, per the data-layer convention: a string means "the caller
 * is this org" (a project outside it reads as not found), null means a system / superadmin
 * caller (scheduler, workflow, staging gate) with no principal to check.
 *
 * Either way, the failure rows it reads are ALWAYS the project's OWN org's.
 * historical_failure_examples carries raw correction excerpts — homeowner and co-customer
 * names — so it is the one learning table that is not pooled across tenants, and a
 * superadmin looking at a project must see that tenant's history, not everyone's. (The
 * pooled, name-free patterns live on the shared knowledge rows' common_corrections.)
 */
export function buildHistoricalFailureReport(db: AppDb, projectId: string, orgId: string | null): HistoricalFailureReport {
  const row = db.get<Row>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!row) throw new Error("Project not found.");
  const projectOrgId = text(row.org_id) || DEFAULT_ORG_ID;
  if (orgId !== null && orgId !== projectOrgId) throw new HttpError(404, "Project not found.");
  const project = projectWithPlanSetText(db, projectFromRow(row));
  const tags = extractProjectFeatureTags(project);
  const tagSet = new Set(tags);
  const key = knowledgeProfileKey({ state: project.state, ahj: project.ahj || project.city, utility: project.utility });

  const projectRows = db.query<Row>(
    `SELECT * FROM historical_project_fingerprints
     WHERE project_id <> ? AND (profile_key = ? OR utility = ? OR state = ?)
     LIMIT 2000`,
    [project.id, key, project.utility, project.state],
  );
  const matchedProjectCount = projectRows.filter((candidate) => scoreTags(tagSet, candidate, project) >= 35).length;

  const failureRows = db.query<Row>(
    `SELECT * FROM historical_failure_examples
     WHERE org_id = ? AND (profile_key = ? OR utility = ? OR state = ?)
     ORDER BY created_at DESC
     LIMIT 3000`,
    [projectOrgId, key, project.utility, project.state],
  );
  let causes = groupedCauses(failureRows, tagSet, project);
  const matchedFailureRecordCount = causes.reduce((sum, cause) => sum + cause.count, 0);
  if (!causes.length) causes = fallbackCauses(project);

  // AN OPERATOR'S AHJ-LEVEL ACKNOWLEDGEMENT turns a learned BLOCKER into a reminder at THIS
  // jurisdiction, for THIS org — the gate (repository.getSubmitGateReport) blocks only on a
  // blocker-severity cause, so the item stays on the checklist and the gate row stays a
  // warning, but it no longer stops every later project there.
  const acks = activeAcknowledgements(db, projectOrgId, project.state, project.ahj || project.city);
  causes = causes.map((cause) => {
    const ack = cause.severity === "blocker" ? acks.get(cause.signature) : undefined;
    return ack ? { ...cause, severity: "warning" as const } : cause;
  });

  const checklist = checklistFromCauses(project, causes).map((item) => {
    const ack = item.sourceCauseSignature ? acks.get(item.sourceCauseSignature) : undefined;
    return ack && item.status === "missing"
      ? { ...item, why: `${item.why} Acknowledged for ${ack.ahj} by ${ack.actor} on ${ack.at.slice(0, 10)}${ack.note ? ` ("${ack.note}")` : ""} — a reminder, no longer a blocker there.` }
      : item;
  });
  const dataConfidence =
    matchedProjectCount >= 25 && matchedFailureRecordCount >= 10 ? "high" : matchedProjectCount >= 5 || matchedFailureRecordCount >= 3 ? "medium" : "low";
  const summaryLabel = `This project matches ${matchedProjectCount} prior ${summarySubject(project, tags)} project${matchedProjectCount === 1 ? "" : "s"} and ${matchedFailureRecordCount} similar failure/delay record${matchedFailureRecordCount === 1 ? "" : "s"}.`;

  return {
    projectId,
    generatedAt: nowIso(),
    summaryLabel,
    matchedProjectCount,
    matchedFailureRecordCount,
    matchTags: tags,
    topRejectionCauses: causes,
    checklist,
    dataConfidence,
    notes: [
      "Matches are based on state, AHJ, utility, portal, equipment, interconnection, ESS, and evidence tags.",
      "The checklist is prevention guidance and must be reviewed before legal submission.",
      matchedFailureRecordCount ? "Historical failures came from redacted correction/status/email learning records." : "No similar historical failure records yet; baseline prevention checks were used.",
    ],
  };
}

// ---------------------------------------------------------------------------
// THE SAME PROJECT THE GATE SEES. getProjectDetail overlays the uploaded plan-set text onto the
// snapshot so the reviewer reads the actual sheets; this report built its project from the bare
// row, so its evidence checks never saw them. At Portland, Coos Bay, Lincoln City and Douglas
// (load test, 2026-09-24) one old "roof framing" correction therefore blocked every later
// project — including 12 whose uploaded sheets state the framing. Same overlay, same rule: the
// parser's own text wins when it already carries the field.
// ---------------------------------------------------------------------------
function projectWithPlanSetText(db: AppDb, project: ProjectRecord): ProjectRecord {
  if (project.parserSnapshot.planSetExtractedText) return project;
  let planSetText = "";
  try { planSetText = planSetTextForProject(db, project.id); } catch { planSetText = ""; }
  return planSetText ? { ...project, parserSnapshot: { ...project.parserSnapshot, planSetExtractedText: planSetText } } : project;
}

// ---------------------------------------------------------------------------
// ACKNOWLEDGED ONCE, AT THE AHJ. An operator who knows a learned blocker does not apply at a
// jurisdiction (or that the jurisdiction accepts what every set already carries) says so ONCE,
// for that AHJ — not once per project. Scope is the project's ORG (historical_failure_examples is
// the one org-scoped learning table; one tenant's ruling on its own history must not clear
// another's) × state × AHJ × the cause's signature (a new, differently worded correction is new
// information and blocks again).
//
// Stored on the audit trail (append-only; the newest acknowledge/revoke per key wins), so the
// decision is attributable and reversible without a schema change.
//
// AN AHJ-LEVEL RULING IS NOT A PROJECT ROW (2026-09-24, D1 verification MF3). The rows used to
// carry the originating project's id in audit_logs.project_id, and deleteProject runs
// "DELETE FROM audit_logs WHERE project_id = ?": deleting the project a revoke was recorded from
// deleted the revoke, and the AHJ-wide acknowledgement RESURRECTED (every project there unblocked
// again, silently); deleting the project an acknowledgement was recorded from made the ruling
// vanish. Duplicate projects are deleted routinely (five groups in the load test). So both rows
// are written with project_id NULL — the ruling belongs to the org × AHJ, not to the project it
// happened to be recorded from — and the originating project id lives in details.projectId.
// ---------------------------------------------------------------------------
const ACK_ACTION = "historical_blocker.acknowledged";
const REVOKE_ACTION = "historical_blocker.ack_revoked";

export interface HistoricalBlockerAck {
  orgId: string;
  state: string;
  ahj: string;
  signature: string;
  title: string;
  actor: string;
  note: string;
  at: string;
}

const ackScopeKey = (state: string, ahj: string): string => `${state.trim().toLowerCase()}|${ahj.trim().toLowerCase()}`;

function activeAcknowledgements(db: AppDb, orgId: string, state: string, ahj: string): Map<string, HistoricalBlockerAck> {
  const out = new Map<string, HistoricalBlockerAck>();
  if (!ahj.trim()) return out;
  const scope = ackScopeKey(state, ahj);
  const rows = db.query<Row>(
    "SELECT action, actor_name, details, created_at FROM audit_logs WHERE action IN (?, ?) ORDER BY created_at ASC, rowid ASC",
    [ACK_ACTION, REVOKE_ACTION],
  );
  for (const row of rows) {
    const d = parseJson<Record<string, unknown>>(text(row.details), {});
    if (text(d.orgId) !== orgId || ackScopeKey(text(d.state), text(d.ahj)) !== scope) continue;
    const signature = text(d.signature);
    if (!signature) continue;
    if (text(row.action) === REVOKE_ACTION) { out.delete(signature); continue; }
    out.set(signature, {
      orgId, state: text(d.state), ahj: text(d.ahj), signature, title: text(d.title),
      actor: text(row.actor_name) || "an operator", note: text(d.note), at: text(row.created_at),
    });
  }
  return out;
}

/** The learned blocker acknowledgements in force at a project's AHJ (for the project page). */
export function listHistoricalBlockerAcknowledgements(db: AppDb, projectId: string, orgId: string | null): HistoricalBlockerAck[] {
  const { project, projectOrgId } = scopedProject(db, projectId, orgId);
  return [...activeAcknowledgements(db, projectOrgId, project.state, project.ahj || project.city).values()];
}

function scopedProject(db: AppDb, projectId: string, orgId: string | null): { project: ProjectRecord; projectOrgId: string } {
  const row = db.get<Row>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!row) throw new HttpError(404, "Project not found.");
  const projectOrgId = text(row.org_id) || DEFAULT_ORG_ID;
  if (orgId !== null && orgId !== projectOrgId) throw new HttpError(404, "Project not found.");
  return { project: projectFromRow(row), projectOrgId };
}

/**
 * Acknowledge ONE learned historical blocker for the project's AHJ (and org). `orgId` is the
 * caller's scope (null = system/superadmin); the org written is always the PROJECT's. The
 * signature must be a learned cause (count > 0) this project's report actually carries — the
 * route cannot mint an acknowledgement for a cause nobody saw.
 */
export function acknowledgeHistoricalBlocker(
  db: AppDb,
  input: { projectId: string; signature: string; actor: string; note?: string },
  orgId: string | null,
): HistoricalBlockerAck {
  const { project, projectOrgId } = scopedProject(db, input.projectId, orgId);
  const ahj = (project.ahj || project.city).trim();
  if (!ahj) throw new HttpError(409, "This project has no AHJ, so there is no jurisdiction to acknowledge the blocker for.");
  const report = buildHistoricalFailureReport(db, input.projectId, orgId);
  const cause = report.topRejectionCauses.find((c) => c.signature === input.signature && c.count > 0);
  if (!cause) throw new HttpError(404, "That historical blocker is not one of this project's learned blockers.");
  const note = String(input.note ?? "").trim().slice(0, 300);
  const actor = String(input.actor ?? "").trim() || "operator";
  addAuditLog(db, null, "human", actor, ACK_ACTION, {
    orgId: projectOrgId, state: project.state, ahj, signature: cause.signature, title: cause.title, note, projectId: input.projectId,
  });
  return activeAcknowledgements(db, projectOrgId, project.state, ahj).get(cause.signature)!;
}

/** Take an AHJ-level acknowledgement back: the blocker blocks again at that AHJ. */
export function revokeHistoricalBlockerAcknowledgement(
  db: AppDb,
  input: { projectId: string; signature: string; actor: string },
  orgId: string | null,
): { revoked: boolean } {
  const { project, projectOrgId } = scopedProject(db, input.projectId, orgId);
  const ahj = (project.ahj || project.city).trim();
  if (!activeAcknowledgements(db, projectOrgId, project.state, ahj).has(input.signature)) return { revoked: false };
  addAuditLog(db, null, "human", String(input.actor ?? "").trim() || "operator", REVOKE_ACTION, {
    orgId: projectOrgId, state: project.state, ahj, signature: input.signature, projectId: input.projectId,
  });
  return { revoked: true };
}
