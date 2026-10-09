// AN AHJ'S PAST CORRECTIONS, TURNED INTO REVIEW RULES (#146).
//
// learnFromCorrection teaches the profile and buildHistoricalFailureReport shows prior corrections,
// but a correction the city issued last month did not become a check on the next plan. Now, when a
// correction STATES a requirement one of the existing rules can compare — a fire pathway / ridge
// setback at least X, a PV dead load at most X, a note or placard that must read "…" — it is
// proposed as a jurisdiction_review_rules row with #145's check shape (JurisdictionAmendmentCheck),
// beside the correction's other proposals. Deterministic: no LLM call.
//
// HARD RULE 4: nothing here approves anything. A proposal is approved only by a person, through
// the one corrections approval (POST /api/corrections/:id/apply -> correctionAgent
// applyJurisdictionProposals). A proposed rule runs NOTHING.
//
// SHARED ON PURPOSE, like the other KB tables: the row holds the check's shape and the correction's
// bucket / root cause / required action only. The AHJ's sentence (which can name the homeowner)
// stays on the org's review item and in historical_failure_examples. Wording that names the
// project's homeowner or address, or carries a number shaped like an account / phone / address,
// is never proposed (it would land in the shared row as the check's value).
//
// What the correction path ALREADY teaches is not duplicated: ground snow, wind speed / exposure
// and attachment spacing go to the AHJ's code profile as criteria proposals
// (designCriteria.extractAhjRequiredCriteria), which the design-criteria rules compare.
//
// SEVERITY IS RULE 3's SHAPE, through #145's comparison (amendmentChecks.compareCheckWithPlan):
//   - an APPROVED rule (a person approved it: human-verified) whose failing value is stated on the
//     package's own sheets                                            -> city.ahj.prior-correction BLOCKER;
//   - an approved rule failed only by a value the parser read         -> WARNING;
//   - required wording no text layer carries, or a quantity the plan does not state
//                                                                     -> city.ahj.prior-correction-unconfirmed WARNING
//     (absence is not a stated value — vision may relax it);
//   - a PROPOSED (unapproved) rule                                    -> nothing.
// city.ahj.prior-correction reports a measured comparison, so it is in reviewerVision's
// MEASURED_FINDING_IDS: a picture of the sheet never relaxes it.
import type {
  CodeReference,
  JurisdictionAmendmentCheck,
  JurisdictionReviewRule,
  ProjectRecord,
  ReviewerFinding,
  ReviewerFindingEvidence,
} from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { checkFieldLabel, compareCheckWithPlan, describeCheckRequirement, parseAmendmentCheck } from "./amendmentChecks";
import type { DesignTextSource } from "./designCriteria";
import { redactSecretValues } from "../../shared/src/portalSafety";

export const PRIOR_CORRECTION_ID = "city.ahj.prior-correction";
export const PRIOR_CORRECTION_UNCONFIRMED_ID = "city.ahj.prior-correction-unconfirmed";

// --- the rule row -------------------------------------------------------------------------------

/** One identity per (jurisdiction, check): the same requirement corrected twice is one rule. */
export function reviewRuleSignature(check: JurisdictionAmendmentCheck): string {
  return `${check.kind}|${check.field}|${String(check.value).replace(/\s+/g, " ").trim().toLowerCase()}|${check.unit ?? ""}`;
}

type Row = Record<string, unknown>;
const txt = (v: unknown): string => (v == null ? "" : String(v));

/** A jurisdiction_review_rules row, or null when its check no longer parses (read strictly). */
export function reviewRuleFromRow(row: Row): JurisdictionReviewRule | null {
  let raw: unknown = null;
  try { raw = JSON.parse(txt(row.check_json)); } catch { raw = null; }
  const check = parseAmendmentCheck(raw, { cited: true });
  if (!check) return null;
  const status = txt(row.status) === "approved" ? "approved" : "proposed";
  return {
    id: txt(row.id),
    profileKey: txt(row.profile_key),
    state: txt(row.state),
    ahj: txt(row.ahj),
    check,
    bucket: txt(row.bucket),
    rootCause: txt(row.root_cause),
    requiredAction: txt(row.required_action),
    status,
    createdAt: txt(row.created_at),
    ...(row.approved_at ? { approvedAt: txt(row.approved_at) } : {}),
  };
}

// --- correction text -> checks (deterministic) ---------------------------------------------------

export interface AhjReviewCheck {
  check: JurisdictionAmendmentCheck;
  /** The sentence the AHJ wrote, tight — for the org's review item only. */
  basis: string;
}

