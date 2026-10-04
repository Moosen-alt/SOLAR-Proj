// LOCAL AMENDMENTS, COMPARED WITH THE PLAN (#145).
//
// Code research has always recorded a jurisdiction's amendments (state row, then AHJ row:
// code / section / summary / sourceUrl), but nothing compared them with the plan: they surfaced
// only as citation text, so a plan printing 25 psf ground snow where the city amended the minimum
// to 30 passed. Research now classifies each CITED amendment it can into one machine-checkable
// shape (JurisdictionAmendmentCheck: a minimum, a maximum, required wording, prohibited wording)
// and this module compares it with what the package states, through the SAME readers the other
// rules use: the design-criteria extractor (ground snow, wind), the roof-plan reader (pathway
// width, ridge setback), the attachment-spacing reader, and the sheets' own text.
//
// SEVERITY IS RULE 3's SHAPE:
//   - the amendment's row is human-VERIFIED and the failing value is stated on the package's own
//     sheets                                                         -> BLOCKER;
//   - a SEEDED (researched / imported) amendment, or a value only the parser read -> WARNING. A
//     parser misread, or a research answer nobody checked, never blocks a filing on its own;
//   - an amendment with no check (uncited, unclassifiable), or one whose quantity the plan does
//     not state                                                      -> one CALLOUT listing them
//     under "local amendments to check by hand".
// city.code.amendment-not-met reports a measured comparison, so it is in reviewerVision's
// MEASURED_FINDING_IDS: a picture of the sheet never relaxes it.
import type {
  AmendmentCheckField,
  CodeReference,
  JurisdictionAmendmentCheck,
  JurisdictionCodeAmendment,
  ProjectRecord,
  ReviewerFinding,
  ReviewerFindingEvidence,
} from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import {
  extractAttachmentSpacings,
  extractRoofPlanDimensions,
  extractStatedDesignCriteria,
  packageReadSources,
  type DesignTextSource,
} from "./designCriteria";

export const AMENDMENT_NOT_MET_ID = "city.code.amendment-not-met";
export const AMENDMENTS_BY_HAND_ID = "city.code.amendments-check-by-hand";

// --- classification (research time) -------------------------------------------------------------

/** The unit each numeric field is compared in. "planText" takes no unit. */
const FIELD_UNIT: Record<Exclude<AmendmentCheckField, "planText">, "psf" | "mph" | "in"> = {
  groundSnowPsf: "psf",
  windSpeedMph: "mph",
  pvDeadLoadPsf: "psf",
  pathwayWidthIn: "in",
  ridgeSetbackIn: "in",
  attachmentSpacingIn: "in",
};
const NUMERIC_KINDS = new Set(["min_value", "max_value"]);
const TEXT_KINDS = new Set(["required_text", "prohibited"]);

const FIELD_LABEL: Record<AmendmentCheckField, string> = {
  groundSnowPsf: "Ground snow load",
  windSpeedMph: "Design wind speed",
  pvDeadLoadPsf: "PV dead load",
  pathwayWidthIn: "Fire access pathway width",
  ridgeSetbackIn: "Ridge setback",
  attachmentSpacingIn: "Attachment spacing",
  planText: "Plan wording",
};

