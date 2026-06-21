import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import type {
  CommonCorrectionPattern,
  CorrectionBucket,
  KnowledgeSource,
  MboxEmailBucket,
  MboxExtractedLearningRecord,
  MboxKnowledgeImportResult,
  PermitStatusCheck,
  AhjResearchResult,
  PermitUtilityKnowledgeProfile,
  ProjectRecord,
  ProjectStatus,
} from "../../shared/src/types";
import { classifyCorrection, type CorrectionClassification } from "./corrections";
import type { AppDb } from "./db";
import { id } from "./ids";
import { asJson, parseJson } from "./json";
import { findApplicationProfile } from "./applicationDocs";
import { enrichMboxLearningWithLlm } from "./llm";
import { allAhjProcessProfiles, findAhjProcessProfile } from "./processProfiles";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

interface KnowledgeFacts {
  state?: string;
  ahj?: string;
  utility?: string;
  portalName?: string;
  portalUrl?: string;
  requiredDocuments?: string[];
  timelineDays?: number | null;
  timelineNote?: string;
  correction?: {
    bucket: CorrectionBucket;
    rootCause: string;
    requiredAction: string;
    sample: string;
  };
  sources?: KnowledgeSource[];
  notes?: string;
  confidence?: PermitUtilityKnowledgeProfile["confidence"];
}

interface KnowledgeEventInput {
  projectId?: string | null;
  eventType: string;
  details?: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function clean(value: unknown): string {
  return text(value).replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function normalize(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "unknown";
}

function profileKey(input: { state?: string; ahj?: string; utility?: string }): string {
  return [normalize(input.state), normalize(input.ahj), normalize(input.utility)].join("|");
}

export function knowledgeProfileKey(input: { state?: string; ahj?: string; utility?: string }): string {
  return profileKey(input);
}

function mergeUnique(existing: string[], incoming: string[], limit = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...existing, ...incoming].map(clean).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function sourceKey(source: KnowledgeSource): string {
  return `${source.sourceType}|${source.label}|${source.url}`.toLowerCase();
}

function mergeSources(existing: KnowledgeSource[], incoming: KnowledgeSource[]): KnowledgeSource[] {
  const map = new Map<string, KnowledgeSource>();
  for (const source of [...existing, ...incoming]) {
    if (!source.label && !source.url) continue;
    map.set(sourceKey(source), source);
  }
  return [...map.values()].slice(0, 40);
}

function confidenceFrom(existing: string, incoming?: PermitUtilityKnowledgeProfile["confidence"]): PermitUtilityKnowledgeProfile["confidence"] {
  if (existing === "mixed" || (existing === "learned" && incoming === "seeded") || (existing === "seeded" && incoming === "learned")) {
    return "mixed";
  }
  return incoming || (existing as PermitUtilityKnowledgeProfile["confidence"]) || "seeded";
}

function correctionSignature(correction: KnowledgeFacts["correction"]): string {
  if (!correction) return "";
  return normalize(`${correction.bucket} ${correction.rootCause} ${correction.requiredAction}`);
}

function redactSample(value: string): string {
  return clean(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{2,6}\s+[A-Z0-9 .'-]{3,60}\s+(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|WAY|BLVD|CIR|CIRCLE)\b(?:[, ]+[A-Z .'-]{2,40})?/gi, "[address]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]")
    .slice(0, 240);
}

export function redactEmailText(value: string): string {
  return clean(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{2,6}\s+[A-Z0-9 .'-]{3,60}\s+(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|WAY|BLVD|CIR|CIRCLE)\b(?:[, ]+[A-Z .'-]{2,40})?/gi, "[address]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]")
    .slice(0, 6000);
}

export interface ClassifiedMboxMessage {
  sourceSignature: string;
  sourceLabel: string;
  subject: string;
  from: string;
  date: string;
  rawSearchText: string;
  redactedText: string;
  record: MboxExtractedLearningRecord;
  state: string;
  portalName: string;
}

function signatureFor(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashValue(value: string): string {
  return value ? crypto.createHash("sha256").update(clean(value).toLowerCase()).digest("hex").slice(0, 24) : "";
}

function extractAddressHash(value: string): string {
  const match = value.match(/\b\d{2,6}\s+[A-Z0-9 .'-]{3,60}\s+(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|WAY|BLVD|CIR|CIRCLE)\b(?:[, ]+[A-Z .'-]{2,40})?/i);
  return match ? hashValue(match[0]) : "";
}

function parserText(project: ProjectRecord): string {
  return [
    project.homeownerName,
    project.projectAddress,
    project.ahj,
    project.utility,
    project.interconnectionMethod,
    text(project.parserSnapshot.moduleMake),
    text(project.parserSnapshot.moduleModel),
    text(project.parserSnapshot.invMake),
    text(project.parserSnapshot.invModel),
    text(project.parserSnapshot.pvMicroMake),
    text(project.parserSnapshot.pvMicroModel),
    text(project.parserSnapshot.batteryMake),
    text(project.parserSnapshot.batteryModel),
    text(project.parserSnapshot.gatewayModel),
    text(project.parserSnapshot.utilityDownloadChecklistText),
    text(project.parserSnapshot.splitPagesText),
    text(project.parserSnapshot.utilityUploadNotesText),
    text(project.parserSnapshot.projectDescriptionText),
  ].join("\n");
}

function tag(value: string): string {
  return normalize(value).replace(/\s+/g, "_");
}

export function extractProjectFeatureTags(project: ProjectRecord): string[] {
  const all = parserText(project);
  const tags = new Set<string>();
  if (project.state) tags.add(`state:${tag(project.state)}`);
  if (project.ahj) tags.add(`ahj:${tag(project.ahj)}`);
  if (project.utility) tags.add(`utility:${tag(project.utility)}`);
  const portal = portalFromProject(project);
  if (portal.portalName) tags.add(`portal:${tag(portal.portalName)}`);
  if (/pacific|pacificorp/i.test(project.utility)) tags.add("utility_family:pacific_power");
  if (/\bpge\b|portland general/i.test(project.utility)) tags.add("utility_family:pge");
  if (/powerwall|tesla/i.test(all)) tags.add("battery:powerwall");
  if (/battery|\bESS\b|backup|encharge|powerwall/i.test(all)) tags.add("scope:ess");
  if (/non.backup|rate saver|self.consumption/i.test(all)) tags.add("ess_mode:non_backup");
  if (/backup|whole.home|critical.load/i.test(all)) tags.add("ess_mode:backup");
  if (/line.side|supply.side|tap/i.test(project.interconnectionMethod + "\n" + all)) tags.add("interco:supply_side");
  if (/load.side|breaker|back.?feed/i.test(project.interconnectionMethod + "\n" + all)) tags.add("interco:load_side");
  if (/ground.mount|ground mounted/i.test(all)) tags.add("mount:ground");
  else tags.add("mount:roof");
  if (/main panel upgrade|\bMPU\b/i.test(all)) tags.add("scope:mpu");
  if (/meter collar|connectder|mmd/i.test(all)) tags.add("scope:meter_adapter");
  if (/trench|underground|811|locate/i.test(all)) tags.add("scope:locates");
  const moduleMake = text(project.parserSnapshot.moduleMake);
  const inverterMake = text(project.parserSnapshot.invMake || project.parserSnapshot.pvMicroMake);
  if (moduleMake) tags.add(`module_make:${tag(moduleMake)}`);
  if (inverterMake) tags.add(`inverter_make:${tag(inverterMake)}`);
  return [...tags].sort();
}

function mergeCorrections(existing: CommonCorrectionPattern[], incoming?: KnowledgeFacts["correction"], at = nowIso()): CommonCorrectionPattern[] {
  if (!incoming) return existing;
  const signature = correctionSignature(incoming);
  const found = existing.find((item) => item.signature === signature);
  if (found) {
    found.count += 1;
    found.lastSeenAt = at;
    found.sample = redactSample(incoming.sample || found.sample);
  } else {
    existing.push({
      signature,
      bucket: incoming.bucket,
      rootCause: incoming.rootCause,
      requiredAction: incoming.requiredAction,
      count: 1,
      lastSeenAt: at,
      sample: redactSample(incoming.sample),
    });
  }
  return existing.sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 25);
}

