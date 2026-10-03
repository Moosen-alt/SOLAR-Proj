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
  UtilityResearchResult,
  PermitUtilityKnowledgeProfile,
  ProjectRecord,
  ProjectStatus,
} from "../../shared/src/types";
import { classifyCorrection, humanizeEnum, type CorrectionClassification } from "./corrections";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { id } from "./ids";
import { asJson, bool, parseJson, text } from "./json";
import { FALLBACK_PROFILE_IDS, findApplicationProfile } from "./applicationDocs";
import { classifyChannelWords, isStatewidePortalUrl } from "./permitProcess";
import { usStateCode } from "./permitPath";
import { enrichMboxLearningWithLlm, stripUrlsFromModelMemory } from "./llm";
import { allAhjProcessProfiles, findAhjProcessProfile } from "./processProfiles";
import { nowIso } from "./time";
import { logger } from "./logger";
import { inferPlatform, isRecognizedPlatform, looksLikeBareUrl } from "./portalPlatformRules";
import { isInformationalPageUrl, isUtilityPlatformUrl, portalHostOf } from "./portalChannel";
import { HttpError } from "./httpError";
import { KNOWN_POWERCLERK_PORTALS, foreignKnownTenant, knownPowerClerkUtility, knownTenantOwner, provablyDifferentUtility, sameUtilityEntity, utilityIdentityOf, type UtilityIdentity } from "./utilityIdentity";

type Row = Record<string, unknown>;

interface KnowledgeFacts {
  state?: string;
  ahj?: string;
  utility?: string;
  portalName?: string;
  portalUrl?: string;
  portalPlatform?: string;
  submissionMethod?: string;
  requiredDocuments?: string[];
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
  /** Set ONLY by the three human-verification writers (saveVerifiedAhjProfile,
   *  saveVerifiedUtilityProfile, the operator-ruling seeder). A write carrying it is
   *  itself verified: it may overwrite a verified row, and it stamps verified_at. */
  verifiedAt?: string;
  verifiedBy?: string;
}

