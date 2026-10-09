import type { HistoricalChecklistItem, ProjectRecord } from "../../shared/src/types";
import { text } from "./json";
import { hasStampedStructuralEvidence } from "./permitPath";
import { projectSecretValues, redactSecretValues } from "./autoLearn";

export type EvidenceConfidence = "high" | "medium" | "low";

export type EvidenceTopic =
  | "accountVerification"
  | "meterPhoto"
  | "sld"
  | "siteRoofPlan"
  | "firePathway"
  | "roofFraming"
  | "rackingAttachment"
  | "structuralLoads"
  | "rapidShutdown"
  | "labels"
  | "inverterSettings"
  | "batteryMode"
  | "utilityApproval"
  | "ownerAuthorization";

export interface ProjectEvidence {
  topic: EvidenceTopic;
  present: boolean;
  confidence: EvidenceConfidence;
  excerpts: string[];
  sources: string[];
  hits: ProjectEvidenceHit[];
  missingEvidence: string[];
}

interface EvidenceSource {
  label: string;
  text: string;
}

export interface ProjectEvidenceHit {
  sourceLabel: string;
  excerpt: string;
  pageHint: string;
}

const topicRequirements: Record<EvidenceTopic, string[]> = {
  accountVerification: ["Utility bill/account holder match", "Utility account number", "Service address match"],
  meterPhoto: ["Meter photo", "Meter number match", "Legible service tag if applicable"],
  sld: ["SLD/one-line sheet", "Interconnection note", "Rapid shutdown/equipment notes"],
  siteRoofPlan: ["Site/roof plan sheet", "Array layout", "Service equipment and disconnect locations"],
  firePathway: ["Dimensioned roof pathway", "Ridge/eave/setback notes", "AHJ/fire exception basis if used"],
  roofFraming: ["Rafter/truss type", "Member size/spacing/span", "Prescriptive worksheet or stamped engineering"],
  rackingAttachment: ["Racking/attachment detail", "Attachment spacing table", "Fastener/embedment and flashing notes"],
  structuralLoads: ["Ground snow load", "PV dead load", "Wind exposure", "Roof slope"],
  rapidShutdown: ["Rapid shutdown equipment", "RSD initiation/control location", "RSD label/placard callout"],
  labels: ["PV label schedule", "Placard locations", "Power source directory"],
  inverterSettings: ["UL 1741 SB listing", "Utility-required inverter settings", "Inverter spec sheet"],
  batteryMode: ["Battery model/quantity", "Backup/non-backup mode", "Export setting", "Backup panel scope"],
  utilityApproval: ["Utility approval or interconnection approval", "Utility application confirmation", "Approval letter if AHJ requires it"],
  ownerAuthorization: ["Signed application", "Owner authorization", "Customer/owner signature"],
};

export function fieldValue(project: ProjectRecord, key: string): string {
  return text(project.parserSnapshot[key]).trim();
}

function maskIdentifier(value: string): string {
  const cleaned = value.replace(/\s+/g, "");
  if (cleaned.length <= 4) return cleaned ? "[captured]" : "";
  return `${"*".repeat(Math.max(0, cleaned.length - 4))}${cleaned.slice(-4)}`;
}