/** A unit as research may write it, normalized to the field's, with the factor to get there. */
function unitFactor(raw: string, want: "psf" | "mph" | "in"): number | null {
  const u = raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\.$/, "");
  if (want === "psf") return /^(psf|lb\/ft2|lbs\/ft2|lb\/ft²|lbs\/ft²|lb\/sqft|lbs\/sqft|poundspersquarefoot)$/.test(u) ? 1 : null;
  if (want === "mph") return /^(mph|mi\/h|milesperhour)$/.test(u) ? 1 : null;
  if (/^(in|inch|inches|")$/.test(u)) return 1;
  if (/^(ft|feet|foot|')$/.test(u)) return 12;
  return null;
}

/**
 * The research answer's `check` for ONE amendment, or undefined. Read strictly — a wrong check is
 * a wrong blocker, so anything short of a well-formed one leaves the amendment informational:
 *   - `cited` false (no source URL, or the research was not web-grounded) -> nothing;
 *   - an unknown kind or field, a numeric kind on planText or a text kind on a quantity -> nothing;
 *   - a numeric value that is not a positive number, or a unit that is not the field's (feet are
 *     converted to inches) -> nothing;
 *   - wording shorter than 3 or longer than 200 characters -> nothing.
 */
export function parseAmendmentCheck(raw: unknown, opts: { cited: boolean }): JurisdictionAmendmentCheck | undefined {
  if (!opts.cited || !raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind.trim() : "";
  const field = typeof r.field === "string" ? r.field.trim() : "";
  if (NUMERIC_KINDS.has(kind)) {
    if (!(field in FIELD_UNIT)) return undefined;
    const want = FIELD_UNIT[field as keyof typeof FIELD_UNIT];
    const n = typeof r.value === "number" ? r.value : typeof r.value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(r.value) ? Number(r.value) : NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const factor = typeof r.unit === "string" ? unitFactor(r.unit, want) : null;
    if (factor == null) return undefined;
    return { kind: kind as JurisdictionAmendmentCheck["kind"], field: field as AmendmentCheckField, value: Math.round(n * factor * 100) / 100, unit: want };
  }
  if (TEXT_KINDS.has(kind)) {
    if (field !== "planText") return undefined;
    const value = typeof r.value === "string" ? r.value.replace(/\s+/g, " ").trim() : "";
    if (value.length < 3 || value.length > 200) return undefined;
    return { kind: kind as JurisdictionAmendmentCheck["kind"], field: "planText", value };
  }
  return undefined;
}

// --- what the plan states -----------------------------------------------------------------------

interface PlanValue {
  value: number;
  source: string;
  excerpt: string;
  /** On the package's own sheets (not the parser's fields or summaries). */
  documentStated: boolean;
}

// "PV DEAD LOAD = 2.85 PSF", "ARRAY WEIGHT: 3 psf", "DEAD LOAD FOR ROOF-MOUNTED PANELS ATTACHMENTS: 2.85 PSF".
// The roof's own dead load ("ROOF DEAD LOAD 15 PSF") is not the PV's.
const PV_DEAD_LOAD = /\b(?:(?:pv|solar|array|module|panel)s?\s+(?:system\s+|array\s+)?(?:dead\s+load|weight|d\.?\s?l\.?)\b|dead\s+load\s+(?:for|of)\s+(?:the\s+)?(?:roof[-\s]mounted\s+)?(?:pv|solar|panels?|modules?|array)\b)[^0-9]{0,40}?(\d+(?:\.\d+)?)\s*psf\b/gi;

function pvDeadLoads(text: string): Array<{ psf: number; excerpt: string }> {
  return [...String(text || "").matchAll(PV_DEAD_LOAD)].map((m) => ({ psf: Number(m[1]), excerpt: m[0].replace(/\s+/g, " ").slice(0, 120) }));
}

function snapshotNumber(project: ProjectRecord, key: string): number | null {
  const raw = (project.parserSnapshot as unknown as Record<string, unknown> | undefined)?.[key];
  const nums = String(raw ?? "").match(/\d+(?:\.\d+)?/g);
  return nums && nums.length === 1 ? Number(nums[0]) : null;
}

function planValues(project: ProjectRecord, field: Exclude<AmendmentCheckField, "planText">, extraTexts: DesignTextSource[]): PlanValue[] {
  if (field === "groundSnowPsf" || field === "windSpeedMph") {
    // Ground snow: the GROUND value (pg), never the roof's; wind: the ultimate speed, never a
    // nominal / ASD one, which is a different quantity.
    return extractStatedDesignCriteria(project, extraTexts).criteria
      .filter((c) => c.criterion === field && typeof c.value === "number"
        && (field === "groundSnowPsf" ? c.qualifier === "ground" : c.qualifier !== "nominal"))
      .map((c) => ({ value: c.value as number, source: c.source, excerpt: c.excerpt ?? "", documentStated: !c.derived }));
  }
  if (field === "pathwayWidthIn" || field === "ridgeSetbackIn") {
    const kind = field === "pathwayWidthIn" ? "pathwayWidth" : "ridgeSetback";
    return extractRoofPlanDimensions(project, extraTexts)
      .filter((d) => d.kind === kind)
      .map((d) => ({ value: d.inches, source: d.source, excerpt: d.excerpt, documentStated: !d.derived }));
  }
  const out: PlanValue[] = [];
  for (const s of packageReadSources(project, extraTexts)) {
    const documentStated = s.sheet && !s.derived;
    if (field === "attachmentSpacingIn") {
      for (const a of extractAttachmentSpacings(s.text)) out.push({ value: a.inches, source: s.label, excerpt: a.excerpt, documentStated });
    } else {
      for (const d of pvDeadLoads(s.text)) out.push({ value: d.psf, source: s.label, excerpt: d.excerpt, documentStated });
    }
  }
  if (field === "pvDeadLoadPsf") {
    // The parser's field is a reading: it can fail a check, never block one.
    for (const key of ["pvDeadLoad", "deadLoad"]) {
      const v = snapshotNumber(project, key);
      if (v != null) { out.push({ value: v, source: "Parsed project fields", excerpt: `${key}: ${v}`, documentStated: false }); break; }
    }
  }
  return out;
}

// Wording is compared on letters and digits only: "PHOTOVOLTAIC SYSTEM — EQUIPPED WITH RAPID
// SHUTDOWN" and "photovoltaic system equipped with rapid shutdown" are the same placard.
const norm = (s: string): string => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
// "NO ROOF-MOUNTED DISCONNECT" names the prohibited thing to say it is absent.
const NEGATION_BEFORE = / (?:no|not|never|without|prohibited|shall not|do not|does not)(?: [a-z0-9]+){0,2} $/;

function wordingAt(text: string, phrase: string): "affirmed" | "negated" | "absent" {
  const t = norm(text);
  const p = norm(phrase);
  if (p.trim().length < 3) return "absent";
  let at = t.indexOf(p);
  let negated = false;
  while (at >= 0) {
    if (!NEGATION_BEFORE.test(t.slice(Math.max(0, at - 40), at + 1))) return "affirmed";
    negated = true;
    at = t.indexOf(p, at + 1);
  }
  return negated ? "negated" : "absent";
}

// --- the rule -----------------------------------------------------------------------------------

interface FailedLine {
  line: string;
  blocker: boolean;
  verified: boolean;
  evidence: ReviewerFindingEvidence[];
  amendment: JurisdictionCodeAmendment;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const amendmentLabel = (a: JurisdictionCodeAmendment): string => `${a.code}${a.section ? ` ${a.section}` : ""}`;

/** Was the row this amendment came from human-verified? A layered read records each merged
 *  amendment's row under fieldSources["amendments.<i>"]; a single row answers for itself. */
function amendmentVerified(ctx: EffectiveCodeContext, index: number): boolean {
  const src = ctx.profile?.fieldSources?.[`amendments.${index}`];
  return src ? src.confidence === "verified" : ctx.verified;
}

function amendmentRef(a: JurisdictionCodeAmendment, verified: boolean): CodeReference {
  return {
    code: a.code,
    section: a.section ?? "",
    title: "Local amendment",
    adoptionScope: verified ? "Jurisdiction amendment (human-verified)." : "Jurisdiction amendment (researched — verify locally).",
    sourceUrl: a.sourceUrl ?? "",
    note: a.summary,
  };
}

function evidenceOf(v: PlanValue, label: string): ReviewerFindingEvidence {
  return {
    kind: v.documentStated ? "source_excerpt" : "field_value",
    label,
    source: v.source,
    excerpt: v.excerpt,
    confidence: v.documentStated ? "high" : "medium",
    pageHint: "",
    screenshotPath: "",
    verifier: v.documentStated ? "rule_engine" : "parser",
    note: v.documentStated ? "Stated on the package's own sheets." : "Read by the parser — confirm it on the sheets.",
  };
}

/**
 * Compare every classified local amendment with what the package states; list the rest for a
 * person. Pure: the jurisdiction context carries the amendments (merged state-then-AHJ).
 */
export function evaluateAmendmentFindings(project: ProjectRecord, ctx: EffectiveCodeContext, opts: { extraTexts?: DesignTextSource[] } = {}): ReviewerFinding[] {
  const amendments = ctx.amendments ?? [];
  if (!amendments.length) return [];
  const extraTexts = opts.extraTexts ?? [];
  const failed: FailedLine[] = [];
  const byHand: Array<{ amendment: JurisdictionCodeAmendment; why: string; verified: boolean }> = [];
  let sources: ReturnType<typeof packageReadSources> | null = null;

  amendments.forEach((a, i) => {
    const verified = amendmentVerified(ctx, i);
    const check = a.check;
    if (!check) { byHand.push({ amendment: a, why: "", verified }); return; }
    const label = amendmentLabel(a);
    if (check.field !== "planText" && (check.kind === "min_value" || check.kind === "max_value")) {
      const required = Number(check.value);
      const unit = FIELD_UNIT[check.field];
      const values = planValues(project, check.field, extraTexts);
      if (!values.length) { byHand.push({ amendment: a, why: `the plan does not state its ${FIELD_LABEL[check.field].toLowerCase()}`, verified }); return; }
      const bad = values.filter((v) => (check.kind === "min_value" ? v.value < required : v.value > required));
      if (!bad.length) return;
      const documentStated = bad.some((v) => v.documentStated);
      const shown = [...new Set(bad.map((v) => `${fmt(v.value)} ${unit} (${v.source}${v.documentStated ? "" : ", parser"})`))].join(", ");
      failed.push({
        amendment: a,
        verified,
        blocker: verified && documentStated,
        evidence: bad.slice(0, 4).map((v) => evidenceOf(v, FIELD_LABEL[check.field])),
        line: `${FIELD_LABEL[check.field]}: the plan states ${shown}; ${label} requires ${check.kind === "min_value" ? "at least" : "at most"} ${fmt(required)} ${unit} ("${a.summary}")`,
      });
      return;
    }
    // Wording, on the package's own text.
    sources ??= packageReadSources(project, extraTexts);
    if (!sources.length) { byHand.push({ amendment: a, why: "no plan text was read to compare its wording with", verified }); return; }
    const phrase = String(check.value);
    const docs = sources.filter((s) => s.sheet && !s.derived);
    if (check.kind === "required_text") {
      // Found anywhere (a parser summary quoting it included) passes: absence is the finding, and
      // it is document-stated only when a document of the package was read.
      if (sources.some((s) => wordingAt(s.text, phrase) !== "absent")) return;
      failed.push({
        amendment: a,
        verified,
        blocker: verified && docs.length > 0,
        evidence: [],
        line: `Required wording missing: ${label} requires "${phrase}" on the plans and no sheet read carries it ("${a.summary}")`,
      });
      return;
    }
    const hits = sources.filter((s) => wordingAt(s.text, phrase) === "affirmed");
    if (!hits.length) return;
    const documentStated = hits.some((s) => s.sheet && !s.derived);
    failed.push({
      amendment: a,
      verified,
      blocker: verified && documentStated,
      evidence: hits.slice(0, 4).map((s) => evidenceOf({ value: 0, source: s.label, excerpt: phrase, documentStated: s.sheet && !s.derived }, "Prohibited wording")),
      line: `Prohibited by ${label}: the plan shows "${phrase}" (${[...new Set(hits.map((s) => s.label))].join(", ")}) ("${a.summary}")`,
    });
  });

  const out: ReviewerFinding[] = [];
  const who = ctx.ahj || ctx.state || "the jurisdiction";
  if (failed.length) {
    const blocker = failed.some((f) => f.blocker);
    const softened = failed.filter((f) => !f.blocker);
    out.push({
      id: AMENDMENT_NOT_MET_ID,
      severity: blocker ? "blocker" : "warning",
      category: "ahj_profile",
      title: "Plan does not meet a local code amendment",
      message: `${failed.map((f) => f.line).join(". ")}.${softened.length
        ? ` ${softened.length === failed.length ? "Each" : "Some"} amendment above is from a researched (not human-verified) profile row or compares a value only the parser read — confirm before treating it as a rejection.`
        : " Each amendment above is on a human-verified profile row and the value is stated on the plan set's own sheets."}`,
      cityFeedback: `Revise the plans to meet ${who}'s local amendment${failed.length > 1 ? "s" : ""} cited below.`,
      designTeamAction: "Update the plan values or notes to satisfy each listed local amendment, or document why it does not apply to this project.",
      evidenceNeeded: failed.map((f) => amendmentLabel(f.amendment)),
      codeReferences: failed.map((f) => amendmentRef(f.amendment, f.verified)),
      installerCallout: true,
      evidenceFound: failed.flatMap((f) => f.evidence),
    });
  }
  if (byHand.length) {
    out.push({
      id: AMENDMENTS_BY_HAND_ID,
      severity: "callout",
      category: "ahj_profile",
      title: "Local amendments to check by hand",
      message: `${who} has local amendment${byHand.length > 1 ? "s" : ""} the review cannot compare with the plan automatically: ${byHand
        .map((b) => `${amendmentLabel(b.amendment)} — ${b.amendment.summary}${b.why ? ` (${b.why})` : ""}`).join("; ")}.`,
      cityFeedback: "Confirm the plans comply with each listed local amendment.",
      designTeamAction: "Read each listed amendment against the plan set and note compliance where the reviewer will look for it.",
      evidenceNeeded: byHand.map((b) => amendmentLabel(b.amendment)),
      codeReferences: byHand.map((b) => amendmentRef(b.amendment, b.verified)),
      installerCallout: false,
    });
  }
  return out;
}