function mapKnowledge(row: Row): PermitUtilityKnowledgeProfile {
  return {
    id: text(row.id),
    profileKey: text(row.profile_key),
    state: text(row.state),
    ahj: text(row.ahj),
    utility: text(row.utility),
    portalName: text(row.portal_name),
    portalUrl: text(row.portal_url),
    requiredDocuments: parseJson<string[]>(text(row.required_documents_json), []),
    averageTimelineDays: row.average_timeline_days == null ? null : Number(row.average_timeline_days),
    timelineSampleCount: Number(row.timeline_sample_count ?? 0),
    timelineNotes: parseJson<string[]>(text(row.timeline_notes_json), []),
    commonCorrections: parseJson<CommonCorrectionPattern[]>(text(row.common_corrections_json), []),
    projectCount: Number(row.project_count ?? 0),
    correctionCount: Number(row.correction_count ?? 0),
    confidence: text(row.confidence) as PermitUtilityKnowledgeProfile["confidence"],
    sources: parseJson<KnowledgeSource[]>(text(row.sources_json), []),
    notes: text(row.notes),
    firstSeenAt: text(row.first_seen_at),
    lastLearnedAt: text(row.last_learned_at),
    updatedAt: text(row.updated_at),
  };
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
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
    parserSnapshot: parseJson<Record<string, unknown>>(text(row.parser_json), {}),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function upsertKnowledge(db: AppDb, facts: KnowledgeFacts, event?: KnowledgeEventInput): PermitUtilityKnowledgeProfile {
  const key = profileKey(facts);
  const ts = nowIso();
  const existing = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);

  const current = existing ? mapKnowledge(existing) : null;
  const requiredDocuments = mergeUnique(current?.requiredDocuments || [], facts.requiredDocuments || []);
  const timelineNotes = mergeUnique(current?.timelineNotes || [], facts.timelineNote ? [facts.timelineNote] : [], 60);
  const commonCorrections = mergeCorrections([...(current?.commonCorrections || [])], facts.correction, ts);
  const correctionCount = commonCorrections.reduce((sum, item) => sum + item.count, 0);
  const sources = mergeSources(current?.sources || [], facts.sources || []);
  const existingAvg = current?.averageTimelineDays ?? null;
  const existingSamples = current?.timelineSampleCount ?? 0;
  const timelineDays = facts.timelineDays != null && Number.isFinite(facts.timelineDays) && facts.timelineDays >= 0 ? facts.timelineDays : null;
  const timelineSampleCount = timelineDays == null ? existingSamples : existingSamples + 1;
  const averageTimelineDays =
    timelineDays == null ? existingAvg : existingSamples > 0 && existingAvg != null ? (existingAvg * existingSamples + timelineDays) / timelineSampleCount : timelineDays;

  if (current) {
    db.run(
      `UPDATE permit_utility_knowledge
       SET state = ?, ahj = ?, utility = ?, portal_name = ?, portal_url = ?,
           required_documents_json = ?, average_timeline_days = ?, timeline_sample_count = ?,
           timeline_notes_json = ?, common_corrections_json = ?, correction_count = ?,
           confidence = ?, sources_json = ?, notes = ?, last_learned_at = ?, updated_at = ?
       WHERE profile_key = ?`,
      [
        clean(facts.state) || current.state,
        clean(facts.ahj) || current.ahj,
        clean(facts.utility) || current.utility,
        clean(facts.portalName) || current.portalName,
        clean(facts.portalUrl) || current.portalUrl,
        asJson(requiredDocuments),
        averageTimelineDays,
        timelineSampleCount,
        asJson(timelineNotes),
        asJson(commonCorrections),
        correctionCount,
        confidenceFrom(current.confidence, facts.confidence),
        asJson(sources),
        mergeUnique([current.notes], facts.notes ? [facts.notes] : [], 8).join(" | "),
        event ? ts : current.lastLearnedAt,
        ts,
        key,
      ],
    );
  } else {
    db.run(
      `INSERT INTO permit_utility_knowledge
        (id, profile_key, state, ahj, utility, portal_name, portal_url, required_documents_json,
         average_timeline_days, timeline_sample_count, timeline_notes_json, common_corrections_json,
         project_count, correction_count, confidence, sources_json, notes, first_seen_at, last_learned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id(),
        key,
        clean(facts.state),
        clean(facts.ahj),
        clean(facts.utility),
        clean(facts.portalName),
        clean(facts.portalUrl),
        asJson(requiredDocuments),
        averageTimelineDays,
        timelineSampleCount,
        asJson(timelineNotes),
        asJson(commonCorrections),
        0,
        correctionCount,
        facts.confidence || "seeded",
        asJson(sources),
        clean(facts.notes),
        ts,
        event ? ts : "",
        ts,
      ],
    );
  }

  if (event) {
    db.run(
      `INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id(), key, event.projectId || null, event.eventType, asJson(event.details || {}), ts],
    );
    recalculateKnowledgeStats(db, key);
  }

  return mapKnowledge(db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key])!);
}

