// ---------------------------------------------------------------------------
// Autonomous portal learning — "learn a new AHJ/utility portal without a human
// recording it, then verify the fill is accurate before trusting the recipe."
//
// Flow (the hybrid the operator asked for):
//   1. LEARN  — an LLM-driven Playwright pass (AutoLearnAdapter) logs in with the
//      client's stored credential, reads each form page, fills it from the project
//      data, advances page-to-page, and STOPS at the review screen. It records every
//      action as a reusable recipe and never clicks final submit or pay.
//   2. VERIFY — the review-screen field/value pairs are checked against the project's
//      authoritative data (LLM verifier, deterministic fallback). Only a clean,
//      contradiction-free fill is allowed to promote the recipe to "complete".
//   3. REPLAY — once trusted, future projects on this AHJ/utility replay the recipe
//      deterministically (fast, no LLM cost) via the existing RecipeAdapter.
//
// Safety: the learner never clicks final submit / resubmit / fee payment / CAPTCHA /
// MFA. The final-submit button is recorded (isFinalSubmit) so a replay knows where the
// filing click is; it is clicked only under the one gate (portalSafety.mayClickFinalSubmit /
// FINAL_SUBMIT_GATE_SENTENCE — a named person's approval of that run AND
// PORTAL_ALLOW_FINAL_SUBMIT=1); there is no per-portal opt-in. A
// low-confidence or unverified pass is left as a draft for human review, never trusted.
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import type { AppDb } from "./db";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { FINAL_SUBMIT_GATE_SENTENCE } from "../../shared/src/portalSafety";
import { learnPortal, browserLimiter } from "../../portal-bot/src/index";
import { resolveHeadless } from "../../portal-bot/src/browser";
import { compareReviewFields } from "../../portal-bot/src/reviewScreenScraper";
import type { LearnPlanRequest, LearnPlanResponse } from "../../portal-bot/src/adapters/autoLearnAdapter";
import { createLLMProvider, getRecentLlmCalls } from "./llm";
import { getDecryptedCredentialForPortal, getDecryptedCredentialByUrl, listPortalCredentials, nearestStoredLogins, recordLoginOutcome } from "./portalCredentials";
import { learnNoteTopicsFromMisses, activeLearnedNoteTerms } from "./noteTopics";
import { RECIPE_FIELD_DESCRIPTIONS, deadFieldBindings, resolveRecipeFieldValues, startPortalRecording, savePortalRecipeSteps, getPortalRecipe, convertLiteralsToBoundFields, findAnyRecipeForProject, appendHumanPatchSteps, promoteRecordingIfEligible, recipeProfileKey, portalEntityEvidence, stampCompanyAttestations, withholdClientLicenceLiteralsFor } from "./portalRecipes";
import { HUMAN_SUBMIT_OBSERVED_NOTE } from "../../portal-bot/src/humanCapture";
import { projectDocsByType } from "./projectDocuments";
import { submissionDocumentsByType, uploadDocumentGuard } from "./submissionDocuments";
import { logger } from "./logger";
import { buildUtilityPackage } from "./docSplitter";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { formPurposeMismatch } from "./formPurpose";
import { looksBotBlocked } from "./runAbort";
import { id } from "./ids";
import { knowledgeProfileKey, findKnowledgeForLearn, isVerifiedKnowledge, learnSafeNotes } from "./knowledgeBase";
import { hostFitsTrackAndEntity, trackSafeUrl, type PortalUrlSource } from "./portalChannel";
import { getCodeProfile } from "./codeProfiles";
import { certifiedNamesForMake } from "./cecEquipment";
import { recordDraftTouch, type DraftTouch } from "./draftLedger";
import { issuingAgencyFor } from "./permitProcess";
import { DECLARED_VALUATION_FIELD, rebindsToValuation } from "./valuation";

/** The submittal track an AHJ learn files, from the recipe discipline it will be keyed under
 *  (authoritative — the value the recipe lookup asks for), else the requested permit type.
 *  null = no permit named: issuingAgencyFor then answers with the AHJ-wide agency. */
function learnTrackFor(discipline: string | undefined, permitType: "structural" | "electrical" | undefined): string | null {
  const d = String(discipline ?? "").trim().toLowerCase();
  if (d === "electrical") return "electrical";
  if (d === "structural") return "building";
  if (d === "combo") return "combo";
  if (permitType === "electrical") return "electrical";
  if (permitType === "structural") return "building";
  return null;
}

export interface AutoLearnResult {
  recipe: PortalRecipe;
  /** "trusted" = verified accurate and promoted to complete; "draft" = recorded but
   *  needs human verification; "paused" = a challenge (MFA/CAPTCHA) stopped the learn;
   *  "failed" = couldn't learn the portal. */
  status: "trusted" | "draft" | "paused" | "failed";
  pauseReason: string | null;
  pageCount: number;
  /** One line per page the walk saw — carried out of the adapter so a finished benchmark can
   *  be asked WHY a portal stopped where it did, instead of sending the next session back to
   *  the portal to re-learn what this run already watched happen. */
  pageTrace?: string[];
  finalSubmitRecorded: boolean;
  verification: {
    accurate: boolean;
    confidence: "low" | "medium" | "high";
    matches: Array<{ label: string; expected: string; found: string; ok: boolean }>;
    issues: string[];
  };
  message: string;
  /** Path of this run's debug bundle (data/learn-runs/<runId>) — everything needed to
   *  troubleshoot the run. Download it zipped via GET /api/learn-runs/<runId>/bundle.zip. */
  debugDir: string | null;
}

// Lines in the long design/plan-set texts that answer the portal's JUDGMENT questions.
// Keyed on the topics the planner prompt's solar defaults reference: disconnect location,
// meter mounting, battery/ESS + backup mode, export limiting, smart-inverter settings,
// attic runs, panel/service upgrades, and tilt/azimuth/tracking for array rows.
const DESIGN_NOTE_TOPICS = /\bdisconnect\b|within 10|meter.{0,20}pole|pole.{0,20}(mount|meter)|\bbattery\b|\bess\b|powerwall|encharge|backup|export (limit|capacit)|limit(ed|ing)? export|ul\s*1741|smart inverter|attic (run|fan)|shutdown -|rapid shutdown|main panel|service upgrade|\bmpu\b|derat|tilt|azimuth|tracking|ground.?mount|existing (pv|solar|system|array|generation)|combined system|system addition/i;

// Extract only decision-relevant lines from the parser snapshot's long text fields.
// Deterministic and cheap (no LLM); capped so it can never re-inflate the prompt.
// extraTerms are SELF-TAUGHT topics (see noteTopics.ts): words from required portal
// questions that past runs couldn't answer — lines mentioning them are included too.
export function designNotesDigest(project: ProjectRecord, maxChars = 1200, extraTerms: string[] = []): string {
  const learned = extraTerms.length
    ? new RegExp(extraTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : null;
  return digestLines(project, maxChars, (line) => DESIGN_NOTE_TOPICS.test(line) || (learned ? learned.test(line) : false), projectSecretValues(project));
}

// SAFETY RULE 2 — which parser/field keys hold a secret. ONE predicate for the planner's key
// filter and for collecting the values to redact from free text. Who HOLDS the account
// (ubAccountHolder*) is identity the portal asks for, not a secret (see buildPortalPlanner).
const PLANNER_SECRET_KEY = /acc(oun)?t|meter|ssn|social|passw|agreement\s*num|application\s*num|agreementnumber|applicationnumber|\besi\b|esiid|service\s*agreement/i;
const PLANNER_IDENTITY_KEY = /^ubAccountHolder/i;
export function isPlannerSecretKey(k: string): boolean {
  return PLANNER_SECRET_KEY.test(k) && !PLANNER_IDENTITY_KEY.test(k);
}

/** Every known secret on the project: the canonical account/meter plus any parser-snapshot
 *  value under a secret key (the parser's own aliases: "account", "meter", "ubMeterNumber"...). */
export function projectSecretValues(project: ProjectRecord): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s.length >= 4) out.add(s);
  };
  add(project.accountNumber);
  add(project.meterNumber);
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(snap)) {
    if ((typeof v === "string" || typeof v === "number") && isPlannerSecretKey(k)) add(v);
  }
  return [...out];
}

/** SAFETY RULE 2 — a secret EMBEDDED in free text. The planner's value filter drops a field
 *  whose WHOLE value equals a secret; prose is not caught that way. Live (City of Jefferson,
 *  2026-09-25): the site-plan line "...tied to exterior utility meter #77 902 323, new PV AC
 *  disconnect ... within 10' of the utility meter" matched the disconnect topic, went into the
 *  design digest, and carried the meter number to the model on every planner call.
 *  Identifier-shaped secrets (5+ digits) are matched digit-for-digit with separators ignored
 *  (spaces, dashes, dots, '#', '/'), never inside a longer digit run; other secrets only when
 *  they carry a digit and are 6+ chars (a meter-keyed word like "exterior" is not an identifier
 *  and must not erase that word from the notes). */
export function redactSecretValues(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    const digits = secret.replace(/\D/g, "");
    if (digits.length >= 5) {
      const pattern = digits.split("").join("[\\s\\-\\u2013.#/]*");
      out = out.replace(new RegExp(`(?<!\\d)${pattern}(?!\\d)`, "g"), "[redacted]");
    } else if (secret.length >= 6 && /\d/.test(secret)) {
      out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
    }
  }
  return out;
}

