import type { HistoricalChecklistItem, ProjectRecord } from "../../shared/src/types";
import { text } from "./json";

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

  for (const [key, label] of keys) {
    const value = text(snapshot[key]).trim();
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
      const patterns = [/rafter/i, /truss/i, /framing/i, /span/i, /structural/i, /engineer/i, /prescriptive/i];
      const present = hasAny(project, patterns);
      const high = present && /spacing|span|2x|engineer|stamped|worksheet|dead load|snow|wind/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
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