interface KnowledgeEventInput {
  projectId?: string | null;
  eventType: string;
  details?: Record<string, unknown>;
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

// A CREDENTIAL TYPED INTO A SHARED TABLE REACHES EVERY TENANT, AND THEN THE MODEL.
//
// Found on 2026-09-12 by decrypting the credential store and hunting the plaintext on disk:
// FOUR permit_utility_knowledge rows carried a real stored secret in their notes —
//     "Sec- Q: <security answer>"                  (md|aaco md)
//     "permit@<company>.com Walmart<password>"      (wa|wa portal)
// plus two more under Sacramento. permit_utility_knowledge is one of the tables CLAUDE.md
// shares across tenants ON PURPOSE, so those were readable by every customer of the system.
//
// Worse, the notes are not inert. knowledgeResearchHint puts up to 700 characters of them into
// the `knownContext` that ahjFormAuto hands to llm.findAhjFormUrl, and autoLearn's KB block
// puts up to 900 into the learner prompt. So a password pasted here went to a language model —
// against §6 of the onboarding guide ("never displayed, printed or passed to a language model")
// and against hard rule 2.
//
// The rows have been redacted. This is the part that stops it coming back: the guard sits at
// the ONE place every writer's notes pass through — imports, research, human patches and the
// learner all route through noteSegments — so no caller has to remember. A dropped segment is
// logged, never silently swallowed, because an operator who typed something useful alongside a
// password needs to know which half went.
// TWO NARROW TESTS, NOT ONE BROAD ONE. The first attempt joined three patterns with "|" and one
// of them carried its own top-level alternation (`...\d|\d\S*[A-Za-z]`), which leaked out and made
// the whole regex match "a digit followed by a letter" — every kVA bracket and fee amount in the
// knowledge base. Separate predicates cannot do that to each other.
//
// A LABEL, with its value. "Sec- Q:" is the real row's wording, so the label side tolerates the
// abbreviation and the stray hyphen.
const CREDENTIAL_LABEL =
  /\b(pass(word|wd|phrase)?|pwd|sec(urity)?\s*[-–—]?\s*(q(uestion)?|a(nswer)?)|secret\s*[qa]|login\s*(pw|pass)|pin|passcode|otp|totp|mfa\s*(seed|secret))\b\s*[:=]/i;

// AN EMAIL FOLLOWED BY A PASSWORD-SHAPED TOKEN, which is how the Washington row read:
// "permit@<company>.com Walmart<secret>". The lookaheads keep this off ordinary prose: requiring
// lower AND upper AND a digit in the same token means "Contact permits@city.gov regarding
// corrections" does not trip it, while a real password almost always does. A password of all one
// case slips through, and that is the accepted cost of not refusing half the notes anyone writes
// about a portal contact address.
const USER_PASS_PAIR =
  /[\w.+-]+@[\w-]+\.[a-z]{2,}\s+(?=\S{6,})(?=\S*[a-z])(?=\S*[A-Z])(?=\S*\d)\S+/;

// A LOGIN HANDLE AND ITS PASSWORD, NOTHING ELSE (leak sweep company-leak-5, 2026-09-28). A shared
// row carried "<Handle> & <password>" — no label, no email — and neither test above saw it. Both
// shapes below are anchored to the WHOLE segment (an optional short "Accela login:" label first),
// so prose never matches: the second token must be one unbroken token of 6+ characters with no
// parentheses (a fee line's "(5-15kVA)" has them).
//   "<handle> & <secret>": the secret carries a letter AND a digit or a password symbol, and is not
//     an email ("Contact & permits@city.gov" is a contact; "Solar & Battery-Storage" is a scope).
//   "<handle> <secret>": the handle looks like a login (CamelCase, a digit, "_" or "."), the secret
//     is lower + upper + digit — "Model IQ8Plus-72" is a model line, not a login.
const HANDLE_AMP_SECRET =
  /^\s*(?:[^:|]{1,40}:\s*)?[A-Za-z][\w.@+-]{2,63}\s*&\s*(?![\w.+-]+@[\w-]+\.[\w.-]+\s*$)(?=[^\s()]{6,}\s*$)(?=[^\s()]*[A-Za-z])(?=[^\s()]*[\d!#$%^&*?~+=@])[^\s()]+\s*$/;
const HANDLE_SPACE_SECRET =
  /^\s*(?:[^:|]{1,40}:\s*)?(?=[A-Za-z][\w.+-]*(?:[a-z][A-Z]|\d|_|\.))[A-Za-z][\w.+-]{2,63}\s+(?=[^\s()]{6,}\s*$)(?=[^\s()]*[a-z])(?=[^\s()]*[A-Z])(?=[^\s()]*\d)[^\s()]+\s*$/;

/** True when a note segment looks like it carries a credential rather than portal knowledge. */
export function looksLikeCredentialNote(segment: string): boolean {
  const s = String(segment ?? "");
  return CREDENTIAL_LABEL.test(s) || USER_PASS_PAIR.test(s) || HANDLE_AMP_SECRET.test(s) || HANDLE_SPACE_SECRET.test(s);
}

/** A shared row's notes as ANY reader is served them: every credential-shaped segment
 *  (looksLikeCredentialNote — the write guard's own predicate) dropped. Byte-identical when clean. */
export function servedKnowledgeNotes(notes: string): string {
  const raw = String(notes ?? "");
  if (!raw) return raw;
  const segs = raw.split(" | ");
  if (!segs.some((seg) => looksLikeCredentialNote(seg.trim()))) return raw;
  return segs.filter((seg) => !looksLikeCredentialNote(seg.trim())).join(" | ");
}

/**
 * THE ONE-TIME CLEANUP OF A CREDENTIAL ALREADY SITTING IN A SHARED NOTE (migration v42, forms skeptic
 * K1 — rule 2). The write guard (noteSegments) only runs when a row is written, so a row seeded before
 * it — one unverified row carried a plaintext "<handle> & <password>" pair — kept it in the shared
 * knowledge base every org can read. Drops the credential-shaped segments from UNVERIFIED rows only:
 * a human-verified row is never auto-rewritten (rule 3, isVerifiedKnowledge) — its notes are filtered
 * when served (servedKnowledgeNotes) and it is counted for the operator. Never logs a segment or a
 * row's text. Idempotent.
 */
export function purgeCredentialNoteSegments(db: AppDb): { cleaned: string[]; keptVerified: string[] } {
  const cleaned: string[] = [];
  const keptVerified: string[] = [];
  const rows = db.query<{ id: string; notes: string | null; verified_at: string | null }>(
    "SELECT id, notes, verified_at FROM permit_utility_knowledge WHERE notes IS NOT NULL AND notes <> ''");
  for (const row of rows) {
    const notes = String(row.notes ?? "");
    const next = servedKnowledgeNotes(notes);
    if (next === notes) continue;
    if (isVerifiedKnowledge(row)) { keptVerified.push(row.id); continue; }
    db.run("UPDATE permit_utility_knowledge SET notes = ? WHERE id = ?", [next, row.id]);
    cleaned.push(row.id);
  }
  return { cleaned, keptVerified };
}

// ---------------------------------------------------------------------------------------------
// WHAT A LEARN PLANNER MAY READ FROM A SHARED NOTE (leak sweep company-leak-5). The KB is shared
// across every company on purpose — but its notes were written from ONE company's sheets, and they
// carry that company's facts: "Operator credential stored for this portal.", its login usernames and
// emails, its licence numbers ("metro license # <n>"). Handed to another company's learn planner as
// AHJ context, the planner could type the first company's licence into the second company's filing,
// and a login pair reached the model (hard rule 2). The row stays as it is (shared knowledge, and
// rule 3 for verified rows); what leaves for the model is filtered here, segment by segment.
// ---------------------------------------------------------------------------------------------
const LOGIN_FACT = /\bcredentials?\b[^|]{0,40}\b(stored|on file|saved)\b|«pw»|\b(user\s*-?\s*name|user\s*id|log\s*-?\s*in|logon|sign\s*-?\s*in|pw|pwd|password|pass)\s*[:=]/i;
/** A login label directly followed by the email it logs in with ("User name <email>", "Login - <email>").
 *  Never the bare word: "…/Login/Index" in a portal URL and "only the login differs per AHJ" are knowledge. */
const LOGIN_EMAIL = /\b(user\s*-?\s*name|username|user\s*id|log\s*-?\s*in|logon|sign\s*-?\s*in)\s*(?:[:=-]\s*|\s+(?:is\s+)?)[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
/** "<handle> & <email>" — a username paired with the login email, the whole segment. */
const HANDLE_AMP_EMAIL = /^\s*(?:[^:|]{1,40}:\s*)?[A-Za-z][\w.+-]{2,63}\s*&\s*[\w.+-]+@[\w-]+\.[\w.-]+\s*$/;
/** A licence / registration NUMBER after its label ("metro license # 12345", "CCB# 123456",
 *  "License No. C1234"). The label stays (the AHJ asks for that licence); the number is the
 *  job's company's own and comes from the job's client, never from a shared note. */
const LICENCE_NUMBER = /\b((?:licen[cs]e|lic\.|registration|reg\.?|ccb|cslb|hic)\s*(?:no\.?|number|num\.?|#)?\s*[:#]?\s*)([A-Z]{0,4}-?\d{3,}[A-Z]?)\b/gi;

/** One shared note segment is another company's fact (a login, a stored credential) — never sent to a model. */
export function isCompanyLoginSegment(segment: string): boolean {
  const s = String(segment ?? "");
  return looksLikeCredentialNote(s) || LOGIN_FACT.test(s) || HANDLE_AMP_EMAIL.test(s) || LOGIN_EMAIL.test(s);
}

/** A licence / registration number in shared prose, replaced by a pointer to the job's own company
 *  (the label stays — the AHJ asking for that licence is knowledge; the number is one company's). */
export function redactLicenceNumbers(text: string): string {
  return String(text ?? "").replace(LICENCE_NUMBER, (_m, label: string) => `${label}[the job's company's own number]`);
}

/** The shared notes as a learn planner may read them: credential / login segments dropped, licence
 *  numbers replaced by a pointer to the job's own company. " | "-joined segments in, the same out. */
export function learnSafeNotes(notes: string): string {
  return String(notes ?? "")
    .split(" | ")
    .map((seg) => seg.trim())
    .filter((seg) => seg && !isCompanyLoginSegment(seg))
    .map((seg) => redactLicenceNumbers(seg))
    .join(" | ");
}

// Notes are stored as " | "-joined segments. Split before merging so dedupe
// compares SEGMENTS — merging the whole blob as one item re-appends the same
// seed sentence on every startup/learn event (the runaway-notes bug).
function noteSegments(value: unknown): string[] {
  const kept: string[] = [];
  for (const seg of clean(value).split(" | ").map((s) => s.trim()).filter(Boolean)) {
    if (looksLikeCredentialNote(seg)) {
      // Never log the segment itself — that would move the secret into the log file, which is
      // the same mistake one layer along.
      logger.warn("kb", "refused a knowledge note that looks like a credential", { chars: seg.length });
      continue;
    }
    kept.push(seg);
  }
  return kept;
}

// THE PLATFORM SENTENCE IS ONE SEGMENT, WRITTEN ONCE (issue #15). A researched card read "reuse
// existing PowerClerk (Clean Power Research) — PNM uses PowerClerk for … automation; only the entry
// URL and login differ (reuse existing PowerClerk … automation; …)": the model answered portalPlatform
// with the reuse sentence itself (the research prompt and the KB hint both say it), the saver wrapped
// its template around that, and because the sentence sat INSIDE the one research blob, a re-research
// that worded anything differently kept a second blob with a second sentence. Now the researched
// savers store only the platform's LABEL and write the sentence as its own segment, and a new one
// replaces the old on an unverified row (mergeNoteSegments).
const RESEARCHED_PLATFORM_SEGMENT = /^Portal platform: [\s\S]*reuse existing/i;
// The same sentence inside a pre-#15 research blob; non-greedy to the template's own ending, which a
// nested copy (the live shape) carries only once with its closing ")." .
const EMBEDDED_PLATFORM_SENTENCE = /\s*Portal platform: [\s\S]*?differ per (?:AHJ|utility)\)\./gi;

/** The platform's NAME out of whatever research returned: no "Portal platform:" prefix, nothing from
 *  "reuse existing" on, no explanatory clause after a dash or semicolon. "Tyler EnerGov" stays as is. */
export function portalPlatformLabel(raw: unknown): string {
  let s = clean(raw).replace(/^portal platform:\s*/i, "");
  const reuse = s.search(/reuse existing/i);
  if (reuse >= 0) s = s.slice(0, reuse);
  s = s.split(/\s+[—–]\s+|;/)[0];
  if (s.lastIndexOf("(") > s.lastIndexOf(")")) s = s.slice(0, s.lastIndexOf("("));
  return s.replace(/[\s,.;:—–-]+$/, "").trim();
}

/** Merge note segments (dedupe by segment, cap 40). An incoming researched platform sentence
 *  replaces the row's earlier ones — standalone, or inside a legacy research blob — unless the row
 *  is human-verified (rule 3), where the person's own platform sentence stands and research adds
 *  none when one is already there. */
function mergeNoteSegments(currentNotes: unknown, incomingNotes: unknown, humanVerified: boolean): string {
  let current = noteSegments(currentNotes);
  let incoming = noteSegments(incomingNotes);
  if (incoming.some((seg) => RESEARCHED_PLATFORM_SEGMENT.test(seg))) {
    if (humanVerified) {
      if (/Portal platform:/i.test(current.join(" | "))) incoming = incoming.filter((seg) => !RESEARCHED_PLATFORM_SEGMENT.test(seg));
    } else {
      current = current
        .filter((seg) => !RESEARCHED_PLATFORM_SEGMENT.test(seg))
        .map((seg) => (/^AI-researched/i.test(seg) ? seg.replace(EMBEDDED_PLATFORM_SENTENCE, "").trim() : seg));
    }
  }
  return mergeUnique(current, incoming, 40).join(" | ");
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

// A LABEL, NEVER A LOCK. This used to return "mixed" whenever a seeded row met a learned
// write -- and every rule-3 check read "mixed" as "a person verified this", so an automatic
// merge locked 25 production rows against correction and re-import. Seeded + learned is now
// "learned" (it has real evidence behind it, and nobody checked it). "mixed" survives only
// where a verified writer put it, or on a legacy row that already carries it; either way
// nothing reads it as verification -- isVerifiedKnowledge() reads verified_at.
function confidenceFrom(existing: string, incoming?: PermitUtilityKnowledgeProfile["confidence"]): PermitUtilityKnowledgeProfile["confidence"] {
  if (existing === "mixed" || incoming === "mixed") return "mixed";
  if (existing === "learned" || incoming === "learned") return "learned";
  return incoming || (existing as PermitUtilityKnowledgeProfile["confidence"]) || "seeded";
}

/**
 * HARD RULE 3's one question: did a PERSON verify this shared knowledge row?
 *
 * True only when verified_at is set -- by a human-verification writer, or by the v30
 * backfill from recorded human-verification events. NOT confidence === "mixed", which an
 * automatic seeded+learned merge also produced. Every rule-3 check (the learn-path scalar
 * lock, the reference-import skip, the dead-link auto-replace, the fuzzy tie-break, the
 * maintenance scripts) calls this, so they cannot drift apart again. Accepts a mapped
 * profile (verifiedAt) or a raw row (verified_at).
 */
export function isVerifiedKnowledge(row: { verifiedAt?: unknown; verified_at?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return text(row.verifiedAt ?? row.verified_at).trim() !== "";
}

/**
 * IS THIS NAME A JURISDICTION THE SHARED KB KNOWS ON SOMEONE'S AUTHORITY — a human-verified row
 * (isVerifiedKnowledge) or one an official / sanitized-reference source wrote. What the product
 * LEARNED never counts: the birth learn (learnFromProject, run right after a project's first QC)
 * writes `<state>|<ahj as typed>|<utility>` for a typo the moment it is saved, and AI research lands
 * under the same key — either would silence the near-miss question on the very next QC run.
 * EXACT key reads only, by state: the fuzzy resolver (knowledgeNameMatchScore) scores
 * "City Of Smonroe" against "Monroe" at 82 by containment and would call the typo known. The
 * utility segment is left open (`state|name|%`; a normalized key holds only [a-z0-9 |]) so a
 * verified row filed under a utility still answers. Read-only.
 */
export function knownKnowledgeName(db: AppDb, state: string, name: string): boolean {
  if (!clean(name)) return false;
  const prefix = `${normalize(state)}|${normalize(name)}|`;
  try {
    for (const row of db.query<Row>("SELECT verified_at, sources_json FROM permit_utility_knowledge WHERE profile_key LIKE ?", [`${prefix}%`])) {
      if (isVerifiedKnowledge(row)) return true;
      const sources = parseJson<KnowledgeSource[]>(text(row.sources_json), []);
      if (sources.some((s) => s && (s.sourceType === "official" || s.sourceType === "sanitized_reference"))) return true;
    }
  } catch { /* table not there yet: not known */ }
  return false;
}

/**
 * THE ONE-TIME CLEANUP OF A KNOWN TENANT WRITTEN AS ANOTHER UTILITY'S PORTAL (migration v41, leak
 * sweep 2026-09-28). The bare /PACIFIC/ and /PGE/ regexes in portalFromProject wrote PacifiCorp's
 * PowerClerk as "Pacific Gas and Electric Company"'s own portal, Portland General's as a CA "PGE"'s,
 * and PacifiCorp's as WA "Pacific County PUD"'s — pooled knowledge, so one project poisoned the row
 * for every tenant. This clears the portal (URL, and the name/platform describing that tenant) from
 * every row carrying pacificorpnetmetering / pgenm whose utility is provably NOT that tenant's owner
 * (utilityIdentity.foreignKnownTenant — the one identity). It also drops the utility-NAMED document
 * lines projectDocs added under the same regexes ("Pacific Power customer generation application",
 * "PGE SLD/site/spec upload package", "PowerClerk interconnection application").
 *
 * NEVER a human-verified row (rule 3, isVerifiedKnowledge). A correct row (Pacific Power in OR/WA/
 * CA/UT/ID/WY, PGE in OR) is not touched. Idempotent; returns what it did.
 */
export function purgeForeignKnownTenantPortals(db: AppDb): { cleared: string[]; docsTrimmed: string[]; keptVerified: string[] } {
  const out = { cleared: [] as string[], docsTrimmed: [] as string[], keptVerified: [] as string[] };
  const FOREIGN_DOC_LINES: Array<{ line: string; owner: "pacificorp" | "portland_general" }> = [
    { line: "Pacific Power customer generation application", owner: "pacificorp" },
    { line: "PGE SLD/site/spec upload package", owner: "portland_general" },
    { line: "PowerClerk interconnection application", owner: "portland_general" },
  ];
  const rows = db.query<Row>(
    `SELECT * FROM permit_utility_knowledge
     WHERE lower(portal_url) LIKE '%powerclerk.com%' OR required_documents_json LIKE '%Pacific Power customer generation application%'
        OR required_documents_json LIKE '%PGE SLD/site/spec upload package%' OR required_documents_json LIKE '%PowerClerk interconnection application%'`,
  );
  const ts = nowIso();
  for (const row of rows) {
    const key = text(row.profile_key);
    const entity = { state: text(row.state), utility: text(row.utility) };
    const url = text(row.portal_url);
    const host = portalHostOf(url);
    const owner = knownTenantOwner(host);
    const foreignPortal = owner ? foreignKnownTenant(host, entity) : null;
    const identity = knownPowerClerkUtility(entity);
    const docs = parseJson<string[]>(text(row.required_documents_json), []);
    const keptDocs = docs.filter((d) => {
      const hit = FOREIGN_DOC_LINES.find((f) => f.line.toLowerCase() === String(d).trim().toLowerCase());
      return !hit || hit.owner === identity;
    });
    const trimDocs = keptDocs.length !== docs.length;
    if (!foreignPortal && !trimDocs) continue;
    if (isVerifiedKnowledge(row)) { out.keptVerified.push(key); continue; }
    if (foreignPortal) {
      const portalName = text(row.portal_name);
      const platform = text(row.portal_platform);
      db.run(
        "UPDATE permit_utility_knowledge SET portal_url = '', portal_name = ?, portal_platform = ?, updated_at = ? WHERE profile_key = ?",
        [
          /powerclerk|pacific power customer generation/i.test(portalName) ? "" : portalName,
          /powerclerk/i.test(platform) ? "" : platform,
          ts, key,
        ],
      );
      out.cleared.push(key);
    }
    if (trimDocs) {
      db.run("UPDATE permit_utility_knowledge SET required_documents_json = ?, updated_at = ? WHERE profile_key = ?", [asJson(keptDocs), ts, key]);
      out.docsTrimmed.push(key);
    }
  }
  return out;
}

function correctionSignature(correction: KnowledgeFacts["correction"]): string {
  if (!correction) return "";
  return normalize(`${correction.bucket} ${correction.rootCause} ${correction.requiredAction}`);
}

// Strip PII (emails, street addresses, long digit runs, phone numbers) from a
// learning/email sample and cap its length. Shared by redactSample/redactEmailText.
function redact(value: string, maxLen: number): string {
  return clean(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{2,6}\s+[A-Z0-9 .'-]{3,60}\s+(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|WAY|BLVD|CIR|CIRCLE)\b(?:[, ]+[A-Z .'-]{2,40})?/gi, "[address]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]")
    .slice(0, maxLen);
}

function redactSample(value: string): string {
  return redact(value, 240);
}

export function redactEmailText(value: string): string {
  return redact(value, 6000);
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
  // The project's utility family by the one state-gated identity (utilityIdentity) — a PG&E job is
  // not the Pacific Power family and must not match PacifiCorp's history.
  const family = knownPowerClerkUtility(project);
  if (family === "pacificorp") tags.add("utility_family:pacific_power");
  if (family === "portland_general") tags.add("utility_family:pge");
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
  // NO SAMPLE on the shared rollup. A raw correction excerpt can name the homeowner or a
  // co-customer, and this JSON is served to every tenant; the excerpt stays in the
  // org-scoped historical_failure_examples row only.
  if (found) {
    found.count += 1;
    found.lastSeenAt = at;
  } else {
    existing.push({
      signature,
      bucket: incoming.bucket,
      rootCause: incoming.rootCause,
      requiredAction: incoming.requiredAction,
      count: 1,
      lastSeenAt: at,
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
    // A URL FILED UNDER "NAME" IS STILL THE PORTAL. Reference imports have twice now put the
    // portal link in portal_name with portal_url empty (Tigard's EnerGov, Douglas County's
    // iWorQ) — and no resolver reads a URL out of a name, so both AHJs staged to the wrong
    // portal until an operator caught it live. When the url column is empty and the name IS
    // an http(s) URL, the name is the url. Never the reverse, and never when a real url exists.
    portalUrl: text(row.portal_url) || (/^https?:\/\/\S+$/i.test(text(row.portal_name).trim()) ? text(row.portal_name).trim() : ""),
    portalPlatform: text(row.portal_platform),
    submissionMethod: text(row.submission_method),
    requiredDocuments: parseJson<string[]>(text(row.required_documents_json), []),
    averageTimelineDays: row.average_timeline_days == null ? null : Number(row.average_timeline_days),
    timelineSampleCount: Number(row.timeline_sample_count ?? 0),
    timelineNotes: parseJson<string[]>(text(row.timeline_notes_json), []),
    commonCorrections: sharedCorrectionPatterns(parseJson<CommonCorrectionPattern[]>(text(row.common_corrections_json), [])),
    projectCount: Number(row.project_count ?? 0),
    correctionCount: Number(row.correction_count ?? 0),
    confidence: text(row.confidence) as PermitUtilityKnowledgeProfile["confidence"],
    verifiedAt: text(row.verified_at).trim() || null,
    verifiedBy: text(row.verified_by),
    sources: parseJson<KnowledgeSource[]>(text(row.sources_json), []),
    // Served WITHOUT a credential-shaped segment (rule 2): a shared row written before the write guard
    // existed — or a human-verified one the v42 cleanup may not touch (rule 3) — never shows a
    // password to any reader (GET /api/knowledge-base is readable by every org).
    notes: servedKnowledgeNotes(text(row.notes)),
    firstSeenAt: text(row.first_seen_at),
    lastLearnedAt: text(row.last_learned_at),
    updatedAt: text(row.updated_at),
  };
}

// Only the fields a shared rollup may carry. Rows written before the rollup stopped copying
// raw samples still hold a `sample` key in their JSON until the scrub script runs; this
// keeps it off every read path (the KB API, the next upsert's merge) in the meantime.
function sharedCorrectionPatterns(items: CommonCorrectionPattern[]): CommonCorrectionPattern[] {
  return (Array.isArray(items) ? items : []).map((item) => ({
    signature: text(item?.signature),
    bucket: item?.bucket,
    rootCause: text(item?.rootCause),
    requiredAction: text(item?.requiredAction),
    count: Number(item?.count ?? 0),
    lastSeenAt: text(item?.lastSeenAt),
  }));
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
  // A URL IS A URL, WHICHEVER FIELD THE SPREADSHEET PUT IT IN. The operator's AHJ process
  // workbook import filed 71 portal links in portalName with portalUrl empty — and no resolver
  // reads a URL out of a name, so Tigard and Douglas County both staged toward the wrong
  // portal before an operator caught each one live (2026-09-20/21). Every importer and the
  // learn path funnel through THIS function, so this is the one seam that makes the swap
  // impossible rather than the two callers that happened to be caught doing it. Exactly-one
  // URL only: a name carrying two links (Newberg) stays ambiguous and is left for a human.
  if (!clean(facts.portalUrl) && looksLikeBareUrl(clean(facts.portalName))) {
    facts = { ...facts, portalUrl: clean(facts.portalName) };
  }
  // AND A URL IS STILL NOT A NAME WHEN THE URL FIELD IS ALSO SET — the mirror case, which
  // the guard above could not reach. AI research returns both fields (its own prompt asks
  // for "the BRANDED portal name" and it answers with the link), so the operator's screen
  // reads "Portal/process: https://energovweb.capecoral.gov/energovprod/selfservice#/..."
  // where a name belongs. Counted 2026-09-22 while checking multi-state readiness: 29 real
  // AHJ rows (OR 11, WA 10, FL 5, ID/TX/CA 1 each) — plus 23 benchmark fixtures, which is
  // why the first count of "77" was wrong and is written down here as a caution.
  //
  // The URL is not discarded: portalUrl already holds it, and the host tells us the portal
  // FAMILY, which is the more useful fact — half those Florida rows are Tyler EnerGov, the
  // same platform as Tigard, so one adapter serves them. Name becomes the platform label
  // when the host is recognized, and is otherwise CLEARED rather than left showing a link:
  // an unknown must not read as an answer.
  if (looksLikeBareUrl(clean(facts.portalName))) {
    const platform = inferPlatform(clean(facts.portalUrl) || clean(facts.portalName));
    facts = {
      ...facts,
      portalName: isRecognizedPlatform(platform) ? platform : "",
      portalPlatform: clean(facts.portalPlatform) || (isRecognizedPlatform(platform) ? platform : facts.portalPlatform),
    };
  }
  // AN INFORMATION PAGE IS NEVER A PORTAL (portal-truth D2, 2026-09-28). City of Corvallis's row
  // held Oregon BCD's help page ("…/bcd/epermitting/help/…/permit-for-solar.aspx") as its portal,
  // and every door downstream had to refuse it again. Every writer funnels through here — learn,
  // AI research, the reference import, the verified saves (which refuse loudly before they get
  // here: saveVerifiedAhjProfile / saveVerifiedUtilityProfile) — so this is the one seam that keeps
  // a help/guide page or a document out of portal_url, judged by THE one predicate
  // (portalChannel.isInformationalPageUrl). The refused URL is kept as a note segment, never lost.
  if (clean(facts.portalUrl) && isInformationalPageUrl(clean(facts.portalUrl))) {
    const refused = clean(facts.portalUrl);
    facts = {
      ...facts,
      portalUrl: "",
      notes: [clean(facts.notes), `Refused as a portal URL: ${refused} is an information page (help / guide / document), not an application portal`].filter(Boolean).join(" | "),
    };
  }
  // RULE 5 AT THE KB WRITE (close-2 item 7): an AHJ-KEYED row never carries a UTILITY portal. The
  // learn path used to stamp PGE's PowerClerk login onto every (ahj, utility) row a PGE project
  // touched ("or|city of tigard|portland general electric" -> pgenm.powerclerk.com), and the
  // permit track then had to be guarded against its own knowledge base. Every importer and every
  // learn path funnel through here, so this is the one seam: the utility portal (its URL and the
  // name / platform that describe it) is moved to the UTILITY's own row (state, "", utility) —
  // verified rows there still fill blanks only — or dropped when no utility is named.
  // A KNOWN UTILITY'S TENANT IS NEVER WRITTEN AS ANOTHER UTILITY'S PORTAL (leak sweep 2026-09-28).
  // PacifiCorp's / Portland General's PowerClerk belongs to that utility only (utilityIdentity — the
  // one state-gated identity). Whatever path carries it here for a utility that provably is not the
  // owner (a CA "Pacific Gas and Electric", a WA "Pacific County PUD"), the portal is dropped; only a
  // person's own verified write may say otherwise.
  if (!facts.verifiedAt && clean(facts.portalUrl) && foreignKnownTenant(portalHostOf(clean(facts.portalUrl)), { state: facts.state, utility: facts.utility })) {
    facts = { ...facts, portalUrl: "", portalName: "", portalPlatform: "" };
  }
  if (clean(facts.ahj) && isUtilityPlatformUrl(clean(facts.portalUrl))) {
    const utilityPortal = { portalUrl: clean(facts.portalUrl), portalName: clean(facts.portalName), portalPlatform: clean(facts.portalPlatform) };
    facts = { ...facts, portalUrl: "", portalName: "", portalPlatform: "" };
    if (clean(facts.utility)) {
      upsertKnowledge(db, {
        state: facts.state, ahj: "", utility: facts.utility, ...utilityPortal,
        sources: facts.sources, confidence: facts.confidence === "mixed" ? "learned" : facts.confidence,
      });
    }
  }
  const key = profileKey(facts);
  const ts = nowIso();
  const existing = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);

  const current = existing ? mapKnowledge(existing) : null;
  const requiredDocuments = mergeUnique(current?.requiredDocuments || [], facts.requiredDocuments || []);
  const timelineNotes = mergeUnique(current?.timelineNotes || [], facts.timelineNote ? [facts.timelineNote] : [], 60);
  const commonCorrections = mergeCorrections([...(current?.commonCorrections || [])], facts.correction, ts);
  const correctionCount = commonCorrections.reduce((sum, item) => sum + item.count, 0);
  const sources = mergeSources(current?.sources || [], facts.sources || []);
  // TIMELINES ARE NOT LEARNED HERE. This used to fold a "days since submission" into a running
  // average on EVERY status check, so the figure measured how often the monitor polled, not how
  // long the AHJ took (Coos Bay 5.6 days, Hood River 0.0). The two columns are now derived only
  // from permit_timeline_samples (recomputeTimelineFromSamples); every write here carries the
  // current values through unchanged.
  const averageTimelineDays = current?.averageTimelineDays ?? null;
  const timelineSampleCount = current?.timelineSampleCount ?? 0;

  if (current) {
    // SAFETY RULE 3: a human-verified row (isVerifiedKnowledge — verified_at set,
    // NOT confidence "mixed") must never have its verified scalar facts
    // overwritten by a learn path (learnFromProject seeds hard-coded portal URLs
    // on every save). For verified rows the scalar precedence flips to
    // FILL-BLANKS-ONLY — the current value always wins and incoming facts only
    // land where the row is empty. Notes/docs/corrections merging stays additive
    // (segment merge) for every confidence level.
    // Exception: an update that is ITSELF human-verified (facts.verifiedAt —
    // saveVerifiedAhjProfile / verified utility edits / operator rulings) may
    // still overwrite; a human correcting their own verified row is not a regression.
    const humanVerified = isVerifiedKnowledge(current) && !facts.verifiedAt;
    const scalar = (currentValue: string, incoming: string | undefined): string =>
      humanVerified ? currentValue || clean(incoming) : clean(incoming) || currentValue;
    db.run(
      `UPDATE permit_utility_knowledge
       SET state = ?, ahj = ?, utility = ?, portal_name = ?, portal_url = ?,
           portal_platform = ?, submission_method = ?,
           required_documents_json = ?, average_timeline_days = ?, timeline_sample_count = ?,
           timeline_notes_json = ?, common_corrections_json = ?, correction_count = ?,
           confidence = ?, sources_json = ?, notes = ?, last_learned_at = ?, updated_at = ?,
           verified_by = CASE WHEN verified_at IS NULL AND ? IS NOT NULL THEN ? ELSE verified_by END,
           verified_at = COALESCE(verified_at, ?)
       WHERE profile_key = ?`,
      [
        scalar(current.state, facts.state),
        scalar(current.ahj, facts.ahj),
        scalar(current.utility, facts.utility),
        scalar(current.portalName, facts.portalName),
        scalar(current.portalUrl, facts.portalUrl),
        scalar(current.portalPlatform, facts.portalPlatform),
        scalar(current.submissionMethod, facts.submissionMethod),
        asJson(requiredDocuments),
        averageTimelineDays,
        timelineSampleCount,
        asJson(timelineNotes),
        asJson(commonCorrections),
        correctionCount,
        confidenceFrom(current.confidence, facts.confidence),
        asJson(sources),
        // Cap counts SEGMENTS (reference imports alone carry up to 16 labeled
        // fields), so it must be generous — a tight cap here silently drops the
        // newest note (e.g. a human-verified profile) once existing segments
        // fill it. 40 bounds growth without ever truncating legitimate content.
        mergeNoteSegments(current.notes, facts.notes, humanVerified),
        event ? ts : current.lastLearnedAt,
        ts,
        // FIRST verification wins (the backfill takes MIN(created_at) for the same reason):
        // a learn write passes null and can never clear it, and the operator-ruling seeder
        // re-running on every boot cannot keep moving it.
        facts.verifiedAt || null,
        clean(facts.verifiedBy) || "human",
        facts.verifiedAt || null,
        key,
      ],
    );
  } else {
    db.run(
      `INSERT INTO permit_utility_knowledge
        (id, profile_key, state, ahj, utility, portal_name, portal_url, portal_platform, submission_method, required_documents_json,
         average_timeline_days, timeline_sample_count, timeline_notes_json, common_corrections_json,
         project_count, correction_count, confidence, sources_json, notes, first_seen_at, last_learned_at, updated_at,
         verified_at, verified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id(),
        key,
        clean(facts.state),
        clean(facts.ahj),
        clean(facts.utility),
        clean(facts.portalName),
        clean(facts.portalUrl),
        clean(facts.portalPlatform),
        clean(facts.submissionMethod),
        asJson(requiredDocuments),
        averageTimelineDays,
        timelineSampleCount,
        asJson(timelineNotes),
        asJson(commonCorrections),
        0,
        correctionCount,
        facts.confidence || "seeded",
        asJson(sources),
        // THE INSERT BRANCH HAD NO GUARD, and a brand-new jurisdiction is exactly where a
        // credential gets pasted — somebody sets a portal up, writes what they had to type, and
        // the row is created rather than updated. noteSegments (which filters) was applied only
        // on the UPDATE path above, so the first write of any profile went through raw. Caught by
        // kbCredentialNote.test.ts driving the real import path instead of the predicate.
        noteSegments(facts.notes).join(" | "),
        ts,
        event ? ts : "",
        ts,
        facts.verifiedAt || null,
        facts.verifiedAt ? clean(facts.verifiedBy) || "human" : "",
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
  // Fingerprints feed matchedProjectCount in every tenant's risk report — a demo or benchmark
  // project must not become "a prior project like this one".
  if (isLearningExcluded(db, project.id)) return;
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

// ---------------------------------------------------------------------------
// LEARNING EXCLUSION (L3). Demo, benchmark and fixture projects run the product's real paths,
// and every one of those paths teaches the SHARED knowledge base — which every tenant reads.
// projects.learning_excluded (set at creation through createProject's option) is checked at
// the top of every project-sourced learn write: the project-event upsert below, the failure
// example insert, the fingerprint, and the timeline sample. One predicate, read from the row.
// ---------------------------------------------------------------------------
export function isLearningExcluded(db: AppDb, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  const row = db.get<Row>("SELECT learning_excluded FROM projects WHERE id = ?", [projectId]);
  return Number(row?.learning_excluded ?? 0) === 1;
}

/** upsertKnowledge for a PROJECT-sourced fact: null (nothing written) when the project is
 *  excluded from learning. The only door the project learn functions use. */
function upsertProjectKnowledge(
  db: AppDb,
  projectId: string,
  facts: KnowledgeFacts,
  event: Omit<KnowledgeEventInput, "projectId">,
): PermitUtilityKnowledgeProfile | null {
  if (isLearningExcluded(db, projectId)) return null;
  return upsertKnowledge(db, facts, { ...event, projectId });
}

// The org a project's learning belongs to — read from the project ROW, never from a caller.
function orgIdForProject(db: AppDb, projectId: string): string {
  return text(db.get<Row>("SELECT org_id FROM projects WHERE id = ?", [projectId])?.org_id) || DEFAULT_ORG_ID;
}

// historical_failure_examples is the ONE org-scoped learning table (raw correction excerpts
// name homeowners and co-customers). Every row carries the org that produced it: a project's
// own org when there is a project, otherwise the org of the session / job that imported it.
// Callers never pass a request-body value here.
function insertHistoricalFailureExample(
  db: AppDb,
  input: {
    orgId: string;
    project?: ProjectRecord;
    facts: KnowledgeFacts;
    correction: NonNullable<KnowledgeFacts["correction"]>;
    sourceType: string;
    sourceLabel: string;
    occurredAt?: string;
    signatureSeed: string;
    /** The live correction this row was learned from (L4) — the key relearnCorrection
     *  replaces and retracts by. Absent for imports (mbox, batch scan). */
    correctionId?: string | null;
  },
): void {
  if (input.project && isLearningExcluded(db, input.project.id)) return;
  const key = profileKey(input.facts);
  const tags = input.project ? extractProjectFeatureTags(input.project) : tagsFromText(`${input.facts.utility} ${input.facts.ahj} ${input.correction.sample}`);
  const sourceSignature = signatureFor(input.signatureSeed);
  const orgId = input.project ? orgIdForProject(db, input.project.id) : clean(input.orgId) || DEFAULT_ORG_ID;
  db.run(
    `INSERT OR IGNORE INTO historical_failure_examples
      (id, org_id, source_signature, profile_key, project_id, state, ahj, utility, portal_name, feature_tags_json,
       outcome, correction_bucket, root_cause, required_action, sample, source_type, source_label, occurred_at, created_at,
       correction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id(),
      orgId,
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
      input.correctionId || null,
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

  // WHICH UTILITY, by the one anchored state-gated answer (utilityIdentity) — a CA "Pacific Gas and
  // Electric" or "PGE" (PG&E) job is neither Portland General nor PacifiCorp.
  const knownUtility = knownPowerClerkUtility(project);
  if (knownUtility === "portland_general") {
    add("PowerClerk interconnection application");
    add("PGE SLD/site/spec upload package");
    add("Utility account and meter verification");
  }
  if (knownUtility === "pacificorp") {
    add("Pacific Power customer generation application");
    add("Meter photo");
    add("UL 1741 SB / inverter settings evidence");
    add("Inspection and safety sign upload after install");
  }

  return [...docs];
}

/** The AHJ's portal a project's profiles name (the process profile's submission method, the
 *  application profile's portal and source URL), and — separately — the UTILITY's interconnection
 *  portal for the utilities whose entry URL is known here. The two never share a row (close-2
 *  item 7): the AHJ half lands on the (ahj, utility) row, the utility half on (state, "", utility). */
function portalFromProject(project: ProjectRecord): { portalName: string; portalUrl: string; utilityPortal: { portalName: string; portalUrl: string } | null } {
  const appProfile = findApplicationProfile(project);
  const process = findAhjProcessProfile(project);
  // A FALLBACK PROFILE IS NOT THE AHJ'S KNOWLEDGE (portal-truth D2). The generic Oregon profile's
  // name ("Oregon ePermitting") and source (BCD's help page) were written into EVERY Oregon AHJ's
  // row with no profile of its own as "learned" — Corvallis's row among them — and the next
  // resolver read them back as that AHJ's portal. Only a profile written for THIS jurisdiction
  // (a hand-written registry entry, or one synthesized from its own seeded process) contributes.
  const ownProfile = !FALLBACK_PROFILE_IDS.has(appProfile.id);
  const portalName = process?.submissionMethod || (ownProfile ? appProfile.portalName : "") || "";
  const portalUrl = ownProfile ? appProfile.sourceUrl || "" : "";
  // The interconnection application lives behind the PowerClerk login, NOT on the public
  // resource-library / marketing page. Seed the real portal-ENTRY URL so the universal self-seed
  // (auto-learn) launches against the actual form instead of an info page it can never fill. Same
  // values the hand-coded PowerClerk adapter targets (powerClerk.ts PGE_LOGIN_URL);
  // portalCredentials.ts aliases the PacifiCorp marketing hosts to its tenant.
  //
  // ONLY for the utility that IS Portland General / PacifiCorp (utilityIdentity: an anchored name in
  // that utility's own states). The bare /PACIFIC/ and /PGE/ regexes this replaced wrote PacifiCorp's
  // tenant as Pacific Gas & Electric's own portal (and Portland General's for a CA "PGE") into the
  // shared KB, and NEM staging launched it — leak sweep 2026-09-28.
  const knownUtility = knownPowerClerkUtility(project);
  const known = knownUtility ? KNOWN_POWERCLERK_PORTALS[knownUtility] : null;
  const utilityPortal = known ? { portalName: known.portalName, portalUrl: known.portalUrl } : null;
  return { portalName, portalUrl, utilityPortal };
}

export function learnFromProject(db: AppDb, project: ProjectRecord, eventType = "project.saved"): PermitUtilityKnowledgeProfile | null {
  const portal = portalFromProject(project);
  // The utility's interconnection portal lands on the UTILITY's own row — never on the AHJ-keyed
  // row below (upsertKnowledge refuses it there too).
  if (portal.utilityPortal && clean(project.utility) && !isLearningExcluded(db, project.id)) {
    upsertKnowledge(db, {
      state: project.state, ahj: "", utility: project.utility, ...portal.utilityPortal,
      sources: [learnedSource("learned_project", "Saved project parser snapshot")], confidence: "learned",
    });
  }
  const profile = upsertProjectKnowledge(
    db,
    project.id,
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
    { eventType, details: { status: project.status } },
  );
  if (!profile) return null;
  upsertProjectFingerprint(db, project);
  return profile;
}

export function learnFromPermitTarget(
  db: AppDb,
  project: ProjectRecord,
  input: { jurisdiction?: string; portalName?: string; portalUrl?: string; applicationNumber?: string; permitNumber?: string },
  eventType = "permit_target.created",
): PermitUtilityKnowledgeProfile | null {
  return upsertProjectKnowledge(
    db,
    project.id,
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

/**
 * Is this classification a REJECTION worth learning as a failure pattern? A reviewer asking a
 * question (C_reviewer_clarification) changed nothing about the package, so it is not a cause
 * the next filing can prevent. The ONE predicate every correction learn path asks — intake,
 * triage, resolve. (The triage agent has no separate "not a correction" verdict; it says so by
 * choosing C.)
 */
export function isLearnableCorrectionBucket(bucket: string): boolean {
  return bucket === "A_we_fix" || bucket === "B_designer_fix";
}

export function learnFromCorrection(
  db: AppDb,
  project: ProjectRecord,
  /** The corrections row this came from. With it, the failure row is keyed by the correction
   *  and re-derived from the row's CURRENT classification (relearnCorrection). null only for
   *  callers with no row (tests of the classifier alone). */
  correctionId: string | null,
  classification: CorrectionClassification,
  correctionText: string,
  source: string,
  eventType = "correction.learned",
): PermitUtilityKnowledgeProfile | null {
  const portal = portalFromProject(project);
  // The shared profile learns the documents and the provenance; the PATTERN is not merged in
  // here any more. It is derived from historical_failure_examples by rebuildKnowledgeRollup, so
  // the intake regex guess and the later triage verdict are one row that gets replaced, not two
  // counts that both stay.
  const profile = upsertProjectKnowledge(
    db,
    project.id,
    {
      state: project.state,
      ahj: project.ahj || project.city,
      utility: project.utility,
      portalName: portal.portalName,
      portalUrl: portal.portalUrl,
      requiredDocuments: docsFromCorrection(correctionText),
      sources: [learnedSource("learned_correction", `Correction intake: ${source}`)],
      confidence: "learned",
      notes: "Common correction pattern learned from correction intake.",
    },
    {
      eventType,
      details: {
        source,
        correctionId: correctionId || null,
        bucket: classification.bucket,
        rootCause: classification.rootCause,
        newRuleRecommended: classification.newRuleRecommended,
      },
    },
  );
  if (!profile) return null;
  if (correctionId) {
    relearnCorrection(db, correctionId);
  } else if (isLearnableCorrectionBucket(classification.bucket)) {
    insertHistoricalFailureExample(db, {
      orgId: orgIdForProject(db, project.id),
      project,
      facts: correctionFacts(project),
      correction: {
        bucket: classification.bucket,
        rootCause: classification.rootCause,
        requiredAction: classification.requiredAction,
        sample: correctionText,
      },
      sourceType: source,
      sourceLabel: "dashboard correction intake",
      occurredAt: nowIso(),
      signatureSeed: `${project.id}|${eventType}|${source}|${correctionText}`,
    });
    rebuildKnowledgeRollup(db, profile.profileKey);
  }
  return mapKnowledge(db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [profile.profileKey])!);
}

function correctionFacts(project: ProjectRecord): KnowledgeFacts {
  const portal = portalFromProject(project);
  return {
    state: project.state,
    ahj: project.ahj || project.city,
    utility: project.utility,
    portalName: portal.portalName,
    portalUrl: portal.portalUrl,
  };
}

/**
 * RE-DERIVE ONE LIVE CORRECTION'S LEARNED FAILURE ROW FROM ITS FINAL CLASSIFICATION (L4).
 *
 * Intake learns from the regex classifier's guess; the paid triage agent (persistTriage) and the
 * operator (resolve) come later and are better. Every one of those moments calls this, and it
 * replaces the row keyed by correction_id with what the corrections row says NOW:
 *   - learnable bucket (A/B), not retracted, project not learning-excluded -> one row, whose
 *     root cause and required action are the corrections row's (titles and severity never read
 *     the raw sample — historicalFailures.ts);
 *   - C_reviewer_clarification, an operator retraction, or an excluded project -> no row.
 * Then the shared rollup is rebuilt for every key the row touched, so common_corrections_json
 * cannot keep a pattern the source table no longer holds.
 *
 * Replace = DELETE then INSERT: the table has two UNIQUE keys (id, source_signature), and an
 * INSERT OR IGNORE would silently keep the stale regex row.
 */
export function relearnCorrection(db: AppDb, correctionId: string): "learned" | "removed" | "skipped" {
  const correction = db.get<Row>("SELECT * FROM corrections WHERE id = ?", [correctionId]);
  if (!correction) return "skipped";
  const projectRow = db.get<Row>("SELECT * FROM projects WHERE id = ?", [text(correction.project_id)]);
  if (!projectRow) return "skipped";
  const project = projectFromRow(projectRow);
  const key = profileKey({ state: project.state, ahj: project.ahj || project.city, utility: project.utility });
  const touched = new Set<string>([
    key,
    ...db
      .query<Row>("SELECT DISTINCT profile_key FROM historical_failure_examples WHERE correction_id = ?", [correctionId])
      .map((r) => text(r.profile_key)),
  ]);
  db.run("DELETE FROM historical_failure_examples WHERE correction_id = ?", [correctionId]);
  const bucket = text(correction.correction_bucket);
  const learn =
    isLearnableCorrectionBucket(bucket) &&
    Number(correction.learning_retracted ?? 0) !== 1 &&
    !isLearningExcluded(db, project.id) &&
    // FK: the failure row points at the shared profile. Intake created it; if it is gone there
    // is nothing to attach the pattern to, and inventing a profile here is not this job.
    Boolean(db.get<Row>("SELECT 1 AS one FROM permit_utility_knowledge WHERE profile_key = ?", [key]));
  if (learn) {
    insertHistoricalFailureExample(db, {
      orgId: orgIdForProject(db, project.id),
      project,
      facts: correctionFacts(project),
      correction: {
        bucket: bucket as CorrectionBucket,
        rootCause: text(correction.root_cause),
        requiredAction: text(correction.required_action),
        sample: text(correction.correction_text),
      },
      sourceType: text(correction.source),
      sourceLabel: "dashboard correction",
      occurredAt: text(correction.created_at) || nowIso(),
      signatureSeed: `correction:${correctionId}`,
      correctionId,
    });
  }
  for (const k of touched) if (k) rebuildKnowledgeRollup(db, k);
  return learn ? "learned" : "removed";
}

/**
 * The operator's "this was not a real rejection, forget it" (L4 #6). Sticky: the corrections
 * row is marked, so a later triage or resolve cannot learn it back. Returns how many learned
 * rows were removed.
 */
export function retractCorrectionLearning(db: AppDb, correctionId: string): number {
  const before = Number(
    db.get<Row>("SELECT COUNT(*) AS n FROM historical_failure_examples WHERE correction_id = ?", [correctionId])?.n ?? 0,
  );
  db.run("UPDATE corrections SET learning_retracted = 1 WHERE id = ?", [correctionId]);
  relearnCorrection(db, correctionId);
  return before;
}

function correctionRollupSignature(row: Row): string {
  return [text(row.correction_bucket), text(row.root_cause), text(row.required_action)]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Recompute a shared profile's DERIVED fields from their source tables: project_count from
 * knowledge_events, common corrections from historical_failure_examples, and the timeline from
 * permit_timeline_samples. Called after anything that removes or replaces source rows
 * (deleteProject, a correction relearn/retraction, a new timeline sample, demo reset).
 */
export function rebuildKnowledgeRollup(db: AppDb, key: string): void {
  const projectRow = db.get<Row>(
    `SELECT COUNT(DISTINCT project_id) AS project_count
     FROM knowledge_events
     WHERE profile_key = ? AND project_id IS NOT NULL`,
    [key],
  );
  const correctionRows = db.query<Row>(
    `SELECT correction_bucket, root_cause, required_action, MAX(created_at) AS last_seen_at, COUNT(*) AS count
     FROM historical_failure_examples
     WHERE profile_key = ?
     GROUP BY correction_bucket, root_cause, required_action
     ORDER BY count DESC, last_seen_at DESC
     LIMIT 25`,
    [key],
  );
  const commonCorrections = correctionRows.map((row) => ({
    signature: correctionRollupSignature(row),
    bucket: text(row.correction_bucket),
    rootCause: text(row.root_cause),
    requiredAction: text(row.required_action),
    count: Number(row.count ?? 0),
    lastSeenAt: text(row.last_seen_at),
    // NO sample: this rollup is the SHARED row every tenant reads, and a raw correction
    // excerpt can name a homeowner. The excerpt stays in the org-scoped source table.
  }));
  db.run(
    `UPDATE permit_utility_knowledge
     SET project_count = ?, common_corrections_json = ?, correction_count = ?, updated_at = ?
     WHERE profile_key = ?`,
    [
      Number(projectRow?.project_count ?? 0),
      asJson(commonCorrections),
      commonCorrections.reduce((sum, item) => sum + item.count, 0),
      nowIso(),
      key,
    ],
  );
  recomputeTimelineFromSamples(db, key);
}

// The per-check note the monitor used to append on every look ("issued: Issued after 5.6
// day(s)", "waiting: In Review"): humanizeEnum(outcome) + ": ". Lower-case enum prefixes, so the
// capitalized mbox labels ("Permit approved/issued: ...") and seeded "Reference timeline: ..."
// segments can never match. A rebuild drops these and its own previous derived segments ONLY.
const MONITOR_TIMELINE_NOTE_RE = /^(waiting|correction flagged|reviewed by ahj|ready for issue|issued|nem approved|needs human review|no change): /;
const MEASURED_TIMELINE_PREFIX = "Measured turnaround";
const MILESTONE_LABELS: Record<string, string> = {
  issued: "issued / approved",
  reviewed: "review complete",
  correction_flagged: "first correction",
};

/** The KB's timeline median (average of the middle pair) — the KPI report reads per-AHJ medians
 *  through this so the panel and average_timeline_days cannot disagree. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The KB's timeline fields, DERIVED (L2): average_timeline_days is the MEDIAN days from the
 * filing's own submitted_at to its first "issued/approved" reading, and timeline_sample_count is
 * how many filings that median rests on. Milestones never mix: review-complete and
 * first-correction turnaround are reported as their own notes, never averaged into issuance.
 * No samples = no number (null / 0), which is what an unmeasured AHJ honestly has.
 */
export function recomputeTimelineFromSamples(db: AppDb, key: string): void {
  const row = db.get<Row>("SELECT timeline_notes_json FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
  if (!row) return;
  const samples = db.query<Row>("SELECT milestone, days FROM permit_timeline_samples WHERE profile_key = ?", [key]);
  const byMilestone = new Map<string, number[]>();
  for (const sample of samples) {
    const list = byMilestone.get(text(sample.milestone)) || [];
    list.push(Number(sample.days));
    byMilestone.set(text(sample.milestone), list);
  }
  const issued = byMilestone.get("issued") || [];
  const round = (value: number) => Math.round(value * 10) / 10;
  const kept = parseJson<string[]>(text(row.timeline_notes_json), []).filter(
    (note) => !MONITOR_TIMELINE_NOTE_RE.test(note) && !note.startsWith(MEASURED_TIMELINE_PREFIX),
  );
  const derived = ["issued", "reviewed", "correction_flagged"]
    .filter((m) => (byMilestone.get(m) || []).length > 0)
    .map((m) => {
      const list = byMilestone.get(m)!;
      return `${MEASURED_TIMELINE_PREFIX} (submitted to ${MILESTONE_LABELS[m]}): median ${round(median(list)).toFixed(1)} day(s), n=${list.length}`;
    });
  db.run(
    `UPDATE permit_utility_knowledge
     SET average_timeline_days = ?, timeline_sample_count = ?, timeline_notes_json = ?
     WHERE profile_key = ?`,
    [issued.length ? round(median(issued)) : null, issued.length, asJson([...kept, ...derived]), key],
  );
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

function inferPortal(value: string, state: string): string {
  if (/powerclerk/i.test(value)) return "PowerClerk";
  if (/devhub/i.test(value)) return "DevHub";
  if (/projectdox/i.test(value)) return "ProjectDox";
  if (/energov/i.test(value)) return "EnerGov";
  // Whole words: a bare "aca" substring matched "vacation", "academy" and "Placa".
  if (/\baca\b|\baccela\b/i.test(value)) return "Accela";
  if (/mygov/i.test(value)) return "MyGov";
  // An e-permitting portal is OREGON's ePermitting only in Oregon (usStateCode — the one "is this
  // Oregon" answer). Elsewhere it is the jurisdiction's own online portal.
  if (/\be-?permitting\b/i.test(value)) return usStateCode(state) === "OR" ? "Oregon ePermitting" : "Online e-permitting portal";
  if (/development direct/i.test(value)) return "Development Direct";
  return "";
}

/** Test hooks for the mbox learner's state / portal inference (pure). */
export function inferMboxState(value: string, ahj: string, utility: string): string { return inferState(value, ahj, utility); }
export function inferMboxPortal(value: string, state: string): string { return inferPortal(value, state); }

function inferState(value: string, ahj: string, utility: string): string {
  const stateMatch = value.match(/\b(AK|AL|AR|AZ|CA|CO|FL|GA|ID|IL|MA|MD|MI|MN|MO|NC|NJ|NM|NV|NY|OH|OR|PA|SC|TN|TX|UT|VA|WA|WI)\b/);
  if (stateMatch) return stateMatch[1].toUpperCase();
  // A PLACE NAME IS NOT A STATE. "Portland", "Salem", "Washington County" and a town named Oregon
  // exist in several states (ME, MA, PA, WI, IL, OH…); guessing Oregon from them filed another
  // state's email under Oregon's knowledge. Only the state's own name, in a state position
  // ("Salem, Oregon", "State of Oregon", "Oregon 97301"), says Oregon. Otherwise: unknown.
  if (/,\s*oregon\b|\bstate of oregon\b|\boregon\s+9[78]\d{3}\b/i.test(`${ahj}\n${value}`)) return "OR";
  // (The utility line is a separate sweep finding — PacifiCorp / Pacific Power serve more than
  // Oregon — left to its own round.)
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
  const state = input.defaults.state || inferState(input.combined, jurisdiction, utility);
  const portalName = inferPortal(input.combined, state);
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
  // orgId: the importing session's / job's org. Required — the failure rows are org-scoped.
  input: { orgId: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
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
        orgId: input.orgId,
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
  input: { orgId: string; mboxText: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  const messages = splitMboxMessages(input.mboxText).slice(0, MBOX_MESSAGE_CAP);
  return runMboxImport(db, messagesFromArray(messages), input);
}

// Streaming variant for large local files — never loads the whole mbox into a
// string, so multi-GB Gmail/Outlook exports import without blowing the heap or
// Node's ~512MB max-string limit.
export async function importMboxKnowledgeFromFile(
  db: AppDb,
  input: { orgId: string; filePath: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  return runMboxImport(db, streamMboxMessagesFromFile(input.filePath, MBOX_MESSAGE_CAP), input);
}

export function learnFromPermitStatus(
  db: AppDb,
  project: ProjectRecord,
  statusCheck: PermitStatusCheck,
  target?: { jurisdiction?: string; portalName?: string; portalUrl?: string; createdAt?: string | null } | null,
  eventType = "permit_status.learned",
): PermitUtilityKnowledgeProfile | null {
  // No timeline and no per-check note any more: a check is a LOOK, not a milestone. Turnaround
  // is measured once per (project, track, milestone) in permit_timeline_samples
  // (timelineSamples.ts recordTimelineSample) and the KB's timeline fields are derived from it.
  return upsertProjectKnowledge(
    db,
    project.id,
    {
      state: project.state,
      ahj: target?.jurisdiction || project.ahj || project.city,
      utility: project.utility,
      portalName: target?.portalName,
      portalUrl: target?.portalUrl,
      requiredDocuments: projectDocs(project),
      sources: [learnedSource("learned_permit_status", "Permit monitor status check")],
      confidence: "learned",
      notes: "Timeline learned from permit/utility monitor status checks.",
    },
    {
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

export function learnFromSubmissionConfirmation(
  db: AppDb,
  project: ProjectRecord,
  input: { applicationNumber?: string; permitNumber?: string; confirmationNumber?: string },
  eventType = "submission.confirmed",
): PermitUtilityKnowledgeProfile | null {
  const portal = portalFromProject(project);
  return upsertProjectKnowledge(
    db,
    project.id,
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
  /** The scanning job's org. The failure row is org-scoped; the shared profile is not. */
  orgId: string;
  state?: string;
  ahj?: string;
  utility?: string;
  portalName?: string;
  requiredDocuments?: string[];
  notes?: string;
  /** PRIVATE provenance (e.g. the file name). Past-project file names are
   *  "First Last - City, ST.pdf" — a homeowner's name — so this goes only to the org-scoped
   *  failure row and the dedupe signature, never into the shared profile. */
  sourceLabel: string;
  /** What KIND of document taught this (e.g. "correction", "sld"). The shared profile's
   *  source label is built from this, not from the file name. */
  docKind?: string;
  correctionText?: string;
}

export function learnFromHistoricalDocument(
  db: AppDb,
  input: HistoricalDocFacts,
): { profileKey: string; learnedCorrection: boolean } {
  const classification = input.correctionText ? classifyCorrection(input.correctionText) : null;
  const sharedBatchLabel = `batch scan: ${clean(input.docKind).replace(/_/g, " ") || "document"}`;
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
    // A document-KIND label on the shared row, never the file name (see HistoricalDocFacts).
    sources: [learnedSource("learned_batch_import", sharedBatchLabel)],
    confidence: "learned",
    notes: input.notes || "Learned from historical past-project document (batch scan).",
  };
  const profile = upsertKnowledge(db, facts, {
    eventType: "batch_import.document_learned",
    details: { sourceLabel: sharedBatchLabel, hasCorrection: Boolean(classification) },
  });
  if (classification && facts.correction) {
    insertHistoricalFailureExample(db, {
      orgId: input.orgId,
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

// WHERE DID AN AI-RESEARCHED ROW COME FROM? These rows are shared with every tenant, and until
// now a web-grounded answer and a 45-second-timeout fallback to model memory were stored
// identically ("AI AHJ research", seeded, with a portal URL). The research functions return
// `webGrounded` at runtime; it is optional here only because older callers build a result by
// hand (ahjFormAuto's form-URL learner) — those keep the unlabeled legacy source.
//   true      → source label says web-grounded.
//   false     → source label + a note segment say model memory, and NO link is persisted: not
//               portalUrl, not a URL-shaped portalName (upsertKnowledge would promote it back
//               into portalUrl), not one in the notes (form discovery harvests .pdf links there).
//   undefined → unchanged legacy behavior.
type ResearchProvenanceFlag = { webGrounded?: boolean };
function researchProvenance(research: ResearchProvenanceFlag, sourceLabel: string): { modelMemory: boolean; source: KnowledgeSource; note: string } {
  if (research.webGrounded === true) return { modelMemory: false, source: learnedSource("ai_researched", `${sourceLabel} (web-grounded)`), note: "" };
  if (research.webGrounded === false) {
    return {
      modelMemory: true,
      source: learnedSource("ai_researched", `${sourceLabel} (model memory — web search did not run)`),
      note: "Provenance: MODEL MEMORY ONLY — web search did not run, so this research pass stored no portal URL; verify every field against the official site.",
    };
  }
  return { modelMemory: false, source: learnedSource("ai_researched", sourceLabel), note: "" };
}

// Save an AI-researched AHJ profile to the knowledge base so the jurisdiction is
// known next time. Marked confidence "seeded" + source "ai_researched" + a
// human-verification note, because model-researched requirements are advisory
// until a real submittal confirms them.
export function saveResearchedAhjProfile(
  db: AppDb,
  input: { state: string; ahj: string; utility?: string },
  research: AhjResearchResult & ResearchProvenanceFlag & {
    /** The AHJ's forms / applications page the form search named (ahjFormAuto — already checked to
     *  be on the AHJ's own site). Kept as its OWN note segment ("Forms page: <url>"), so it merges
     *  and dedupes by segment and steers the next search (knowledgeResearchHint). */
    formsPageUrl?: string;
    /** A researched URL the write door refused as the portal (researchWithFittedUrl). */
    referenceUrl?: string;
  },
): PermitUtilityKnowledgeProfile {
  const provenance = researchProvenance(research, "AI AHJ research");
  const scrub = (s: string): string => (provenance.modelMemory ? stripUrlsFromModelMemory(s) : s);
  const formsPageSegment = research.formsPageUrl && /^https?:\/\//i.test(research.formsPageUrl) && !provenance.modelMemory
    ? `Forms page: ${research.formsPageUrl}` : "";
  const referenceSegment = referenceLinkSegment(research.referenceUrl, provenance.modelMemory);
  const platform = portalPlatformLabel(research.portalPlatform);
  const platformSegment = platform ? scrub(`Portal platform: ${platform} (reuse existing ${platform} portal automation; only the entry URL + login differ per AHJ).`) : "";
  const noteParts = [
    "AI-researched AHJ profile — verify against the official site before relying on it.",
    provenance.note,
    research.submissionMethod ? `Submission: ${research.submissionMethod}.` : "",
    research.submissionSteps.length ? `Steps: ${research.submissionSteps.join(" → ")}` : "",
    research.tips.length ? `Tips: ${research.tips.join(" | ")}` : "",
  ].filter(Boolean).map(scrub).filter(Boolean);
  const facts: KnowledgeFacts = {
    state: input.state,
    ahj: input.ahj,
    utility: input.utility,
    portalName: scrub(research.portalName),
    portalUrl: provenance.modelMemory ? "" : research.portalUrl,
    portalPlatform: platform,
    submissionMethod: research.submissionMethod,
    requiredDocuments: research.requiredDocuments.map(scrub).filter(Boolean),
    sources: [provenance.source],
    confidence: "seeded",
    // The research blob is one segment; the platform sentence and the forms page are segments of
    // their own (a re-research replaces the platform one — mergeNoteSegments).
    notes: [noteParts.join(" "), platformSegment, formsPageSegment, referenceSegment].filter(Boolean).join(" | "),
  };
  return upsertKnowledge(db, facts, {
    eventType: "ahj.ai_researched",
    details: { ahj: input.ahj, state: input.state, utility: input.utility || "", platform, confidence: research.confidence, docCount: research.requiredDocuments.length, webGrounded: research.webGrounded ?? null },
  });
}

/** A researched URL refused as the portal (an information page, another track's or entity's host,
 *  or one the research itself did not confirm — researchWithFittedUrl) is KEPT, as a reference link
 *  in its own note segment: never portal_url, never launched (issue #8). Model-memory research
 *  stores no links at all. */
function referenceLinkSegment(url: string | undefined, modelMemory: boolean): string {
  const u = clean(url);
  return u && /^https?:\/\//i.test(u) && !modelMemory ? `Reference link (not confirmed as the application portal): ${u}` : "";
}

/** A PERSON'S verified save naming an information page as the portal is refused OUT LOUD (a 409
 *  the editor shows), not silently dropped like an automatic write: they typed it, and a verified
 *  row outranks everything (portal-truth D2 — the one predicate, isInformationalPageUrl). */
function refuseInformationalPortal(input: { portalUrl?: string; portalName?: string }): void {
  for (const u of [clean(input.portalUrl), looksLikeBareUrl(clean(input.portalName)) ? clean(input.portalName) : ""]) {
    if (u && isInformationalPageUrl(u)) {
      throw new HttpError(409, `${u} is an information page (help / guide / document), not an application portal — save the portal's own entry page, where an application is filed.`, { hostRefused: true, code: "not_a_portal" });
    }
  }
}

// Human-verified AHJ profile upsert — a coordinator confirming/correcting what the
// AI researched (e.g. "Hillsboro actually uses email + ProjectDox, not Accela").
// Marks the profile mixed-confidence + a human-verified source so it outranks AI guesses.
export function saveVerifiedAhjProfile(
  db: AppDb,
  input: {
    state: string;
    ahj: string;
    utility?: string;
    portalName?: string;
    portalPlatform?: string;
    portalUrl?: string;
    submissionMethod?: string;
    requiredDocuments?: string[];
    notes?: string;
    /** The verifying user's id (from the session, never the body). */
    verifiedBy?: string;
  },
): PermitUtilityKnowledgeProfile {
  if (!input.ahj?.trim()) throw new Error("ahj is required.");
  refuseInformationalPortal(input);
  const noteParts = [
    "Human-verified AHJ profile.",
    input.portalPlatform ? `Portal platform: ${input.portalPlatform} (reuse existing ${input.portalPlatform} automation; only entry URL + login differ per AHJ).` : "",
    input.submissionMethod ? `Submission: ${input.submissionMethod}.` : "",
    input.notes || "",
  ].filter(Boolean);
  const facts: KnowledgeFacts = {
    state: input.state,
    ahj: input.ahj.trim(),
    utility: input.utility,
    portalName: input.portalName,
    portalUrl: input.portalUrl,
    portalPlatform: input.portalPlatform,
    submissionMethod: input.submissionMethod,
    requiredDocuments: input.requiredDocuments,
    sources: [learnedSource("official", "Human-verified AHJ profile")],
    confidence: "mixed",
    verifiedAt: nowIso(),
    verifiedBy: clean(input.verifiedBy) || "human",
    notes: noteParts.join(" "),
  };
  return upsertKnowledge(db, facts, {
    eventType: "ahj.human_verified",
    details: { ahj: input.ahj, platform: input.portalPlatform || "", method: input.submissionMethod || "" },
  });
}

// Onboard an UNKNOWN utility the same way as an AHJ: save the AI-researched NEM /
// interconnection process as a utility-scoped KB profile (ahj = "" so it matches by
// state+utility for any AHJ). The smart-inverter-settings / disconnect / aggregation
// facts are folded into the notes so the NEM worksheet and a coordinator can see them.
export function saveResearchedUtilityProfile(
  db: AppDb,
  input: { state: string; utility: string; ahj?: string },
  research: UtilityResearchResult & ResearchProvenanceFlag & { referenceUrl?: string },
): PermitUtilityKnowledgeProfile {
  const provenance = researchProvenance(research, "AI utility NEM research");
  const referenceSegment = referenceLinkSegment(research.referenceUrl, provenance.modelMemory);
  const scrub = (s: string): string => (provenance.modelMemory ? stripUrlsFromModelMemory(s) : s);
  const platform = portalPlatformLabel(research.portalPlatform);
  const platformSegment = platform ? scrub(`Portal platform: ${platform} (reuse existing ${platform} automation; only the entry URL + login differ per utility).`) : "";
  const noteParts = [
    "AI-researched utility NEM profile — verify against the utility's official interconnection page before relying on it.",
    provenance.note,
    research.submissionMethod ? `Submission: ${research.submissionMethod}.` : "",
    research.smartInverterSettings ? `Smart inverter settings: ${research.smartInverterSettings}` : "",
    research.meterAggregation ? `Meter aggregation: ${research.meterAggregation}` : "",
    research.acDisconnectRule ? `AC disconnect: ${research.acDisconnectRule}` : "",
    research.exportLimitNote ? `Export limit: ${research.exportLimitNote}` : "",
    research.submissionSteps.length ? `Steps: ${research.submissionSteps.join(" → ")}` : "",
    research.tips.length ? `Tips: ${research.tips.join(" | ")}` : "",
  ].filter(Boolean).map(scrub).filter(Boolean);
  const facts: KnowledgeFacts = {
    state: input.state,
    // ALWAYS the utility's own row (ahj ""), whatever AHJ the research was run for (issue #8). The
    // caller passes the project's AHJ as research CONTEXT; keying the row on it made the NEM result
    // an AHJ-keyed row, and the permit track's KB read (WHERE ahj = ?) and the permit card's
    // "link on file" then served PNM's site as City of Albuquerque's permit portal (rule 5).
    ahj: "",
    utility: input.utility,
    portalName: scrub(research.portalName),
    portalUrl: provenance.modelMemory ? "" : research.portalUrl,
    portalPlatform: platform,
    submissionMethod: research.submissionMethod,
    requiredDocuments: research.requiredDocuments.map(scrub).filter(Boolean),
    sources: [provenance.source],
    confidence: "seeded",
    notes: [noteParts.join(" "), platformSegment, referenceSegment].filter(Boolean).join(" | "),
  };
  return upsertKnowledge(db, facts, {
    eventType: "utility.ai_researched",
    details: { utility: input.utility, state: input.state, platform, confidence: research.confidence, docCount: research.requiredDocuments.length, webGrounded: research.webGrounded ?? null },
  });
}

// ---------------------------------------------------------------------------
// Bulk reference-spreadsheet import (see referenceImport.ts). Imports write a
// SEEDED profile but must never clobber a human-verified one. Human verification
// is recorded in verified_at (isVerifiedKnowledge) — NOT confidence "mixed", which
// an automatic seeded+learned merge also produced and which therefore locked rows
// nobody had checked. The UPDATE would still overwrite portal/notes on a verified
// row, hence the explicit skip here rather than relying on the upsert's lock.
// ---------------------------------------------------------------------------

function isHumanVerifiedProfile(db: AppDb, key: string): boolean {
  return isVerifiedKnowledge(db.get<Row>("SELECT verified_at FROM permit_utility_knowledge WHERE profile_key = ?", [key]));
}

export interface ReferenceUtilityInput {
  state: string;
  utility: string;
  portalName?: string;
  portalUrl?: string;
  requiredDocuments?: string[];
  notes?: string;
  sourceLabel: string;
}

/** Import one utility NEM profile from a reference spreadsheet (seeded, skip verified). */
export function importSeededUtilityKnowledge(db: AppDb, input: ReferenceUtilityInput): "imported" | "skipped_verified" | "skipped_empty" {
  if (isJunkEntityName(input.utility)) return "skipped_empty"; // spreadsheet section header / artifact row
  const utility = input.utility.trim();
  if (!utility) return "skipped_empty";
  const key = knowledgeProfileKey({ state: input.state, ahj: "", utility });
  if (isHumanVerifiedProfile(db, key)) return "skipped_verified";
  upsertKnowledge(db, {
    state: input.state,
    ahj: "",
    utility,
    portalName: input.portalName,
    portalUrl: input.portalUrl,
    requiredDocuments: input.requiredDocuments,
    sources: [learnedSource("sanitized_reference", input.sourceLabel)],
    confidence: "seeded",
    notes: input.notes,
  }, { eventType: "utility.reference_imported", details: { utility, state: input.state } });
  return "imported";
}

export interface ReferenceAhjInput {
  state: string;
  ahj: string;
  portalName?: string;
  portalUrl?: string;
  requiredDocuments?: string[];
  notes?: string;
  sourceLabel: string;
}

/** Import one AHJ process profile from a reference spreadsheet (seeded, skip verified). */
export function importSeededAhjKnowledge(db: AppDb, input: ReferenceAhjInput): "imported" | "skipped_verified" | "skipped_empty" {
  if (isJunkEntityName(input.ahj)) return "skipped_empty"; // spreadsheet section header / artifact row
  const ahj = input.ahj.trim();
  if (!ahj) return "skipped_empty";
  const key = knowledgeProfileKey({ state: input.state, ahj, utility: "" });
  if (isHumanVerifiedProfile(db, key)) return "skipped_verified";
  upsertKnowledge(db, {
    state: input.state,
    ahj,
    utility: "",
    portalName: input.portalName,
    portalUrl: input.portalUrl,
    requiredDocuments: input.requiredDocuments,
    sources: [learnedSource("sanitized_reference", input.sourceLabel)],
    confidence: "seeded",
    notes: input.notes,
  }, { eventType: "ahj.reference_imported", details: { ahj, state: input.state } });
  return "imported";
}

// Human-verified utility NEM profile upsert — a coordinator confirming/correcting what
// the AI researched (or teaching a utility from scratch). Marks it mixed-confidence +
// a human-verified source so it outranks AI guesses.
export function saveVerifiedUtilityProfile(
  db: AppDb,
  input: {
    state: string;
    utility: string;
    ahj?: string;
    portalName?: string;
    portalPlatform?: string;
    portalUrl?: string;
    submissionMethod?: string;
    requiredDocuments?: string[];
    smartInverterSettings?: string;
    meterAggregation?: string;
    acDisconnectRule?: string;
    exportLimitNote?: string;
    notes?: string;
    /** The verifying user's id (from the session, never the body). */
    verifiedBy?: string;
  },
): PermitUtilityKnowledgeProfile {
  if (!input.utility?.trim()) throw new Error("utility is required.");
  refuseInformationalPortal(input);
  const noteParts = [
    "Human-verified utility NEM profile.",
    input.portalPlatform ? `Portal platform: ${input.portalPlatform} (reuse existing ${input.portalPlatform} automation; only entry URL + login differ per utility).` : "",
    input.submissionMethod ? `Submission: ${input.submissionMethod}.` : "",
    input.smartInverterSettings ? `Smart inverter settings: ${input.smartInverterSettings}` : "",
    input.meterAggregation ? `Meter aggregation: ${input.meterAggregation}` : "",
    input.acDisconnectRule ? `AC disconnect: ${input.acDisconnectRule}` : "",
    input.exportLimitNote ? `Export limit: ${input.exportLimitNote}` : "",
    input.notes || "",
  ].filter(Boolean);
  const facts: KnowledgeFacts = {
    state: input.state,
    ahj: input.ahj || "",
    utility: input.utility.trim(),
    portalName: input.portalName,
    portalUrl: input.portalUrl,
    portalPlatform: input.portalPlatform,
    submissionMethod: input.submissionMethod,
    requiredDocuments: input.requiredDocuments,
    sources: [learnedSource("official", "Human-verified utility NEM profile")],
    confidence: "mixed",
    verifiedAt: nowIso(),
    verifiedBy: clean(input.verifiedBy) || "human",
    notes: noteParts.join(" "),
  };
  return upsertKnowledge(db, facts, {
    eventType: "utility.human_verified",
    details: { utility: input.utility, platform: input.portalPlatform || "", method: input.submissionMethod || "" },
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

export type KnowledgeDeleteResult =
  | { status: "not_found" }
  | { status: "verified_needs_confirmation"; profile: PermitUtilityKnowledgeProfile }
  | { status: "deleted"; profile: PermitUtilityKnowledgeProfile; removed: Record<string, number> };

// The tables whose profile_key is a FOREIGN KEY into permit_utility_knowledge (db.ts, with
// foreign_keys = ON). The row cannot go while any of these still points at it, and they are the
// evidence the row was built from: leaving them would let the next rebuildKnowledgeRollup /
// mbox re-import resurrect exactly the entry a person just removed (the poisoned Albuquerque row,
// issue #8). So a delete takes them with it, and the counts go in the audit.
const KNOWLEDGE_CHILD_TABLES = [
  "knowledge_events",
  "historical_project_fingerprints",
  "historical_failure_examples",
  "mbox_learning_records",
] as const;

/**
 * DELETE ONE SHARED KB ROW — the operator's way out of a poisoned or junk entry (issue #26).
 * A HUMAN-VERIFIED row (isVerifiedKnowledge, rule 3) is refused unless the caller passes
 * confirmVerified: nobody wipes a person's verified knowledge by a misclick. Authorization and
 * the audit entry live at the route edge (admin-only), like every other admin write.
 */
export function deleteKnowledgeProfile(db: AppDb, profileKey: string, options: { confirmVerified: boolean }): KnowledgeDeleteResult {
  const row = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [profileKey]);
  if (!row) return { status: "not_found" };
  const profile = mapKnowledge(row);
  if (isVerifiedKnowledge(row) && !options.confirmVerified) return { status: "verified_needs_confirmation", profile };
  const removed: Record<string, number> = {};
  db.transaction(() => {
    for (const table of KNOWLEDGE_CHILD_TABLES) {
      removed[table] = Number(db.get<Row>(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_key = ?`, [profileKey])?.n ?? 0);
      db.run(`DELETE FROM ${table} WHERE profile_key = ?`, [profileKey]);
    }
    db.run("DELETE FROM permit_utility_knowledge WHERE profile_key = ?", [profileKey]);
  });
  return { status: "deleted", profile, removed };
}

// Find the best-matching LEARNED profile for a project's jurisdiction, so the
// application-doc builder can use the AHJ's real learned requirements instead of
// a generic fallback. Tries most-specific key first (state+ahj+utility) down to
// ahj-only, and only returns a profile that actually carries required documents.
export function findLearnedProfileForProject(
  db: AppDb,
  input: { state?: string; ahj?: string; utility?: string },
  opts: { requireDocs?: boolean } = {},
): PermitUtilityKnowledgeProfile | null {
  if (!input.ahj) return null;
  const requireDocs = opts.requireDocs !== false;
  const candidates = [
    knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: input.utility }),
    knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: "" }),
    knowledgeProfileKey({ state: "", ahj: input.ahj, utility: input.utility }),
    knowledgeProfileKey({ state: "", ahj: input.ahj, utility: "" }),
  ];
  for (const key of candidates) {
    const row = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
    if (row) {
      const profile = withoutInformationalPortal(mapKnowledge(row));
      if (!requireDocs || profile.requiredDocuments.length) return profile;
    }
  }
  // Fuzzy fallback so imported reference rows ("Woodburn" from a spreadsheet)
  // still serve a project entered as "City of Woodburn". Exact keys above stay
  // authoritative; this only fires when every exact candidate missed.
  const fuzzy = findKnowledgeByName(db, "ahj", input.ahj, input.state);
  if (fuzzy && (!requireDocs || fuzzy.requiredDocuments.length)) return fuzzy;
  return null;
}

/** A ROW WRITTEN BEFORE THE WRITE DOOR (portal-truth D2) may still hold an information page as its
 *  portal: the profile the stage / the learner / the research hint read never returns it as one.
 *  The row itself is untouched (a verified row is never auto-edited); the listing still shows it. */
export function withoutInformationalPortal(profile: PermitUtilityKnowledgeProfile): PermitUtilityKnowledgeProfile {
  const url = clean(profile.portalUrl);
  const name = clean(profile.portalName);
  const badUrl = Boolean(url) && isInformationalPageUrl(url);
  const badName = looksLikeBareUrl(name) && isInformationalPageUrl(name);
  if (!badUrl && !badName) return profile;
  return { ...profile, ...(badUrl ? { portalUrl: "" } : {}), ...(badName ? { portalName: "" } : {}) };
}

// ---------------------------------------------------------------------------
// Fuzzy KB resolution for the auto-learn planner. Exact profile_key lookups miss
// most imported reference rows because operators type short names ("PGE", "APS")
// while the spreadsheets carry legal names ("Portland General Electric",
// "Arizona Public Service Company"). Normalized-token + acronym matching bridges
// that so an unknown AHJ/utility still gets its imported notes at learn time.
// ---------------------------------------------------------------------------

// Bare US state/territory names and pure-digit strings are section headers /
// artifacts from reference spreadsheets, not real entities — never import them
// as utilities/AHJs and never fuzzy-match against them ("Idaho Power" must not
// resolve to a junk row named "Idaho").
const US_STATE_NAMES = new Set([
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia",
  "hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland",
  "massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey",
  "new mexico","new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina",
  "south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming",
  "district of columbia","puerto rico",
]);

export function isJunkEntityName(name: unknown): boolean {
  const n = normalize(name);
  if (!n || n === "unknown") return true;
  if (/^[\d ]+$/.test(n)) return true;
  return US_STATE_NAMES.has(n);
}

const KB_MATCH_STOPWORDS = new Set([
  "city", "of", "county", "town", "township", "village", "borough", "parish",
  "company", "co", "inc", "corp", "corporation", "llc", "the", "and",
  "electric", "power", "energy", "utility", "utilities", "light", "gas",
  "dept", "department", "district", "cooperative", "coop", "authority", "services",
]);

function kbTokens(value: string): string[] {
  return normalize(value).split(" ").filter((t) => t && t !== "unknown");
}

function kbCompact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

// Initials of the multi-word name: "Arizona Public Service Company" -> "apsc".
function kbAcronym(value: string): string {
  const toks = kbTokens(value);
  return toks.length >= 2 ? toks.map((t) => t[0]).join("") : "";
}

/** Score how well a project-entered name matches a KB row name (0-100). */
export function knowledgeNameMatchScore(projectValue: string, kbValue: string): number {
  const a = kbCompact(projectValue);
  const b = kbCompact(kbValue);
  if (!a || !b || a === "unknown" || b === "unknown") return 0;
  if (a === b) return 100;
  // Acronym: short entered value vs long KB legal name (and vice versa).
  const acrB = kbAcronym(kbValue);
  if (acrB && a.length >= 2 && (acrB === a || (a.length >= 3 && acrB.startsWith(a)))) return 78;
  const acrA = kbAcronym(projectValue);
  if (acrA && b.length >= 2 && (acrA === b || (b.length >= 3 && acrA.startsWith(b)))) return 78;
  // Containment after compaction ("woodburn" vs "city of woodburn").
  if (a.length >= 5 && b.includes(a)) return 82;
  if (b.length >= 5 && a.includes(b)) return 82;
  // Meaningful-token overlap.
  const ta = kbTokens(projectValue).filter((t) => !KB_MATCH_STOPWORDS.has(t));
  const tb = kbTokens(kbValue).filter((t) => !KB_MATCH_STOPWORDS.has(t));
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t));
  const ratio = shared.length / Math.max(ta.length, tb.length);
  if (shared.length >= 2 && ratio >= 0.6) return 60 + Math.round(ratio * 15);
  if (shared.length === 1 && ta.length === 1 && tb.length === 1) return 65; // single distinctive token each
  return 0;
}

function findKnowledgeByName(
  db: AppDb,
  kind: "ahj" | "utility",
  value: string | undefined,
  state: string | undefined,
): PermitUtilityKnowledgeProfile | null {
  const wanted = clean(value);
  if (!wanted) return null;
  const stateNorm = normalize(state || "");
  // 1) Exact profile_key candidates (cheap, precise).
  const exactKeys =
    kind === "utility"
      ? [profileKey({ state, utility: wanted }), profileKey({ utility: wanted })]
      : [profileKey({ state, ahj: wanted }), profileKey({ ahj: wanted })];
  for (const key of exactKeys) {
    const row = db.get<Row>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
    if (row) return withoutInformationalPortal(mapKnowledge(row));
  }
  // 2) Fuzzy scan over rows of the same kind (thousands of rows is fine for SQLite+JS).
  const col = kind === "utility" ? "utility" : "ahj";
  const rows = db.query<Row>(`SELECT * FROM permit_utility_knowledge WHERE ${col} != ''`);
  let best: { profile: PermitUtilityKnowledgeProfile; score: number } | null = null;
  for (const row of rows) {
    const profile = mapKnowledge(row);
    if (isJunkEntityName(kind === "utility" ? profile.utility : profile.ahj)) continue;
    const rowState = normalize(profile.state || "");
    // A row pinned to a different state never matches; empty-state rows match anywhere.
    if (stateNorm !== "unknown" && rowState !== "unknown" && rowState !== stateNorm) continue;
    // The one utility identity first (utilityIdentity, judged in the PROJECT's state): "PacifiCorp"
    // IS "Pacific Power" in Oregon (the fuzzy scorer scores that 0), and "Pacific Gas and Electric"
    // is provably NOT "Pacific Power" (the fuzzy scorer scores that 65).
    let score = kind === "utility" && sameUtilityEntity(state, wanted, profile.utility)
      ? 100
      : kind === "utility" && provablyDifferentUtility(state, wanted, profile.utility)
        ? 0
        : knowledgeNameMatchScore(wanted, kind === "utility" ? profile.utility : profile.ahj);
    if (!score) continue;
    if (rowState !== "unknown" && rowState === stateNorm) score += 6; // prefer state-pinned rows
    if (isVerifiedKnowledge(profile)) score += 4; // human-verified beats seeded on ties
    if (profile.notes) score += 2;
    if (!best || score > best.score) best = { profile, score };
  }
  return best && best.score >= 60 ? withoutInformationalPortal(best.profile) : null;
}

export interface LearnKnowledgeMatch {
  utility: PermitUtilityKnowledgeProfile | null;
  ahj: PermitUtilityKnowledgeProfile | null;
}

/** Resolve the best KB rows for a learn run: the utility's row AND the AHJ's row,
 *  via exact keys first then fuzzy name matching, state-filtered. Either may be null. */
export function findKnowledgeForLearn(
  db: AppDb,
  input: { state?: string; ahj?: string; utility?: string },
): LearnKnowledgeMatch {
  return {
    utility: findKnowledgeByName(db, "utility", input.utility, input.state),
    ahj: findKnowledgeByName(db, "ahj", input.ahj, input.state),
  };
}

export interface KnowledgeResearchHint {
  /** Compact prompt block for the research LLM: what we already know, marked verify-first. */
  text: string;
  /** Direct .pdf URLs found in the KB row (imported forms/application links) — free
   *  download candidates for the form-acquisition pipeline before/alongside web search. */
  pdfUrls: string[];
}

/** What the KB already knows about this AHJ/utility, packaged as a research hint so
 *  the onboarding web-search starts from the imported portal/notes instead of blind.
 *  Uses the same fuzzy resolver as the learn planner. Null when nothing matches. */
export function knowledgeResearchHint(
  db: AppDb,
  input: { state?: string; ahj?: string; utility?: string },
  scope: "ahj" | "utility",
): KnowledgeResearchHint | null {
  let profile: PermitUtilityKnowledgeProfile | null = null;
  try {
    const match = findKnowledgeForLearn(db, input);
    profile = scope === "ahj" ? match.ahj : match.utility;
  } catch { return null; }
  if (!profile) return null;
  const name = scope === "ahj" ? profile.ahj : profile.utility;
  const pdfUrls = [
    ...new Set(
      (`${profile.notes} ${profile.portalUrl}`.match(/https?:\/\/[^\s"'<>)\]]+\.pdf\b[^\s"'<>)\]]*/gi) || []).map((u) => u.trim()),
    ),
  ].slice(0, 5);
  // The same filter as the learn planner's KB block: this text goes to a model too (llm research).
  const notes = clean(learnSafeNotes(profile.notes)).slice(0, 700);
  // A STATEWIDE PORTAL NAMED ONLY IN WORDS is not asserted (portal-truth D1). Learned rows carry the
  // generic fallback's own "Oregon ePermitting" laundered in (City of Beaverton, Seaside, Willamina),
  // and "Known portal: Oregon ePermitting" steered research straight back to the statewide portal
  // for a city that files on its own. Omitted — at read; the row is untouched — unless a PERSON
  // verified the row or the row itself holds a statewide URL. Judged under the asking state and the
  // row's own (a row filed under the wrong state still carries Oregon's words).
  const statewideWordsOnly = !isVerifiedKnowledge(profile) && !looksLikeBareUrl(clean(profile.portalName)) && [input.state, profile.state].some((st) =>
    classifyChannelWords(st, profile!.portalName) === "statewide" && !isStatewidePortalUrl(st, profile!.portalUrl));
  const portalName = statewideWordsOnly ? "" : profile.portalName;
  const text = [
    `Our internal knowledge base already has a ${scope === "ahj" ? "jurisdiction" : "utility"} record for "${name}"${profile.state ? ` (${profile.state})` : ""} [confidence: ${profile.confidence}]:`,
    portalName ? `- Known portal: ${portalName}` : "",
    profile.portalUrl ? `- Known portal URL: ${profile.portalUrl}` : "",
    profile.requiredDocuments.length ? `- Known required documents: ${profile.requiredDocuments.slice(0, 12).join("; ")}` : "",
    notes ? `- Notes: ${notes}` : "",
    "Treat this as a STARTING POINT for your search — confirm against the official site (it may be stale) and fill the gaps.",
  ].filter(Boolean).join("\n").slice(0, 1400);
  // A record with only a name adds nothing worth prompting with.
  if (!portalName && !profile.portalUrl && !profile.requiredDocuments.length && !notes) return null;
  return { text, pdfUrls };
}

export function seedInitialKnowledgeBase(db: AppDb): void {
  seedOfficialKnowledge(db);
  seedSanitizedAhjProfiles(db);
  seedOperatorRulings(db);
  seedDeficiencyCureWindows(db);
  backfillExistingProjectLearning(db);
}

// A UTILITY'S CURE WINDOW for an interconnection deficiency, in days, by the one state-gated
// identity (utilityIdentityOf). Seed data: it lands on a utility row only where that row has no
// window yet, so a window a person typed is never overwritten (rule 3), and the KPI resolver
// (kpi.utilityDeficiencyCureDays) reads the row first and this table only for a row it has not
// reached. Every other utility takes the 5-day default until its record says otherwise.
export const SEEDED_DEFICIENCY_CURE_DAYS: Partial<Record<UtilityIdentity, number>> = {
  pacific_gas_electric: 10,
};

export function seededDeficiencyCureDays(state: unknown, utility: unknown): number | null {
  const identity = utilityIdentityOf(state, utility);
  return (identity && SEEDED_DEFICIENCY_CURE_DAYS[identity]) || null;
}

function seedDeficiencyCureWindows(db: AppDb): void {
  const rows = db.query<{ id: string; state: string; utility: string }>(
    "SELECT id, state, utility FROM permit_utility_knowledge WHERE ahj = '' AND utility <> '' AND deficiency_cure_days IS NULL",
  );
  for (const row of rows) {
    const days = seededDeficiencyCureDays(row.state, row.utility);
    if (days) db.run("UPDATE permit_utility_knowledge SET deficiency_cure_days = ? WHERE id = ? AND deficiency_cure_days IS NULL", [days, row.id]);
  }
}

// ---------------------------------------------------------------------------
// OPERATOR RULINGS — decisions a human made about a jurisdiction, recorded as
// knowledge with their provenance and their date.
//
// An operator stating a rule IS a human gesture, so these land human-verified
// ("mixed") rather than "seeded" — that is the rule-3 exception, not a breach of
// it: rule 3 protects human-verified knowledge from being overwritten by imports
// and research, and this IS the human. What makes it legitimate is the
// provenance: every ruling carries an `official` source whose label names the
// operator ruling and whose observedAt is the DATE THEY RULED, not the date the
// server happened to boot — so a later reader can tell a human decision from an
// import, and can see how old the decision is.
//
// Runs AFTER seedSanitizedAhjProfiles on purpose: the workbook import lands
// first, then the ruling is layered over it. Idempotent by construction —
// upsertKnowledge merges note SEGMENTS and dedupes sources on
// (sourceType|label|url), so booting twice produces the identical row.
// ---------------------------------------------------------------------------

interface OperatorRuling {
  /** ISO date the operator made the call. Becomes the source's observedAt. */
  ruledOn: string;
  state: string;
  /** Every AHJ SPELLING this ruling must be findable under. permit_utility_knowledge
   *  keys on the normalized name, so "Salem" and "City of Salem" are DIFFERENT rows
   *  and a ruling recorded on one is invisible from the other. */
  ahjSpellings: string[];
  /** The ruling itself, as one note segment. */
  note: string;
  /** Rows superseded by this ruling — stamped with a pointer segment so a reader who
   *  lands on the old row is told where the answer moved. Not deleted: a stored row is
   *  a matching key, and deleting one silently changes what an old lookup resolves to. */
  supersedes?: Array<{ ahj: string; note: string }>;
}

const OPERATOR_RULINGS: OperatorRuling[] = [
  {
    // 2026-09-19: the operator ruled on Salem's stamp rule after two reference rows
    // were found disagreeing about it. The FUNCTIONAL fix is in
    // backend/data/reference-ahj-processes.json (Salem is now its own row with
    // requiresStructuralStamp:false, and is no longer listed on the combined Marion
    // County row) because resolveStampRequirement reads THAT, not this table. This
    // record is the provenance and the operator-visible statement of the same rule.
    ruledOn: "2026-09-19",
    state: "OR",
    ahjSpellings: ["Salem", "City of Salem"],
    note:
      "OPERATOR RULING 2026-09-19: Salem does NOT require a PE stamp on the PRESCRIPTIVE path; "
      + "a PE stamp and sealed structural letter ARE required on the ENGINEERED (non-prescriptive) path — "
      + "the same strict split as Coos Bay. Recorded human-verified with operator provenance. "
      + "Before this ruling the answer depended on how the AHJ was spelled: the reference workbook's bare "
      + "\"Salem\" row said a structural stamp was always required while its combined "
      + "\"Marion Co/Hubbard/Keizer/Mount Angel/Salem/Gervais\" row said the opposite, and the two tied on "
      + "match score so file order decided which one answered.",
    supersedes: [
      {
        ahj: "Marion Co/Hubbard OR/Keizer OR / Mount Angel / Salem / Gervais",
        note:
          "SALEM SPLIT OUT 2026-09-19 (operator ruling): this combined Marion County row no longer covers Salem. "
          + "Salem is its own jurisdiction row — see the Salem profile for its stamp rule. Hubbard, Keizer, "
          + "Mount Angel and Gervais still resolve here.",
      },
    ],
  },
];

function seedOperatorRulings(db: AppDb): void {
  for (const ruling of OPERATOR_RULINGS) {
    const source: KnowledgeSource = {
      label: `Operator ruling ${ruling.ruledOn}`,
      url: "",
      sourceType: "official",
      // The DATE OF THE DECISION, not of this boot — an operator reading the row needs to
      // know how old the call is, and nowIso() here would silently refresh it every restart.
      observedAt: `${ruling.ruledOn}T00:00:00.000Z`,
    };
    for (const ahj of ruling.ahjSpellings) {
      upsertKnowledge(
        db,
        {
          state: ruling.state, ahj, utility: "", notes: ruling.note, sources: [source], confidence: "mixed",
          // Verified on the DATE OF THE RULING, for the same reason as observedAt above.
          verifiedAt: source.observedAt, verifiedBy: `operator ruling ${ruling.ruledOn}`,
        },
        { eventType: "ahj.operator_ruling", details: { ahj, state: ruling.state, ruledOn: ruling.ruledOn } },
      );
    }
    for (const superseded of ruling.supersedes || []) {
      // Only stamp a row that actually exists — creating one would invent a jurisdiction.
      const key = profileKey({ state: ruling.state, ahj: superseded.ahj, utility: "" });
      if (!db.get<Row>("SELECT profile_key FROM permit_utility_knowledge WHERE profile_key = ?", [key])) continue;
      upsertKnowledge(db, { state: ruling.state, ahj: superseded.ahj, utility: "", notes: superseded.note, sources: [source] });
    }
  }
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
      // Real portal-ENTRY URL (the PowerClerk login) so the universal self-seed launches the
      // actual interconnection form, not the public resource-library landing page. The
      // resource library remains cited under `sources` below for reference.
      portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login",
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
      notes: "Official PGE seed for interconnection/NEM document package. Portal: PowerClerk (pgenm.powerclerk.com). Smart inverter settings: POLICY ANSWER = Yes — 'Will you be using PGE recommended smart inverter settings?' must be answered Yes for standard residential projects using UL 1741-SB listed inverters (IQ8, IQ7, SolarEdge HD-Wave, Tesla Inverter). This is a portal Yes/No radio — select Yes. Export limit: POLICY ANSWER = No — 'Do you propose to limit the export capacity?' must be answered No for standard residential NEM (full export allowed; systems over 25 kW are Tier 2). Meter aggregation: POLICY ANSWER = No — standard single-home residential does not aggregate meters. AC disconnect: lockable AC disconnect required within 10 ft of the PGE meter; max AC output without a disconnect is 7.2 kW at 240V single-phase. Meter base must meet ESR 3.10.2.1 (no ringless/banjo bases). Any required (asterisk-marked) Yes/No radio or dropdown for smart inverter settings or export limit MUST be answered per the policy answers above.",
    },
    {
      state: "OR",
      ahj: "",
      utility: "Pacific Power",
      portalName: "Pacific Power Customer Generation Portal",
      // Real portal ENTRY url: PacifiCorp customer generation runs on a PowerClerk tenant
      // (pacificorpnetmetering.powerclerk.com); pacificpower.net is the marketing/resource site,
      // kept as a source citation below. Mirrors the PGE seed fix.
      portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login",
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
      notes: "Official Pacific Power seed for customer generation/NEM path. Smart inverter settings work like PGE: a Yes/No election to use the utility's recommended smart inverter settings — answer Yes for UL 1741-SB listed inverters, plus an inverter spec/cut-sheet upload (not a grid-profile drawing). Witness test + meter exchange may apply; some projects exceed 70 business days when equipment upgrades are needed.",
    },
    {
      // Issue #31: research kept PNM's program page (www.pnm.com/customer-solar-program1) as the NEM
      // portal while naming PowerClerk; the owner confirmed PNM's own PowerClerk tenant live
      // (2026-10-02). SEEDED, never verified (rule 3): the owner verifies it in the UI.
      state: "NM",
      ahj: "",
      utility: "PNM",
      portalName: "PowerClerk",
      portalPlatform: "PowerClerk",
      portalUrl: "https://pnminterconnect.powerclerk.com/MvcAccount/Login",
      sources: [officialSource("PNM Customer Solar Program", "https://www.pnm.com/customer-solar-program1")],
      confidence: "seeded",
      notes: "PNM (Public Service Company of New Mexico) takes residential interconnection applications on its PowerClerk tenant (pnminterconnect.powerclerk.com); www.pnm.com pages are program information, not the portal. Seeded — verify before relying on it.",
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

// Teach the shared knowledge base from projects that predate a learning change.
// Deliberately cross-tenant: an AHJ's behaviour learned from one job should help
// everyone (see the shared-knowledge policy in CLAUDE.md).
//
// BOUNDED. This used to `SELECT * FROM projects` unbounded on every single startup,
// re-walking the whole table plus several per-project queries even though every
// project was already backfilled and guarded by eventExists. That is fine at fifty
// projects and a slow boot at fifty thousand. It now takes only projects with no
// backfill event yet, a batch at a time, and says so when it caps out — the work is
// idempotent, so the remainder is simply picked up on the next restart.
const BACKFILL_BATCH = Number(process.env.KB_BACKFILL_BATCH || 500);

function backfillExistingProjectLearning(db: AppDb): void {
  const projects = db.query<Row>(
    `SELECT p.* FROM projects p
     WHERE COALESCE(p.learning_excluded, 0) = 0
       -- An excluded project never earns its backfill event (it learns nothing), so without
       -- this filter it would be re-selected on every boot and could fill the whole batch.
       AND NOT EXISTS (
       SELECT 1 FROM knowledge_events e
       WHERE e.project_id = p.id AND e.event_type = 'backfill.v2.project'
     )
     ORDER BY p.created_at ASC
     LIMIT ?`,
    [Math.max(1, BACKFILL_BATCH)],
  );
  if (projects.length >= BACKFILL_BATCH) {
    console.log(`[kb] backfilling ${projects.length} project(s) this start; more remain and will run on the next restart.`);
  }
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
        text(correction.id),
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

    for (const status of db.query<Row>("SELECT * FROM permit_status_checks WHERE project_id = ? ORDER BY created_at ASC, rowid ASC", [project.id])) {
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