function upsertProjectFingerprint(db: AppDb, project: ProjectRecord): void {
  // Derive the key with the SAME city fallback that learnFromProject/upsertKnowledge
  // uses, so the fingerprint's profile_key always matches an existing profile.
  const key = profileKey({ state: project.state, ahj: project.ahj || project.city, utility: project.utility });
  // FK safety: the fingerprint references permit_utility_knowledge(profile_key).
  // If that profile row doesn't exist yet (e.g. fingerprint called before the
  // profile is learned), skip rather than throwing a FOREIGN KEY constraint error.
  const profileExists = db.get<{ one: number }>("SELECT 1 one FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
  if (!profileExists) return;
  const portal = portalFromProject(project);
  const ts = nowIso();
  db.run(
    `INSERT INTO historical_project_fingerprints
      (project_id, profile_key, state, ahj, utility, portal_name, feature_tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
      profile_key = excluded.profile_key,
      state = excluded.state,
      ahj = excluded.ahj,
      utility = excluded.utility,
      portal_name = excluded.portal_name,
      feature_tags_json = excluded.feature_tags_json,
      updated_at = excluded.updated_at`,
    [
      project.id,
      key,
      project.state,
      project.ahj || project.city,
      project.utility,
      portal.portalName,
      asJson(extractProjectFeatureTags(project)),
      project.createdAt || ts,
      ts,
    ],
  );
}

function insertHistoricalFailureExample(
  db: AppDb,
  input: {
    project?: ProjectRecord;
    facts: KnowledgeFacts;
    correction: NonNullable<KnowledgeFacts["correction"]>;
    sourceType: string;
    sourceLabel: string;
    occurredAt?: string;
    signatureSeed: string;
  },
): void {
  const key = profileKey(input.facts);
  const tags = input.project ? extractProjectFeatureTags(input.project) : tagsFromText(`${input.facts.utility} ${input.facts.ahj} ${input.correction.sample}`);
  const sourceSignature = signatureFor(input.signatureSeed);
  db.run(
    `INSERT OR IGNORE INTO historical_failure_examples
      (id, source_signature, profile_key, project_id, state, ahj, utility, portal_name, feature_tags_json,
       outcome, correction_bucket, root_cause, required_action, sample, source_type, source_label, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id(),
      sourceSignature,
      key,
      input.project?.id || null,
      clean(input.facts.state),
      clean(input.facts.ahj),
      clean(input.facts.utility),
      clean(input.facts.portalName),
      asJson(tags),
      "rejected_or_delayed",
      input.correction.bucket,
      input.correction.rootCause,
      input.correction.requiredAction,
      redactSample(input.correction.sample),
      input.sourceType,
      input.sourceLabel,
      input.occurredAt || nowIso(),
      nowIso(),
    ],
  );
}

function insertMboxLearningRecord(
  db: AppDb,
  input: {
    record: MboxExtractedLearningRecord;
    sourceSignature: string;
    sourceLabel: string;
    state: string;
    profileKey: string;
  },
): boolean {
  const existing = db.get<Row>("SELECT id FROM mbox_learning_records WHERE source_signature = ?", [input.sourceSignature]);
  if (existing) return false;
  db.run(
    `INSERT INTO mbox_learning_records
      (id, source_signature, source_label, bucket, workflow, profile_key, state, jurisdiction, utility, portal_name,
       project_address_hash, project_address_redacted, correction_category, correction_subcategory, required_action,
       preventable, required_documents_json, timeline_signal, status_label, classifier, confidence, sample, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id(),
      input.sourceSignature,
      input.sourceLabel,
      input.record.type,
      input.record.workflow,
      input.profileKey,
      input.state,
      input.record.jurisdiction || "",
      input.record.utility || "",
      input.record.portalName || "",
      input.record.projectAddressHash || "",
      input.record.projectAddress || "",
      input.record.correctionCategory || "",
      input.record.correctionSubcategory || "",
      input.record.requiredAction || "",
      input.record.preventable ? 1 : 0,
      asJson(input.record.requiredDocuments),
      input.record.timelineSignal || "",
      input.record.statusLabel || "",
      input.record.classifier,
      input.record.confidence,
      input.record.sample,
      input.record.occurredAt,
      nowIso(),
    ],
  );
  return true;
}

function recalculateKnowledgeStats(db: AppDb, key: string): void {
  const row = db.get<Row>(
    `SELECT COUNT(DISTINCT project_id) AS project_count
     FROM knowledge_events
     WHERE profile_key = ? AND project_id IS NOT NULL`,
    [key],
  );
  db.run("UPDATE permit_utility_knowledge SET project_count = ?, updated_at = ? WHERE profile_key = ?", [
    Number(row?.project_count ?? 0),
    nowIso(),
    key,
  ]);
}

function officialSource(label: string, url: string): KnowledgeSource {
  return { label, url, sourceType: "official", observedAt: nowIso() };
}

function learnedSource(sourceType: KnowledgeSource["sourceType"], label: string): KnowledgeSource {
  return { label, url: "", sourceType, observedAt: nowIso() };
}

function projectDocs(project: ProjectRecord): string[] {
  const docs = new Set<string>();
  const add = (value: string) => {
    if (value) docs.add(value);
  };
  const appProfile = findApplicationProfile(project);
  for (const doc of appProfile.requiredDocuments) add(doc);

  const process = findAhjProcessProfile(project);
  if (process?.requiresElectricalPermitApplication) add("Electrical permit application");
  if (process?.requiresBuildingPermitApplication) add("Building/structural permit application");
  if (process?.requiresSolarChecklist) add("Solar checklist / prescriptive worksheet");
  if (process?.requiresPlanSet) add("Complete plan set");
  if (process?.requiresUtilityApproval) add("Utility approval / interconnection evidence");
  if (process?.requiresCustomerSignature) add("Customer signature / owner authorization");
  if (process?.requiresFloodplainCheck) add("Floodplain/FEMA check evidence");

  const textBlob = [
    text(project.parserSnapshot.splitPagesText),
    text(project.parserSnapshot.utilityDownloadChecklistText),
    text(project.parserSnapshot.packetReadinessText),
  ].join("\n");
  if (/sld|single.line|3-line|three.line/i.test(textBlob)) add("Electrical one-line / SLD / 3-line");
  if (/site|plot/i.test(textBlob)) add("Site / plot plan");
  if (/fire|pathway|access/i.test(textBlob)) add("Fire access pathway plan");
  if (/roof|framing|rafter|truss/i.test(textBlob)) add("Roof framing plan or structural documentation");
  if (/rack|mount|attachment/i.test(textBlob)) add("Racking attachment detail");
  if (/module/i.test(textBlob)) add("Module specification sheet");
  if (/inverter|microinverter/i.test(textBlob)) add("Inverter / microinverter specification sheet");
  if (/label|placard/i.test(textBlob)) add("PV label / placard schedule");
  if (/utility bill|account|meter/i.test(textBlob)) add("Utility bill / account / meter evidence");

  if (/PGE|PORTLAND GENERAL/i.test(project.utility)) {
    add("PowerClerk interconnection application");
    add("PGE SLD/site/spec upload package");
    add("Utility account and meter verification");
  }
  if (/PACIFIC|PACIFICORP/i.test(project.utility)) {
    add("Pacific Power customer generation application");
    add("Meter photo");
    add("UL 1741 SB / inverter settings evidence");
    add("Inspection and safety sign upload after install");
  }

  return [...docs];
}

function portalFromProject(project: ProjectRecord): { portalName: string; portalUrl: string } {
  const appProfile = findApplicationProfile(project);
  const process = findAhjProcessProfile(project);
  let portalName = process?.submissionMethod || appProfile.portalName || "";
  let portalUrl = appProfile.sourceUrl || "";
  if (/PGE|PORTLAND GENERAL/i.test(project.utility)) {
    portalName = portalName || "PowerClerk";
    portalUrl = "https://portlandgeneral.com/resources-for-solar-installers/interconnection-resource-library";
  }
  if (/PACIFIC|PACIFICORP/i.test(project.utility)) {
    portalName = "PowerClerk";
    portalUrl = "https://www.pacificpower.net/savings-energy-choices/customer-generation.html";
  }
  return { portalName, portalUrl };
}

export function learnFromProject(db: AppDb, project: ProjectRecord, eventType = "project.saved"): PermitUtilityKnowledgeProfile {
  const portal = portalFromProject(project);
  const profile = upsertKnowledge(
    db,
    {
      state: project.state,
      ahj: project.ahj || project.city,
      utility: project.utility,
      portalName: portal.portalName,
      portalUrl: portal.portalUrl,
      requiredDocuments: projectDocs(project),
      sources: [learnedSource("learned_project", "Saved project parser snapshot")],
      confidence: "learned",
      notes: "Learned from project parser payload and generated application profile.",
    },
    { projectId: project.id, eventType, details: { status: project.status } },
  );
  upsertProjectFingerprint(db, project);
  return profile;
}

export function learnFromPermitTarget(
  db: AppDb,
  project: ProjectRecord,
  input: { jurisdiction?: string; portalName?: string; portalUrl?: string; applicationNumber?: string; permitNumber?: string },
  eventType = "permit_target.created",
): PermitUtilityKnowledgeProfile {
  return upsertKnowledge(
    db,
    {
      state: project.state,
      ahj: input.jurisdiction || project.ahj || project.city,
      utility: project.utility,
      portalName: input.portalName,
      portalUrl: input.portalUrl,
      requiredDocuments: projectDocs(project),
      sources: [learnedSource("learned_project", "Permit target configured")],
      confidence: "learned",
      notes: "Portal and tracking target learned from dashboard permit monitor setup.",
    },
    {
      projectId: project.id,
      eventType,
      details: {
        jurisdiction: input.jurisdiction || "",
        portalName: input.portalName || "",
        hasApplicationNumber: Boolean(input.applicationNumber),
        hasPermitNumber: Boolean(input.permitNumber),
      },
    },
  );
}

export function learnFromCorrection(
  db: AppDb,
  project: ProjectRecord,
  classification: CorrectionClassification,
  correctionText: string,
  source: string,
  eventType = "correction.learned",
): PermitUtilityKnowledgeProfile {
  const portal = portalFromProject(project);
  const facts: KnowledgeFacts = {
    state: project.state,
    ahj: project.ahj || project.city,
    utility: project.utility,
    portalName: portal.portalName,
    portalUrl: portal.portalUrl,
    requiredDocuments: docsFromCorrection(correctionText),
    correction: {
      bucket: classification.bucket,
      rootCause: classification.rootCause,
      requiredAction: classification.requiredAction,
      sample: correctionText,
    },
    sources: [learnedSource("learned_correction", `Correction intake: ${source}`)],
    confidence: "learned",
    notes: "Common correction pattern learned from correction intake.",
  };
  const profile = upsertKnowledge(
    db,
    facts,
    {
      projectId: project.id,
      eventType,
      details: {
        source,
        bucket: classification.bucket,
        rootCause: classification.rootCause,
        newRuleRecommended: classification.newRuleRecommended,
      },
    },
  );
  insertHistoricalFailureExample(db, {
    project,
    facts,
    correction: facts.correction!,
    sourceType: source,
    sourceLabel: "dashboard correction intake",
    occurredAt: nowIso(),
    signatureSeed: `${project.id}|${eventType}|${source}|${correctionText}`,
  });
  return profile;
}

function docsFromCorrection(correctionText: string): string[] {
  const docs: string[] = [];
  const text = correctionText.toLowerCase();
  if (/site|plot/.test(text)) docs.push("Site / plot plan");
  if (/fire|pathway|setback/.test(text)) docs.push("Fire access pathway plan");
  if (/rafter|truss|framing|span|structural/.test(text)) docs.push("Roof framing plan or structural documentation");
  if (/engineer|stamp|calculation|calc/.test(text)) docs.push("Stamped engineering calculations / structural letter");
  if (/single line|sld|3-line|one-line|electrical/.test(text)) docs.push("Electrical one-line / SLD / 3-line");
  if (/module/.test(text)) docs.push("Module specification sheet");
  if (/inverter|1741|settings/.test(text)) docs.push("Inverter / microinverter specification sheet");
  if (/label|placard/.test(text)) docs.push("PV label / placard schedule");
  if (/application|signature|owner authorization/.test(text)) docs.push("Signed application / owner authorization");
  return docs;
}

function tagsFromText(value: string): string[] {
  const tags = new Set<string>();
  if (/pacific|pacificorp/i.test(value)) tags.add("utility_family:pacific_power");
  if (/\bpge\b|portland general/i.test(value)) tags.add("utility_family:pge");
  if (/powerwall|tesla/i.test(value)) tags.add("battery:powerwall");
  if (/battery|\bESS\b|backup|encharge|powerwall/i.test(value)) tags.add("scope:ess");
  if (/line.side|supply.side|tap/i.test(value)) tags.add("interco:supply_side");
  if (/load.side|breaker|back.?feed/i.test(value)) tags.add("interco:load_side");
  if (/meter photo|meter picture/i.test(value)) tags.add("evidence:meter_photo");
  if (/one.line|single line|sld|3.line/i.test(value)) tags.add("evidence:sld");
  if (/account/i.test(value)) tags.add("evidence:account");
  return [...tags].sort();
}

function inferUtility(value: string): string {
  if (/pacific power|pacificorp/i.test(value)) return "Pacific Power";
  if (/\bpge\b|portland general/i.test(value)) return "PGE";
  if (/\bsrp\b|salt river project/i.test(value)) return "SRP";
  if (/\baps\b|arizona public service/i.test(value)) return "APS";
  if (/unisource/i.test(value)) return "UniSource";
  if (/nv energy/i.test(value)) return "NV Energy";
  if (/duke energy/i.test(value)) return "Duke Energy";
  if (/florida power|fpl/i.test(value)) return "FPL";
  if (/idaho power/i.test(value)) return "Idaho Power";
  if (/rocky mountain power/i.test(value)) return "Rocky Mountain Power";
  if (/pseg|public service electric/i.test(value)) return "PSE&G";
  return "";
}

function inferAhj(value: string): string {
  const stopWords =
    /\b(?:permit|permitting|building|electrical|solar|pv|application|app|plan|plans|review|correction|comments?|fees?|invoice|payment|missing|required|revision|narrative|approved|approval|issued|status|inspection|final|nem|interconnection|utility|pto|resubmit|upload|submit)\b.*$/i;
  const explicitMunicipality = value.match(/\b(city|town|village|borough) of ([A-Z][A-Za-z .'-]{2,50})/i);
  if (explicitMunicipality) {
    const name = clean(explicitMunicipality[2]).replace(stopWords, "").replace(/[,:;.-]+$/, "").trim();
    if (name) return `${titleCase(explicitMunicipality[1])} of ${titleCase(name)}`;
  }
  const explicitCountyOf = value.match(/\bcounty of ([A-Z][A-Za-z .'-]{2,50})/i);
  if (explicitCountyOf) {
    const name = clean(explicitCountyOf[1]).replace(stopWords, "").replace(/[,:;.-]+$/, "").trim();
    if (name) return `County of ${titleCase(name)}`;
  }
  const explicitCounty = value.match(/\b([A-Z][A-Za-z .'-]{2,50}?) county\b/i);
  if (explicitCounty) {
    const name = clean(explicitCounty[1]).replace(stopWords, "").replace(/[,:;.-]+$/, "").trim();
    if (name) return `${titleCase(name)} County`;
  }
  const match = value.match(/\b(?:city of|county of)?\s*(portland|clackamas county|washington county|hillsboro|salem|oregon city)\b/i);
  if (!match) return "";
  const raw = match[1].toLowerCase();
  if (raw === "portland") return "City of Portland";
  return titleCase(raw);
}

function inferPortal(value: string): string {
  if (/powerclerk/i.test(value)) return "PowerClerk";
  if (/devhub/i.test(value)) return "DevHub";
  if (/projectdox/i.test(value)) return "ProjectDox";
  if (/energov/i.test(value)) return "EnerGov";
  if (/aca|accela/i.test(value)) return "Accela";
  if (/mygov/i.test(value)) return "MyGov";
  if (/epermitting|e-permitting|accela/i.test(value)) return "Oregon ePermitting";
  if (/development direct/i.test(value)) return "Development Direct";
  return "";
}

function inferState(value: string, ahj: string, utility: string): string {
  const stateMatch = value.match(/\b(AK|AL|AR|AZ|CA|CO|FL|GA|ID|IL|MA|MD|MI|MN|MO|NC|NJ|NM|NV|NY|OH|OR|PA|SC|TN|TX|UT|VA|WA|WI)\b/);
  if (stateMatch) return stateMatch[1].toUpperCase();
  if (/portland|clackamas|washington county|hillsboro|salem|oregon/i.test(`${ahj}\n${value}`)) return "OR";
  if (/pacific power|pacificorp|pge|portland general/i.test(utility)) return "OR";
  if (/srp|aps|unisource|maricopa|pinal|phoenix|tucson/i.test(`${utility}\n${ahj}\n${value}`)) return "AZ";
  if (/fpl|duke energy|miami|tampa|orange county|broward/i.test(`${utility}\n${ahj}\n${value}`)) return "FL";
  return "";
}

function hasAnyText(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function classifyMboxBucket(value: string): { bucket: MboxEmailBucket; workflow: MboxExtractedLearningRecord["workflow"]; confidence: number } {
  const lower = value.toLowerCase();
  const nem = /\b(nem|net meter|net-meter|interconnection|powerclerk|pto|permission to operate|customer generation|utility application|export|meter photo|inverter settings)\b/i.test(value);
  const permit = /\b(permit|building|electrical|inspection|inspector|plans examiner|ahj|jurisdiction|devhub|projectdox|epermitting|accela|energov)\b/i.test(value);
  const correction = /\b(correction|required correction|deficien|rejected|revise|resubmit|review comments|not approved|failed review|plan check comments)\b/i.test(value);
  const approval = /\b(approved|approval|accepted|issued|ready to issue|ready for issue|permit issued|interconnection approved|application approved|pto granted|permission to operate)\b/i.test(value);
  const missingInfo = /\b(missing|incomplete|provide|please upload|please submit|required documents?|additional information|more information|cannot process|hold)\b/i.test(value);
  const fee = /\b(fee|fees|invoice|payment due|balance due|pay online|payment required|permit fee)\b/i.test(value);
  const inspection = /\b(inspection|final inspection|inspection scheduled|inspection result|certificate of completion|coc|final notice|passed final)\b/i.test(value);
  const status = /\b(received|submitted|under review|in review|processing|routed|assigned|queued|pending review|status update)\b/i.test(value);
  const solarSignal = /\b(solar|photovoltaic|\bpv\b|battery|powerwall|ess|permit|inspection|interconnection|nem|net meter|customer generation|powerclerk)\b/i.test(value);

  const workflow: MboxExtractedLearningRecord["workflow"] = nem && permit ? "both" : nem ? "nem" : permit ? "permit" : "unknown";
  if (!solarSignal) return { bucket: "spam_irrelevant", workflow, confidence: 0.96 };
  if (fee) return { bucket: "fee_request", workflow: workflow === "unknown" ? "permit" : workflow, confidence: 0.9 };
  if (inspection) return { bucket: "inspection_final_notice", workflow: "permit", confidence: 0.88 };
  if (correction && nem) return { bucket: "nem_correction", workflow: workflow === "permit" ? "both" : "nem", confidence: 0.9 };
  if (correction && permit) return { bucket: "permit_correction", workflow: workflow === "nem" ? "both" : "permit", confidence: 0.9 };
  if (missingInfo && nem) return { bucket: "nem_correction", workflow: workflow === "permit" ? "both" : "nem", confidence: 0.82 };
  if (missingInfo && permit) return { bucket: "missing_info_request", workflow: workflow === "nem" ? "both" : "permit", confidence: 0.82 };
  if (approval && nem) return { bucket: "nem_approval", workflow: workflow === "permit" ? "both" : "nem", confidence: 0.88 };
  if (approval && permit) return { bucket: "permit_approval", workflow: workflow === "nem" ? "both" : "permit", confidence: 0.88 };
  if (status) return { bucket: "status_update", workflow, confidence: 0.74 };
  if (lower.trim()) return { bucket: "spam_irrelevant", workflow, confidence: 0.75 };
  return { bucket: "spam_irrelevant", workflow: "unknown", confidence: 0.99 };
}

function correctionTaxonomy(value: string, bucket: MboxEmailBucket): { category: string | null; subcategory: string | null; requiredAction: string | null; docs: string[] } {
  const docs = docsFromCorrection(value);
  const docAction = (category: string, subcategory: string, action: string, doc?: string) => ({
    category,
    subcategory,
    requiredAction: action,
    docs: doc ? mergeUnique(docs, [doc]) : docs,
  });
  if (bucket === "fee_request") return docAction("Fees", "Payment", "Pay required fee or capture fee due before issuance.");
  if (bucket === "inspection_final_notice") return docAction("Inspection", "Final notice", "Record inspection/final status and update project stage.");
  if (/revision narrative|rev narrative/i.test(value)) return docAction("Documentation", "Revision Narrative", "Upload revision narrative.", "Revision narrative");
  if (/owner authorization|authorization|signature|signed/i.test(value)) return docAction("Documentation", "Owner Authorization", "Upload signed owner authorization/application.", "Signed application / owner authorization");
  if (/meter photo|meter picture/i.test(value)) return docAction("Utility/NEM", "Meter Photo", "Upload legible meter photo that matches parsed meter number.", "Meter photo");
  if (/utility bill|account holder|account verification|account number/i.test(value)) return docAction("Utility/NEM", "Account Verification", "Upload/verify utility bill account holder, account number, and service address.", "Utility bill / account / meter evidence");
  if (/1741|inverter settings|smart inverter|ieee 1547/i.test(value)) return docAction("Utility/NEM", "Inverter Settings", "Upload inverter settings / UL 1741 SB evidence.", "UL 1741 SB / inverter settings evidence");
  if (/single line|one.line|one-line|sld|3-line|three.line/i.test(value)) return docAction("Electrical", "One-Line / SLD", "Revise/upload one-line or SLD.", "Electrical one-line / SLD / 3-line");
  if (/site plan|plot plan|roof plan/i.test(value)) return docAction("Documentation", "Site/Roof Plan", "Revise/upload site or roof plan.", "Site / plot plan");
  if (/fire|pathway|setback/i.test(value)) return docAction("Design", "Fire Pathway", "Add fire pathway/setback evidence to plan set.", "Fire access pathway plan");
  if (/rafter|truss|framing|structural|engineer|stamp/i.test(value)) return docAction("Structural", "Framing/Engineering", "Provide structural/framing evidence or stamped engineering.", "Roof framing plan or structural documentation");
  if (/label|placard/i.test(value)) return docAction("Electrical", "Labels/Placards", "Upload label/placard schedule.", "PV label / placard schedule");
  if (/application|form/i.test(value)) return docAction("Documentation", "Application Form", "Complete and upload required application form.", "Required application form");
  if (bucket === "permit_correction" || bucket === "nem_correction" || bucket === "missing_info_request") {
    return docAction("Documentation", "General Missing/Correction", "Review email, add missing document/data, and update pre-submission QC rule.");
  }
  return { category: null, subcategory: null, requiredAction: null, docs };
}

function statusLabelForBucket(bucket: MboxEmailBucket): string {
  const map: Record<MboxEmailBucket, string> = {
    permit_approval: "Permit approved/issued",
    permit_correction: "Permit correction",
    nem_approval: "NEM/interconnection approved",
    nem_correction: "NEM/interconnection correction",
    status_update: "Status update",
    missing_info_request: "Missing information request",
    fee_request: "Fee request",
    inspection_final_notice: "Inspection/final notice",
    spam_irrelevant: "Irrelevant",
  };
  return map[bucket];
}

function timelineSignalForBucket(bucket: MboxEmailBucket): string | null {
  if (bucket === "permit_approval") return "permit_approved";
  if (bucket === "nem_approval") return "nem_approved";
  if (bucket === "permit_correction" || bucket === "nem_correction" || bucket === "missing_info_request") return "correction_or_missing_info";
  if (bucket === "fee_request") return "fee_due";
  if (bucket === "inspection_final_notice") return "inspection_or_final";
  if (bucket === "status_update") return "review_status";
  return null;
}

function isPreventableBucket(bucket: MboxEmailBucket): boolean {
  return bucket === "permit_correction" || bucket === "nem_correction" || bucket === "missing_info_request" || bucket === "fee_request";
}

function splitMboxMessages(mboxText: string): string[] {
  const normalized = mboxText.replace(/\r\n/g, "\n");
  return normalized
    .split(/\n(?=From [^\n]+\n)/g)
    .map((message) => message.trim())
    .filter(Boolean);
}

function parseMessage(message: string): { headers: Record<string, string>; body: string } {
  const cleaned = message.replace(/^From [^\n]+\n/, "");
  const [rawHeaders, ...bodyParts] = cleaned.split(/\n\n/);
  const headers: Record<string, string> = {};
  let current = "";
  for (const line of rawHeaders.split("\n")) {
    if (/^\s/.test(line) && current) {
      headers[current] = `${headers[current]} ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(":");
    if (index > 0) {
      current = line.slice(0, index).toLowerCase();
      headers[current] = line.slice(index + 1).trim();
    }
  }
  return { headers, body: bodyParts.join("\n\n").replace(/--[a-z0-9_=-]+/gi, "\n") };
}

function safeDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso();
}

function buildMboxLearningRecord(input: {
  combined: string;
  subject: string;
  from: string;
  date: string;
  defaults: { state?: string; ahj?: string; utility?: string };
}): { record: MboxExtractedLearningRecord; state: string; portalName: string } {
  const bucket = classifyMboxBucket(input.combined);
  const utility = input.defaults.utility || inferUtility(input.combined);
  const jurisdiction = input.defaults.ahj || inferAhj(input.combined);
  const portalName = inferPortal(input.combined);
  const state = input.defaults.state || inferState(input.combined, jurisdiction, utility);
  const taxonomy = correctionTaxonomy(input.combined, bucket.bucket);
  const sample = redactSample(`${input.subject}\n${input.from}\n${input.combined}`);
  const record: MboxExtractedLearningRecord = {
    source: "email",
    type: bucket.bucket,
    workflow: bucket.workflow,
    jurisdiction: jurisdiction || null,
    utility: utility || null,
    projectAddress: extractAddressHash(input.combined) ? "REDACTED" : null,
    projectAddressHash: extractAddressHash(input.combined) || null,
    portalName: portalName || null,
    correctionCategory: taxonomy.category,
    correctionSubcategory: taxonomy.subcategory,
    requiredAction: taxonomy.requiredAction,
    preventable: isPreventableBucket(bucket.bucket),
    requiredDocuments: taxonomy.docs,
    timelineSignal: timelineSignalForBucket(bucket.bucket),
    statusLabel: statusLabelForBucket(bucket.bucket),
    classifier: "deterministic",
    confidence: bucket.confidence,
    sample,
    occurredAt: safeDate(input.date),
  };
  return { record, state, portalName };
}

function shouldCreateFailureExample(record: MboxExtractedLearningRecord): boolean {
  return record.type === "permit_correction" || record.type === "nem_correction" || record.type === "missing_info_request";
}

function correctionForMboxRecord(record: MboxExtractedLearningRecord): NonNullable<KnowledgeFacts["correction"]> {
  const classification = classifyCorrection(`${record.requiredAction || ""}\n${record.sample}`);
  return {
    bucket: classification.bucket,
    rootCause: [record.correctionCategory, record.correctionSubcategory].filter(Boolean).join(" / ") || classification.rootCause,
    requiredAction: record.requiredAction || classification.requiredAction,
    sample: record.sample,
  };
}

function mergeLlmRecord(base: MboxExtractedLearningRecord, llm: Partial<MboxExtractedLearningRecord> | null): MboxExtractedLearningRecord {
  if (!llm) return base;
  return {
    ...base,
    type: (llm.type as MboxEmailBucket) || base.type,
    workflow: llm.workflow || base.workflow,
    jurisdiction: llm.jurisdiction || base.jurisdiction,
    utility: llm.utility || base.utility,
    portalName: llm.portalName || base.portalName,
    correctionCategory: llm.correctionCategory || base.correctionCategory,
    correctionSubcategory: llm.correctionSubcategory || base.correctionSubcategory,
    requiredAction: llm.requiredAction || base.requiredAction,
    preventable: typeof llm.preventable === "boolean" ? llm.preventable : base.preventable,
    requiredDocuments: Array.isArray(llm.requiredDocuments) && llm.requiredDocuments.length ? mergeUnique(base.requiredDocuments, llm.requiredDocuments, 30) : base.requiredDocuments,
    timelineSignal: llm.timelineSignal || base.timelineSignal,
    statusLabel: llm.statusLabel || base.statusLabel,
    classifier: "llm",
    confidence: typeof llm.confidence === "number" ? Math.max(base.confidence, Math.min(1, llm.confidence)) : base.confidence,
  };
}

export async function classifyMboxMessages(input: {
  mboxText: string;
  sourceLabel?: string;
  defaultState?: string;
  defaultAhj?: string;
  defaultUtility?: string;
}): Promise<{ messages: ClassifiedMboxMessage[]; llmReviewRecommended: number }> {
  const sourceLabel = input.sourceLabel || "Imported MBOX";
  const messages: ClassifiedMboxMessage[] = [];
  let llmReviewRecommended = 0;

  for (const raw of splitMboxMessages(input.mboxText).slice(0, 10000)) {
    const parsed = parseMessage(raw);
    const subject = parsed.headers.subject || "";
    const from = parsed.headers.from || "";
    const date = parsed.headers.date || "";
    const body = parsed.body.slice(0, 12000);
    const combined = `${subject}\n${from}\n${body}`;
    const sourceSignature = signatureFor(`${sourceLabel}|${subject}|${date}|${redactSample(body).slice(0, 180)}`);
    const built = buildMboxLearningRecord({
      combined,
      subject,
      from,
      date,
      defaults: { state: input.defaultState, ahj: input.defaultAhj, utility: input.defaultUtility },
    });
    let record = built.record;
    if (record.confidence < 0.72 || record.type === "spam_irrelevant") {
      const llm = await enrichMboxLearningWithLlm({
        redactedEmailText: redactEmailText(combined),
        deterministicRecord: record,
      });
      if (llm) record = mergeLlmRecord(record, llm);
      else if (record.type !== "spam_irrelevant") llmReviewRecommended += 1;
    }
    messages.push({
      sourceSignature,
      sourceLabel,
      subject,
      from,
      date,
      rawSearchText: combined,
      redactedText: redactEmailText(combined),
      record,
      state: built.state,
      portalName: built.portalName,
    });
  }

  return { messages, llmReviewRecommended };
}

// Stream messages out of a (potentially multi-GB) mbox file without ever
// holding the whole file — or even a >512MB slice — in a single JS string.
// readline yields one line at a time; we accumulate a message and flush it
// when the next mbox "From " separator line appears.
async function* streamMboxMessagesFromFile(filePath: string, maxMessages: number): AsyncGenerator<string> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let current: string[] = [];
  let count = 0;
  for await (const line of rl) {
    if (/^From .+/.test(line) && current.length) {
      const msg = current.join("\n").trim();
      current = [];
      if (msg) {
        yield msg;
        if (++count >= maxMessages) {
          rl.close();
          return;
        }
      }
    }
    current.push(line);
  }
  if (current.length && count < maxMessages) {
    const msg = current.join("\n").trim();
    if (msg) yield msg;
  }
}

async function* messagesFromArray(messages: string[]): AsyncGenerator<string> {
  for (const message of messages) yield message;
}

const MBOX_MESSAGE_CAP = 10000;

// Shared importer: consumes a stream of raw mbox message blocks and learns from
// each. Both the in-memory (string) and streaming (file path) entry points use
// this so behavior stays identical regardless of how the messages were read.
async function runMboxImport(
  db: AppDb,
  rawMessages: AsyncIterable<string>,
  input: { sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  const touched = new Set<string>();
  const extractedRecords: MboxExtractedLearningRecord[] = [];
  const bucketCounts = {
    permit_approval: 0,
    permit_correction: 0,
    nem_approval: 0,
    nem_correction: 0,
    status_update: 0,
    missing_info_request: 0,
    fee_request: 0,
    inspection_final_notice: 0,
    spam_irrelevant: 0,
  } satisfies Record<MboxEmailBucket, number>;
  let messagesScanned = 0;
  let learningEvents = 0;
  let failuresImported = 0;
  let skippedMessages = 0;
  let duplicateMessages = 0;
  let llmReviewRecommended = 0;
  const sourceLabel = input.sourceLabel || "Imported MBOX";

  for await (const raw of rawMessages) {
    messagesScanned += 1;
    const parsed = parseMessage(raw);
    const subject = parsed.headers.subject || "";
    const from = parsed.headers.from || "";
    const date = parsed.headers.date || "";
    const body = parsed.body.slice(0, 12000);
    const combined = `${subject}\n${from}\n${body}`;
    const sourceSignature = signatureFor(`${sourceLabel}|${subject}|${date}|${redactSample(body).slice(0, 180)}`);
    if (db.get<Row>("SELECT id FROM mbox_learning_records WHERE source_signature = ?", [sourceSignature])) {
      duplicateMessages += 1;
      continue;
    }

    const built = buildMboxLearningRecord({
      combined,
      subject,
      from,
      date,
      defaults: { state: input.defaultState, ahj: input.defaultAhj, utility: input.defaultUtility },
    });
    let record = built.record;
    if (record.confidence < 0.72 || record.type === "spam_irrelevant") {
      const llm = await enrichMboxLearningWithLlm({
        redactedEmailText: redactEmailText(combined),
        deterministicRecord: record,
      });
      if (llm) record = mergeLlmRecord(record, llm);
      else if (record.type !== "spam_irrelevant") llmReviewRecommended += 1;
    }
    bucketCounts[record.type] += 1;

    if (record.type === "spam_irrelevant") {
      skippedMessages += 1;
      extractedRecords.push(record);
      continue;
    }

    const utility = record.utility || "";
    const ahj = record.jurisdiction || "";
    const state = built.state || inferState(combined, ahj, utility);
    const correction = shouldCreateFailureExample(record) ? correctionForMboxRecord(record) : undefined;
    const facts: KnowledgeFacts = {
      state,
      ahj,
      utility,
      portalName: record.portalName || built.portalName,
      requiredDocuments: record.requiredDocuments,
      timelineNote: record.timelineSignal ? `${record.statusLabel}: ${record.timelineSignal}` : undefined,
      correction,
      sources: [learnedSource(shouldCreateFailureExample(record) ? "learned_correction" : "learned_permit_status", sourceLabel)],
      confidence: "learned",
      notes: "Imported from MBOX permitting/NEM message. Raw email was not stored; extracted record is redacted.",
    };
    const profile = upsertKnowledge(db, facts, {
      projectId: null,
      eventType: "mbox.learned",
      details: {
        bucket: record.type,
        workflow: record.workflow,
        subject: redactSample(subject),
        fromDomain: (from.match(/@([^>\s]+)/)?.[1] || "").toLowerCase(),
        hasDate: Boolean(date),
        correctionCategory: record.correctionCategory,
        correctionSubcategory: record.correctionSubcategory,
        preventable: record.preventable,
        classifier: record.classifier,
      },
    });
    touched.add(profile.profileKey);
    const inserted = insertMboxLearningRecord(db, {
      record,
      sourceSignature,
      sourceLabel,
      state,
      profileKey: profile.profileKey,
    });
    if (!inserted) {
      duplicateMessages += 1;
      continue;
    }
    extractedRecords.push(record);
    learningEvents += 1;

    if (facts.correction) {
      insertHistoricalFailureExample(db, {
        facts,
        correction: facts.correction,
        sourceType: "mbox",
        sourceLabel,
        occurredAt: record.occurredAt,
        signatureSeed: sourceSignature,
      });
      failuresImported += 1;
    }
  }

  return {
    messagesScanned,
    learningEvents,
    failureExamplesImported: failuresImported,
    profilesTouched: touched.size,
    skippedMessages,
    duplicateMessages,
    llmReviewRecommended,
    bucketCounts,
    extractedRecords: extractedRecords.slice(0, 100),
  };
}

export async function importMboxKnowledge(
  db: AppDb,
  input: { mboxText: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  const messages = splitMboxMessages(input.mboxText).slice(0, MBOX_MESSAGE_CAP);
  return runMboxImport(db, messagesFromArray(messages), input);
}

// Streaming variant for large local files — never loads the whole mbox into a
// string, so multi-GB Gmail/Outlook exports import without blowing the heap or
// Node's ~512MB max-string limit.
export async function importMboxKnowledgeFromFile(
  db: AppDb,
  input: { filePath: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  return runMboxImport(db, streamMboxMessagesFromFile(input.filePath, MBOX_MESSAGE_CAP), input);
}

export function learnFromPermitStatus(
  db: AppDb,
  project: ProjectRecord,
  statusCheck: PermitStatusCheck,
  target?: { jurisdiction?: string; portalName?: string; portalUrl?: string; createdAt?: string | null } | null,
  eventType = "permit_status.learned",
): PermitUtilityKnowledgeProfile {
  const timelineDays = timelineDaysForStatus(db, project.id, target?.createdAt || project.createdAt, statusCheck);
  const timelineNote =
    timelineDays == null
      ? `${statusCheck.outcome}: ${statusCheck.statusLabel}`
      : `${statusCheck.outcome}: ${statusCheck.statusLabel} after ${timelineDays.toFixed(1)} day(s)`;
  return upsertKnowledge(
    db,
    {
      state: project.state,
      ahj: target?.jurisdiction || project.ahj || project.city,
      utility: project.utility,
      portalName: target?.portalName,
      portalUrl: target?.portalUrl,
      requiredDocuments: projectDocs(project),
      timelineDays,
      timelineNote,
      sources: [learnedSource("learned_permit_status", "Permit monitor status check")],
      confidence: "learned",
      notes: "Timeline learned from permit/utility monitor status checks.",
    },
    {
      projectId: project.id,
      eventType,
      details: {
        outcome: statusCheck.outcome,
        statusLabel: statusCheck.statusLabel,
        confidence: statusCheck.confidence,
        reviewedByAhj: statusCheck.reviewedByAhj,
        readyForIssue: statusCheck.readyForIssue,
      },
    },
  );
}

function timelineDaysForStatus(db: AppDb, projectId: string, fallbackStart: string, statusCheck: PermitStatusCheck): number | null {
  if (!statusCheck.reviewedByAhj && statusCheck.outcome !== "correction_flagged" && !statusCheck.readyForIssue) return null;
  const submission = db.get<Row>(
    "SELECT submitted_at, created_at FROM submissions WHERE project_id = ? ORDER BY COALESCE(submitted_at, created_at) ASC LIMIT 1",
    [projectId],
  );
  const start = text(submission?.submitted_at) || text(submission?.created_at) || fallbackStart;
  const startMs = Date.parse(start);
  const endMs = Date.parse(statusCheck.createdAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round(((endMs - startMs) / 86400000) * 10) / 10;
}

export function learnFromSubmissionConfirmation(
  db: AppDb,
  project: ProjectRecord,
  input: { applicationNumber?: string; permitNumber?: string; confirmationNumber?: string },
  eventType = "submission.confirmed",
): PermitUtilityKnowledgeProfile {
  const portal = portalFromProject(project);
  return upsertKnowledge(
    db,
    {
      state: project.state,
      ahj: project.ahj || project.city,
      utility: project.utility,
      portalName: portal.portalName,
      portalUrl: portal.portalUrl,
      requiredDocuments: projectDocs(project),
      sources: [learnedSource("learned_project", "Submission confirmation captured")],
      confidence: "learned",
      notes: "Legal submit confirmation captured manually; future status checks can use this as timeline start.",
    },
    {
      projectId: project.id,
      eventType,
      details: {
        hasApplicationNumber: Boolean(input.applicationNumber),
        hasPermitNumber: Boolean(input.permitNumber),
        hasConfirmationNumber: Boolean(input.confirmationNumber),
      },
    },
  );
}

// Learn from a historical document WITHOUT creating a project. Used by the
// batch past-project scanner: it feeds AHJ/utility requirements, required-document
// lists, and correction patterns into the knowledge base so future live projects
// benefit, but never persists a project row or any PII.
export interface HistoricalDocFacts {
  state?: string;
  ahj?: string;
  utility?: string;
  portalName?: string;
  requiredDocuments?: string[];
  notes?: string;
  sourceLabel: string;
  correctionText?: string;
}

export function learnFromHistoricalDocument(
  db: AppDb,
  input: HistoricalDocFacts,
): { profileKey: string; learnedCorrection: boolean } {
  const classification = input.correctionText ? classifyCorrection(input.correctionText) : null;
  const facts: KnowledgeFacts = {
    state: input.state,
    ahj: input.ahj,
    utility: input.utility,
    portalName: input.portalName,
    requiredDocuments: input.requiredDocuments,
    correction:
      classification && input.correctionText
        ? {
            bucket: classification.bucket,
            rootCause: classification.rootCause,
            requiredAction: classification.requiredAction,
            sample: input.correctionText,
          }
        : undefined,
    sources: [learnedSource("learned_batch_import", input.sourceLabel)],
    confidence: "learned",
    notes: input.notes || "Learned from historical past-project document (batch scan).",
  };
  const profile = upsertKnowledge(db, facts, {
    eventType: "batch_import.document_learned",
    details: { sourceLabel: input.sourceLabel, hasCorrection: Boolean(classification) },
  });
  if (classification && facts.correction) {
    insertHistoricalFailureExample(db, {
      facts,
      correction: facts.correction,
      sourceType: "batch_import",
      sourceLabel: input.sourceLabel,
      occurredAt: nowIso(),
      signatureSeed: `batch|${input.sourceLabel}|${input.correctionText}`,
    });
  }
  return { profileKey: profile.profileKey, learnedCorrection: Boolean(classification) };
}

// Save an AI-researched AHJ profile to the knowledge base so the jurisdiction is
// known next time. Marked confidence "seeded" + source "ai_researched" + a
// human-verification note, because model-researched requirements are advisory
// until a real submittal confirms them.
export function saveResearchedAhjProfile(
  db: AppDb,
  input: { state: string; ahj: string; utility?: string },
  research: AhjResearchResult,
): PermitUtilityKnowledgeProfile {
  const noteParts = [
    "AI-researched AHJ profile — verify against the official site before relying on it.",
    research.portalPlatform ? `Portal platform: ${research.portalPlatform} (reuse existing ${research.portalPlatform} portal automation; only the entry URL + login differ per AHJ).` : "",
    research.submissionMethod ? `Submission: ${research.submissionMethod}.` : "",
    research.submissionSteps.length ? `Steps: ${research.submissionSteps.join(" → ")}` : "",
    research.tips.length ? `Tips: ${research.tips.join(" | ")}` : "",
  ].filter(Boolean);
  const facts: KnowledgeFacts = {
    state: input.state,
    ahj: input.ahj,
    utility: input.utility,
    portalName: research.portalName,
    portalUrl: research.portalUrl,
    requiredDocuments: research.requiredDocuments,
    sources: [learnedSource("ai_researched", "AI AHJ research")],
    confidence: "seeded",
    notes: noteParts.join(" "),
  };
  return upsertKnowledge(db, facts, {
    eventType: "ahj.ai_researched",
    details: { ahj: input.ahj, state: input.state, utility: input.utility || "", confidence: research.confidence, docCount: research.requiredDocuments.length },
  });
}

export function listKnowledgeProfiles(db: AppDb): PermitUtilityKnowledgeProfile[] {
  return db
    .query<Row>(
      `SELECT * FROM permit_utility_knowledge
       ORDER BY project_count DESC, correction_count DESC, state ASC, ahj ASC, utility ASC`,
    )
    .map(mapKnowledge);
}

// Find the best-matching LEARNED profile for a project's jurisdiction, so the
// application-doc builder can use the AHJ's real learned requirements instead of
// a generic fallback. Tries most-specific key first (state+ahj+utility) down to
// ahj-only, and only returns a profile that actually carries required documents.
export function findLearnedProfileForProject(
  db: AppDb,
  input: { state?: string; ahj?: string; utility?: string },
): PermitUtilityKnowledgeProfile | null {
  if (!input.ahj) return null;
  const candidates = [
    knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: input.utility }),
    knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: "" }),
    knowledgeProfileKey({ state: "", ahj: input.ahj, utility: input.utility }),
    knowledgeProfileKey({ state: "", ahj: input.ahj, utility: "" }),
  ];
  for (const key of candidates) {
    const row = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
    if (row) {
      const profile = mapKnowledge(row);
      if (profile.requiredDocuments.length) return profile;
    }
  }
  return null;
}

export function getKnowledgeProfile(db: AppDb, profileId: string): PermitUtilityKnowledgeProfile {
  const row = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE id = ?", [profileId]);
  if (!row) throw new Error("Knowledge profile not found.");
  return mapKnowledge(row);
}

export function seedInitialKnowledgeBase(db: AppDb): void {
  seedOfficialKnowledge(db);
  seedSanitizedAhjProfiles(db);
  backfillExistingProjectLearning(db);
}

function seedOfficialKnowledge(db: AppDb): void {
  const officialSeeds: KnowledgeFacts[] = [
    {
      state: "OR",
      ahj: "City of Portland",
      utility: "",
      portalName: "DevHub",
      portalUrl: "https://devhub.portlandoregon.gov/",
      requiredDocuments: [
        "DevHub Solar Permit Request",
        "Solar worksheet / prescriptive path eligibility",
        "Structural design criteria",
        "Site plan",
        "Fire access path",
        "Roof framing plan or roof layout for trusses",
        "Roof cross-section when required",
        "System racking attachment",
        "Electrical Renewable Energy Permit Application",
        "Stamped engineering calculations for engineered systems",
      ],
      timelineNote: "Portland states permit requests are reviewed in received order and contacts applicants within one to two business days if more information is needed.",
      sources: [
        officialSource("Portland Solar Permits", "https://www.portland.gov/ppd/solar-development/solar-permits"),
        officialSource("Portland DevHub Solar Permit Guide", "https://www.portland.gov/ppd/solar-permit-app-guide"),
      ],
      confidence: "seeded",
      notes: "Official Portland seed for solar permit path, required documents, and DevHub portal.",
    },
    {
      state: "OR",
      ahj: "Generic Oregon ePermitting AHJ",
      utility: "",
      portalName: "Oregon ePermitting",
      portalUrl: "https://aca-oregon.accela.com/oregon/",
      requiredDocuments: [
        "Residential or Commercial Structural Solar/PV permit",
        "Submitted job value",
        "Prescriptive or non-prescriptive photovoltaic fee path",
        "Plans for plan review",
        "Inspection path after issuance",
      ],
      timelineNote: "Oregon BCD notes both prescriptive and non-prescriptive qualifying Solar/PV installs require plan review before issuance.",
      sources: [officialSource("Oregon BCD solar/PV ePermitting help", "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx")],
      confidence: "seeded",
      notes: "Official Oregon ePermitting seed for generic subscribed jurisdictions.",
    },
    {
      state: "OR",
      ahj: "",
      utility: "PGE",
      portalName: "PowerClerk",
      portalUrl: "https://portlandgeneral.com/resources-for-solar-installers/interconnection-resource-library",
      requiredDocuments: [
        "PowerClerk interconnection application",
        "Electrical one-line / SLD / 3-line",
        "Site / plot plan",
        "Module specification sheet",
        "Inverter / microinverter specification sheet",
        "Utility account and meter verification",
        "Certificate of completion / as-built forms when required",
        "Commissioning or energization checklist when required",
      ],
      timelineNote: "PGE maintains PowerClerk access and interconnection resource forms/checklists for renewable installers.",
      sources: [officialSource("PGE Interconnection Resource Library", "https://portlandgeneral.com/resources-for-solar-installers/interconnection-resource-library")],
      confidence: "seeded",
      notes: "Official PGE seed for interconnection/NEM document package.",
    },
    {
      state: "OR",
      ahj: "",
      utility: "Pacific Power",
      portalName: "PowerClerk",
      portalUrl: "https://www.pacificpower.net/savings-energy-choices/customer-generation.html",
      requiredDocuments: [
        "Pacific Power customer generation online application",
        "Meter picture",
        "Site plan",
        "Example one-line drawing / electrical one-line",
        "Examples of required labeling",
        "Provided inverter settings / UL 1741 SB evidence",
        "Inspection document upload",
        "Safety sign photo upload",
        "Electronic signature request",
      ],
      timelineNote: "Pacific Power states some projects may take longer than 70 business days depending on design or utility equipment upgrades.",
      sources: [
        officialSource("Pacific Power Customer Generation", "https://www.pacificpower.net/savings-energy-choices/customer-generation.html"),
        officialSource("Pacific Power Oregon Customer Generation Agreement", "https://www.pacificpower.net/content/dam/pcorp/documents/en/pacificpower/savings-energy-choices/customer-generation/OR_CG_Pre-Connection_Agreement.pdf"),
      ],
      confidence: "seeded",
      notes: "Official Pacific Power seed for customer generation/NEM path.",
    },
  ];

  for (const seed of officialSeeds) upsertKnowledge(db, seed);
}

function seedSanitizedAhjProfiles(db: AppDb): void {
  const source = {
    label: "Sanitized Infinity AHJ process workbook",
    url: "backend/data/reference-ahj-processes.json",
    sourceType: "sanitized_reference" as const,
    observedAt: nowIso(),
  };
  for (const profile of allAhjProcessProfiles()) {
    const docs: string[] = [];
    if (profile.requiresElectricalPermitApplication) docs.push("Electrical permit application");
    if (profile.requiresBuildingPermitApplication) docs.push("Building/structural permit application");
    if (profile.requiresSolarChecklist) docs.push("Solar checklist / prescriptive worksheet");
    if (profile.requiresPlanSet) docs.push("Complete plan set");
    if (profile.requiresUtilityApproval) docs.push("Utility approval / interconnection evidence");
    if (profile.requiresCustomerSignature) docs.push("Customer signature / owner authorization");
    if (profile.requiresFloodplainCheck) docs.push("Floodplain/FEMA check evidence");
    if (profile.requiresJurisdictionCheck) docs.push("Jurisdiction/address verification");
    upsertKnowledge(db, {
      state: profile.state,
      ahj: profile.ahj,
      utility: "",
      portalName: profile.submissionMethod,
      requiredDocuments: docs,
      timelineNote: profile.timeline ? `Reference timeline: ${profile.timeline}` : "",
      sources: [source],
      confidence: "seeded",
      notes: [profile.otherRequirements, profile.reviewerNotes].filter(Boolean).join(" | "),
    });
  }
}

function eventExists(db: AppDb, projectId: string, eventType: string): boolean {
  const row = db.get<Row>("SELECT id FROM knowledge_events WHERE project_id = ? AND event_type = ? LIMIT 1", [projectId, eventType]);
  return Boolean(row);
}

function backfillExistingProjectLearning(db: AppDb): void {
  const projects = db.query<Row>("SELECT * FROM projects ORDER BY created_at ASC");
  for (const row of projects) {
    const project = projectFromRow(row);
    upsertProjectFingerprint(db, project);
    if (!eventExists(db, project.id, "backfill.v2.project")) {
      learnFromProject(db, project, "backfill.v2.project");
    }

    for (const target of db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ?", [project.id])) {
      const eventType = `backfill.v2.permit_target.${text(target.id)}`;
      if (eventExists(db, project.id, eventType)) continue;
      learnFromPermitTarget(
        db,
        project,
        {
          jurisdiction: text(target.jurisdiction),
          portalName: text(target.portal_name),
          portalUrl: text(target.portal_url),
          applicationNumber: text(target.application_number),
          permitNumber: text(target.permit_number),
        },
        eventType,
      );
    }

    for (const correction of db.query<Row>("SELECT * FROM corrections WHERE project_id = ?", [project.id])) {
      const eventType = `backfill.v2.correction.${text(correction.id)}`;
      if (eventExists(db, project.id, eventType)) continue;
      learnFromCorrection(
        db,
        project,
        {
          bucket: text(correction.correction_bucket) as CorrectionBucket,
          rootCause: text(correction.root_cause),
          requiredAction: text(correction.required_action),
          assignedTo: text(correction.assigned_to),
          draftResponse: text(correction.draft_response),
          newRuleRecommended: bool(correction.new_rule_recommended),
        },
        text(correction.correction_text),
        text(correction.source),
        eventType,
      );
    }

    for (const status of db.query<Row>("SELECT * FROM permit_status_checks WHERE project_id = ?", [project.id])) {
      const eventType = `backfill.v2.permit_status.${text(status.id)}`;
      if (eventExists(db, project.id, eventType)) continue;
      const target = status.target_id
        ? db.get<Row>("SELECT * FROM permit_check_targets WHERE id = ? AND project_id = ?", [text(status.target_id), project.id])
        : null;
      learnFromPermitStatus(
        db,
        project,
        {
          id: text(status.id),
          projectId: project.id,
          targetId: status.target_id == null ? null : text(status.target_id),
          source: text(status.source) as PermitStatusCheck["source"],
          rawStatusText: text(status.raw_status_text),
          statusLabel: text(status.status_label),
          outcome: text(status.outcome) as PermitStatusCheck["outcome"],
          confidence: Number(status.confidence ?? 0),
          correctionId: status.correction_id == null ? null : text(status.correction_id),
          reviewedByAhj: bool(status.reviewed_by_ahj),
          readyForIssue: bool(status.ready_for_issue),
          issueFeeDue: bool(status.issue_fee_due),
          applicationNumber: text(status.application_number),
          permitNumber: text(status.permit_number),
          message: text(status.message),
          createdAt: text(status.created_at),
        },
        target
          ? {
              jurisdiction: text(target.jurisdiction),
              portalName: text(target.portal_name),
              portalUrl: text(target.portal_url),
              createdAt: text(target.created_at),
            }
          : null,
        eventType,
      );
    }
  }
}
