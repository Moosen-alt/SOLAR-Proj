// ISSUED PERMITS IN THE SAME AHJ AS A CHECK (#147).
//
// A city plan checker knows what this office has already accepted. The approved-design
// observations (codeProfiles.recordApprovedDesignObservation, written on a structural target's
// first issued reading) now also keep what the issued plan CARRIED: its module, inverter,
// battery, racking, roof-attachment hardware and roof-attachment detail. This compares the
// current plan against them:
//
//   - the plan reuses something an issued permit here carried -> one CALLOUT saying so (the
//     reviewer can spend less time on a product the office has already accepted);
//   - the plan departs from EVERY accepted precedent on a dimension this AHJ has corrected
//     before (its shared correction rollup names that dimension) -> a WARNING naming the
//     precedent. Never a blocker: a precedent is corroboration, not the AHJ's rule, and a new
//     product is not a deficiency — it is where the last corrections came from.
//
// Pure over the context: no model call, no database read here (resolveEffectiveCodeContext loads
// `approvedDesigns` and `ahjCorrections`). Pooled across tenants ON PURPOSE (CLAUDE.md, shared
// knowledge), so a message carries only product names, counts and dates — never another
// project's id, record number or address.

import type {
  CommonCorrectionPattern,
  PermitPrecedentDimension,
  PermitPrecedentItem,
  ProjectRecord,
  ReviewerFinding,
  ReviewerFindingEvidence,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import type { EffectiveCodeContext } from "./codeProfiles";
import { knowledgeNameMatchScore } from "./knowledgeBase";

export const PRECEDENT_MATCH_ID = "city.ahj.precedent-match";
export const PRECEDENT_DEPARTURE_ID = "city.ahj.precedent-departure";

const DIMENSION_LABEL: Record<PermitPrecedentDimension, string> = {
  module: "module",
  inverter: "inverter",
  battery: "battery",
  racking: "racking",
  attachment: "attachment hardware",
  roofDetail: "roof attachment detail",
};

// Which correction wording is ABOUT a dimension. Read over the rollup's rootCause +
// requiredAction (the shared row carries no raw sample).
const DIMENSION_CORRECTED: Record<PermitPrecedentDimension, RegExp> = {
  module: /\b(?:pv\s+)?(?:modules?|panels?)\b/i,
  inverter: /\b(?:micro-?)?inverters?\b/i,
  battery: /\b(?:batter(?:y|ies)|ess|energy storage)\b/i,
  racking: /\b(?:racking|rails?)\b/i,
  attachment: /\b(?:attachments?|mounts?|standoffs?|flashings?|lags?|lag screws?)\b/i,
  roofDetail: /\b(?:roof(?:ing)?\s+(?:section|detail|assembly|covering)|attachment detail|tile|shingle)\b/i,
};

// A correction the DESIGN had to answer. "We fix" (A) is the operator's paperwork, not the plan.
const DESIGN_BUCKETS = new Set(["B_designer_fix", "C_reviewer_clarification"]);

function snap(project: ProjectRecord, key: string): string {
  const v = (project.parserSnapshot || {})[key];
  return typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

function makeModel(project: ProjectRecord, make: string, model: string): string {
  const mk = snap(project, make);
  const md = snap(project, model);
  if (!md) return "";
  return mk && !md.toLowerCase().startsWith(mk.toLowerCase()) ? `${mk} ${md}` : md;
}

/** The matching key: case, spacing and punctuation never make two products differ. */
export function precedentKey(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** What this plan carries on each precedent dimension, from scalar parser fields only. */
export function extractPermitPrecedents(project: ProjectRecord): PermitPrecedentItem[] {
  const out: PermitPrecedentItem[] = [];
  const add = (dimension: PermitPrecedentDimension, value: string): void => {
    if (value && precedentKey(value).length >= 3) out.push({ dimension, value });
  };
  add("module", makeModel(project, "moduleMake", "moduleModel"));
  add("inverter", makeModel(project, "pvMicroMake", "pvMicroModel") || makeModel(project, "invMake", "invModel"));
  add("battery", makeModel(project, "batteryMake", "batteryModel"));
  add("racking", snap(project, "rackingSystem"));
  add("attachment", snap(project, "attachmentHardware") || snap(project, "tileAttachmentMethod"));
  // The roof-attachment detail the office reviewed: the roof covering it is drawn for, and the
  // framing it lands on when stated.
  const roof = snap(project, "roofMaterial");
  if (roof) add("roofDetail", [roof, snap(project, "framingType")].filter(Boolean).join(" / "));
  return out;
}

/**
 * The AHJ's design-correction patterns from the SHARED knowledge rollup (bucket / rootCause /
 * requiredAction / count / lastSeenAt — never a raw sample). Same-state rows whose AHJ is this one
 * by exact name or the knowledge-base fuzzy match. A READ: resolveEffectiveCodeContext runs on
 * page-load paths that write nothing.
 */
export function listAhjCorrectionPatterns(db: AppDb, state: string, ahj: string): CommonCorrectionPattern[] {
  const st = String(state || "").trim().toLowerCase();
  const wanted = String(ahj || "").trim();
  if (!st || !wanted) return [];
  const out: CommonCorrectionPattern[] = [];
  for (const row of db.query<{ ahj: string; common_corrections_json: string }>(
    "SELECT ahj, common_corrections_json FROM permit_utility_knowledge WHERE LOWER(state) = ? AND common_corrections_json != '[]'", [st],
  )) {
    if (String(row.ahj || "").trim().toLowerCase() !== wanted.toLowerCase() && knowledgeNameMatchScore(wanted, String(row.ahj || "")) < 60) continue;
    let items: unknown = [];
    try { items = JSON.parse(String(row.common_corrections_json || "[]")); } catch { items = []; }
    if (!Array.isArray(items)) continue;
    for (const c of items as Array<Partial<CommonCorrectionPattern>>) {
      if (!c || typeof c !== "object") continue;
      out.push({
        signature: String(c.signature ?? ""),
        bucket: String(c.bucket ?? "") as CommonCorrectionPattern["bucket"],
        rootCause: String(c.rootCause ?? ""),
        requiredAction: String(c.requiredAction ?? ""),
        count: Number(c.count ?? 0) || 0,
        lastSeenAt: String(c.lastSeenAt ?? ""),
      });
    }
  }
  return out;
}

interface PrecedentTally { value: string; count: number; latest: string }

function tallyPrecedents(ctx: EffectiveCodeContext, projectId: string): Map<PermitPrecedentDimension, Map<string, PrecedentTally>> {
  const out = new Map<PermitPrecedentDimension, Map<string, PrecedentTally>>();
  for (const o of ctx.approvedDesigns ?? []) {
    // A project is never its own precedent (a re-review after its permit issued).
    if (o.projectId && o.projectId === projectId) continue;
    const seen = new Set<string>();
    for (const p of o.precedents ?? []) {
      const key = precedentKey(p.value);
      if (!key || seen.has(`${p.dimension}|${key}`)) continue;
      seen.add(`${p.dimension}|${key}`);
      const byKey = out.get(p.dimension) ?? new Map<string, PrecedentTally>();
      const t = byKey.get(key) ?? { value: p.value, count: 0, latest: "" };
      t.count++;
      if (String(o.issuedAt || "") > t.latest) t.latest = String(o.issuedAt || "");
      byKey.set(key, t);
      out.set(p.dimension, byKey);
    }
  }
  return out;
}

function describeTally(t: PrecedentTally): string {
  return `"${t.value}" (${t.count} issued permit${t.count === 1 ? "" : "s"}${t.latest ? `, latest ${t.latest.slice(0, 10)}` : ""})`;
}

function planEvidence(item: PermitPrecedentItem): ReviewerFindingEvidence {
  return {
    kind: "field_value",
    label: `Plan ${DIMENSION_LABEL[item.dimension]}`,
    source: "Parsed plan fields",
    excerpt: item.value,
    confidence: "medium",
    pageHint: "",
    screenshotPath: "",
    verifier: "rule_engine",
    note: "Compared with what issued permits in this AHJ carried (corroboration, not the AHJ's rule).",
  };
}

/** The callout and warnings. Empty when no issued permit here recorded a precedent. */
export function evaluatePermitPrecedentFindings(project: ProjectRecord, ctx: EffectiveCodeContext): ReviewerFinding[] {
  const plan = extractPermitPrecedents(project);
  if (!plan.length) return [];
  const tallies = tallyPrecedents(ctx, project.id);
  if (!tallies.size) return [];
  const who = ctx.ahj || "this AHJ";
  const corrections = (ctx.ahjCorrections ?? []).filter((c) => DESIGN_BUCKETS.has(String(c.bucket)) && c.count > 0);
  const out: ReviewerFinding[] = [];

  const matched: Array<{ item: PermitPrecedentItem; tally: PrecedentTally }> = [];
  const departed: Array<{ item: PermitPrecedentItem; precedents: PrecedentTally[]; corrected: CommonCorrectionPattern[] }> = [];
  for (const item of plan) {
    const byKey = tallies.get(item.dimension);
    if (!byKey?.size) continue;
    const hit = byKey.get(precedentKey(item.value));
    if (hit) { matched.push({ item, tally: hit }); continue; }
    const corrected = corrections
      .filter((c) => DIMENSION_CORRECTED[item.dimension].test(`${c.rootCause} ${c.requiredAction}`))
      .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt));
    if (!corrected.length) continue;
    const precedents = [...byKey.values()].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest)).slice(0, 3);
    departed.push({ item, precedents, corrected });
  }

  // ONE departure finding per report: the gate keeps one finding per id (reviewerEngine dedupe),
  // so each departed dimension is a sentence of the same warning.
  if (departed.length) {
    const labels = departed.map((d) => DIMENSION_LABEL[d.item.dimension]);
    out.push({
      id: PRECEDENT_DEPARTURE_ID,
      severity: "warning",
      category: "ahj_profile",
      title: `Plan departs from issued-permit precedent here: ${labels.join(", ")}`,
      message: departed.map((d) => {
        const label = DIMENSION_LABEL[d.item.dimension];
        const times = d.corrected.reduce((sum, c) => sum + c.count, 0);
        const top = d.corrected[0];
        return `This plan's ${label} "${d.item.value}" matches none that issued permits in ${who} carried: ${d.precedents.map(describeTally).join(", ")}; `
          + `${who} has corrected the ${label} before (${times} correction${times === 1 ? "" : "s"}; e.g. "${(top.rootCause || top.requiredAction).slice(0, 160)}").`;
      }).join(" ") + " Precedent is corroboration only, not the jurisdiction's requirement.",
      cityFeedback: departed.map((d) => `Confirm the ${DIMENSION_LABEL[d.item.dimension]} meets ${who}'s requirements; previously accepted: ${d.precedents.map((p) => p.value).join(", ")}.`).join(" "),
      designTeamAction: departed.map((d) => {
        const top = d.corrected[0];
        return `Check the ${DIMENSION_LABEL[d.item.dimension]} against what ${who} corrected before${top.requiredAction ? ` ("${top.requiredAction.slice(0, 160)}")` : ""}, or use the accepted ${d.precedents[0].value}.`;
      }).join(" "),
      evidenceNeeded: labels.map((label) => `${label[0].toUpperCase()}${label.slice(1)} cut sheet / detail answering ${who}'s earlier correction`),
      codeReferences: [],
      installerCallout: false,
      evidenceStatus: "weak",
      evidenceFound: departed.map((d) => planEvidence(d.item)),
    });
  }

  if (matched.length) {
    out.unshift({
      id: PRECEDENT_MATCH_ID,
      severity: "callout",
      category: "ahj_profile",
      title: "Issued-permit precedent here",
      message: `Issued permits in ${who} already carried this plan's ${matched.map((m) => `${DIMENSION_LABEL[m.item.dimension]} ${describeTally(m.tally)}`).join("; ")}. `
        + "The office has accepted these before — corroboration only, not the jurisdiction's requirement.",
      cityFeedback: "",
      designTeamAction: "",
      evidenceNeeded: [],
      codeReferences: [],
      installerCallout: false,
      evidenceStatus: "verified",
      evidenceFound: matched.map((m) => planEvidence(m.item)),
    });
  }
  return out;
}