/** The sentence states a requirement ("shall", "must", "minimum", "provide", "add" …). */
const REQUIREMENT_CUE = /\b(?:shall|must|required|requires?|min(?:imum)?\.?|at\s+least|provide|add|include|revise|not\s+(?:to\s+)?exceed|max(?:imum)?\.?|no\s+more\s+than)\b/i;
/** A question, a condition, or the package quoted back — not the AHJ's rule. */
const NOT_A_RULE = /^\s*(?:\(?\d+[.)]\s*)?(?:if|unless|when|where|verify\s+whether)\b|\bwhether\b|\b(?:plans?|calc\w*|letter|sheets?|drawings?)\s+(?:show|state|indicate|list)s?\b|\b(?:is|are)\s+(?:incorrect|acceptable|ok)\b/i;
const UNIT = String.raw`(in(?:ch(?:es)?)?\b|"|”|''|ft\b|feet\b|foot\b|'|’)`;
const NUM = String.raw`(\d+(?:\.\d+)?)`;
const PATHWAY_BEFORE = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:-\s*)?(?:(?:wide|minimum|min\.?|clear|unobstructed)\s+)*(?:fire\s+)?(?:access\s+)?pathways?\b`, "i");
const PATHWAY_AFTER = new RegExp(String.raw`\b(?:fire\s+)?(?:access\s+)?pathways?\b[^.\d]{0,50}?(?:min(?:imum)?\.?|at\s+least|of|be|width)\s*(?:of\s+)?${NUM}\s*${UNIT}`, "i");
const RIDGE_BEFORE = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:(?:minimum|min\.?|clear)\s+)?(?:setback\s+)?(?:from|below|of|off)\s+(?:the\s+)?ridge\b`, "i");
const RIDGE_AFTER = new RegExp(String.raw`\bridge\s+setback\b[^.\d]{0,50}?${NUM}\s*${UNIT}`, "i");
const PV_DEAD_LOAD_MAX = /\b(?:pv|solar|array|module|panel)s?\s+(?:system\s+)?(?:dead\s+load|weight)\b[^.\d]{0,40}?(?:shall\s+not\s+exceed|not\s+(?:to\s+)?exceed|max(?:imum)?\.?(?:\s+of)?|no\s+more\s+than|at\s+most|≤|<=)\s*(\d+(?:\.\d+)?)\s*psf\b/i;
/** Required wording: the sentence asks for a note / label / placard and quotes what it must say. */
const WORDING_ASK = /\b(?:add|provide|include|show|install|shall\s+(?:read|state|say)|must\s+(?:read|state|say)|reading)\b/i;
const WORDING_THING = /\b(?:notes?|labels?|placards?|statements?|wording|signs?|signage|markings?|text)\b/i;
const QUOTED = /["“]([^"”]{3,200})["”]/g;

function sentencesOf(text: string): string[] {
  return String(text || "")
    .split(/\r?\n+|(?<=[.;!?])\s+(?=[A-Z0-9(\-•*])/)
    .map((s) => s.replace(/^\s*[-•*]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const tight = (sentence: string): string => (sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence);

/** Inches / feet as the AHJ wrote them, into a check — strictly, through #145's parser. */
function lengthCheck(kind: "min_value", field: "pathwayWidthIn" | "ridgeSetbackIn", n: string, unit: string): JurisdictionAmendmentCheck | undefined {
  const u = unit.replace(/[”]/g, "\"").replace(/[’]/g, "'").replace(/^''$/, "\"");
  return parseAmendmentCheck({ kind, field, value: Number(n), unit: u }, { cited: true });
}

/**
 * The review checks a correction's text STATES — none it merely mentions. One value per check per
 * correction: a field stated with two different values is ambiguous, and a person reads it.
 */
export function extractAhjReviewChecks(text: string): AhjReviewCheck[] {
  const found: AhjReviewCheck[] = [];
  for (const sentence of sentencesOf(text)) {
    if (!REQUIREMENT_CUE.test(sentence) || NOT_A_RULE.test(sentence)) continue;
    const add = (check: JurisdictionAmendmentCheck | undefined): void => { if (check) found.push({ check, basis: tight(sentence) }); };
    const p = PATHWAY_BEFORE.exec(sentence) ?? PATHWAY_AFTER.exec(sentence);
    if (p) add(lengthCheck("min_value", "pathwayWidthIn", p[1], p[2]));
    const r = RIDGE_BEFORE.exec(sentence) ?? RIDGE_AFTER.exec(sentence);
    if (r) add(lengthCheck("min_value", "ridgeSetbackIn", r[1], r[2]));
    const d = PV_DEAD_LOAD_MAX.exec(sentence);
    if (d) add(parseAmendmentCheck({ kind: "max_value", field: "pvDeadLoadPsf", value: Number(d[1]), unit: "psf" }, { cited: true }));
    if (WORDING_ASK.test(sentence) && WORDING_THING.test(sentence)) {
      for (const m of sentence.matchAll(QUOTED)) add(parseAmendmentCheck({ kind: "required_text", field: "planText", value: m[1] }, { cited: true }));
    }
  }
  const out: AhjReviewCheck[] = [];
  const keyOf = (c: JurisdictionAmendmentCheck): string => `${c.kind}|${c.field}`;
  for (const key of [...new Set(found.map((f) => keyOf(f.check)))]) {
    const hits = found.filter((f) => keyOf(f.check) === key);
    if (hits[0].check.field === "planText") {
      // Several required notes are several rules; the same note twice is one.
      const seen = new Set<string>();
      for (const h of hits) if (!seen.has(reviewRuleSignature(h.check))) { seen.add(reviewRuleSignature(h.check)); out.push(h); }
      continue;
    }
    if (new Set(hits.map((h) => String(h.check.value))).size === 1) out.push(hits[0]);
  }
  return out;
}

/** Words a name or street shares with ordinary plan / review wording — never evidence on their own. */
const COMMON_WORDS = new Set([
  "the", "and", "of", "to", "in", "at", "on", "or", "by", "for", "per", "with", "a", "an", "is", "be", "no", "not",
  "pv", "ac", "dc", "kw", "in", "ft", "psf", "mph", "nec", "irc", "ifc", "ul",
  "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane", "way", "ct", "court", "pl", "place",
  "blvd", "cir", "circle", "hwy", "n", "s", "e", "w", "ne", "nw", "se", "sw", "llc", "inc", "co", "jr", "sr", "mr", "mrs", "ms",
]);
const nameWords = (s: string | undefined): string[] =>
  String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !COMMON_WORDS.has(w));

/**
 * Could this text carry the homeowner's details into the SHARED table? Checked on anything a rule
 * row would store or show another tenant (the wording, and the correction's root cause / required
 * action, which the triage LLM rewrites from a prompt that carries the homeowner and address):
 *   - an email, or an identifier-shaped number: 5+ digits with separators IGNORED (rule 2's
 *     convention, redactSecretValues — "/" aside): "APN 123-456-78", "SA# 1234 5678", a phone number;
 *   - the project's own secrets (account / meter / the parser's secret fields), matched by
 *     redactSecretValues itself;
 *   - any word of the homeowner's name, or of the street (number and name) — 2-letter words
 *     included, words every plan uses ("st", "pv", "nec") excluded.
 * A code edition ("2023 NEC") or a dimension is fine. False positives only drop a proposal or a
 * classification sentence, which is the safe direction.
 */
export function wordingNamesProject(
  phrase: string,
  project: { homeownerName?: string; projectAddress?: string },
  secrets: Iterable<string> = [],
): boolean {
  const raw = String(phrase || "");
  // Separators as redactSecretValues reads them, except "/": "120/240 V" is a service voltage.
  // Any dash counts (ASCII, U+2010-2015, minus), as knowledgeBase redact() reads them.
  // (redactSecretValues itself still treats only U+2013 as a Unicode dash.)
  if (/@/.test(raw) || /\d(?:[\s\-\u2010-\u2015\u2212.#]*\d){4,}/.test(raw)) return true;
  if (redactSecretValues(raw, secrets) !== raw) return true;
  const p = ` ${raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (nameWords(project.homeownerName).some((w) => p.includes(` ${w} `))) return true;
  const address = String(project.projectAddress || "").toLowerCase().split(",")[0];
  const houseNumber = address.match(/^\s*(\d+)\b/)?.[1];
  const streetWords = nameWords(address);
  if (streetWords.some((w) => p.includes(` ${w} `))) return true;
  if (houseNumber && streetWords[0] && p.includes(` ${houseNumber} ${streetWords[0]} `)) return true;
  return false;
}

/** The correction's root cause / required action as the SHARED row may hold it: verbatim when it
 *  names nothing of the project (wordingNamesProject), otherwise "" — never a partial scrub. */
export function sharedClassificationText(
  text: string,
  project: { homeownerName?: string; projectAddress?: string },
  secrets: Iterable<string> = [],
): string {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return t && !wordingNamesProject(t, project, secrets) ? t : "";
}

// --- the rule -----------------------------------------------------------------------------------

function ruleRef(ctx: EffectiveCodeContext, rule: JurisdictionReviewRule): CodeReference {
  return {
    code: "AHJ plan review",
    section: "",
    title: "Prior correction from this AHJ",
    adoptionScope: "A correction this jurisdiction issued on an earlier plan, approved as a review rule by a person.",
    sourceUrl: "",
    // The requirement only — never the correction's root cause / required action: this note is
    // shown to every tenant in the AHJ, and those sentences came from one tenant's correction.
    note: `${ctx.ahj || rule.ahj} has corrected plans for ${describeCheckRequirement(rule.check)}.`,
  };
}

/**
 * Compare every APPROVED review rule of this AHJ with what the package states. Pure: the context
 * carries the rules (codeProfiles.resolveEffectiveCodeContext); a proposed rule is skipped here
 * too, whoever loaded it.
 */
export function evaluatePriorCorrectionFindings(project: ProjectRecord, ctx: EffectiveCodeContext, opts: { extraTexts?: DesignTextSource[] } = {}): ReviewerFinding[] {
  const rules = (ctx.reviewRules ?? []).filter((r) => r.status === "approved");
  if (!rules.length) return [];
  const extraTexts = opts.extraTexts ?? [];
  const cache = {};
  const who = ctx.ahj || rules[0].ahj || "This jurisdiction";
  const failed: Array<{ rule: JurisdictionReviewRule; line: string; blocker: boolean; evidence: ReviewerFindingEvidence[] }> = [];
  const unconfirmed: Array<{ rule: JurisdictionReviewRule; line: string }> = [];
  for (const rule of rules) {
    const r = compareCheckWithPlan(project, rule.check, extraTexts, cache);
    const wants = describeCheckRequirement(rule.check);
    if (r.outcome === "met") continue;
    if (r.outcome === "not_met") {
      failed.push({
        rule,
        // Approved by a person = human-verified; the sheet's own statement is what makes it a blocker.
        blocker: r.documentStated,
        evidence: r.evidence,
        line: rule.check.kind === "prohibited"
          ? `${who} previously corrected "${String(rule.check.value)}" and the plan shows it (${r.shown})`
          : `${checkFieldLabel(rule.check.field)}: the plan states ${r.shown}; ${who} previously corrected plans for ${wants}`,
      });
    } else if (r.outcome === "wording_missing") {
      unconfirmed.push({ rule, line: `${who} previously required ${wants} and no ${r.docsRead ? "sheet" : "text"} read carries it` });
    } else {
      unconfirmed.push({ rule, line: `${who} previously corrected plans for ${wants}, and ${r.why}` });
    }
  }
  const out: ReviewerFinding[] = [];
  if (failed.length) {
    const blocker = failed.some((f) => f.blocker);
    out.push({
      id: PRIOR_CORRECTION_ID,
      severity: blocker ? "blocker" : "warning",
      category: "ahj_profile",
      title: "Plan repeats something this AHJ has corrected before",
      message: `${failed.map((f) => f.line).join(". ")}.${failed.every((f) => f.blocker)
        ? " Each rule above was approved by a person from an earlier correction, and the value is stated on the plan set's own sheets."
        : " Where a value above was read only by the parser, confirm it on the sheets before treating it as a rejection."}`,
      cityFeedback: `Revise the plans to meet what ${who} required on an earlier correction.`,
      designTeamAction: "Update the plan values or notes listed, or document why the earlier correction does not apply to this project.",
      evidenceNeeded: failed.map((f) => describeCheckRequirement(f.rule.check)),
      codeReferences: failed.map((f) => ruleRef(ctx, f.rule)),
      installerCallout: true,
      evidenceFound: failed.flatMap((f) => f.evidence),
    });
  }
  if (unconfirmed.length) {
    // Never a blocker: the text layer not carrying a value or a note is not the sheet lacking it.
    out.push({
      id: PRIOR_CORRECTION_UNCONFIRMED_ID,
      severity: "warning",
      category: "ahj_profile",
      title: "Confirm the plan answers this AHJ's earlier corrections",
      message: `${unconfirmed.map((u) => u.line).join(". ")}. It may be drawn on a sheet the text layer does not carry — confirm before filing.`,
      cityFeedback: `Show on the plans how each of ${who}'s earlier corrections listed is met.`,
      designTeamAction: "Add each listed value or note to the plan set, or point to the sheet that already shows it.",
      evidenceNeeded: unconfirmed.map((u) => describeCheckRequirement(u.rule.check)),
      codeReferences: unconfirmed.map((u) => ruleRef(ctx, u.rule)),
      installerCallout: true,
    });
  }
  return out;
}
