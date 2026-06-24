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
      const index = Math.max(0, match.index - 70);
      const excerpt = cleanExcerpt(source.text.slice(index, match.index + match[0].length + 110));
      if (excerpt && !excerpts.includes(excerpt)) {
        excerpts.push(excerpt);
        hits.push({ sourceLabel: source.label, excerpt, pageHint: pageHintFor(source.label, excerpt) });
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
      const patterns = [/\bSLD\b/i, /single[-\s]?line/i, /one[-\s]?line/i, /\b3[-\s]?line\b/i, /three[-\s]?line/i, /electrical diagram/i];
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
      const patterns = [/fire access/i, /access pathway/i, /pathway/i, /setback/i, /ridge/i, /eave/i, /smoke ventilation/i];
      const present = hasAny(project, patterns);
      const high = present && /dimension|ft\b|feet|inch|setback|ridge|eave|valley|hip/i.test(all);
      return evidence(project, topic, present, high ? "high" : present ? "medium" : "low", patterns);
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
  if (/battery|powerwall|ess/i.test(title)) return "batteryMode";
  if (/fire|pathway|setback/i.test(title)) return "firePathway";
  if (/rafter|truss|span|framing|structural/i.test(title)) return "roofFraming";
  if (/signature|owner authorization/i.test(title)) return "ownerAuthorization";
  return null;
}

export function requirementsForTopic(topic: EvidenceTopic): string[] {
  return topicRequirements[topic];
}
