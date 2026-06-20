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
import { parseJson } from "./json";
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

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

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

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function signatureFor(row: Row): string {
  return normalize(`${text(row.correction_bucket)} ${text(row.root_cause)} ${text(row.required_action)}`) || normalize(text(row.sample));
}

function titleForCause(cause: string, action: string, sample: string): string {
  const haystack = `${cause} ${action} ${sample}`.toLowerCase();
  if (/account/.test(haystack)) return "Missing account verification";
  if (/meter.*photo|photo.*meter|meter picture/.test(haystack)) return "Incorrect or missing meter photo";
  if (/one.line|single line|sld|3.line/.test(haystack)) return "Missing one-line / SLD note";
  if (/1741|inverter settings|smart inverter/.test(haystack)) return "Missing inverter settings evidence";
  if (/battery|powerwall|ess|backup/.test(haystack)) return "Battery/Powerwall mode mismatch";
  if (/fire|pathway|setback/.test(haystack)) return "Missing fire pathway evidence";
  if (/rafter|truss|span|structural/.test(haystack)) return "Missing roof framing/span evidence";
  if (/signature|owner authorization/.test(haystack)) return "Missing signature / owner authorization";
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
      title: titleForCause(rootCause, requiredAction, sample),
      count: 1,
      correctionBucket: text(row.correction_bucket) as CorrectionBucket | "",
      rootCause,
      requiredAction,
      sample,
      severity: /account|meter|one.line|single line|sld|structural|rafter|truss|fire|pathway/i.test(`${rootCause} ${requiredAction} ${sample}`)
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
      signature: normalize(`${title} ${rootCause}`),
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

function statusFor(project: ProjectRecord, title: string): HistoricalChecklistItem["status"] {
  const topic = historicalTopicForTitle(title);
  if (!topic) return "needs_review";
  return statusFromEvidence(evidenceForTopic(project, topic));
}

function checklistFromCauses(project: ProjectRecord, causes: HistoricalFailureCause[]): HistoricalChecklistItem[] {
  const map = new Map<string, HistoricalChecklistItem>();
  for (const cause of causes) {
    const title = cause.title;
    map.set(cause.signature, {
      id: cause.signature,
      status: statusFor(project, title),
      title,
      why: cause.count
        ? `Seen in ${cause.count} similar historical rejection/delay record(s).`
        : "Baseline prevention item for this project type.",
      action: cause.requiredAction,
      evidence: evidenceForTitle(project, title),
      sourceCauseSignature: cause.signature,
    });
  }
  return [...map.values()];
}

function evidenceForTitle(project: ProjectRecord, title: string): string[] {
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

export function buildHistoricalFailureReport(db: AppDb, projectId: string): HistoricalFailureReport {
  const row = db.get<Row>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!row) throw new Error("Project not found.");
  const project = projectFromRow(row);
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
     WHERE profile_key = ? OR utility = ? OR state = ?
     ORDER BY created_at DESC
     LIMIT 3000`,
    [key, project.utility, project.state],
  );
  let causes = groupedCauses(failureRows, tagSet, project);
  const matchedFailureRecordCount = causes.reduce((sum, cause) => sum + cause.count, 0);
  if (!causes.length) causes = fallbackCauses(project);

  const checklist = checklistFromCauses(project, causes);
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