function digestLines(project: ProjectRecord, maxChars: number, matches: (line: string) => boolean, secrets: string[] = []): string {
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const sources = [
    "sitePlanNotesText", "roofPlanNotesText", "projectDescriptionText", "electricalCalcText",
    "structuralCalcText", "labelsText", "reviewFlags", "utilityUploadNotesText", "planSetExtractedText",
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  let total = 0;
  for (const key of sources) {
    const text = typeof snap[key] === "string" ? (snap[key] as string) : "";
    if (!text) continue;
    // Redact the WHOLE text before it is split or capped: a split on '.' or a cap that cut a
    // secret in half would leave pieces the full pattern no longer matches.
    for (const rawLine of redactSecretValues(text, secrets).split(/[\n.;]+/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (line.length < 8 || line.length > 220) continue;
      if (!matches(line)) continue;
      const norm = line.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(line);
      total += line.length + 3;
      if (total >= maxChars) return out.join(" | ").slice(0, maxChars);
    }
  }
  return out.join(" | ").slice(0, maxChars);
}

function clip(value: string | undefined, max: number): string {
  const v = (value || "").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

// Compose the planner's KB context from the fuzzy-matched utility + AHJ knowledge
// rows and (for AHJ-scope learns) the jurisdiction's adopted-code profile. Kept
// compact: notes are the imported submit instructions / disconnect / meter /
// stamp rules — exactly what the portal's judgment questions ask about.
export function buildLearnKbContext(
  db: AppDb,
  project: ProjectRecord,
  opts: { scopeType?: "ahj" | "utility"; permitType?: "structural" | "electrical" },
): string {
  const sections: string[] = [];
  try {
    const match = findKnowledgeForLearn(db, { state: project.state, ahj: project.ahj, utility: project.utility });
    const primary = opts.scopeType === "ahj" ? match.ahj : match.utility;
    const secondary = opts.scopeType === "ahj" ? match.utility : match.ahj;
    for (const [label, profile] of [
      [opts.scopeType === "ahj" ? "AHJ" : "Utility", primary],
      [opts.scopeType === "ahj" ? "Utility" : "AHJ", secondary],
    ] as const) {
      if (!profile) continue;
      const name = label === "Utility" ? profile.utility : profile.ahj;
      // RULE 5 IN THE PROMPT TOO. City of Jefferson's learned AHJ row carries Pacific Power's
      // PowerClerk portal (and its NEM documents); handed to the PERMIT planner as "Portal:", it told
      // the model the permit files on the utility's portal. A portal line whose URL belongs to the
      // other track's kind of portal is left out of this label's section.
      const portalFits = !profile.portalUrl || Boolean(trackSafeUrl(label === "Utility" ? "nem" : "building", profile.portalUrl));
      // …and only the entity this planner files with has a portal worth naming: a permit planner never
      // files on the utility's portal, a NEM planner never on the AHJ's.
      const isPrimary = label === (opts.scopeType === "ahj" ? "AHJ" : "Utility");
      const lines = [
        `${label}: ${name}${profile.state ? ` (${profile.state})` : ""} [KB confidence: ${profile.confidence}]`,
        isPrimary && portalFits && (profile.portalName || profile.portalUrl) ? `Portal: ${clip(profile.portalName, 80)} ${clip(profile.portalUrl, 120)}`.trim() : "",
        profile.requiredDocuments.length ? `Required docs: ${clip(profile.requiredDocuments.join("; "), 300)}` : "",
        // The primary scope's notes carry the judgment answers — give them the bigger cap. SHARED notes
        // were written from one company's sheets: its logins, "credential stored" lines and licence
        // numbers never reach another company's planner (knowledgeBase.learnSafeNotes; rule 2).
        learnSafeNotes(profile.notes) ? `Notes: ${clip(learnSafeNotes(profile.notes), label === (opts.scopeType === "ahj" ? "AHJ" : "Utility") ? 900 : 400)}` : "",
      ].filter(Boolean);
      if (lines.length > 1) sections.push(lines.join("\n"));
    }
  } catch { /* KB table may not exist yet */ }
  if (opts.scopeType === "ahj") {
    try {
      const code = getCodeProfile(db, { state: project.state, ahj: project.ahj });
      if (code) {
        const dc = code.designCriteria;
        const dcParts = [
          dc.windSpeedMph ? `wind ${dc.windSpeedMph}mph` : "",
          dc.windExposure ? `exposure ${dc.windExposure}` : "",
          dc.groundSnowLoadPsf ? `ground snow ${dc.groundSnowLoadPsf}psf` : "",
          dc.seismicDesignCategory ? `seismic ${dc.seismicDesignCategory}` : "",
          dc.frostDepthIn ? `frost ${dc.frostDepthIn}in` : "",
        ].filter(Boolean);
        const lines = [
          code.adoptedCodes.length ? `Adopted codes: ${clip(code.adoptedCodes.map((c) => `${c.code} ${c.edition}`).join(", "), 200)} [${code.confidence}]` : "",
          dcParts.length ? `Design criteria: ${dcParts.join(", ")}` : "",
          code.amendments.length ? `Local amendments: ${clip(code.amendments.map((a) => `${a.code}${a.section ? ` ${a.section}` : ""}: ${a.summary}`).join("; "), 400)}` : "",
          code.fireSetbacks.length ? `Fire setbacks: ${clip(code.fireSetbacks.map((f) => f.description).join("; "), 250)}` : "",
        ].filter(Boolean);
        if (lines.length) sections.push(`Jurisdiction code profile:\n${lines.join("\n")}`);
      }
    } catch { /* code profile table may not exist yet */ }
  }
  if (!sections.length) return "";
  const full = `KB CONTEXT for this ${opts.scopeType === "ahj" ? "AHJ" : "utility"} (learned/imported knowledge — trust the live page over this if they conflict):\n\n${sections.join("\n\n")}`;
  return full.length > 2400 ? `${full.slice(0, 2399)}…` : full;
}

// Build the LLM planner the portal fill loop calls when it has the live fields on a page,
// plus the project's secret-free field values. Shared by autonomous learning AND the hybrid
// staging gap-fill so both use identical data + safety handling. Secrets (account/meter/SSN/
// password) are stripped here and NEVER reach the LLM — the adapter binds those deterministically.
/** Fills, selects and checks - the steps that actually put data into a form. The only
 *  depth measure available on both a stored draft and a fresh learn. */
export function substantiveStepCount(steps: Array<{ action?: unknown }> | undefined): number {
  return (steps ?? []).filter((st) => ["fill", "select", "check"].includes(String(st?.action ?? ""))).length;
}

/**
 * DEPTH IS INFORMATION, AND A SHORTER DRAFT MUST NOT ERASE A LONGER ONE.
 *
 * A complete recipe is already protected. Two DRAFTS of the same portal were not ranked at
 * all, so the last writer won - and on 2026-09-09 the last writer was a benchmark run the
 * harness cut off at 660 seconds. It replaced Miami's 58-step, 39-fill draft, which had
 * walked twelve pages of the intake, with the 28-step, 18-fill draft that run managed before
 * it was killed. The good one survived only in prev_steps_json.
 *
 * Neither draft replays, so nothing files differently either way; what is lost is the record
 * of how far the portal can actually be walked, which is the entire point of keeping a draft.
 */
export function shouldKeepDeeperDraft(
  existingSteps: Array<{ action?: unknown }> | undefined,
  newSteps: Array<{ action?: unknown }> | undefined,
  opts: { protectComplete: boolean; hasExisting: boolean },
): boolean {
  if (opts.protectComplete || !opts.hasExisting) return false;
  return substantiveStepCount(existingSteps) > substantiveStepCount(newSteps);
}

/** Everything the trust gate is allowed to consider. One argument per condition, all of it
 *  computed by the caller from the run's own evidence — no defaults, so a new signal cannot
 *  be forgotten into silently passing. */
export interface TrustGateSignals {
  /** The learn walked to the portal's review screen (not a landing/disclaimer page). */
  reachedReview: boolean;
  /** At least one field was actually filled on the way there. */
  filledSomething: boolean;
  /** The review screen could be read at all — DOM fields, body text, or a usable screenshot. */
  reviewReadable: boolean;
  /** The authoritative LLM verifier (vision when usable, else text) says the fill is right. */
  verificationAccurate: boolean;
  /** The text verifier compared real values and said they are WRONG (not merely absent). */
  textContradicts: boolean;
  /** Required fields the adapter's structural sweep found blank/unselected. */
  requiredFieldMisses: string[];
  /** Required document upload controls left with no file. */
  missingRequiredDocs: string[];
  /** The portal's own validation refused an advance. */
  validationBlocks: string[];
  /** Recorded literals that match this project's data under MORE THAN ONE field, so they
   *  cannot be safely auto-bound and would replay verbatim onto the next customer. */
  ambiguousLiteralCount: number;
  /** Steps bound to a key resolveRecipeFieldValues cannot produce — unfillable forever. */
  deadBindings: string[];
  /** Pages walked, and fills/selects/checks recorded — the promotion floor. */
  pageCount: number;
  substantiveFills: number;
  /** The form this run filled is not the form we meant to file (permit extension, renewal…). */
  formPurposeMismatch: boolean;
}

/**
 * THE WHOLE BAR FOR "complete", IN ONE PLACE.
 *
 * This is the only thing standing between an unattended replay and a real customer's filing,
 * and until now it did not exist as a thing you could read: the conditions were spread over a
 * hundred and eighty lines and four early returns, so nobody could see the bar whole and four
 * separate paths were found going round it. Written down, a recipe is trusted only when ALL
 * of the following hold — each one is here because a live run got it wrong:
 *
 *   1. reachedReview        — it walked to the portal's review screen. (Without this a run that
 *                             got lost mid-wizard reported "staged".)
 *   2. filledSomething      — and filled something on the way. (Salem: a disclaimer page misread
 *                             as review, promoted with an EMPTY application.)
 *   3. reviewReadable       — and the review screen could actually be READ. "Accurate" over a
 *                             page nobody could read is vacuous: nothing present, nothing
 *                             contradicted, everything approved.
 *   4. verificationAccurate — the LLM verifier (vision when it could see, else text) says the
 *                             values match the project record.
 *   5. !textContradicts     — and no verifier compared real values and called them WRONG.
 *   6. no required-field miss, no missing required document, no portal validation block — the
 *                             three structural blockers the adapter finds and the verifier
 *                             CANNOT see, because a review summary just omits the row it never
 *                             got. (Ameren Illinois: promoted with Email, Street, Name, Company,
 *                             Address and Docket Number blank, and replay faithfully reproduced
 *                             the incomplete application, reporting no failures.)
 *   7. no ambiguous literal — a recorded value matching this project's data under more than one
 *                             field cannot be bound, and would replay this customer's data onto
 *                             the next one.
 *   8. no dead binding      — a step bound to a key the resolver cannot produce fills "" forever
 *                             and is skipped in silence. (PacifiCorp's `descriptionOfService`,
 *                             which changed the portal's own branching two pages later.)
 *   9. >= 3 pages and >= 5 fills — the promotion floor. A trusted recipe must have walked a
 *                             wizard, not a page.
 *  10. !formPurposeMismatch — and it must have been the RIGHT form. (Gilbert AZ scored 6 of 6
 *                             filling a Permit Extension Request perfectly.)
 *
 * Signal 3 is the one condition here that the pre-2026-09-10 gate computed and then ignored;
 * it is included deliberately, and it is the only change to the bar itself.
 *
 * Returns the blockers as well as the verdict, so a caller can TELL the operator what stopped
 * promotion instead of leaving them to infer it. Pure — no DB, no clock, no network — so it is
 * testable directly, which is the point: an unreachable gate is as bad as a leaky one.
 */
export function evaluateTrustGate(sig: TrustGateSignals): { trusted: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!sig.reachedReview) blockers.push("never reached the portal's review screen");
  if (!sig.filledSomething) blockers.push("filled no fields");
  if (!sig.reviewReadable) blockers.push("the review screen could not be read, so the fill was never actually verified");
  if (!sig.verificationAccurate) blockers.push("the verifier did not confirm the fill is accurate");
  if (sig.textContradicts) blockers.push("the text verifier found values that CONTRADICT the project record");
  if (sig.requiredFieldMisses.length) blockers.push(`required field(s) left blank: ${sig.requiredFieldMisses.slice(0, 12).join(", ")}`);
  if (sig.missingRequiredDocs.length) blockers.push(`required document(s) not attached: ${sig.missingRequiredDocs.slice(0, 8).join(", ")}`);
  if (sig.validationBlocks.length) blockers.push(`portal validation blocked an advance: ${sig.validationBlocks.slice(0, 8).join("; ")}`);
  if (sig.ambiguousLiteralCount > 0) blockers.push(`${sig.ambiguousLiteralCount} recorded literal(s) could not be uniquely bound to a project field`);
  if (sig.deadBindings.length) blockers.push(`step(s) bound to a field the resolver cannot produce: ${sig.deadBindings.slice(0, 8).join(", ")}`);
  if (sig.pageCount < 3 || sig.substantiveFills < 5) blockers.push(`too thin to auto-trust (${sig.pageCount} page(s), ${sig.substantiveFills} recorded fill(s))`);
  if (sig.formPurposeMismatch) blockers.push("the form this run filled is not the form this track files");
  return { trusted: blockers.length === 0, blockers };
}

/**
 * WHO THE BOT MAY E-SIGN AS: the project's own client's authorized signer, read from the client
 * row itself — never the plan set, never a contact name the parser found, never another client.
 * "" when the project has no client or the client names no signer; the learner then PAUSES at a
 * typed-signature step (operator ruling 2026-09-26: a typed e-signature on the draft is fine,
 * the review step is where it stops).
 */
/**
 * WHAT A TRUSTED LEARN SAYS IT CHECKED — WITH THE DENOMINATOR (dryrun-0928 B10).
 *
 * The learn's result message and its recipe note used to read "verified (high confidence)" and
 * end with an invitation to "opt this portal into trusted auto-submit". Both were false:
 *   - the per-portal opt-in no longer exists (operator rulings 2026-09-24 / 2026-09-26 — the arm
 *     route refuses with 409), so the words contradicted hard rule 1; the ONE sentence that
 *     describes the real gate (portalSafety.FINAL_SUBMIT_GATE_SENTENCE) replaces them;
 *   - the verifiers read only the page the run ended on. On PowerClerk that is the last wizard
 *     page, so "high confidence" was about 3 attestation fields out of 101 recorded fills across
 *     10 pages. The words now say how many fields were checked, of how many, on how many pages.
 * The note keeps its leading "Auto-learned and verified (<confidence> confidence) on N page(s)."
 * EXACTLY — it is a matching key (scripts/rekey-recipe.ts notesSayVerified and its tests).
 * Pure, exported for the unit test.
 */
export function trustedLearnWording(input: {
  confidence: string;
  /** Fields the verifier compared (verification.matches.length) and how many of them matched. */
  fieldsChecked: number;
  fieldsMatched: number;
  /** Recorded fill / select / check steps across the whole walk. */
  recordedFills: number;
  pageCount: number;
  scopeType: "ahj" | "utility";
  bindingNote: string;
}): { note: string; message: string; done: string } {
  const checked = `${input.fieldsChecked} field(s) checked on the final page (${input.fieldsMatched} matched) of ${input.recordedFills} recorded fill(s) across ${input.pageCount} page(s)`;
  return {
    note: `Auto-learned and verified (${input.confidence} confidence) on ${input.pageCount} page(s).${input.bindingNote} The verifier read the final page only: ${checked}. ${FINAL_SUBMIT_GATE_SENTENCE}`,
    message: `Portal learned: ${checked} (verifier confidence: ${input.confidence}) — the earlier pages were not re-read, so review them before submitting. The recipe is trusted and will replay on future ${input.scopeType === "utility" ? "utility" : "AHJ"} projects. ${FINAL_SUBMIT_GATE_SENTENCE}`,
    done: `Learning complete — recipe trusted (${input.fieldsChecked} field(s) checked on the final page of ${input.pageCount}).`,
  };
}

export function learnSignerName(db: AppDb, project: Pick<ProjectRecord, "clientId">): string {
  if (!project.clientId) return "";
  try {
    const row = db.get<{ authorized_signer_name?: string | null }>("SELECT authorized_signer_name FROM clients WHERE id = ?", [project.clientId]);
    return String(row?.authorized_signer_name ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export function buildPortalPlanner(
  db: AppDb,
  project: ProjectRecord,
  opts: { portalType: string; scopeType?: "ahj" | "utility"; permitType?: "structural" | "electrical"; track?: string | null },
): { planner: (req: LearnPlanRequest) => Promise<LearnPlanResponse>; projectFields: Record<string, string> } {
  // The filing this planner fills — the licence keys answer "the licence THIS permit takes".
  const track = opts.track !== undefined ? opts.track
    : opts.scopeType === "utility" ? "nem" : learnTrackFor(undefined, opts.permitType);
  const fieldValues = resolveRecipeFieldValues(db, project, opts.portalType, track);
  const projectFields: Record<string, string> = {};
  // SAFETY RULE 2: secrets never reach the LLM. Two layers:
  // (a) KEY filter — broad, not exact-name: parser-snapshot alias keys spread into
  //     fieldValues first (resolveRecipeFieldValues), so "acctNum", "utilityAccount",
  //     "meterNo", "customerSSN", "nemAgreementNumber" etc. must all be caught, not
  //     just the canonical accountNumber/meterNumber keys. Agreement/application
  //     numbers are account-linked identifiers and are treated the same way.
  // (b) VALUE filter — any value that string-equals a known secret (after trim) is
  //     dropped regardless of what key it arrived under.
  // (keys: isPlannerSecretKey — ONE predicate, shared with projectSecretValues.)
  // WHO HOLDS THE ACCOUNT IS IDENTITY, NOT A SECRET. The ubAccountHolder* keys carry the
  // billing contact's name/email/phone — the very values PowerClerk's Customer Information
  // page asks for — and "AccountHolder" matches the broad account regex. Treating them as
  // secrets poisoned the VALUE set with the homeowner's email, phone, and surname, which the
  // value filter then erased under EVERY key: live on Marineau's NEM, two learns in a row
  // left the required Email boxes blank because homeownerEmail had been silently deleted as
  // "a secret". The account NUMBER stays under its own keys and stays stripped.
  const isSecretKey = isPlannerSecretKey;
  const secretValues = new Set<string>();
  const addSecret = (v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s.length >= 4) secretValues.add(s);
  };
  addSecret(project.accountNumber);
  addSecret(project.meterNumber);
  for (const [k, v] of Object.entries(fieldValues)) {
    if (isSecretKey(k)) addSecret(v);
  }
  for (const [k, v] of Object.entries(fieldValues)) {
    if (isSecretKey(k)) continue;
    if (v && secretValues.has(String(v).trim())) continue;
    if (v) projectFields[k] = v;
  }
  // Provide today's date so the planner can compute time-relative values
  // (e.g. estimated commissioning date = today + 28 days).
  projectFields["todayDate"] = new Date().toISOString().slice(0, 10);
  // A PERMIT'S "Project Name" IS THE HOMEOWNER'S NAME — operator policy, because that is how
  // the AHJ, the inspector and the office all look the job up afterwards. Left to its own
  // devices the planner writes a description ("Residential Solar PV Installation", live on
  // Coos Bay 194-26-001471-ELEC), which reads fine and is useless for finding the record.
  // Supplied as its own field so the planner has an exact value to bind rather than a rule to
  // remember, and so a recipe records it bound to projectName instead of a frozen literal.
  if (project.homeownerName) projectFields["projectName"] = project.homeownerName;
  // COMPACT DESIGN DIGEST. The long parser/plan-set text blobs are excluded from
  // fieldValues (they cost ~40k tokens per LLM call), but a handful of the portal's
  // JUDGMENT questions (disconnect-within-10ft, meter on pole, battery/backup mode,
  // export limiting, attic run) are answered from design NOTES, not structured fields.
  // Extract only the decision-relevant lines into a small digest so the planner keeps
  // that signal at ~200 tokens instead of the full text. Self-taught topics (terms from
  // required questions past runs couldn't answer) extend the built-in topic list.
  const digest = designNotesDigest(project, 1200, activeLearnedNoteTerms(db));
  if (digest) projectFields["designNotes"] = digest;
  // EXPORT-LIMITING ANSWER. NEM portals ask a REQUIRED "Do you propose to limit the
  // export capacity?" radio; without a bound field the planner leaves it blank and the
  // trust gate refuses the recipe on every run (seen live on PGE). Derive it: the
  // answer is "Yes" only when the design carries actual export-limiting evidence
  // (PCS / power control system, export limit, non-export, NGOM) — a plain NEM system
  // exports and answers "No". Never override an explicit parser/operator value.
  if (!projectFields["exportLimiting"]) {
    const evidence = `${fieldValues["exportMode"] ?? ""} ${fieldValues["pcs"] ?? ""} ${fieldValues["exportLimit"] ?? ""} ${projectFields["designNotes"] ?? ""}`;
    projectFields["exportLimiting"] =
      /non.?export|export.?limit\b|power control system|\bpcs\b|\bngom\b/i.test(evidence) ? "Yes" : "No";
  }

  // KB CONTEXT. Fuzzy, state-aware lookup so imported reference knowledge
  // ("Portland General Electric" / "Arizona Public Service Company") still hits
  // when the project says "PGE" / "APS" — critical when learning an UNKNOWN
  // portal, where the imported submit instructions / disconnect / meter rules
  // are the only prior signal. Utility and AHJ rows are pulled separately and
  // capped so this stays a few hundred tokens.
  const kbContext = buildLearnKbContext(db, project, opts);

  // (c) EMBEDDED filter — the last pass over everything the planner will send: a secret
  //     inside ANY field's text (the design digest above all; a description or note that
  //     quotes the meter) is redacted in place. The digest redacts at its source too.
  const allSecrets = [...secretValues, ...projectSecretValues(project)];
  for (const [k, v] of Object.entries(projectFields)) {
    if (typeof v === "string" && v) projectFields[k] = redactSecretValues(v, allSecrets);
  }

  let jurisdictionContext = "";
  if (opts.scopeType === "ahj") {
    const discipline = opts.permitType === "electrical" ? "electrical" : "structural";
    jurisdictionContext = [
      `permitDiscipline: ${discipline}`,
      project.ahj ? `targetJurisdiction (AHJ): ${project.ahj}` : "",
      project.city ? `projectCity: ${project.city}` : "",
      project.state ? `state: ${project.state}` : "",
    ].filter(Boolean).join("\n");
  }

  const llm = learnLlmFactory();
  const planner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    const indexedFields = req.fields.map((f, i) => ({ index: i, label: f.label, fieldType: f.fieldType, options: f.options, section: f.section }));
    const plan = await llm.planPortalFields({
      url: req.url,
      pageTitle: req.pageTitle,
      fields: indexedFields,
      bodyText: req.bodyText,
      projectFields,
      alreadyFilledLabels: req.alreadyFilledLabels,
      kbContext: kbContext || undefined,
      jurisdictionContext: jurisdictionContext || undefined,
      isDashboard: req.isDashboard,
      recoveryHint: req.recoveryHint,
      screenshotBase64: req.screenshotBase64,
    });
    return {
      // A JOB VALUE BOX TAKES THE VALUATION, NOT THE CONTRACT (leak sweep 2026-09-28): whatever the
      // planner chose for a box whose label asks for the work's valuation (the contract keys, or a
      // typed figure), the learn draft files — and the recipe records — the declared valuation.
      fills: plan.fills.map((f) => {
        const target = req.fields[f.index];
        // A free-text box only: a valuation RANGE select ("$10,001 – $25,000") keeps its option.
        if (target && (target.fieldType === "text" || target.fieldType === "other") && rebindsToValuation(String(target.label ?? ""), f.field)) {
          return { selectorIndex: f.index, value: projectFields[DECLARED_VALUATION_FIELD] ?? "", field: DECLARED_VALUATION_FIELD };
        }
        return { selectorIndex: f.index, value: f.value, field: f.field };
      }),
      advanceSelectorIndex: plan.advanceIndex,
      navigateSelectorIndex: plan.navigateIndex,
      finalSubmitSelectorIndex: plan.finalSubmitIndex,
      atReview: plan.atReview,
      notes: plan.notes,
    };
  };
  return { planner, projectFields };
}

/**
 * Learn an AHJ or utility portal autonomously for a project, record a recipe, verify
 * the fill, and promote the recipe to "complete" only when the verification passes.
 */
/**
 * ONE BROWSER PROFILE PER PORTAL, NOT ONE PER SCOPE.
 *
 * portalType here is the literal string "AHJ" or "utility", so every jurisdiction a client
 * ever learns shared a single Chrome profile — eleven portals on eight platforms in the
 * 2026-09-04 sweep, all pouring cookies, localStorage, service workers and consent choices
 * into the same 412 MB directory. For a tool whose whole promise is "point it at any portal
 * and it works", the last portal it visited should not be able to change what the next one
 * renders, and Washington County's Accela — whose login form is detectable in 1.2 seconds
 * from a clean context — was reported "login form was not recognised" in that sweep.
 *
 * It also forced every learn through one profile lease, so portals queued behind each other
 * for no reason.
 *
 * Keyed on the portal HOST: unique, stable across the query strings and deep paths that
 * differ between one project and the next, and legible in a directory listing. The
 * hand-coded staging adapters keep their own named profiles (powerclerk_*, oregon_*) and
 * are untouched by this — only auto-learn used the generic name.
 *
 * Exported for the unit test.
 */
export function learnProfileName(portalType: string, portalUrl: string): string {
  let host = "";
  try { host = new URL(portalUrl).hostname.toLowerCase(); } catch { host = ""; }
  // A portal we cannot parse a host from keeps the old shared profile rather than landing
  // everything unparseable in one bucket named after the empty string.
  if (!host) return portalType;
  const slug = host.replace(/^www\d*\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${portalType.toLowerCase()}-${slug || "portal"}`;
}

/**
 * EVERY PATH THAT OPENS A LIVE PORTAL WRITES THE DRAFT LEDGER FIRST — NOT JUST THE BENCHMARK.
 *
 * A learn logs into the operator's real account and starts a real application. It never
 * submits, but the draft stays under the customer's licence and nothing deletes it. Only
 * runLearnBenchmark wrote the ledger; the API-triggered learn (jobQueue "auto_learn"), the
 * self-heal re-learn queue, the staging self-seed and the root live-*-learn scripts all
 * opened the same portals with no record. This builds the entry every autoLearnPortal run
 * records BEFORE the browser opens — a run that dies mid-way has still created the draft,
 * and that is exactly the case worth recording.
 *
 * Returns null for exactly one caller: runLearnBenchmark identifies itself with
 * createdBy "learn-benchmark" and writes its OWN entry (runLearnBenchmark.ts:226) before
 * this function is ever reached, with the benchmark's richer purpose text — recording here
 * too would double-count every benchmark draft in the ledger operators clean up from.
 * The coupling cuts both ways: if the benchmark ever renames its createdBy we get duplicate
 * rows (noisy but safe); if it ever drops its own recordDraftTouch while keeping the name,
 * benchmark drafts go UNRECORDED — the dangerous direction — so that call and this skip
 * must move together.
 *
 * Secrets-safe by construction: the account is the credential store's username REFERENCE
 * (the non-secret half kept in the clear), never a decrypted username or password, and no
 * field value is copied in. Exported for the unit test.
 */
export function buildLearnDraftTouch(input: {
  portalUrl: string;
  projectId: string;
  createdBy?: string;
  selfTestEnabled: boolean;
  /** The client's stored logins — the API view, which never carries a secret. */
  credentials: Array<{ portalUrl: string; usernameReference: string }>;
}): DraftTouch | null {
  if ((input.createdBy || "") === "learn-benchmark") return null;
  let host = "";
  try { host = new URL(input.portalUrl).hostname.toLowerCase(); } catch { host = ""; }
  const hit = input.credentials.find((c) => {
    try { return new URL(c.portalUrl).hostname.toLowerCase() === host; } catch { return false; }
  });
  // A host miss with exactly ONE stored login mirrors getDecryptedCredentialAny: when a
  // single credential is all the client has, it is unambiguous which account the draft
  // will sit under. More than one and no host match means we honestly don't know — an
  // empty account beats a guessed one in a cleanup ledger.
  const account = hit?.usernameReference ?? (input.credentials.length === 1 ? input.credentials[0].usernameReference : "");
  return {
    at: new Date().toISOString(),
    host,
    portalUrl: input.portalUrl,
    account: String(account ?? ""),
    projectId: input.projectId,
    // The replay self-test re-runs the LIVE portal in a fresh session, so one learn can
    // mint a SECOND draft — the purpose says so up front, mirroring the benchmark's.
    purpose: input.selfTestEnabled ? "auto-learn +selftest (up to 2 drafts)" : "auto-learn",
    note: `learn walks to the review screen and stops; never submitted (createdBy: ${input.createdBy || "unknown"})`,
  };
}

// ── Test seams (AUTOPILOT_TEST_SEAMS=1 only): the browser learn and the LLM provider ──────────
// A test must prove a learn is refused BEFORE any browser launches (the stub launcher is never
// called) and see exactly what the verifiers are sent, without a real browser or a real LLM.
type LearnPortalFn = typeof learnPortal;
let learnPortalRunner: LearnPortalFn = learnPortal;
let learnLlmFactory: () => ReturnType<typeof createLLMProvider> = createLLMProvider;
export function setAutoLearnSeamsForTests(seams: { learnPortal?: LearnPortalFn | null; llm?: (() => ReturnType<typeof createLLMProvider>) | null }): void {
  if (process.env.AUTOPILOT_TEST_SEAMS !== "1") throw new Error("setAutoLearnSeamsForTests needs AUTOPILOT_TEST_SEAMS=1 — it is a test seam only.");
  if ("learnPortal" in seams) learnPortalRunner = seams.learnPortal ?? learnPortal;
  if ("llm" in seams) learnLlmFactory = seams.llm ?? createLLMProvider;
}

/** Review-screen labels that name a secret (account/meter numbers, passwords, SSN, card data).
 *  Such fields are bound at replay from the encrypted credential store, never from the recipe,
 *  and they never go to a verifier. One predicate for the text AND the vision verifier. */
export const SENSITIVE_REVIEW_LABEL = /\b(password|passcode|account\s*(number|no|#)?|acct|meter\s*(number|no|#)?|ssn|social security|tax\s*id|ein|routing|card\s*number|cvv|security code)\b/i;

/**
 * WRITE THE URL A TRUSTED LEARN PROVED BACK TO THE KB — the one door, both scopes.
 *
 * It used to be `UPDATE ... WHERE ahj = ?`: every row with that AHJ NAME in EVERY state (42 AHJ
 * names occur in more than one state; "City of Tigard" has rows in OR, AL, AR and WA), human-
 * verified rows included (rule 3), with whatever URL the learn ran — the utility-scope branch
 * likewise overwrote a verified utility row on conflict. Now: the URL must fit the track and the
 * entity (hostFitsTrackAndEntity), the write touches only THIS entity's rows in THIS state (by
 * profile_key), and a row isVerifiedKnowledge() holds is never written. Returns what it did.
 */
export function recordTrustedLearnPortalUrl(
  db: AppDb,
  input: { scope: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; portalUrl: string },
): { written: string[]; skippedVerified: string[]; refused: string | null } {
  const scope = input.scope === "utility" ? "utility" : "ahj";
  const state = String(input.state ?? "").trim();
  const name = String((scope === "utility" ? input.utility : input.ahj) ?? "").trim();
  const out = { written: [] as string[], skippedVerified: [] as string[], refused: null as string | null };
  if (!name) { out.refused = "no entity name"; return out; }
  const track = scope === "utility" ? "nem" : "permit";
  const fit = hostFitsTrackAndEntity(track, portalEntityEvidence(db, { scope, state, name }), input.portalUrl, "learn");
  if (!fit.fits) { out.refused = fit.reason; return out; }
  const now = new Date().toISOString();
  // The rows this entity owns in this state: the entity-only key, and (AHJ) the key with the
  // project's utility — the two keys the resolvers read. Never a same-named row elsewhere.
  const keys = scope === "utility"
    ? [knowledgeProfileKey({ state, ahj: "", utility: name })]
    : [...new Set([knowledgeProfileKey({ state, ahj: name, utility: "" }), knowledgeProfileKey({ state, ahj: name, utility: input.utility })])];
  for (const key of keys) {
    const row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
    if (row && isVerifiedKnowledge(row)) { out.skippedVerified.push(key); continue; }
    if (row) {
      db.run("UPDATE permit_utility_knowledge SET portal_url = ?, updated_at = ? WHERE profile_key = ?", [input.portalUrl, now, key]);
      out.written.push(key);
    }
  }
  // No row for the entity-only key yet → create the minimal one (the pre-existing utility-branch
  // behaviour, now for both scopes), so the next project on this entity finds the portal.
  const baseKey = keys[0];
  if (!out.written.includes(baseKey) && !out.skippedVerified.includes(baseKey)) {
    db.run(
      `INSERT INTO permit_utility_knowledge
         (id, profile_key, state, ahj, utility, portal_url, notes, first_seen_at, last_learned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_key) DO NOTHING`,
      [id(), baseKey, state, scope === "utility" ? "" : name, scope === "utility" ? name : "", input.portalUrl,
        scope === "utility" ? "Auto-learned utility NEM portal entry URL (trusted learn)." : "Auto-learned AHJ permit portal entry URL (trusted learn).",
        now, now, now],
    );
    out.written.push(baseKey);
  }
  return out;
}

export async function autoLearnPortal(
  db: AppDb,
  projectId: string,
  input: {
    scope: "ahj" | "utility";
    portalUrl: string;
    createdBy?: string;
    /** Where portalUrl came from (the staging self-seed passes "statewide" for the statewide
     *  fallback). Judged by hostFitsTrackAndEntity before anything else happens. */
    urlSource?: PortalUrlSource;
    permitType?: "structural" | "electrical";
    /** Recipe discipline for THIS stage's track (recipeDisciplineForTrack). Authoritative
     *  over permitType — it is the same value the recipe lookup keys on. */
    discipline?: string;
    /** Operator delegation: click the recorded final submit at review rather than leaving it.
     *  Honoured only alongside PORTAL_ALLOW_FINAL_SUBMIT=1, checked at the click itself. The
     *  self-seed IS the staging run for a portal with no trusted recipe yet, so without this a
     *  delegated submit would be impossible on exactly the portals that need it most. */
    allowFinalSubmit?: boolean;
    // Optional pre-resolved project record. The staging self-seed path passes its
    // client-contractor *overlaid* stagedProject (authoritative CCB#/installer identity) so the
    // learner fills the same data the hand-coded adapters would. When omitted (the manual
    // /auto-learn endpoint), the raw project is loaded from the DB.
    project?: ProjectRecord;
    // Headed/headless for the learn browser. The staging self-seed passes the operator-intended
    // setting (headed locally) so it matches the hand-coded/replay adapters and leaves the browser
    // open at review; when omitted, resolveHeadless falls back to PORTAL_HEADLESS / server default.
    headless?: boolean;
    /** Accept a cookie banner that offers nothing but an acceptance. Declining is always
     *  tried first; this governs only the residual, and never a CAPTCHA. */
    allowConsentAccept?: boolean;
    // Optional live-progress sink (drives the UI progress bar). Non-PII signals only.
    onProgress?: import("../../portal-bot/src/adapters/autoLearnAdapter").LearnProgressFn;
    /** Wall-clock cap on the page walk. The run stops ITSELF at the deadline and returns
     *  a real result; without it, a caller that gives up simply loses sight of a run that
     *  keeps going. Omit for no cap (the default for operator-initiated learns). */
    budgetMs?: number;
  },
): Promise<AutoLearnResult> {
  const projectRow = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) throw new HttpError(404, "Project not found.");
  // getProjectDetail is the canonical mapper; import lazily to avoid a cycle. A caller may pass
  // a pre-overlaid project (staging self-seed); otherwise load the canonical record.
  const { getProjectDetail } = await import("./repository");
  const baseProject: ProjectRecord = input.project ?? getProjectDetail(db, projectId).project;
  // Thread the requested permit discipline onto the project the LEARNER sees — the
  // deterministic ACA passes key jurisdiction-row (CITY=structural / COUNTY=electrical)
  // and record-type selection off project.permitType, which the stored record rarely
  // carries. The planner prompt receives the same discipline separately.
  const project: ProjectRecord = input.permitType && !baseProject.permitType
    ? { ...baseProject, permitType: input.permitType }
    : baseProject;

  const scopeType = input.scope === "utility" ? "utility" : "ahj";
  const portalUrl = (input.portalUrl || "").trim();
  if (!portalUrl) throw new HttpError(400, "portalUrl is required to learn a portal.");
  // RULE 5, BOTH WAYS, AND THE ENTITY — AT THE LEARN'S OWN DOOR, BEFORE ANYTHING ELSE. Every
  // caller (the operator's /auto-learn, the staging self-seed, the stale-recipe re-learn, the
  // supervised script) reaches a browser through here, and the only guard used to be on the
  // staging path: disk showed AHJ-scoped learns on PowerClerk and ComEd hosts. The entity's own
  // existing recipe for this key is not evidence for its own URL (a mis-keyed recipe re-learning
  // itself would vouch for its wrong host). Nothing is launched, locked or written on a refusal.
  {
    const own = findAnyRecipeForProject(db, {
      scopeType, state: project.state, ahj: project.ahj, utility: project.utility,
      discipline: scopeType === "utility" ? "" : input.discipline,
    });
    const entity = portalEntityEvidence(db, {
      scope: scopeType, state: project.state, name: scopeType === "utility" ? project.utility : project.ahj,
      excludeRecipeIds: own ? [own.id] : [],
    });
    const fit = hostFitsTrackAndEntity(scopeType === "utility" ? "nem" : "permit", entity, portalUrl, input.urlSource ?? "operator");
    if (!fit.fits) {
      addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_refused_host", {
        scope: scopeType, portalUrl, code: fit.code, reason: fit.reason, createdBy: input.createdBy ?? null,
      });
      throw new HttpError(409,
        `Not learning ${portalUrl}: ${fit.reason}. Nothing was opened. `
        + (fit.code === "track_conflict"
          ? `Learn the ${scopeType === "utility" ? "utility's interconnection" : "AHJ's permit"} portal for this track instead.`
          : `If ${scopeType === "utility" ? project.utility || "this utility" : project.ahj || "this AHJ"} really files there, save that portal on its knowledge-base profile (verified), then learn again.`),
        { hostRefused: true, code: fit.code, portalUrl });
    }
  }
  if (scopeType === "ahj") {
    const { resolvePermitPath } = await import("./permitPath");
    if (resolvePermitPath(project).path === "unknown") throw new HttpError(409,
      "Confirm the permit path (prescriptive or engineered) before learning an AHJ application.");
  }

  // ONE LIVE LEARN PER PORTAL RECIPE. Recipes are shared across tenants on purpose — an AHJ
  // quirk learned once helps everyone — so two clients filing with the same AHJ can trigger
  // two learns of the SAME recipe at once. They use different browser profiles, so the
  // profile queue does not separate them: both would wipe the recipe, both would save, and
  // whichever finished last would silently discard the other's work.
  //
  // The lease is held only for the life of an in-process run, so a learn killed by a crash
  // leaves nothing behind — the next attempt proceeds, and startPortalRecording's snapshot
  // still protects the previous working steps. That keeps an operator retrying a cancelled
  // learn unblocked, which a database-status lock would not.
  // Key on EXACTLY what the recipe row is keyed on. A hand-rolled key here silently defeated
  // the lease: recipeProfileKey includes the utility for an AHJ recipe and normalises the
  // parts, so two learns that WOULD collide on one row could compute different lease keys
  // and both proceed — the precise failure this lease exists to prevent.
  const leaseKey = `${recipeProfileKey({ scopeType, state: project.state, ahj: project.ahj, utility: project.utility })}|${(input.discipline || "").trim().toLowerCase()}`;
  if (activeLearnKeys.has(leaseKey)) {
    throw new HttpError(409,
      "A learn for this portal is already running. Recipes are shared between clients, so a second "
      + "learn would overwrite the first one's work. Wait for it to finish, then retry.");
  }
  activeLearnKeys.add(leaseKey);
  try {
    return await autoLearnPortalInner(db, projectId, input, project, scopeType, portalUrl);
  } finally {
    activeLearnKeys.delete(leaseKey);
  }
}

/** Recipe keys with a learn running in THIS process right now (see autoLearnPortal). */
const activeLearnKeys = new Set<string>();

async function autoLearnPortalInner(
  db: AppDb,
  projectId: string,
  input: Parameters<typeof autoLearnPortal>[2],
  project: ProjectRecord,
  scopeType: "ahj" | "utility",
  portalUrl: string,
): Promise<AutoLearnResult> {
  if (scopeType === "ahj" && !(project.ahj || "").trim()) throw new HttpError(400, "Project has no AHJ to key the recipe on.");
  if (scopeType === "utility" && !(project.utility || "").trim()) throw new HttpError(400, "Project has no utility to key the recipe on.");

  const portalType = scopeType === "utility" ? "utility" : "AHJ";
  // The filing this learn records: NEM, or the permit its discipline / permit type names (null =
  // not named). Every value map below is resolved for it — the licence keys depend on it.
  const learnTrack = scopeType === "utility" ? "nem" : learnTrackFor(input.discipline, input.permitType);
  // Secrets are stripped inside buildPortalPlanner — they never reach the LLM; the adapter
  // binds account/meter deterministically from the encrypted credential store.
  const { planner, projectFields } = buildPortalPlanner(db, project, {
    portalType,
    scopeType,
    permitType: input.permitType,
    track: learnTrack,
  });

  // Credential lookup (B11): the portal's URL decides FIRST (host + first path segment), then
  // the client's only credential when its host does not contradict the target. A row whose
  // portal_type is literally "AHJ"/"utility" never outranks the URL — it used to win for every
  // target whatever portal it was stored for (getDecryptedCredentialForPortal).
  const credential = project.clientId
    ? getDecryptedCredentialForPortal(db, project.clientId, portalType, portalUrl) ?? undefined
    : undefined;
  const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
  const userDataDir = project.clientId
    ? path.join(profileBase, project.clientId, learnProfileName(portalType, portalUrl))
    : path.join(profileBase, learnProfileName(portalType, portalUrl));

  // Assemble the upload-ready document set so the learner can attach the right split
  // document at each portal upload control. Split the plan set into typed sheets first
  // (best-effort) if it hasn't been split yet, then collect docType → file path. The
  // adapter only uploads what's actually available; a missing doc is left for the human.
  let docsByType: Record<string, string> = {};
  if (scopeType === "ahj") {
    const { prepareOfficialDocuments } = await import("./prepareOfficialDocuments");
    await prepareOfficialDocuments(db, project);
  }
  try {
    const existing = projectDocsByType(db, projectId);
    const hasSheets = ["sld", "site_plan", "inverter_spec"].every((t) => existing[t]);
    if (!hasSheets) {
      await buildUtilityPackage(db, projectId, scopeType === "utility" ? "nem" : "permit").catch(() => null);
    }
    // Use the replay selection policy: filled applications are available, and
    // the operator's explicit upload wins when both versions exist. Scoped to the filing this
    // learn records (docs-audit PLAN D3): no permit named = every AHJ document ("permit").
    docsByType = submissionDocumentsByType(db, project,
      scopeType === "utility" ? "nem" : ((learnTrackFor(input.discipline, input.permitType) ?? "permit") as Parameters<typeof submissionDocumentsByType>[2]));
  } catch {
    docsByType = {};
  }

  // Marks the start of this run's LLM window — every Claude call from here on (planner,
  // verifiers) lands in the run bundle's llm-calls.json.
  const learnStartedAtMs = Date.now();

  // PATCH-BY-DEMONSTRATION sink. When the headed browser is left open at review, every
  // fix the operator makes by hand is captured and merged into the learned recipe (in
  // replayable position, literals bound to project fields). Steps can start arriving
  // before the recipe row exists (it is created after the learn returns), so buffer
  // until the stub id is known, then flush. When an existing verified-complete recipe
  // is being protected, no stub is created and the buffer is deliberately discarded —
  // human fixes on an unverified pass must not mutate the trusted recipe.
  const humanPatch: { recipeId: string | null; buffer: RecipeStep[]; count: number; submitObserved: boolean } = { recipeId: null, buffer: [], count: 0, submitObserved: false };
  // Promote the recording once the HUMAN clicks the portal's final Submit in the left-open
  // browser: their manual submit of the (corrected) fill is the strongest end-to-end
  // demonstration the recipe works, so the draft graduates to a replayable "complete" and
  // the "recording in progress" banner clears — no extra dashboard click needed.
  const promoteOnHumanSubmit = (recipeId: string): void => {
    try {
      promoteRecordingIfEligible(db, recipeId, {
        finishedBy: "operator (submitted in review browser)",
        via: "human_submit_observed",
        projectId,
      });
    } catch { /* promotion is best-effort */ }
  };
  const onHumanStep = (step: RecipeStep): void => {
    try {
      // Submit-observed is a SIGNAL, never a merged step (see humanCapture.ts).
      if ((step.note || "") === HUMAN_SUBMIT_OBSERVED_NOTE) {
        humanPatch.submitObserved = true;
        if (humanPatch.recipeId) promoteOnHumanSubmit(humanPatch.recipeId);
        return;
      }
      // LATCH: once the human filed the application, nothing that happens afterward
      // belongs in the recipe. The page-side disarm flag does not survive a full-page
      // navigation (addInitScript re-arms the fresh document), so a confirmation page's
      // "Continue"/"Download receipt" clicks would otherwise stream in here and merge
      // into replayable position. The sink-side latch is navigation-proof.
      if (humanPatch.submitObserved) return;
      humanPatch.count++;
      if (humanPatch.count === 1) {
        addAuditLog(db, projectId, "human", "operator", "portal.recipe_human_patch_started", { scope: scopeType });
      }
      if (humanPatch.recipeId) appendHumanPatchSteps(db, humanPatch.recipeId, [step], projectFields, project.clientId);
      else humanPatch.buffer.push(step);
    } catch { /* capture merge is best-effort — never disturb the operator's session */ }
  };

  // A PORTAL THAT REFUSES ROBOTS MAY STILL ACCEPT A REAL WINDOW.
  //
  // Several jurisdictions front their portal with a WAF that serves 403 / "Access Denied" to
  // a headless browser and the ordinary site to a headed one — measured on gosolarapp.org
  // and two other AZ/CA hosts. That is not a portal we cannot learn; it is a browser posture
  // it will not talk to. So a run blocked that way is retried ONCE with a real window.
  //
  // Only for a bot block: a genuine 403 from an auth failure, a dead host, or any other
  // error retries nothing. And only where a display exists — set PORTAL_HEADED_RETRY=0 on a
  // server, where a headed launch cannot work and the retry would just cost time.
  let headlessForAttempt = input.headless;
  let headedRetryUsed = false;
  let learn;
  // THE BUDGET IS FOR THE PORTAL, NOT FOR EACH ATTEMPT.
  //
  // The headed retry below re-runs the identical learn, and a fresh adapter would take a
  // fresh deadline — so a capped portal that retries could run to twice its budget. The
  // benchmark's outer backstop fires at budget + 180s, i.e. in the MIDDLE of that retry,
  // and its message says "target closed", so isHarnessAbort would score the row "not
  // measured" and leave a headed browser running. That would blind the sweep to exactly
  // the WAF-fronted portals this retry exists to reach.
  const budgetStartedAt = Date.now();
  let budgetForAttempt = input.budgetMs;
  // Named so the headed retry below can re-run the IDENTICAL learn; headlessForAttempt is
  // read when the options are built, so flipping it and calling again is all that differs.
  const runLearn = () => learnPortalRunner({
      portalName: scopeType === "utility" ? project.utility : project.ahj,
      portalUrl,
      project,
      planner,
      credential,
      // A LOGIN MET MID-RUN on another host (a city page first, then the statewide Accela
      // sign-in) gets THAT host's own saved login — host and jurisdiction segment matched by
      // getDecryptedCredentialByUrl, so one portal's password is never typed into another.
      // Without it the learner can use only the start site's login (live: City of Jefferson,
      // 2026-09-25 — it now stops cleanly instead of looping, but still could not sign in).
      credentialForUrl: (u: string) => (project.clientId ? getDecryptedCredentialByUrl(db, project.clientId, u) : null),
      userDataDir,
      // A caller that stops WAITING for this run does not stop the run; it walks on,
      // holding a browser profile and spending LLM calls where nobody is looking. The
      // budget is handed down so the walk can end itself and still report what it reached.
      budgetMs: budgetForAttempt,
      docsByType,
      beforeUpload: uploadDocumentGuard(db, projectId, scopeType === "ahj"),
      // Contractor contact identity for the deterministic ACA "Add New" contact pass
      // (Accela permit portals). buildPortalPlanner already split installerContactName
      // into first/last in projectFields; the account has many pre-existing contacts,
      // so the pass adds a fresh one with the filing contractor's own info.
      // SITE CONTACT is the PROPERTY OWNER, not the contractor - filling installer
      // identity into both sections produced a mixed contact live (owner name +
      // contractor address).
      siteContactIdentity: {
        // The property's parcel (parser snapshot) — the ACA work-location pass searches by it,
        // by the panel's Search button, when the address finds nothing (Lee County).
        parcel: projectFields.parcelNumber || "",
        firstName: projectFields.homeownerFirstName || "",
        lastName: projectFields.homeownerLastName || "",
        email: projectFields.homeownerEmail || "",
        phone: projectFields.homeownerPhone || "",
        street: projectFields.street || "",
        city: projectFields.city || "",
        state: projectFields.state || "",
        zip: projectFields.zip || "",
      },
      contactIdentity: {
        // THE E-SIGNATURE SIGNER comes from the CLIENT RECORD ONLY — its authorized signer, read
        // here from the row, not from projectFields (which layers the plan-set snapshot under the
        // client overlay). No signer = the typed signature step pauses for the operator.
        signerName: learnSignerName(db, project),
        firstName: projectFields.installerFirstName || "",
        lastName: projectFields.installerLastName || projectFields.installerCompanyName || "",
        email: projectFields.installerEmail || "",
        phone: projectFields.installerPhone || "",
        // ACA's contact dialog requires the address block too (and validates zip #####).
        street: projectFields.installerStreet || "",
        city: projectFields.installerCity || "",
        state: projectFields.installerState || "",
        zip: projectFields.installerZip || "",
      },
      // Equipment identity for the deterministic PV-spec combobox pass (matched with
      // certified-name aliases + distinctive-token fallback inside the adapter).
      // CEC-certified manufacturer names (weekly cec_equipment sync) — appended
      // after the curated static aliases inside the adapter. Empty table → {}.
      certifiedAliases: (() => {
        const out: Record<string, string[]> = {};
        try {
          const pairs: Array<["module" | "inverter" | "battery", string]> = [
            ["inverter", projectFields.inverterMake || projectFields.inverterManufacturer || ""],
            ["module", projectFields.moduleMake || projectFields.moduleManufacturer || ""],
            ["battery", projectFields.batteryMake || projectFields.battMake || ""],
          ];
          for (const [kind, make] of pairs) {
            if (!make) continue;
            const names = certifiedNamesForMake(db, kind, make);
            if (names.length) out[make.toLowerCase().replace(/[^a-z0-9]/g, "")] = names;
          }
        } catch { /* CEC table optional */ }
        return out;
      })(),
      equipment: {
        inverterMake: projectFields.inverterMake || projectFields.inverterManufacturer || "",
        inverterModel: projectFields.inverterModel || projectFields.invModel || projectFields.pvMicroModel || "",
        moduleMake: projectFields.moduleMake || projectFields.moduleManufacturer || "",
        moduleModel: projectFields.moduleModel || "",
        // Repeater companions on the same PV-spec page: quantities and array
        // geometry are pure project data too — the planner kept leaving them
        // on "Please select…", so the deterministic pass owns them as well.
        inverterQty: projectFields.inverterQty || projectFields.invQty || projectFields.pvMicroQty || "",
        moduleQty: projectFields.moduleQty || projectFields.modQty || "",
        tilt: projectFields.tilt || projectFields.arrayTilt || projectFields.roofPitch || "",
        azimuth: projectFields.azimuth || projectFields.arrayAzimuth || "",
        // Battery/ESS repeaters on NEM apps (storage sections ask make/model/qty).
        batteryMake: projectFields.batteryMake || projectFields.battMake || "",
        batteryModel: projectFields.batteryModel || projectFields.battModel || "",
        batteryQty: projectFields.batteryQty || projectFields.battQty || "",
        // Residential rooftop is fixed-mount — but ONLY default "Fixed" when
        // nothing in the design suggests a tracker/ground-mount system; a wrong
        // deterministic answer on an interconnection app is worse than leaving
        // the field to the planner/human.
        tracking:
          projectFields.tracking ||
          (/track/i.test(`${projectFields.mountType || ""} ${projectFields.arrayType || ""} ${projectFields.racking || ""} ${projectFields.mountingSystem || ""}`)
            ? ""
            : "Fixed"),
      },
      headless: headlessForAttempt,
      // AHJ portals (Accela / Oregon ePermitting) require one combined plan-set PDF per
      // upload control; utility portals (PowerClerk) want the split sheets per slot.
      uploadMode: scopeType === "ahj" ? "combined" : "split",
      // Deterministic policy answers (export capacity → No, UL 1741 → Yes) are standard-
      // residential-NEM domain policy: apply them only on UTILITY interconnection learns,
      // never on AHJ/permit portals. PORTAL_POLICY_DEFAULTS=off disables them everywhere
      // (non-standard projects); the planner + project data then decide.
      policyProfile:
        process.env.PORTAL_POLICY_DEFAULTS === "off" || process.env.PORTAL_POLICY_DEFAULTS === "0"
          ? "none"
          : scopeType === "utility" ? "residential_nem" : "none",
      // The keys a REPLAY can resolve. The planner picks the field each fill binds to, and
      // a key that exists only in the planner's richer map (or one it invents outright)
      // fills "" forever. Handing the adapter the replay map stops a dead binding being
      // recorded at all, rather than catching it afterwards at the trust gate.
      // BINDABLE MEANS "A REPLAY COULD RESOLVE THIS KEY", NOT "THIS PROJECT HAS A VALUE".
      //
      // resolveRecipeFieldValues emits equipment keys only when the project HAS them, so a
      // learn run against a project with no parsed plan set produces no inverterMake /
      // inverterModel / inverterQty — and the guard then REFUSES the planner's perfectly
      // correct binding for "Inverter Manufacturer". The recipe is recorded with no binding
      // and no literal, and it can never fill that field again, for any future project,
      // however complete their data. Measured on Ameren PowerClerk: three of the six blanks
      // on its review screen were this, and the recipe would have carried the fault forever.
      //
      // RECIPE_FIELD_DESCRIPTIONS is the catalogue of keys the dictionary knows how to
      // resolve. Union it with what this project actually resolved, so a key that is real
      // but empty TODAY still binds — replay fills it for the project that has it, and the
      // required-field sweep reports the blank rather than the recipe hiding it.
      bindableFields: Array.from(new Set([
        ...Object.keys(resolveRecipeFieldValues(db, project, portalType, learnTrack)),
        ...Object.keys(RECIPE_FIELD_DESCRIPTIONS),
      ])),
      // Identity for the address-disambiguation grid: which city/ZIP this project is in, whose
      // name is on it, and which discipline we are filing. Used to REFUSE another property's
      // row, not to fill anything.
      allowFinalSubmit: input.allowFinalSubmit === true, allowConsentAccept: input.allowConsentAccept,
      // Only an explicit "no battery" arms the guard. An unknown stays the planner's call —
      // silence about a battery is not the same as the project stating there isn't one.
      hasBattery: (() => {
        const raw = String((project.parserSnapshot as Record<string, unknown> | undefined)?.hasBattery ?? "").trim();
        if (/^(no|false|none|n)$/i.test(raw)) return false;
        if (/^(yes|true|y)$/i.test(raw)) return true;
        return undefined;
      })(),
      siteIdentity: {
        city: project.city,
        zip: project.zip,
        homeownerName: project.homeownerName,
        isElectrical: /elec/i.test(String(input.permitType ?? "")),
        // THE AGENCY THAT ISSUES THIS LEARN'S PERMIT (the per-job lookup, permitProcess): the
        // address-version grid is ranked by it (portal-bot addressVersion), not by Coos Bay's
        // city-structural / county-electrical convention. Production 2026-09-27: City of
        // Jefferson's permits are Marion County's. AHJ scope only — an interconnection portal
        // has no permit agency. null = unknown, and the learner keeps the convention.
        issuingAgency: scopeType === "utility" ? null : (issuingAgencyFor(project, learnTrackFor(input.discipline, input.permitType))?.value ?? null),
      },
      onProgress: input.onProgress,
      onHumanStep,
    });
  // WRITE IT DOWN BEFORE WE TOUCH THE PORTAL, NOT AFTER. This run is about to log into a
  // REAL account and start a REAL application; a run that dies mid-way has still created
  // the draft. The benchmark records its own entry (see buildLearnDraftTouch — it returns
  // null for that caller); every other learn path records here.
  const draftTouch = buildLearnDraftTouch({
    portalUrl,
    projectId,
    createdBy: input.createdBy,
    // Same parse as the self-test gate below — the self-test replays the LIVE portal in a
    // fresh session, so it can mint a second draft per run.
    selfTestEnabled: process.env.PORTAL_REPLAY_SELFTEST === "1" || process.env.PORTAL_REPLAY_SELFTEST === "true",
    credentials: project.clientId ? listPortalCredentials(db, project.clientId) : [],
  });
  if (draftTouch) recordDraftTouch(draftTouch);
  try {
    learn = await browserLimiter(runLearn);
  } catch (err) {
    throw new HttpError(502, `Portal learn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The headed retry described above. Re-runs the identical learn with a real window when —
  // and only when — the failure looks like a bot block.
  if (!headedRetryUsed && looksBotBlocked(String(learn?.message || "")) && resolveHeadless(headlessForAttempt)
      && process.env.PORTAL_HEADED_RETRY !== "0") {
    headedRetryUsed = true;
    headlessForAttempt = false;
    if (input.budgetMs) {
      const left = input.budgetMs - (Date.now() - budgetStartedAt);
      // Under a minute buys nothing but a browser that will be cut off mid-page.
      if (left < 60_000) {
        logger.info("auto-learn", "portal refused a headless browser, but too little budget remains to retry headed", { portal: portalUrl });
        headlessForAttempt = true;
      }
      budgetForAttempt = Math.max(60_000, left);
    }
    if (!headlessForAttempt) {
    logger.info("auto-learn", "portal refused a headless browser — retrying with a real window", { portal: portalUrl });
    try {
      const retried = await browserLimiter(runLearn);
      // Keep the retry only if it actually got further; a second refusal should not erase
      // the first result's diagnostics.
      if (retried && (retried.ok || (retried.pageCount ?? 0) > (learn?.pageCount ?? 0))) {
        learn = retried;
        learn.message = `${learn.message} (succeeded on a headed retry — this portal refuses headless browsers)`;
      }
    } catch { /* the headless result stands */ }
    }
  }

  // NEAR-MISS credential diagnosis. "No stored credential was found" is technically
  // true and operationally maddening when the client HAS logins — just for a
  // different portal host (live-tested: a PGE PowerClerk login saved, project on
  // Pacific Power's PowerClerk — same platform, different tenant host, correctly
  // refused). Name what IS stored so the operator adds the right login instead of
  // hunting a phantom bug.
  // LOGIN HEALTH. A stored credential the portal refused is a fact worth keeping — otherwise
  // it dies with the run and the next person to touch that jurisdiction rediscovers it. Both
  // outcomes are recorded, because a success is what clears a stale mark. Diagnostic only:
  // never allowed to affect the run.
  if (credential && project.clientId) {
    try {
      const msg = String(learn.message || "");
      const rejected = /still on the login form|username\/password was likely rejected|login failed/i.test(msg);
      const reachedPortal = learn.ok || learn.pageCount > 0 || /review|advance|fill/i.test(msg);
      if (rejected) {
        recordLoginOutcome(db, project.clientId, portalUrl, { ok: false, note: msg.slice(0, 240) });
      } else if (reachedPortal) {
        recordLoginOutcome(db, project.clientId, portalUrl, { ok: true, note: "login accepted" });
      }
    } catch { /* diagnostic only */ }
  }

  if (!credential && project.clientId && /no stored credential/i.test(String(learn.message || ""))) {
    try {
      const targetHost = (() => { try { return new URL(portalUrl).hostname.toLowerCase(); } catch { return String(portalUrl || "").toLowerCase(); } })();
      const stored = listPortalCredentials(db, project.clientId);
      if (stored.length) {
        // LIST THE NEAR MISSES, NOT THE WHOLE BOOK. A service bureau holds a login per
        // jurisdiction — this client has 83 — and dumping all of them produced a 4,700
        // character wall that buried the one fact that mattered.
        const near = nearestStoredLogins(stored, portalUrl, project.ahj);
        const nearNote = near.length
          ? ` The closest stored login(s) are ${near.join(", ")} — check whether one of those is actually the same system before adding a new one.`
          : " None of them look related to this portal.";
        learn.message += ` Note: this client has ${stored.length} stored login(s), but none for ${targetHost}.${nearNote} Jurisdictions and utilities on a shared platform still use separate hosts and accounts, so a login for THIS portal has to be added.`;
      }
    } catch { /* diagnostic only */ }
  }

  // Per-run debug bundle (data/learn-runs/<runId>) created by the adapter. `finalize` is the
  // single chokepoint every terminal path returns through: it stamps the bundle path onto the
  // result and drops the backend-side artifacts into the bundle — llm-calls.json (metadata for
  // every planner/verifier Claude call this run: latency, tokens, cache hits, stop_reason) and
  // result.json (the outcome + verification signals). Diagnostics only — never fails the learn.
  const debugDir = learn.debugDir ?? null;
  const finalize = (r: Omit<AutoLearnResult, "debugDir">): AutoLearnResult => {
    const result: AutoLearnResult = { ...r, debugDir };
    if (debugDir) {
      try {
        fs.writeFileSync(path.join(debugDir, "llm-calls.json"), JSON.stringify({
          llmMode: process.env.ANTHROPIC_API_KEY ? "claude" : "stub (heuristic planner — set ANTHROPIC_API_KEY for real learning)",
          note: "Every Claude call in this run (planner + verifiers): latency, token usage, cache hits, stop_reason. Prompts and responses are never stored. In stub mode this list is empty.",
          calls: getRecentLlmCalls(learnStartedAtMs),
        }, null, 2));
        fs.writeFileSync(path.join(debugDir, "result.json"), JSON.stringify({
          status: result.status,
          pauseReason: result.pauseReason,
          pageCount: result.pageCount,
          finalSubmitRecorded: result.finalSubmitRecorded,
          verification: result.verification,
          message: result.message,
          recipeId: result.recipe?.id ?? null,
          recipeStatus: result.recipe?.status ?? null,
        }, null, 2));
      } catch { /* non-fatal */ }
    }
    return result;
  };

  // PROTECT A TRUSTED RECIPE: startPortalRecording resets the existing recipe for this
  // profile key (bumps version, clears steps, status -> 'recording') before the outcome is
  // known. Routing normally only auto-learns when no complete recipe exists, but the manual
  // /auto-learn endpoint can target a portal that already has a verified-complete recipe —
  // and a paused/failed/unverified pass must NOT destroy it. A complete recipe is only ever
  // replaced by a NEW learn that itself verified trusted (or by an explicit delete/re-record).
  // Discipline-scoped: unscoped, an ELECTRICAL learn would find the AHJ's STRUCTURAL
  // recipe, treat it as "already trusted", and silently discard its own pass.
  // The discipline the CALLER is staging, not one re-derived from permitType. Deriving it
  // here could never produce "combo" (the DEFAULT permit track for any AHJ that is not
  // split) and mapped "mpu" to structural, so the value WRITTEN never matched the value
  // the lookup asks for: the combo track re-learned the portal on every single stage, and
  // each of those learns claimed the building track's structural row and wiped its steps.
  const learnDiscipline = scopeType === "utility"
    ? ""
    : (input.discipline ?? (input.permitType === "electrical" ? "electrical" : input.permitType === "structural" ? "structural" : ""));
  const existingRecipe = findAnyRecipeForProject(db, {
    scopeType,
    state: project.state,
    ahj: project.ahj,
    utility: project.utility,
    discipline: learnDiscipline,
  });
  const protectComplete = existingRecipe?.status === "complete";
  // DEPTH IS INFORMATION, AND A SHORTER DRAFT MUST NOT ERASE A LONGER ONE.
  //
  // protectComplete only guards a COMPLETE recipe. Two drafts of the same portal were not
  // ranked at all, so the last writer won — and on 2026-09-09 the last writer was a
  // benchmark run the harness cut off at 660 seconds. It replaced Miami's 58-step, 39-fill
  // draft, which had walked twelve pages of the intake, with the 28-step, 18-fill draft that
  // run managed before it was killed. The good one survived only in prev_steps_json.
  //
  // Neither draft replays (both are needs_rerecord), so nothing files differently either
  // way; what is lost is the record of how far the portal can actually be walked, which is
  // the whole point of keeping a draft. Substantive steps - fills, selects, checks - is the
  // only depth measure available on both sides.
  const existingDepth = substantiveStepCount(existingRecipe?.steps as Array<{ action?: unknown }> | undefined);
  const substantive = substantiveStepCount;
  const keepDeeperDraft = (why: string): boolean => {
    const newDepth = substantiveStepCount(learn.steps as Array<{ action?: unknown }>);
    if (!shouldKeepDeeperDraft(existingRecipe?.steps as Array<{ action?: unknown }> | undefined, learn.steps as Array<{ action?: unknown }>, { protectComplete, hasExisting: !!existingRecipe })) return false;
    void newDepth;
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_kept_deeper_draft", {
      scope: scopeType, existingDepth, newDepth, reason: why,
    });
    return true;
  };
  // Terminal progress signal — the LearnProgress contract includes phase "done" so the UI
  // progress bar can complete; emit it on EVERY terminal path, success or not.
  const emitDone = (message: string) => input.onProgress?.({ phase: "done", pageCount: learn.pageCount, maxPages: learn.pageCount, message });
  const preserved = (status: "draft" | "paused" | "failed", pauseReason: string | null, verification: AutoLearnResult["verification"], why: string): AutoLearnResult => {
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_kept_existing_recipe", { scope: scopeType, outcome: status, reason: why });
    emitDone(`Learning finished (${status}) — existing verified recipe kept.`);
    return finalize({
      recipe: existingRecipe!,
      status, pauseReason,
      pageCount: learn.pageCount,
      finalSubmitRecorded: learn.finalSubmitRecorded, pageTrace: learn.pageTrace ?? [],
      verification,
      message: `${why} The existing verified recipe for this portal was left untouched — delete it first if you want to force a re-learn.`,
    });
  };

  // Record the learned steps as a recipe (starts in "recording"). Deferred behind the
  // protectComplete guards — creating the stub is what RESETS an existing recipe row.
  const mkStub = () => startPortalRecording(db, {
    scopeType,
    state: project.state,
    ahj: project.ahj,
    utility: project.utility,
    portalPlatform: "auto-learned",
    portalUrl,
    createdBy: input.createdBy || "auto-learn",
    // Claims this discipline's own row instead of resetting the AHJ's other one.
    discipline: learnDiscipline,
  });

  if (learn.pauseReason) {
    // What the operator reads. An MFA/CAPTCHA is a "challenge"; the e-signature pauses
    // (signature_no_signer / signature_drawn / signature_incomplete) are not, and the learner's
    // own message already says what to do.
    const pauseWhat = /^signature_/.test(learn.pauseReason)
      ? `at the e-signature step (${learn.pauseReason}): ${String(learn.message || "").slice(0, 300)}`
        + (learn.pauseReason === "signature_drawn" && !resolveHeadless(input.headless) ? " The browser is open at the signature step for you to sign." : "")
      : `on a ${learn.pauseReason} challenge — a human must complete it.`;
    if (protectComplete) {
      return preserved("paused", learn.pauseReason, { accurate: false, confidence: "low", matches: [], issues: [] }, `Learning paused ${pauseWhat}`);
    }
    // A PAUSE IS THE LEAST INFORMATIVE OUTCOME THERE IS, and it was the one path allowed to
    // overwrite a deeper draft. Both failure paths below consult keepDeeperDraft; this one
    // did not, so a run that hit an MFA wall on page one replaced whatever the last run had
    // walked. Live: every SmartGov row in the 2026-09-09 sweep is a 2-fill "Auto-learn
    // paused: mfa_captcha" stub sitting on top of its own predecessor. Returning here also
    // avoids the reset entirely — no version bump, no wipe, nothing to roll back.
    if (keepDeeperDraft(`learning paused on a ${learn.pauseReason} challenge`)) {
      return preserved("paused", learn.pauseReason, { accurate: false, confidence: "low", matches: [], issues: [] },
        `Learning paused ${pauseWhat} Kept the existing draft, which got further (${existingDepth} field(s) vs ${substantive(learn.steps as Array<{ action?: unknown }>)}).`);
    }
    const stub = mkStub();
    savePortalRecipeSteps(db, stub.id, withholdClientLicenceLiteralsFor(db, learn.steps, project.clientId), { status: "recording", notes: `Auto-learn paused: ${learn.pauseReason}. Resume manually.` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_paused", { scope: scopeType, pauseReason: learn.pauseReason });
    emitDone(`Learning paused ${pauseWhat}`);
    return finalize({ recipe: getPortalRecipe(db, stub.id), status: "paused", pauseReason: learn.pauseReason, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, pageTrace: learn.pageTrace ?? [], verification: { accurate: false, confidence: "low", matches: [], issues: [] }, message: `Learning paused ${pauseWhat} The partial recipe was saved as a draft.` });
  }

  if (!learn.ok || !learn.steps.length) {
    if (protectComplete) {
      return preserved("failed", null, { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, `Could not learn the portal automatically: ${learn.message}.`);
    }
    if (keepDeeperDraft("learn could not complete")) {
      return preserved("failed", null, { accurate: false, confidence: "low", matches: [], issues: [learn.message] },
        `Could not learn the portal automatically: ${learn.message} Kept the existing draft, which got further (${existingDepth} field(s) vs ${substantive(learn.steps as Array<{ action?: unknown }>)}).`);
    }
    const stub = mkStub();
    savePortalRecipeSteps(db, stub.id, withholdClientLicenceLiteralsFor(db, learn.steps, project.clientId), { status: "needs_rerecord", notes: `Auto-learn could not complete: ${learn.message}` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_failed", { scope: scopeType });
    emitDone("Learning failed — the portal could not be learned automatically.");
    return finalize({ recipe: getPortalRecipe(db, stub.id), status: "failed", pauseReason: null, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, pageTrace: learn.pageTrace ?? [], verification: { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, message: `Could not learn the portal automatically: ${learn.message}. Record it manually instead.` });
  }

  // A CLEAN stage requires BOTH reaching the portal's review screen AND having filled at least one
  // field. `learn.ok` is true if EITHER held, so without this gate two fake-success modes slip
  // through to verification and get reported as a draft "staged to review": (a) filled pages but
  // never reached review (got lost mid-wizard), and (b) a premature atReview on a landing/disclaimer
  // page that filled nothing. Both stage nothing for a human to verify/submit — mark failed and say
  // which so the operator can fix the start URL or record manually.
  const reachedReview = learn.reachedReview === true;
  const filledSomething = learn.filledSomething === true;
  if (!reachedReview || !filledSomething) {
    const why = !reachedReview
      ? "filled fields but never reached the portal's review screen"
      : "reached a screen treated as review but filled no fields (likely a landing/disclaimer page misread as the review screen)";
    if (protectComplete) {
      return preserved("failed", null, { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, `Nothing was staged — ${why}.`);
    }
    if (keepDeeperDraft(why)) {
      return preserved("failed", null, { accurate: false, confidence: "low", matches: [], issues: [learn.message] },
        // KEEP THE RUN'S OWN WORDS. This path returns before the message assembly, so the
        // portal's notices, the validation blockers and the "none of what it offered fits
        // this job" line were all dropped exactly when they were most useful — the run that
        // got further is the one whose reasons the operator needs.
        `Nothing was staged — ${why}. Kept the existing draft, which got further (${existingDepth} field(s) vs ${substantive(learn.steps as Array<{ action?: unknown }>)}). ${learn.message}`);
    }
    const stub = mkStub();
    emitDone(`Learning failed — ${why}.`);
    savePortalRecipeSteps(db, stub.id, withholdClientLicenceLiteralsFor(db, learn.steps, project.clientId), { status: "needs_rerecord", notes: `Auto-learn did not stage cleanly: ${why}. ${learn.message}` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_failed", { scope: scopeType, reason: !reachedReview ? "no_review" : "premature_review" });
    return finalize({ recipe: getPortalRecipe(db, stub.id), status: "failed", pauseReason: null, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, pageTrace: learn.pageTrace ?? [], verification: { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, message: `Nothing was staged — ${why}. ${learn.message}` });
  }

  // VERIFY the fill against the project data before trusting the recipe.
  input.onProgress?.({
    phase: "verify",
    pageCount: learn.pageCount,
    maxPages: learn.pageCount,
    message: "Verifying the filled values against the project record…",
  });
  const llm = learnLlmFactory();
  const reviewBody = learn.reviewScreen.bodyTextSnippet || "";

  // Sensitive fields (account#, meter#, password) are stripped from projectFields so they
  // never reach the LLM planner. Strip them from the review-screen fields before the text
  // verifier too — they're bound at replay from the encrypted credential store, not from the
  // recipe, so a masked portal value must NOT gate recipe promotion.
  const nonSensitiveReviewFields = learn.reviewScreen.fields.filter((f) => !SENSITIVE_REVIEW_LABEL.test(f.label));

  // THREE independent verification signals, combined for defense in depth:
  //  1. text — the LLM compares the DOM-scraped field/value pairs to the project data;
  //  2. vision — the LLM LOOKS AT the review screenshot (works even when the DOM scrape is
  //     thin, which is exactly the read-only-review case that produced the "blank app");
  //  3. deterministic — code-level compare of scraped fields + rendered page text.
  const textVerification = await llm.verifyPortalFill({
    reviewFields: nonSensitiveReviewFields,
    projectFields,
    bodyText: reviewBody,
  });
  // Vision verification can be disabled (PORTAL_VISION_VERIFY=0). NOTE: the review screenshot
  // is a RAW render and may contain portal-rendered PII (account/meter numbers shown as text)
  // that the DOM/text path masks — it is sent to the model and written to data/screenshots, so
  // treat it as sensitive.
  let visionVerification: typeof textVerification | null = null;
  if (learn.reviewScreenshotBase64 && process.env.PORTAL_VISION_VERIFY !== "0") {
    try {
      visionVerification = await llm.verifyPortalFillVision({
        screenshotBase64: learn.reviewScreenshotBase64,
        mimeType: "image/png",
        // The SAME filtered list the text verifier gets (it used to receive every scraped field,
        // account and meter numbers included). The screenshot itself is still a raw render —
        // masking it is the L2 work, recorded as open.
        reviewFields: nonSensitiveReviewFields,
        projectFields,
        bodyText: reviewBody,
      });
    } catch { visionVerification = null; }
  }

  // The deterministic check returns a single "reviewScreen" SENTINEL when it could read
  // nothing — that is an honest "couldn't read", NOT a per-field mismatch, so don't let it
  // masquerade as one or veto trust.
  const allDetMismatches = compareReviewFields(learn.reviewScreen.fields, project, reviewBody);
  const isUnreadableSentinel = allDetMismatches.length === 1 && allDetMismatches[0].field === "reviewScreen";
  // Exclude sensitive fields (accountNumber, meterNumber) from trust-gating: they're bound at
  // replay from the credential store, so a portal that masks them on the review screen must
  // not block promotion. The mismatches are still surfaced in the UI for human awareness.
  const SENSITIVE_DET_FIELDS = new Set(["accountNumber", "meterNumber"]);
  const deterministicMismatches = isUnreadableSentinel ? [] : allDetMismatches.filter((m) => !SENSITIVE_DET_FIELDS.has(m.field));

  // "Usable" = a signal actually had something to compare. A captured-but-unverified
  // screenshot does NOT count (the vision call may have failed/returned nothing), so the
  // honest "could not be read" message isn't suppressed.
  const visionUsable = !!(visionVerification && visionVerification.matches.length > 0);
  // READABLE MEANS PARSED FIELDS OR A VISION READ. A non-empty body snippet used to count, and
  // any 320-character scrap of page chrome ("Home | Help | Log out …") made a review screen
  // nobody parsed "readable" — the vacuous "accurate over an unread page" the trust gate names.
  const reviewReadable = learn.reviewScreen.fields.length > 0 || visionUsable;

  // Vision is authoritative for DISPLAY when it actually read the page (it sees read-only
  // review screens the DOM scrape can't). But TRUST is granted only when the signals AGREE —
  // defense in depth may only ever LOWER trust, never raise it past a concrete mismatch.
  const verification = visionUsable ? { ...visionVerification! } : { ...textVerification };
  const mergedIssues = [...verification.issues];
  // Always surface the OTHER signals' NEGATIVE findings so a contradiction is never hidden.
  if (visionUsable && textVerification.issues.length) mergedIssues.push(`text-check: ${textVerification.issues.join("; ")}`);
  if (deterministicMismatches.length) mergedIssues.push(`deterministic-check flagged: ${deterministicMismatches.map((m) => m.field).join(", ")}.`);

  if (!reviewReadable) {
    mergedIssues.push("Review screen could not be read (no fields, text, or readable screenshot) — the fill could not be verified; a human must confirm before this recipe is trusted.");
  } else if (verification.matches.length === 0 && deterministicMismatches.length > 0) {
    // Neither LLM produced matches but the deterministic check found concrete issues — show
    // them as the matches so the dashboard isn't blank.
    verification.matches = deterministicMismatches.map((m) => ({ label: m.field, expected: m.expected, found: m.found, ok: false }));
  }
  verification.issues = mergedIssues;

  // TRUST GATE (promotes the recipe to "complete" for deterministic replay + the trusted-
  // submit allowlist). The LLM verifier(s) are the authoritative signal. Deterministic
  // mismatches are surfaced as warnings but do NOT block promotion — the deterministic
  // scraper too often false-positives on read-only portals, masked sensitive fields, and
  // conditional widgets the scraper can't reach. A text contradiction (LLM explicitly says
  // values are WRONG, not just absent) still blocks — that's a concrete data error.
  // NOTE: Final submit always requires human action regardless of this gate.
  const textContradicts = textVerification.matches.length > 0 && !textVerification.accurate;
  // HARD BLOCKERS the adapter detected structurally (not via the LLM verifier): REQUIRED fields
  // left blank/unselected, required document uploads with no file, or portal validation errors on
  // an advance. The vision/text verifier looks at the rendered review summary and can MISS a
  // dropped Schedule or an unanswered Yes/No group (the summary just omits the row), so without
  // this the recipe gets promoted to "trusted" with a known-blank required field — exactly the
  // false-confidence the operator hit. Any blocker forces "draft" for human completion.
  const requiredMisses = learn.requiredFieldMisses ?? [];
  // SELF-TEACHING: record the words of every required question this run couldn't answer.
  // Terms that recur across runs become active digest topics, so future runs surface the
  // matching plan-set/notes lines to the planner and can answer the question.
  try { learnNoteTopicsFromMisses(db, requiredMisses); } catch { /* best-effort */ }
  const docMisses = learn.missingRequiredDocs ?? [];
  const validationBlocks = learn.validationBlocks ?? [];
  const hasHardBlockers = requiredMisses.length > 0 || docMisses.length > 0 || validationBlocks.length > 0;

  // POST-LEARN BINDING PASS. The auto-learned recipe is the ONLY home for portal specifics, so a
  // fill recorded as a frozen LITERAL that equals THIS project's data would replay verbatim onto
  // every future project. Convert such literals into reusable field bindings; a literal that
  // matches project data AMBIGUOUSLY (>1 field) can't be safely auto-bound, so treat it as a hard
  // blocker — never promote a contaminated recipe to trusted.
  const { steps: boundLiteralSteps, bound: boundLiterals, ambiguous: ambiguousLiterals, portalConstants } =
    // Company attestations are stamped with THIS job's client first (recipeReplayBinding R8 answers
    // them only for that client; any other company's job leaves them for a person).
    convertLiteralsToBoundFields(stampCompanyAttestations(learn.steps, project.clientId), projectFields);
  // THE LEARN COMPANY'S LICENCE NEVER STAYS A LITERAL (withholdClientLicenceLiterals, licences skeptic L1):
  // a recorded value equal to ANY licence this job's client holds, still unbound after the pass above,
  // is withheld for a person — never replayed on another company's job.
  const boundSteps = withholdClientLicenceLiteralsFor(db, boundLiteralSteps, project.clientId);
  if (ambiguousLiterals.length) {
    verification.issues.push(
      `Recorded literal value(s) match this project's data but could not be uniquely bound to a field (${ambiguousLiterals.slice(0, 6).map((a) => `"${a.value}"→${a.candidates.join("/")}`).join(", ")}). These would replay verbatim onto other projects — review before trusting.`,
    );
  }
  // A literal KEPT because its label showed the control asks something else entirely. Not a
  // blocker — but the operator must still see it, because the rule reads the label and a
  // question worded without any recognisable token ("backup power unit on site?") would be
  // frozen at this project's answer for every future project. This list is where that shows.
  if (portalConstants.length) {
    verification.issues.push(
      `Kept as portal constant(s) — the control's own wording shows it is not asking about this project's data, so the recorded answer replays unchanged (${portalConstants.slice(0, 6).map((c) => `"${String(c.value).slice(0, 24)}"${c.note ? ` @ ${String(c.note).slice(0, 40)}` : ""}`).join("; ")}). Confirm each is right for every project this portal will file.`,
    );
  }
  // DEAD BINDINGS. The LLM planner CHOOSES the field name a fill binds to
  // (autoLearnAdapter.ts sets `step.field = fillReq.field` verbatim), and nothing checked
  // that the name it chose is one resolveRecipeFieldValues can actually produce. A step
  // bound to an invented key resolves to "" on every replay, forever: resolveValue returns
  // empty, the step returns false, and it is SKIPPED IN SILENCE. Found live — the
  // PacifiCorp recipe carries `field: "descriptionOfService"`, which is not a key the
  // resolver emits, so that select could never fill on any project, and the blank it left
  // changed the portal's own branching two pages later.
  //
  // A recipe with a dead binding cannot replay correctly, so this BLOCKS promotion rather
  // than being a warning: promoting one is exactly how a recipe becomes trusted and still
  // never works. Sensitive steps are included on purpose — they carry a field and no
  // literal, so a bad key there is silently unfillable too.
  // Validate against the REPLAY map, not the learn map. `projectFields` here is the
  // PLANNER's map, which is a superset: autoLearn injects `designNotes` (a digest for the
  // model) and used to inject `exportLimiting`. A step bound to a learn-only key passes a
  // check against this map and still resolves to "" on every replay — the precise hole that
  // makes a recipe trusted and non-functional. resolveRecipeFieldValues IS the replay map.
  const replayFields = resolveRecipeFieldValues(db, project, portalType, learnTrack);
  const deadBindings = deadFieldBindings(boundSteps, replayFields);
  if (deadBindings.length) {
    verification.issues.push(
      `Step(s) bound to a field the project data does not define, so they can NEVER fill on replay: ${deadBindings.slice(0, 8).join(", ")}${deadBindings.length > 8 ? `, +${deadBindings.length - 8} more` : ""}. Re-record these fields, or bind them to a real project field.`,
    );
  }
  const bindingNote = boundLiterals.length ? ` Bound ${boundLiterals.length} literal value(s) to project fields for safe replay.` : "";

  // PROMOTION FLOOR: a trusted recipe must have actually WALKED a wizard. The live Salem
  // run stopped on page 2 (entry disclaimer misread as review) with a single recorded fill
  // and was promoted with an EMPTY application — "accurate" was vacuous: nothing present,
  // nothing contradicted. Below these minimums the recipe stays draft for human
  // confirmation; it is never auto-trusted.
  const substantiveSteps = (learn.steps ?? []).filter((s) => s.action === "fill" || s.action === "select" || s.action === "check").length;
  const tooThin = (learn.pageCount ?? 0) < 3 || substantiveSteps < 5;
  if (tooThin) {
    verification.issues.push(
      `Learn run too thin to auto-trust (${learn.pageCount} page(s), ${substantiveSteps} recorded fill(s)) — verify the captured fill by hand before trusting.`,
    );
  }

  // WAS THIS EVEN THE RIGHT FORM?
  //
  // Everything above measures how WELL the run filled the form it reached. Nothing asked
  // whether it was the right form. Gilbert, AZ was the only portal of eleven to reach a
  // review screen in the 2026-09-04 baseline — top rung — on a page titled "Neumo: Permit
  // Extension Request", from the stored URL .../f/permitext. A permit extension, filled
  // perfectly, scored 6 of 6.
  //
  // A trusted recipe replays unattended on every future project in its jurisdiction, so a
  // trusted recipe for a permit extension files permit extensions for real customers. The
  // run's own evidence is enough to catch it: what the form called itself, and where it was.
  const gotoUrls = (learn.steps ?? []).filter((st) => st.action === "goto").map((st) => String(st.value || ""));
  const purpose = formPurposeMismatch(
    [learn.portalName, learn.reviewScreen?.bodyTextSnippet],
    [portalUrl, ...gotoUrls],
  );
  if (purpose.mismatch) verification.issues.push(purpose.reason);

  // THE TRUST GATE. Every condition above feeds evaluateTrustGate, which is where the bar is
  // written down in full — read that comment before changing anything here. Nothing may grant
  // trust past it: the code below only ever REMOVES trust (the replay self-test), never adds it.
  const gate = evaluateTrustGate({
    // Both are guaranteed true by the early return a hundred lines up, and are passed anyway
    // so the gate is a total function of the run rather than of what its caller remembered.
    reachedReview, filledSomething,
    reviewReadable,
    verificationAccurate: verification.accurate,
    textContradicts,
    requiredFieldMisses: requiredMisses,
    missingRequiredDocs: docMisses,
    validationBlocks,
    ambiguousLiteralCount: ambiguousLiterals.length,
    deadBindings,
    pageCount: learn.pageCount ?? 0,
    substantiveFills: substantiveSteps,
    formPurposeMismatch: purpose.mismatch,
  });
  let trusted = gate.trusted;
  if (hasHardBlockers) {
    if (requiredMisses.length) verification.issues.push(`Required field(s) left blank/unselected — fill before trusting: ${requiredMisses.slice(0, 12).join(", ")}${requiredMisses.length > 12 ? ", …" : ""}.`);
    if (docMisses.length) verification.issues.push(`Required document(s) not attached: ${docMisses.slice(0, 8).join(", ")}.`);
    if (validationBlocks.length) verification.issues.push(`Portal validation blocked an advance: ${validationBlocks.slice(0, 8).join("; ")}.`);
  }

  // While a verified-complete recipe is being protected, the stub (which RESETS that row) is
  // created only after the FINAL trust decision — the replay self-test below can still downgrade
  // trusted → draft, and a draft must never have already clobbered the trusted steps.
  let stub = protectComplete ? null : mkStub();

  // F4: REPLAY SELF-TEST (opt-in via PORTAL_REPLAY_SELFTEST=1). A recipe is only worth TRUSTING if
  // it REPRODUCES the review deterministically in a fresh session — a learn-pass fill working does
  // NOT prove the recorded selectors will resolve next time (dynamic ids, frames, timing). So before
  // promoting, replay the just-bound recipe via the RecipeAdapter and require it to reach review.
  // OFF BY DEFAULT: this re-runs the LIVE portal, which can create a SECOND draft application — enable
  // it deliberately when validating a freshly-learned recipe. Best-effort: a self-test error or a
  // non-reproduction downgrades the recipe to a draft rather than hard-failing the learn.
  const selfTestEnabled = process.env.PORTAL_REPLAY_SELFTEST === "1" || process.env.PORTAL_REPLAY_SELFTEST === "true";
  // RUN IT EVEN WHEN THE RECIPE WAS NOT GOING TO BE TRUSTED.
  //
  // Gating this on `trusted` meant the only recipes ever replay-tested were the ones already
  // believed good, and the ones most in need of the test — everything recorded but unverified
  // — skipped it silently. Live: permiteyes.us learned a nine-fill application, was saved as
  // "recording", and replayed two steps later into a permit-type menu it had no step for. The
  // recipe never encoded the type choice, and nothing in the learn noticed, because the one
  // mechanism that would have noticed only runs for recipes it has already decided are fine.
  //
  // A recipe that fails the self-test cannot be promoted; a recipe that passes has earned
  // something. Both are worth knowing, and only one of them was being measured.
  // SAY WHETHER IT RAN. Three runs were spent deciding whether a missing verdict meant the
  // self-test failed silently or never ran at all — a question the run itself should answer.
  console.log(`[self-test] ${selfTestEnabled ? "ENABLED — replaying the learned recipe" : "disabled (PORTAL_REPLAY_SELFTEST not set)"}`);
  if (selfTestEnabled) {
    input.onProgress?.({ phase: "verify", pageCount: learn.pageCount, maxPages: learn.pageCount, message: "Replay self-test: re-running the learned recipe in a fresh session…" });
    try {
      const { stageWithRecipe } = await import("../../portal-bot/src/index");
      // When the existing complete recipe is protected there's no stub row yet — synthesize the
      // replay recipe in memory (same steps/url) without touching the DB.
      const baseRecipe: PortalRecipe = stub ? getPortalRecipe(db, stub.id) : { ...existingRecipe!, portalUrl: portalUrl || existingRecipe!.portalUrl };
      const recipeForReplay: PortalRecipe = { ...baseRecipe, steps: boundSteps };
      const replayFieldValues = resolveRecipeFieldValues(db, project, portalType, learnTrack);
      // A REPLAY THAT CANNOT LOG IN IS NOT A TEST OF THE RECIPE.
      //
      // This call passed neither the credential, nor the browser profile, nor the portal's
      // login URL — the three things the LEARN is given a few hundred lines above. So the
      // replay landed on a login page it could not pass, runAdapter returned its
      // login-failure shape (ok:false, no message, no data), and every "replay self-test did
      // NOT reproduce the review" verdict this project has ever recorded was a login failure
      // wearing a recipe failure's clothes. Ameren's first genuine review screen is what made
      // that visible: the recipe was fine and the test never reached it.
      //
      // "Fresh session" means a fresh browser, not a fresh identity — production replay uses
      // the same per-portal profile, so the self-test must too or it is testing something
      // nobody will ever run.
      const replay = await stageWithRecipe(recipeForReplay, project, replayFieldValues, docsByType, [], {
        headless: input.headless,
        credential,
        userDataDir,
        loginUrl: portalUrl,
        beforeUpload: uploadDocumentGuard(db, projectId, input.scope === "ahj"),
      }) as Record<string, unknown>;
      const reproduced = replay.ok === true && !replay.pauseReason;
      if (!reproduced) {
        // Already untrusted stays untrusted; this only ever removes trust, never grants it.
        trusted = false;
        // SAY WHAT THE REPLAY DID, NOT JUST THAT IT FAILED.
        //
        // This is the single most important check in the product — can the bot re-run what
        // it just learned — and on Ameren's first genuine review screen it reported
        // "recipe did not reach review on replay" and nothing else, because replay.message
        // was empty and the fallback string is all there was. Everything needed was sitting
        // in the replay result: which steps were skipped, what drifted, where it stopped.
        const rd = (replay.data ?? {}) as {
          skipped?: string[]; driftWarnings?: string[]; unresolvedFields?: string[];
          executed?: number; requiredStillEmpty?: string[]; stoppedAtPayment?: boolean;
        };
        const detail = [
          String(replay.message || replay.pauseReason || "").trim(),
          typeof rd.executed === "number" ? `${rd.executed} step(s) executed` : "",
          rd.skipped?.length ? `SKIPPED: ${rd.skipped.slice(0, 6).join("; ")}` : "",
          rd.unresolvedFields?.length ? `unresolved binding(s): ${rd.unresolvedFields.slice(0, 6).join(", ")}` : "",
          rd.requiredStillEmpty?.length ? `still empty: ${rd.requiredStillEmpty.slice(0, 6).join(", ")}` : "",
          rd.driftWarnings?.length ? `drift: ${rd.driftWarnings.slice(0, 3).join(" | ")}` : "",
        ].filter(Boolean).join(". ");
        console.log(`[self-test] FAILED — ${detail || "(the replay reported nothing)"}`);
        verification.issues.push(`Replay self-test did NOT reproduce the review in a fresh session (${detail || "recipe did not reach review on replay, and the replay reported nothing — that is itself the defect to fix"}). Kept as a draft for human verification.`);
        addAuditLog(db, projectId, "system", "auto-learn", "portal.replay_selftest_failed", {
          scope: scopeType,
          executed: rd.executed ?? null,
          skipped: (rd.skipped ?? []).slice(0, 10),
          unresolved: (rd.unresolvedFields ?? []).slice(0, 10),
        });
      } else {
        console.log("[self-test] PASSED — the recipe reproduced the review in a fresh session");
        addAuditLog(db, projectId, "system", "auto-learn", "portal.replay_selftest_passed", { scope: scopeType });
      }
    } catch (err) {
      trusted = false;
      console.log(`[self-test] ERRORED — ${err instanceof Error ? err.message : String(err)}`);
      verification.issues.push(`Replay self-test errored (${err instanceof Error ? err.message : String(err)}). Kept as a draft.`);
    }
  }

  // An UNVERIFIED pass never replaces a verified-complete recipe — the fill was staged to the
  // portal (nothing is lost for THIS project) but the reusable recipe keeps its trusted steps.
  if (!trusted && protectComplete) {
    return preserved("draft", null, {
      accurate: verification.accurate,
      confidence: verification.overallConfidence,
      matches: verification.matches,
      issues: verification.issues,
    }, `Portal was filled and staged, but this pass did not verify cleanly (${verification.issues.slice(0, 2).join("; ") || "low confidence"}).`);
  }
  stub = stub ?? mkStub();
  // What this learn checked, with its denominator, and the one sentence for the submit gate (B10).
  const trustedWords = trustedLearnWording({
    confidence: String(verification.overallConfidence),
    fieldsChecked: verification.matches.length,
    fieldsMatched: verification.matches.filter((m) => m.ok).length,
    recordedFills: substantiveSteps,
    pageCount: learn.pageCount ?? 0,
    scopeType,
    bindingNote,
  });
  // DEPTH ON THIS PATH IS GUARDED IN THE WRITER, NOT HERE. This is the third and last place
  // that can bury a deeper draft — a run that reached review, filled four fields and failed
  // the trust gate lands here as "recording" and used to overwrite a 60-step draft — but the
  // trust verdict is only final AFTER the replay self-test, which needs the stub row. Rather
  // than reorder the run around one guard, the invariant lives in savePortalRecipeSteps: a
  // save that is not 'complete' may not reduce the recipe's fill count. That covers this
  // path, the pause path, both failure paths, the PUT route and anything written later.
  savePortalRecipeSteps(db, stub.id, boundSteps, {
    status: trusted ? "complete" : "recording",
    notes: trusted
      ? trustedWords.note
      : `Auto-learned but NOT verified — review the captured fill and confirm before trusting.${bindingNote} Issues: ${verification.issues.join("; ") || "low confidence"}.`,
  });
  // The recipe row + steps now exist — route captured human fixes into it, and flush any
  // fixes made in the window before the row was saved (flushed AFTER the save above so the
  // baseline steps can't overwrite them).
  humanPatch.recipeId = stub.id;
  if (humanPatch.buffer.length) {
    try { appendHumanPatchSteps(db, stub.id, humanPatch.buffer.splice(0), projectFields, project.clientId); } catch { /* best-effort */ }
  }
  // Submit observed in the pre-flush window (human corrected + submitted before the
  // recipe row landed) — apply the promotion now that the row exists.
  if (humanPatch.submitObserved) promoteOnHumanSubmit(stub.id);

  // Debug: dump the three verification signals + the trust-gate decision into the run bundle
  // so the operator can see WHY a recipe was (or wasn't) trusted — text vs vision vs
  // deterministic, and which signal disagreed. Always written when the bundle is enabled
  // (falls back to data/screenshots when it isn't). Sensitive review fields are masked.
  {
    try {
      const maskMatches = (ms: Array<{ label: string; expected: string; found: string; ok: boolean }>) =>
        ms.map((m) => SENSITIVE_REVIEW_LABEL.test(m.label)
          ? { label: m.label, expected: "***sensitive***", found: "***sensitive***", ok: m.ok }
          : m);
      let dest: string;
      if (debugDir) {
        dest = path.join(debugDir, "verdict.json");
      } else {
        const screenshotDir = path.join(process.cwd(), "data", "screenshots");
        fs.mkdirSync(screenshotDir, { recursive: true });
        dest = path.join(screenshotDir, `verdict-${stub.id}-${Date.now()}.json`);
      }
      fs.writeFileSync(dest, JSON.stringify({
        recipeId: stub.id,
        trusted,
        trustGate: {
          verificationAccurate: verification.accurate,
          textContradicts,
          reviewReadable,
          // THE BUNDLE MUST NAME WHAT STOPPED IT. This block used to describe a two-condition
          // gate that had not been the real bar for months, so an operator reading a run's
          // verdict.json to find out why a recipe stayed a draft was told nothing that applied.
          // evaluateTrustGate's blockers are the actual reasons, in the gate's own words.
          blockers: gate.blockers,
          note: "trusted = evaluateTrustGate(...).trusted — see the full bar documented on that function in backend/src/autoLearn.ts. The replay self-test can only remove trust afterwards, never grant it. Deterministic mismatches are warnings only.",
        },
        textSignal: {
          accurate: textVerification.accurate,
          confidence: textVerification.overallConfidence,
          matches: maskMatches(textVerification.matches),
          issues: textVerification.issues,
        },
        visionSignal: visionVerification ? {
          usable: visionUsable,
          accurate: visionVerification.accurate,
          confidence: visionVerification.overallConfidence,
          matches: maskMatches(visionVerification.matches),
          issues: visionVerification.issues,
        } : { usable: false, note: "vision verify disabled or returned nothing" },
        deterministicSignal: {
          unreadableSentinel: isUnreadableSentinel,
          mismatchesGating: deterministicMismatches.map((m) => m.field),
          allMismatches: allDetMismatches
            .filter((m) => !SENSITIVE_DET_FIELDS.has(m.field))
            .map((m) => ({ field: m.field, expected: m.expected, found: m.found })),
        },
        finalIssues: verification.issues,
      }, null, 2));
    } catch { /* non-fatal */ }
  }

  // Write the review screenshot to disk if captured (the dashboard shows it as the captured review).
  // NOTE: a portal-rendered review page can show account/meter numbers as plain text, so this PNG may
  // contain customer PII AT REST under data/screenshots. Operators who don't want PII on disk can set
  // PORTAL_SAVE_REVIEW_SCREENSHOT=0 to skip the write (the in-memory vision check is separately gated
  // by PORTAL_VISION_VERIFY). Default on.
  if (learn.reviewScreenshotBase64 && process.env.PORTAL_SAVE_REVIEW_SCREENSHOT !== "0") {
  // Record WHICH application this run produced. A portal list can hold several drafts for
  // the same customer (a learn, a replay, a demo), so without this an audit afterwards has
  // to guess which row to open — and guessing "the first" or "the newest" opened the wrong
  // one both times it was tried, once reporting a stale application as if it were this run's.
  if (learn.applicationUrl) {
    try {
      db.run("UPDATE portal_recipes SET notes = notes || ? WHERE id = ?", [` [application:${learn.applicationUrl}]`, stub.id]);
    } catch { /* non-fatal */ }
  }

    try {
      const screenshotDir = path.join(process.cwd(), "data", "screenshots");
      fs.mkdirSync(screenshotDir, { recursive: true });
      const screenshotPath = path.join(screenshotDir, `review-${stub.id}-${Date.now()}.png`);
      const pngBuf = Buffer.from(learn.reviewScreenshotBase64, "base64");
      fs.writeFileSync(screenshotPath, pngBuf);
      db.run("UPDATE portal_recipes SET notes = notes || ? WHERE id = ?", [` [screenshot:${screenshotPath}]`, stub.id]);
      // Copy into the run bundle so the handed-over folder is self-contained.
      if (debugDir) fs.writeFileSync(path.join(debugDir, "review.png"), pngBuf);
    } catch { /* non-fatal */ }
  }

  // After a successful auto-learn, upsert the learned portal URL back to KB (best-effort).
  // SCOPE-GATED: a utility (NEM) learn must write the utility-keyed row ONLY — stamping the
  // utility URL onto the AHJ-keyed row poisons the permit track's launch URL (a permit stage
  // would then open the NEM portal, e.g. PowerClerk for a City of Willamina building permit).
  // Keyed on profile_key + state, never a verified row, only a URL that fits the track and the
  // entity — see recordTrustedLearnPortalUrl (one door for both scopes).
  if (trusted) {
    try {
      const kbWrite = recordTrustedLearnPortalUrl(db, {
        scope: scopeType, state: project.state, ahj: project.ahj, utility: project.utility, portalUrl,
      });
      if (kbWrite.skippedVerified.length || kbWrite.refused) {
        addAuditLog(db, projectId, "system", "auto-learn", "portal.learned_url_not_written", {
          scope: scopeType, skippedVerified: kbWrite.skippedVerified, refused: kbWrite.refused,
        });
      }
    } catch { /* KB upsert is best-effort */ }
  }

  addAuditLog(db, projectId, "system", "auto-learn", trusted ? "portal.auto_learned_trusted" : "portal.auto_learned_draft", {
    scope: scopeType, pageCount: learn.pageCount, confidence: verification.overallConfidence, finalSubmitRecorded: learn.finalSubmitRecorded, pageTrace: learn.pageTrace ?? [],
  });

  emitDone(trusted ? trustedWords.done : "Learning complete — recipe saved as a draft pending your verification.");
  return finalize({
    recipe: getPortalRecipe(db, stub.id),
    status: trusted ? "trusted" : "draft",
    pauseReason: null,
    pageCount: learn.pageCount,
    finalSubmitRecorded: learn.finalSubmitRecorded, pageTrace: learn.pageTrace ?? [],
    verification: {
      accurate: verification.accurate,
      confidence: verification.overallConfidence,
      matches: verification.matches,
      issues: verification.issues,
    },
    message: (trusted
      ? trustedWords.message
      : `Portal learned but needs your verification — open the captured fill and confirm it's correct before it's trusted. ${verification.issues.length ? "Flags: " + verification.issues.slice(0, 3).join("; ") : ""}`)
      + (learn.reachedReview && !resolveHeadless(input.headless)
        ? " The browser is open at the review screen — any field you fill or fix by hand there is recorded into the recipe automatically (patch-by-demonstration)."
        : ""),
  });
}

/**
 * Did this run fail because the portal refuses automated browsers, rather than because the
 * portal is broken or the credential is wrong?
 *
 * Several jurisdictions front their permitting portal with a WAF that serves 403 / "Access
 * Denied" to a headless browser and the ordinary site to a headed one — measured on
 * gosolarapp.org and two other AZ/CA hosts during the portal sweep. Deliberately narrow: an
 * ordinary auth 403, a dead host, or a timeout must NOT trigger a retry, because a second
 * attempt would cost minutes and change nothing.
 */
export { looksBotBlocked } from "./runAbort";