function cleanExcerpt(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\b(account(?:\s*(?:number|#|no\.?))?\s*[:#]?\s*)([A-Z0-9-]{5,})/gi, (_match, label: string, account: string) => `${label}${maskIdentifier(account)}`)
    .replace(/\b(meter(?:\s*(?:number|#|no\.?))?\s*[:#]?\s*)([A-Z0-9-]{5,})/gi, (_match, label: string, meter: string) => `${label}${maskIdentifier(meter)}`)
    .trim()
    .slice(0, 220);
}

function pageHintFor(sourceLabel: string, excerpt: string): string {
  const match = excerpt.match(/\b(?:page|pages|sheet|sheets)\s*[:#-]?\s*[A-Z0-9.,\s-]{1,24}/i);
  return match ? cleanExcerpt(match[0]).slice(0, 80) : sourceLabel;
}

function sourcesFor(project: ProjectRecord): EvidenceSource[] {
  const snapshot = project.parserSnapshot;
  const base: EvidenceSource[] = [
    { label: "Project utility", text: project.utility },
    { label: "Project AHJ", text: project.ahj },
    { label: "Interconnection method", text: project.interconnectionMethod },
    { label: "Parser confidence summary", text: project.parserConfidenceSummary },
    { label: "Utility account number", text: project.accountNumber ? `account number captured ${maskIdentifier(project.accountNumber)}` : "" },
    { label: "Meter number", text: project.meterNumber ? `meter number captured ${maskIdentifier(project.meterNumber)}` : "" },
  ];

  const keys: Array<[string, string]> = [
    ["planSetExtractedText", "Uploaded plan set text"],
    ["splitPagesText", "Split page mapping"],
    ["packetReadinessText", "Packet readiness"],
    ["utilityDownloadChecklistText", "Utility download checklist"],
    ["utilityUploadNotesText", "Utility upload notes"],
    ["projectDescriptionText", "Project description"],
    ["sitePlanNotesText", "Site plan notes"],
    ["roofPlanNotesText", "Roof plan notes"],
    ["structuralCalcText", "Structural calculation text"],
    ["electricalCalcText", "Electrical calculation text"],
    ["inverterSettings", "Inverter settings"],
    ["inverterSettingsText", "Inverter settings text"],
    ["labelsText", "Labels text"],
    ["ubMeterVerification", "Utility bill/meter verification"],
    ["locateCalloutText", "Locate callout"],
    ["stampRecommendation", "Stamp recommendation"],
    ["reviewFlags", "Parser review flags"],
    ["batteryMake", "Battery make"],
    ["batteryModel", "Battery model"],
    ["batteryQty", "Battery quantity"],
    ["invMake", "Inverter make"],
    ["invModel", "Inverter model"],
    ["pvMicroMake", "Microinverter make"],
    ["pvMicroModel", "Microinverter model"],
  ];

  // RULE 2 AT THE SOURCE (#260 review). An excerpt is a window cut from these texts and capped, and it
  // lands in a finding's evidence, its evidenceNeeded and the vision prompt. A window that ENDS inside
  // a meter number keeps a digit prefix the whole-number scrub can no longer match, so the texts are
  // scrubbed whole, before any window — as the design digest does (autoLearn.digestLines).
  const secrets = projectSecretValues(project);
  for (const [key, label] of keys) {
    const value = redactSecretValues(text(snapshot[key]).trim(), secrets);
    if (value) base.push({ label, text: value });
  }
  return base.filter((source) => text(source.text).trim());
}

export function allProjectEvidenceText(project: ProjectRecord): string {
  return sourcesFor(project)
    .map((source) => `${source.label}: ${source.text}`)
    .join("\n");
}

function matchSources(project: ProjectRecord, patterns: RegExp[], limit = 4): { excerpts: string[]; sources: string[]; hits: ProjectEvidenceHit[] } {
  const excerpts: string[] = [];
  const labels: string[] = [];
  const hits: ProjectEvidenceHit[] = [];
  for (const source of sourcesFor(project)) {
    for (const pattern of patterns) {
      const match = pattern.exec(source.text);
      if (!match) continue;
      // THE EXCERPT LEADS WITH THE EVIDENCE. It used to start 70 characters BEFORE the match,
      // and on a plan sheet the 70 characters before a sheet name are the title block — the
      // f7d7af7e SLD evidence opened "PHONE: 1-800-… SOLAR.COM Initial Design 00 4/15/26" and
      // the operator asked why the SLD evidence looked like our phone number. The same text
      // also feeds the evidence-image page picker, so leading junk steered the crop too.
      //
      // It starts at the match, or at the sentence/label boundary just before it when one is
      // close (the pattern that hits first is not always the earliest words: "One Line Diagram
      // (SLD)" is found by /\bSLD\b/, and the words that make it a diagram come before it).
      // Extracted PDF text separates text runs with two spaces, so a title-block cell ends in
      // a boundary and the excerpt still starts at the sheet name.
      //
      // It also ENDS at a line break. Extracted plan-set text joins its pages with "\n", so a
      // window that runs past one is quoting the NEXT sheet — whose first words are that
      // sheet's title block: "SNOW LOAD: 16 PSF ACME SOLAR PHONE: 1-800-…" is the same leak
      // at the other end, and the next sheet's words then steer the page picker to it.
      //
      // The page HINT still reads the wider window: a "SHEET E-1.1" label just before the
      // match is where the sheet reference lives, and the hint is metadata, not the quote.
      const lookback = source.text.slice(Math.max(0, match.index - 70), match.index);
      const boundaries = [...lookback.matchAll(/[.!?;]\s+|\s[—–]\s|\s{2,}|\n|\|\s*/g)];
      const lastBoundary = boundaries[boundaries.length - 1];
      const start = lastBoundary
        ? match.index - lookback.length + lastBoundary.index! + lastBoundary[0].length
        : match.index;
      const end = match.index + match[0].length + 180;
      const lineBreak = source.text.indexOf("\n", match.index + match[0].length);
      const excerpt = cleanExcerpt(source.text.slice(start, lineBreak >= 0 && lineBreak < end ? lineBreak : end));
      const hintWindow = cleanExcerpt(source.text.slice(Math.max(0, match.index - 70), match.index + match[0].length + 110));
      if (excerpt && !excerpts.includes(excerpt)) {
        excerpts.push(excerpt);
        hits.push({ sourceLabel: source.label, excerpt, pageHint: pageHintFor(source.label, hintWindow) });
      }
      if (!labels.includes(source.label)) labels.push(source.label);
      if (excerpts.length >= limit) return { excerpts, sources: labels, hits };
      break;
    }
  }
  return { excerpts, sources: labels, hits };
}

function hasAny(project: ProjectRecord, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(allProjectEvidenceText(project)));
}

// FIREFIGHTER ACCESS IS NOT THE SAME WORD AS A ZONING SETBACK.
//
// This test used to accept the bare words "setback", "ridge" and "eave" as fire-pathway
// evidence, and then grant HIGH confidence if any dimension appeared anywhere in the document.
// Every residential roof plan labels a ridge and an eave; every site plan carries zoning
// setbacks; solar plan sets are wall-to-wall dimensions. So the topic read present/high for
// essentially any plan set, both fire rules stayed silent, and a set with NO firefighter access
// pathway was reviewed identically to one with a dimensioned IFC 1205.2 pathway — measured, the
// two produced byte-identical reports. A life-safety review that cannot tell them apart is not
// happening. Found 2026-09-22 by an adversarial pass over the gate.
//
// The vocabulary below is HARVESTED from the operator's own corpus, not invented: across 23
// live projects the real phrases are "FIRE PATHWAY", "FIRE ACCESS" and "36\" FIRE SETBACK".
// That last one is why proximity matters — "setback" IS fire evidence when it is a fire
// setback, and is not when it is a lot line. 22 of 23 keep their evidence under this rule; the
// one that loses it is a test fixture with no fire content at all.
//
// Exported because codeReviewRules asks the same question for city.fire.pathways-missing, and
// two modules with two vocabularies is the exact defect pattern this gate keeps producing.
export const FIRE_PATHWAY_PATTERNS: RegExp[] = [
  /fire\s*access/i,
  /fire\s*pathway/i,
  /access\s*pathway/i,
  /smoke\s*vent(?:ilation)?/i,
  /IFC\s*1205/i,
  /R\s*324\.6/i,
  /firefighter/i,
  // Generic roof/zoning words become evidence only when tied to "fire" in the same breath.
  /fire[^.\n]{0,60}(?:setback|ridge|eave|pathway|clear)/i,
  /(?:setback|ridge|eave)[^.\n]{0,60}fire/i,
];

// HIGH confidence wants the dimension NEXT TO the fire callout, not merely somewhere on a
// sheet covered in dimensions. "36\" FIRE SETBACK" qualifies; "FRONT SETBACK 20 FT" on the
// site plan of a set that mentions fire elsewhere does not.
export const FIRE_PATHWAY_DIMENSIONED =
  /(?:fire|pathway)[^.\n]{0,80}\d+\s*(?:"|''|in\b|inch|ft\b|feet|')|\d+\s*(?:"|''|in\b|inch|ft\b|feet|')[^.\n]{0,80}(?:fire|pathway)/i;

// DOES THE PACKAGE SHOW AN SLD? One question, one predicate. codeReviewRules' city.plan.sld-missing
// kept its own four-word list without "one-line", so a package whose only SLD wording was
// "one-line diagram" (the Oregon golden fixture) raised the "Electrical one-line not reviewable"
// BLOCKER while this topic reported the same SLD present at high confidence — the gate
// contradicting itself about one project. The rule now reads packageShowsSld, i.e. this topic.
// Word-bounded: an unbounded /one[-\s]?line/ read "WIND ZONE LINE" on a roof plan and "PHONE
// LINE" in a title block as a one-line diagram — and, now that this predicate also decides the
// sld-missing blocker, would have cleared it for a package with no diagram at all.
const SLD_PATTERNS: RegExp[] = [/\bSLD\b/i, /\bsingle[-\s]?line\b/i, /\bone[-\s]?line\b/i, /\b3[-\s]?line\b/i, /\bthree[-\s]?line\b/i, /\belectrical diagram\b/i];

export function packageShowsSld(project: ProjectRecord): boolean {
  return evidenceForTopic(project, "sld").present;
}

function evidence(
  project: ProjectRecord,
  topic: EvidenceTopic,
  present: boolean,
  confidence: EvidenceConfidence,
  patterns: RegExp[],
  extraExcerpts: string[] = [],
): ProjectEvidence {
  const matched = matchSources(project, patterns);
  const extraHits = extraExcerpts
    .map(cleanExcerpt)
    .filter(Boolean)
    .map((excerpt) => ({ sourceLabel: "Normalized project field", excerpt, pageHint: "Project field" }));
  const excerpts = [...extraHits.map((hit) => hit.excerpt), ...matched.excerpts].filter(Boolean).slice(0, 5);
  return {
    topic,
    present,
    confidence,
    excerpts,
    sources: [...new Set([...extraHits.map((hit) => hit.sourceLabel), ...matched.sources])],
    hits: [...extraHits, ...matched.hits].slice(0, 5),
    missingEvidence: topicRequirements[topic],
  };
}

// DOES THE PACKAGE SHOW THE ROOF FRAMING? — the question a learned "Missing roof framing/span
// evidence" correction asks of every later project at that AHJ.
//
// It used to be answered by any of seven bare words anywhere in the text: rafter, truss, framing,
// span, STRUCTURAL, ENGINEER, PRESCRIPTIVE. The last three are on every plan set ever drawn —
// "STRUCTURAL NOTES:", "without the written approval of the engineer", "prescriptive path" — so
// once the history check could read the uploaded sheets (historicalFailures.ts) the blocker would
// have cleared for a set with no framing on it at all. And the parser's own STRUCTURED answer
// (framingType "truss", roofRafterSpacing 24) was not read at all, so a project whose parse said
// exactly what the correction asked for read "missing" — the load test's 12 blocked projects.
//
// Now, one clause at a time (a denial in its own clause — "rafter size not shown" — is not
// evidence; "No.2" the lumber grade is a number, not a denial):
//   present = a framing member is NAMED (rafter / truss / joist / framing), or the parsed
//             framingType names one, or a sealed structural letter/calcs is in hand
//             (hasStampedStructuralEvidence — the one predicate for that question);
//   high    = a named member WITH a dimension in the same clause (2x6, 24" o.c., span 12 ft), or
//             the parsed member plus a parsed spacing/span/size, or the sealed letter.
// A member with no dimension — in the text or the parsed fields — is missing, which is what keeps
// the blocker for a set that truly lacks it (see the last paragraph below).
//
// THE DIMENSION MUST BELONG TO THE MEMBER (2026-09-24, D1 verification MF1). Any number in a
// clause that named a member used to count, and every plan set has a clause like that which is
// about the ATTACHMENT, not the roof: "5/16\" x 4\" SS LAG SCREW INTO RAFTER, 2.5\" MIN EMBEDMENT"
// and "RAILS ATTACHED TO RAFTERS WITH L-FOOT MOUNTS @ 48\" O.C." both read present/high, so at a
// standard-review AHJ (City of Austin TX) a set whose only framing text was "standoffs lagged to
// rafters @ 48 in o.c." cleared a learned "rafter size, spacing and span" blocker and reached
// ready_to_stage with 0 blockers. The fastener's size and the attachment's spacing say nothing
// about the rafter it goes into. And a member merely NAMED in plan text — a sheet title "PV-3
// ROOF FRAMING PLAN", "EXISTING ROOF FRAMING TO BE VERIFIED" — is not framing evidence either:
// the correction asked for size, spacing and span, and those words carry none.
//
// So, per comma-separated part of a clause: a part that talks about a fastener or attachment is
// dropped before judging (the part before it — "2X6 RAFTERS @ 24\" O.C., ATTACH RAILS W/ LAGS" —
// still counts), and what is left must NAME a member and carry a MEMBER dimension: an NxM size
// (never the tail of a fraction — "3/8 x 5" is a lag), a spacing on centre, or a span with its
// length. Plan text that only names a member no longer makes the topic present — and neither does
// a parsed framingType with no parsed size, spacing or span.
const FRAMING_MEMBER = /\b(?:rafters?|truss(?:es)?|(?:i-?|ceiling |roof )?joists?|tji|top chords?|framing)\b/i;
const FRAMING_ATTACHMENT = /\b(?:lag(?:s|ged|ging)?|screws?|bolts?|embedment|embed(?:ded)?|stand-?offs?|l-?f(?:oo|ee)t|mounts?|mounting|mounted|attach\w*|flash(?:ed|ing|ings)?|rails?|racking|clamps?|brackets?|hooks?|fasten\w*)\b/i;
const MEMBER_DIMENSION: RegExp[] = [
  // Nominal size: "2x6", "2 X 10", "1.75x11.875" — not "3/8 x 5" (the 8 is a fraction's tail).
  /(?<![\/\d.])\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?(?![\/\d])/i,
  // Spacing on centre: "@ 24\" o.c.", "at 24 inches on center", "24 in OC", "24\" O.C.".
  /\d+(?:\.\d+)?\s*(?:"|''|in\b\.?|inch(?:es)?)?\s*(?:o\.?\s*c\b\.?|on[-\s]?cent(?:er|re))/i,
  // Spacing written with @ and a unit: "rafters @ 24\"", "@ 16 in".
  /@\s*\d+(?:\.\d+)?\s*(?:"|''|in\b|inch(?:es)?)/i,
  // Span with its length: "span 11 ft 6 in", "clear span: 10'", "10 ft clear span".
  /\bspans?\b[^\n,]{0,24}\d/i,
  /\d+(?:\.\d+)?\s*(?:ft\b|feet|')[^\n,]{0,20}\bspans?\b/i,
];
const FRAMING_DENIAL = /\b(?:not|no|none|missing|unknown|n\/a|tbd|without|lacks?|blank)\b|n't\b/i;
const MEMBER_WORD = /\b(?:rafter|truss|joist|i-?joist|tji|beam|purlin)s?\b/i;

/** A clause's member-owned framing text: its comma parts, minus any part about a fastener or an
 *  attachment. Exported for the test that pins the vocabulary. */
export function framingMemberText(clause: string): string {
  return clause.split(",").filter((part) => !FRAMING_ATTACHMENT.test(part)).join(",");
}

function framingField(project: ProjectRecord, keys: string[]): string {
  for (const key of keys) {
    const value = text(project.parserSnapshot?.[key]).trim();
    if (value && !/^(?:unknown|n\/a|na|none|tbd|not\s+sure|-+|\?+)$/i.test(value)) return value;
  }
  return "";
}

export function roofFramingFacts(project: ProjectRecord): { present: boolean; high: boolean; fieldLines: string[] } {
  // The parser's structured reading of the framing (llm.ts STRUCTURAL block; structuralIntake.ts).
  const member = framingField(project, ["framingType"]);
  const memberOk = MEMBER_WORD.test(member);
  const spacing = framingField(project, ["roofRafterSpacing", "rafterSpacing"]);
  const span = framingField(project, ["roofRafterSpan", "rafterSpan"]);
  const size = framingField(project, ["roofRafterSize", "rafterSize"]);
  const dims = [
    /\d/.test(size) ? `size ${size}` : "",
    /\d/.test(spacing) ? `${spacing.replace(/[^0-9.]/g, "")} in o.c.` : "",
    /\d/.test(span) ? `span ${span.replace(/[^0-9.]/g, "")} ft` : "",
  ].filter(Boolean);
  const fieldLines = memberOk ? [`Parsed roof framing: ${member}${dims.length ? `, ${dims.join(", ")}` : ""}`] : [];

  let dimensioned = false;
  for (const raw of allProjectEvidenceText(project).split(/[\n;]|\.(?=\s|$)/)) {
    // "No. 2" / "No.2" is the lumber grade (a NUMBER), not a denial.
    const clause = raw.replace(/\bno\.?\s*(?=[#\d])/gi, " number ");
    if (FRAMING_DENIAL.test(clause)) continue;
    const memberText = framingMemberText(clause);
    if (!FRAMING_MEMBER.test(memberText)) continue;
    if (MEMBER_DIMENSION.some((re) => re.test(memberText))) dimensioned = true;
  }
  const sealed = hasStampedStructuralEvidence(project);
  // Plan text counts only with a member dimension (see above), and so does the parser's
  // structured member: framingType "rafter" with no parsed size/spacing/span answers none of what
  // the correction asked for. It used to be a "needs review" lead — which the gate does not block
  // on — so a parsed type beside a sheet title ("PV-3 ROOF FRAMING PLAN", enough for the
  // reviewer's own regex) reached ready_to_stage at City of Austin with the learned blocker in
  // force. Present now means a member WITH a member dimension, from either source, or the seal.
  const present = dimensioned || sealed || (memberOk && dims.length > 0);
  const high = present;
  return { present, high, fieldLines };
}

export function evidenceForTopic(project: ProjectRecord, topic: EvidenceTopic): ProjectEvidence {
  const all = allProjectEvidenceText(project);
  switch (topic) {
    case "accountVerification": {
      const accountCaptured = Boolean(project.accountNumber);
      const verificationPatterns = [
        /utility bill/i,
        /account holder/i,
        /service address match/i,
        /account (?:data|verification|verified|match)/i,
        /verified .*account/i,
        /bill parsed/i,
      ];
      const verified = accountCaptured && hasAny(project, verificationPatterns);
      return evidence(
        project,
        topic,
        accountCaptured,
        verified ? "high" : accountCaptured ? "medium" : "low",
        verificationPatterns,
        accountCaptured ? [`Project account number captured: ${maskIdentifier(project.accountNumber)}`] : [],
      );
    }
    case "meterPhoto": {
      const meterCaptured = Boolean(project.meterNumber);
      const photoPatterns = [/meter photo/i, /meter picture/i, /meter image/i, /photo.*meter/i, /meter evidence/i, /service tag/i];
      const photoFound = hasAny(project, photoPatterns);
      return evidence(
        project,
        topic,
        meterCaptured || photoFound,
        meterCaptured && photoFound ? "high" : meterCaptured || photoFound ? "medium" : "low",
        photoPatterns,
        meterCaptured ? [`Project meter number captured: ${maskIdentifier(project.meterNumber)}`] : [],
      );
    }
    case "sld": {
      const patterns = SLD_PATTERNS;
      const mapped = matchSources(project, patterns);
      const present = mapped.excerpts.length > 0;
      const high = present && /page|sheet|diagram|705|interconnection|rapid shutdown|RSD/i.test(mapped.excerpts.join(" "));
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
    }
    case "siteRoofPlan": {
      const patterns = [/site plan/i, /plot plan/i, /roof plan/i, /\bPV layout\b/i, /array layout/i, /array dimensions/i];
      const present = hasAny(project, patterns);
      const high = present && /roof|array|service equipment|disconnect|dimension|page|sheet/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
    }
    case "firePathway": {
      const present = FIRE_PATHWAY_PATTERNS.some((p) => p.test(all));
      const high = present && FIRE_PATHWAY_DIMENSIONED.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", FIRE_PATHWAY_PATTERNS);
    }
    case "roofFraming": {
      // The excerpt list is unchanged (what the evidence card quotes); WHETHER framing is shown is
      // decided by roofFramingFacts — see its header for why the bare words stopped counting.
      const patterns = [/rafter/i, /truss/i, /framing/i, /span/i, /structural/i, /engineer/i, /prescriptive/i];
      const facts = roofFramingFacts(project);
      return evidence(project, topic, facts.present, facts.high ? "high" : facts.present ? "medium" : "low", patterns, facts.fieldLines);
    }
    case "rackingAttachment": {
      const patterns = [/racking/i, /attachment/i, /standoff/i, /lag/i, /flashing/i, /rail/i, /mounting/i, /embedment/i];
      const present = hasAny(project, patterns);
      const high = present && /spacing|detail|fastener|embedment|flashing|rafter/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
    }
    case "structuralLoads": {
      const patterns = [/ground snow/i, /\bsnow\b/i, /dead load/i, /wind exposure/i, /roof slope/i, /psf/i];
      const present = hasAny(project, patterns);
      const high = present && /snow/i.test(all) && /dead load|psf/i.test(all) && /wind/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
    }
    case "rapidShutdown": {
      const patterns = [/rapid shutdown/i, /\bRSD\b/i, /690\.12/i, /controlled conductor/i];
      const present = hasAny(project, patterns);
      const high = present && /label|initiator|equipment|inverter|690\.12/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
    }
    case "labels": {
      const patterns = [/label/i, /placard/i, /directory/i, /705\.10/i, /backfed breaker warning/i];
      const present = hasAny(project, patterns);
      const high = present && /schedule|placard|directory|rapid shutdown|disconnect|service/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
    }
    case "inverterSettings": {
      // For utility NEM (PGE PowerClerk / Pacific Power), "smart inverter settings" is
      // a portal Yes/No election to use the utility's RECOMMENDED smart inverter settings
      // — answered Yes for a UL 1741-SB listed smart inverter — plus an inverter technical
      // specification / cut-sheet upload. It is NOT a grid-profile drawing on the plan set.
      // So: explicit listing/settings text = high; an identified inverter model OR a spec/
      // cut-sheet reference = medium (the spec upload + "Yes" answer satisfies the utility).
      const patterns = [
        /UL\s*1741\s*SB/i,
        /inverter settings/i,
        /smart inverter/i,
        /IEEE\s*1547/i,
        /utility[- ]recommended.*settings/i,
        /recommended smart inverter settings/i,
        /utility settings/i,
      ];
      const present = hasAny(project, patterns);
      const snapshot = (project.parserSnapshot || {}) as Record<string, unknown>;
      const inverterModelCaptured = Boolean(
        text(snapshot.pvMicroModel).trim() || text(snapshot.invModel).trim() || text(snapshot.gatewayModel).trim(),
      );
      const specOnly = !present && (
        inverterModelCaptured ||
        hasAny(project, [/inverter spec/i, /microinverter spec/i, /cut ?sheet/i, /\bUL\s*1741\b/i, /datasheet/i])
      );
      return evidence(project, topic, present || specOnly, present ? "high" : specOnly ? "medium" : "low", patterns);
    }
    case "batteryMode": {
      const batteryScope = /battery|\bESS\b|powerwall|encharge|backup/i.test(all);
      const patterns = [/backup/i, /non[-\s]?backup/i, /self consumption/i, /rate saver/i, /export/i, /backup panel/i, /whole home/i, /critical load/i];
      const modeFound = batteryScope && hasAny(project, patterns);
      return evidence(project, topic, batteryScope && modeFound, modeFound ? "high" : batteryScope ? "medium" : "low", patterns);
    }
    case "utilityApproval": {
      const patterns = [/utility approval/i, /interconnection approved/i, /net meter approved/i, /approval letter/i, /approved interconnection/i, /SRP approval/i];
      const present = hasAny(project, patterns);
      return evidence(project, topic, present, present ? "high" : "low", patterns);
    }
    case "ownerAuthorization": {
      const patterns = [/owner authorization/i, /customer signature/i, /signed application/i, /signature request/i, /representative/i, /notar/i];
      const present = hasAny(project, patterns);
      return evidence(project, topic, present, present ? "high" : "low", patterns);
    }
  }
}

export function statusFromEvidence(check: ProjectEvidence): HistoricalChecklistItem["status"] {
  if (!check.present) return "missing";
  return check.confidence === "high" ? "present" : "needs_review";
}

export function evidenceLines(check: ProjectEvidence): string[] {
  if (!check.excerpts.length) return ["No matching evidence found in parsed project text."];
  return check.excerpts.map((excerpt) => `Found ${check.confidence}-confidence evidence: ${excerpt}`);
}

export function historicalTopicForTitle(title: string): EvidenceTopic | null {
  if (/account/i.test(title)) return "accountVerification";
  if (/meter photo/i.test(title)) return "meterPhoto";
  if (/one-line|sld|3-line|single line/i.test(title)) return "sld";
  if (/inverter settings|1741|smart inverter/i.test(title)) return "inverterSettings";
  // \bESS\b, never a bare "ess": "Address", "necessary", "process" and "access" all contain it.
  if (/battery|powerwall|\bESS\b/i.test(title)) return "batteryMode";
  if (/fire|pathway|setback/i.test(title)) return "firePathway";
  if (/rafter|truss|span|framing|structural/i.test(title)) return "roofFraming";
  if (/signature|owner authorization/i.test(title)) return "ownerAuthorization";
  if (/label|placard/i.test(title)) return "labels";
  return null;
}

export function requirementsForTopic(topic: EvidenceTopic): string[] {
  return topicRequirements[topic];
}
