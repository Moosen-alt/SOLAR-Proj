// ===========================================================================
// THE PRE-SUBMITTAL CORRECTION NOTICE (#148) — the reviewer gate's findings, read back as the
// AHJ's own correction letter, so the installer fixes them before filing rather than after the
// city mails them.
//
// A VIEW, never a second judgement. Every item is a ReviewerFinding the gate already produced;
// its weight is the gate's severity (blocker → hold, warning → comment, callout → info). Rule 3's
// shape — a hold only on verified data plus a value the documents state, parser-only never holds —
// is decided in the gate and carried through here unchanged: nothing in this file promotes or
// softens a finding, and it mints no finding ids (so MEASURED_FINDING_IDS is untouched).
//
// Grouped the way AHJ letters are (Structural / Electrical / Fire / Plan completeness / Local
// requirements), holds first within each group, numbered through the whole letter. Citations are
// the finding's own code references, which citationFor already resolved to the ADOPTED edition.
//
// buildCorrectionNotice and renderCorrectionNoticeText are pure. readCorrectionNotice is the one
// db-holding entry (GET /api/projects/:id/correction-notice) and writes nothing: the code-research
// enqueue the gate would make for an un-profiled AHJ is suppressed for the read
// (withoutCodeResearch), and no LLM is called — vision verdicts are read from cache only.
// ===========================================================================
import type {
  CorrectionNotice,
  CorrectionNoticeGroup,
  CorrectionNoticeItem,
  CorrectionNoticePriorCorrection,
  CorrectionNoticeWeight,
  HistoricalFailureCause,
  ReviewerFinding,
  ReviewerReport,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import { getProjectDetail, reviewerGateReportFor } from "./repository";
import { resolveEffectiveCodeContext } from "./codeProfiles";
import { buildHistoricalFailureReport } from "./historicalFailures";
import { withoutCodeResearch } from "./nextStep";
import { nowIso } from "./time";

/** Print order of the letter's sections. */
export const CORRECTION_NOTICE_GROUPS: readonly CorrectionNoticeGroup[] = [
  "Structural",
  "Electrical",
  "Fire",
  "Plan completeness",
  "Local requirements",
];

const WEIGHT_FOR: Record<Exclude<ReviewerFinding["severity"], "pass">, CorrectionNoticeWeight> = {
  blocker: "hold",
  warning: "comment",
  callout: "info",
};
const WEIGHT_RANK: Record<CorrectionNoticeWeight, number> = { hold: 0, comment: 1, info: 2 };

// Fire first: the fire-pathway checks live in plan-set / code-rule families (city.fire.*,
// reviewer.plan.fire-path) and a plan checker's letter puts them under Fire, not Plan.
export function correctionNoticeGroupFor(finding: Pick<ReviewerFinding, "id" | "category">): CorrectionNoticeGroup {
  const id = finding.id;
  if (id.startsWith("city.fire.") || /fire-path|fire-setback/.test(id)) return "Fire";
  if (id.startsWith("city.struct.") || id === "reviewer.profile.structural-stamp" || finding.category === "structural") return "Structural";
  if (id.startsWith("city.elec.") || id.startsWith("city.ess.") || id === "reviewer.plan.rapid-shutdown"
    || id === "reviewer.profile.electrical-stamp" || finding.category === "electrical") return "Electrical";
  if (id.startsWith("city.plan.") || id.startsWith("reviewer.plan.") || id === "reviewer.profile.plan-set" || finding.category === "plan_set") return "Plan completeness";
  return "Local requirements";
}

const clip = (s: string, max: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function citationsFor(finding: ReviewerFinding): string[] {
  const out: string[] = [];
  for (const ref of finding.codeReferences || []) {
    const head = `${ref.code || ""} ${ref.section || ""}`.trim();
    const line = [head, ref.title || ""].filter(Boolean).join(" — ");
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

// What the submitted documents say: the excerpts the gate read (a sheet's text or a recorded
// field). An absence check means the package states nothing on the point — which is itself what
// the plan "states", and the reason a letter writes the comment.
function planStatesFor(finding: ReviewerFinding): string {
  const evidence = finding.evidenceFound || [];
  const stated = evidence.filter((e) => (e.kind === "source_excerpt" || e.kind === "field_value") && String(e.excerpt || "").trim());
  if (stated.length) {
    return stated.slice(0, 2).map((e) => `${e.source ? `${e.source}: ` : ""}"${clip(e.excerpt, 240)}"`).join("; ");
  }
  if (evidence.some((e) => e.kind === "absence_check") || finding.evidenceStatus === "missing") return "Not shown in the submitted package.";
  return "";
}

// The sheet is where plan TEXT was read; a recorded field or a profile table is not a sheet.
function sheetFor(finding: ReviewerFinding): string {
  const hit = (finding.evidenceFound || []).find((e) => e.kind === "source_excerpt" && String(e.pageHint || "").trim());
  return hit ? clip(hit.pageHint, 80) : "";
}

export interface CorrectionNoticeContext {
  ahj: string;
  state: string;
  /** Which layer supplied the code basis (EffectiveCodeContext.source) and its adopted editions. */
  codeBasis: { source: "verified" | "seeded" | "defaults"; adoptedCodes: Array<{ code: string; edition: string }> };
  /** This org's matched prior-correction causes (HistoricalFailureReport.topRejectionCauses). */
  priorCauses?: HistoricalFailureCause[];
  generatedAt?: string;
}

export function provenanceLineFor(ctx: Pick<CorrectionNoticeContext, "ahj" | "state" | "codeBasis">): string {
  const where = [ctx.ahj, ctx.state].filter(Boolean).join(", ") || "this jurisdiction";
  const editions = ctx.codeBasis.adoptedCodes.map((e) => `${e.edition} ${e.code}`.trim()).filter(Boolean).join(", ");
  if (ctx.codeBasis.source === "verified") {
    return `Code basis: ${where} — verified jurisdiction profile (checked by a person)${editions ? `. Adopted: ${editions}.` : "."}`;
  }
  if (ctx.codeBasis.source === "seeded") {
    return `Code basis: ${where} — seeded profile (researched, not yet verified by a person)${editions ? `. Adopted per research: ${editions}` : ""}. Confirm the adopted editions with the AHJ before citing them as authoritative.`;
  }
  return `Code basis: no adopted-code record for ${where} — model-code defaults stand in${editions ? ` (${editions})` : ""}. Confirm the local code cycle and amendments before citing.`;
}

export function buildCorrectionNotice(report: ReviewerReport, ctx: CorrectionNoticeContext): CorrectionNotice {
  const drafted = report.findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity !== "pass")
    .map(({ finding, index }) => ({
      index,
      group: correctionNoticeGroupFor(finding),
      weight: WEIGHT_FOR[finding.severity as keyof typeof WEIGHT_FOR],
      finding,
    }));
  const groupRank = (g: CorrectionNoticeGroup) => CORRECTION_NOTICE_GROUPS.indexOf(g);
  drafted.sort((a, b) => groupRank(a.group) - groupRank(b.group) || WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight] || a.index - b.index);

  const items: CorrectionNoticeItem[] = drafted.map(({ group, weight, finding }, i) => ({
    number: i + 1,
    group,
    weight,
    findingId: finding.id,
    title: finding.title,
    comment: finding.cityFeedback || finding.message,
    citations: citationsFor(finding),
    planStates: planStatesFor(finding),
    required: finding.designTeamAction || "",
    sheet: sheetFor(finding),
  }));

  // Only causes that MATCHED this project's records (count > 0): the report's fallback baseline
  // causes are generic prevention advice, not this AHJ's history. Never the raw sample — it is a
  // correction excerpt and can name a homeowner.
  const priorCorrections: CorrectionNoticePriorCorrection[] = (ctx.priorCauses || [])
    .filter((c) => c.count > 0)
    .map((c) => ({ title: c.title, count: c.count, requiredAction: c.requiredAction }));

  return {
    projectId: report.projectId,
    generatedAt: ctx.generatedAt || nowIso(),
    ahj: ctx.ahj,
    state: ctx.state,
    provenance: ctx.codeBasis.source,
    provenanceLine: provenanceLineFor(ctx),
    counts: {
      hold: items.filter((i) => i.weight === "hold").length,
      comment: items.filter((i) => i.weight === "comment").length,
      info: items.filter((i) => i.weight === "info").length,
    },
    items,
    priorCorrections,
  };
}

const WEIGHT_LABEL: Record<CorrectionNoticeWeight, string> = { hold: "HOLD", comment: "COMMENT", info: "INFO" };

/** The letter as plain text — what "Copy as text" puts on the clipboard. */
export function renderCorrectionNoticeText(notice: CorrectionNotice): string {
  const where = [notice.ahj, notice.state].filter(Boolean).join(", ") || "the AHJ";
  const lines: string[] = [
    `PRE-SUBMITTAL CORRECTION NOTICE — ${where}`,
    "Prepared by the reviewer gate before submittal. Not issued by the AHJ.",
    notice.provenanceLine,
    `Generated ${notice.generatedAt}`,
    `${notice.counts.hold} hold(s) · ${notice.counts.comment} comment(s) · ${notice.counts.info} informational`,
  ];
  if (!notice.items.length) lines.push("", "No corrections: the gate found nothing to hold or comment on.");
  for (const group of CORRECTION_NOTICE_GROUPS) {
    const items = notice.items.filter((i) => i.group === group);
    if (!items.length) continue;
    lines.push("", group.toUpperCase());
    for (const item of items) {
      lines.push(`${String(item.number).padStart(2, " ")}. [${WEIGHT_LABEL[item.weight]}] ${item.title}`);
      if (item.citations.length) lines.push(`    Code: ${item.citations.join("; ")}`);
      if (item.comment) lines.push(`    Comment: ${item.comment}`);
      if (item.planStates) lines.push(`    Plan states: ${item.planStates}`);
      if (item.required) lines.push(`    Required: ${item.required}`);
      if (item.sheet) lines.push(`    Sheet: ${item.sheet}`);
    }
  }
  if (notice.priorCorrections.length) {
    lines.push("", "PRIOR CORRECTIONS MATCHING THIS PROJECT (your organization's records)");
    for (const p of notice.priorCorrections) lines.push(`  - ${p.title} (×${p.count}): ${p.requiredAction}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The notice for one project. Reads only — see the header. */
export function readCorrectionNotice(db: AppDb, projectId: string): CorrectionNotice {
  const { project } = getProjectDetail(db, projectId);
  return withoutCodeResearch(() => {
    const report = reviewerGateReportFor(db, project);
    const code = resolveEffectiveCodeContext(db, project.state, project.ahj);
    let priorCauses: HistoricalFailureCause[] = [];
    try { priorCauses = buildHistoricalFailureReport(db, projectId, null).topRejectionCauses; } catch { priorCauses = []; }
    return buildCorrectionNotice(report, {
      ahj: project.ahj,
      state: project.state,
      codeBasis: { source: code.source, adoptedCodes: code.adoptedCodes.map((e) => ({ code: e.code, edition: e.edition })) },
      priorCauses,
    });
  });
}
