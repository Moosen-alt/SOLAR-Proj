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
// MFA. The final-submit button is recorded (isFinalSubmit) for the allowlist but only
// ever executed later under the explicit per-portal trusted-auto-submit opt-in. A
// low-confidence or unverified pass is left as a draft for human review, never trusted.
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import type { AppDb } from "./db";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { learnPortal, browserLimiter } from "../../portal-bot/src/index";
import { resolveHeadless } from "../../portal-bot/src/browser";
import { compareReviewFields } from "../../portal-bot/src/reviewScreenScraper";
import type { LearnPlanRequest, LearnPlanResponse } from "../../portal-bot/src/adapters/autoLearnAdapter";
import { createLLMProvider, getRecentLlmCalls } from "./llm";
import { getDecryptedCredential, getDecryptedCredentialByUrl, getDecryptedCredentialAny } from "./portalCredentials";
import { learnNoteTopicsFromMisses, activeLearnedNoteTerms } from "./noteTopics";
import { resolveRecipeFieldValues, startPortalRecording, savePortalRecipeSteps, getPortalRecipe, convertLiteralsToBoundFields, findAnyRecipeForProject, appendHumanPatchSteps, promoteRecordingIfEligible } from "./portalRecipes";
import { HUMAN_SUBMIT_OBSERVED_NOTE } from "../../portal-bot/src/humanCapture";
import { projectDocsByType } from "./projectDocuments";
import { buildUtilityPackage } from "./docSplitter";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { knowledgeProfileKey, findKnowledgeForLearn } from "./knowledgeBase";
import { getCodeProfile } from "./codeProfiles";

export interface AutoLearnResult {
  recipe: PortalRecipe;
  /** "trusted" = verified accurate and promoted to complete; "draft" = recorded but
   *  needs human verification; "paused" = a challenge (MFA/CAPTCHA) stopped the learn;
   *  "failed" = couldn't learn the portal. */
  status: "trusted" | "draft" | "paused" | "failed";
  pauseReason: string | null;
  pageCount: number;
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
const DESIGN_NOTE_TOPICS = /\bdisconnect\b|within 10|meter.{0,20}pole|pole.{0,20}(mount|meter)|\bbattery\b|\bess\b|powerwall|encharge|backup|export (limit|capacit)|limit(ed|ing)? export|ul\s*1741|smart inverter|attic (run|fan)|shutdown -|rapid shutdown|main panel|service upgrade|\bmpu\b|derat|tilt|azimuth|tracking|ground.?mount/i;

// Extract only decision-relevant lines from the parser snapshot's long text fields.
// Deterministic and cheap (no LLM); capped so it can never re-inflate the prompt.
// extraTerms are SELF-TAUGHT topics (see noteTopics.ts): words from required portal
// questions that past runs couldn't answer — lines mentioning them are included too.
export function designNotesDigest(project: ProjectRecord, maxChars = 1200, extraTerms: string[] = []): string {
  const learned = extraTerms.length
    ? new RegExp(extraTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : null;
  return digestLines(project, maxChars, (line) => DESIGN_NOTE_TOPICS.test(line) || (learned ? learned.test(line) : false));
}

function digestLines(project: ProjectRecord, maxChars: number, matches: (line: string) => boolean): string {
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
    for (const rawLine of text.split(/[\n.;]+/)) {
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
      const lines = [
        `${label}: ${name}${profile.state ? ` (${profile.state})` : ""} [KB confidence: ${profile.confidence}]`,
        profile.portalName || profile.portalUrl ? `Portal: ${clip(profile.portalName, 80)} ${clip(profile.portalUrl, 120)}`.trim() : "",
        profile.requiredDocuments.length ? `Required docs: ${clip(profile.requiredDocuments.join("; "), 300)}` : "",
        // The primary scope's notes carry the judgment answers — give them the bigger cap.
        profile.notes ? `Notes: ${clip(profile.notes, label === (opts.scopeType === "ahj" ? "AHJ" : "Utility") ? 900 : 400)}` : "",
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
export function buildPortalPlanner(
  db: AppDb,
  project: ProjectRecord,
  opts: { portalType: string; scopeType?: "ahj" | "utility"; permitType?: "structural" | "electrical" },
): { planner: (req: LearnPlanRequest) => Promise<LearnPlanResponse>; projectFields: Record<string, string> } {
  const fieldValues = resolveRecipeFieldValues(db, project, opts.portalType);
  const projectFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldValues)) {
    if (/password|accountNumber|meterNumber|ssn/i.test(k)) continue;
    if (v) projectFields[k] = v;
  }
  // Provide today's date so the planner can compute time-relative values
  // (e.g. estimated commissioning date = today + 28 days).
  projectFields["todayDate"] = new Date().toISOString().slice(0, 10);
  // COMPACT DESIGN DIGEST. The long parser/plan-set text blobs are excluded from
  // fieldValues (they cost ~40k tokens per LLM call), but a handful of the portal's
  // JUDGMENT questions (disconnect-within-10ft, meter on pole, battery/backup mode,
  // export limiting, attic run) are answered from design NOTES, not structured fields.
  // Extract only the decision-relevant lines into a small digest so the planner keeps
  // that signal at ~200 tokens instead of the full text. Self-taught topics (terms from
  // required questions past runs couldn't answer) extend the built-in topic list.
  const digest = designNotesDigest(project, 1200, activeLearnedNoteTerms(db));
  if (digest) projectFields["designNotes"] = digest;

  // KB CONTEXT. Fuzzy, state-aware lookup so imported reference knowledge
  // ("Portland General Electric" / "Arizona Public Service Company") still hits
  // when the project says "PGE" / "APS" — critical when learning an UNKNOWN
  // portal, where the imported submit instructions / disconnect / meter rules
  // are the only prior signal. Utility and AHJ rows are pulled separately and
  // capped so this stays a few hundred tokens.
  const kbContext = buildLearnKbContext(db, project, opts);

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

  const llm = createLLMProvider();
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
      fills: plan.fills.map((f) => ({ selectorIndex: f.index, value: f.value, field: f.field })),
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
export async function autoLearnPortal(
  db: AppDb,
  projectId: string,
  input: {
    scope: "ahj" | "utility";
    portalUrl: string;
    createdBy?: string;
    permitType?: "structural" | "electrical";
    // Optional pre-resolved project record. The staging self-seed path passes its
    // client-contractor *overlaid* stagedProject (authoritative CCB#/installer identity) so the
    // learner fills the same data the hand-coded adapters would. When omitted (the manual
    // /auto-learn endpoint), the raw project is loaded from the DB.
    project?: ProjectRecord;
    // Headed/headless for the learn browser. The staging self-seed passes the operator-intended
    // setting (headed locally) so it matches the hand-coded/replay adapters and leaves the browser
    // open at review; when omitted, resolveHeadless falls back to PORTAL_HEADLESS / server default.
    headless?: boolean;
    // Optional live-progress sink (drives the UI progress bar). Non-PII signals only.
    onProgress?: import("../../portal-bot/src/adapters/autoLearnAdapter").LearnProgressFn;
  },
): Promise<AutoLearnResult> {
  const projectRow = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) throw new HttpError(404, "Project not found.");
  // getProjectDetail is the canonical mapper; import lazily to avoid a cycle. A caller may pass
  // a pre-overlaid project (staging self-seed); otherwise load the canonical record.
  const { getProjectDetail } = await import("./repository");
  const project: ProjectRecord = input.project ?? getProjectDetail(db, projectId).project;

  const scopeType = input.scope === "utility" ? "utility" : "ahj";
  const portalUrl = (input.portalUrl || "").trim();
  if (!portalUrl) throw new HttpError(400, "portalUrl is required to learn a portal.");
  if (scopeType === "ahj" && !(project.ahj || "").trim()) throw new HttpError(400, "Project has no AHJ to key the recipe on.");
  if (scopeType === "utility" && !(project.utility || "").trim()) throw new HttpError(400, "Project has no utility to key the recipe on.");

  const portalType = scopeType === "utility" ? "utility" : "AHJ";
  // Secrets are stripped inside buildPortalPlanner — they never reach the LLM; the adapter
  // binds account/meter deterministically from the encrypted credential store.
  const { planner, projectFields } = buildPortalPlanner(db, project, {
    portalType,
    scopeType,
    permitType: input.permitType,
  });

  // Credential lookup: try exact portalType match first, then URL hostname match, then
  // most-recent credential for this client (handles mismatched portal_type strings).
  const credential = project.clientId
    ? (getDecryptedCredential(db, project.clientId, portalType)
        ?? getDecryptedCredentialByUrl(db, project.clientId, portalUrl)
        ?? getDecryptedCredentialAny(db, project.clientId, portalUrl))
      ?? undefined
    : undefined;
  const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
  const userDataDir = project.clientId ? path.join(profileBase, project.clientId, portalType) : path.join(profileBase, portalType);

  // Assemble the upload-ready document set so the learner can attach the right split
  // document at each portal upload control. Split the plan set into typed sheets first
  // (best-effort) if it hasn't been split yet, then collect docType → file path. The
  // adapter only uploads what's actually available; a missing doc is left for the human.
  let docsByType: Record<string, string> = {};
  try {
    const existing = projectDocsByType(db, projectId);
    const hasSheets = ["sld", "site_plan", "inverter_spec"].every((t) => existing[t]);
    if (!hasSheets) {
      await buildUtilityPackage(db, projectId, scopeType === "utility" ? "nem" : "permit").catch(() => null);
    }
    docsByType = projectDocsByType(db, projectId);
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
      if (humanPatch.recipeId) appendHumanPatchSteps(db, humanPatch.recipeId, [step], projectFields);
      else humanPatch.buffer.push(step);
    } catch { /* capture merge is best-effort — never disturb the operator's session */ }
  };

  let learn;
  try {
    learn = await browserLimiter(() => learnPortal({
      portalName: scopeType === "utility" ? project.utility : project.ahj,
      portalUrl,
      project,
      planner,
      credential,
      userDataDir,
      docsByType,
      // Equipment identity for the deterministic PV-spec combobox pass (matched with
      // certified-name aliases + distinctive-token fallback inside the adapter).
      equipment: {
        inverterMake: projectFields.inverterMake || projectFields.inverterManufacturer || "",
        inverterModel: projectFields.inverterModel || projectFields.invModel || projectFields.pvMicroModel || "",
        moduleMake: projectFields.moduleMake || projectFields.moduleManufacturer || "",
        moduleModel: projectFields.moduleModel || "",
      },
      headless: input.headless,
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
      onProgress: input.onProgress,
      onHumanStep,
    }));
  } catch (err) {
    throw new HttpError(502, `Portal learn failed: ${err instanceof Error ? err.message : String(err)}`);
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
  const existingRecipe = findAnyRecipeForProject(db, {
    scopeType,
    state: project.state,
    ahj: project.ahj,
    utility: project.utility,
  });
  const protectComplete = existingRecipe?.status === "complete";
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
      finalSubmitRecorded: learn.finalSubmitRecorded,
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
  });

  if (learn.pauseReason) {
    if (protectComplete) {
      return preserved("paused", learn.pauseReason, { accurate: false, confidence: "low", matches: [], issues: [] }, `Learning paused on a ${learn.pauseReason} challenge — a human must complete it.`);
    }
    const stub = mkStub();
    savePortalRecipeSteps(db, stub.id, learn.steps, { status: "recording", notes: `Auto-learn paused: ${learn.pauseReason}. Resume manually.` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_paused", { scope: scopeType, pauseReason: learn.pauseReason });
    emitDone(`Learning paused on a ${learn.pauseReason} challenge.`);
    return finalize({ recipe: getPortalRecipe(db, stub.id), status: "paused", pauseReason: learn.pauseReason, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, verification: { accurate: false, confidence: "low", matches: [], issues: [] }, message: `Learning paused on a ${learn.pauseReason} challenge — a human must complete it. The partial recipe was saved as a draft.` });
  }

  if (!learn.ok || !learn.steps.length) {
    if (protectComplete) {
      return preserved("failed", null, { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, `Could not learn the portal automatically: ${learn.message}.`);
    }
    const stub = mkStub();
    savePortalRecipeSteps(db, stub.id, learn.steps, { status: "needs_rerecord", notes: `Auto-learn could not complete: ${learn.message}` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_failed", { scope: scopeType });
    emitDone("Learning failed — the portal could not be learned automatically.");
    return finalize({ recipe: getPortalRecipe(db, stub.id), status: "failed", pauseReason: null, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, verification: { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, message: `Could not learn the portal automatically: ${learn.message}. Record it manually instead.` });
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
    const stub = mkStub();
    emitDone(`Learning failed — ${why}.`);
    savePortalRecipeSteps(db, stub.id, learn.steps, { status: "needs_rerecord", notes: `Auto-learn did not stage cleanly: ${why}. ${learn.message}` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_failed", { scope: scopeType, reason: !reachedReview ? "no_review" : "premature_review" });
    return finalize({ recipe: getPortalRecipe(db, stub.id), status: "failed", pauseReason: null, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, verification: { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, message: `Nothing was staged — ${why}. ${learn.message}` });
  }

  // VERIFY the fill against the project data before trusting the recipe.
  input.onProgress?.({
    phase: "verify",
    pageCount: learn.pageCount,
    maxPages: learn.pageCount,
    message: "Verifying the filled values against the project record…",
  });
  const llm = createLLMProvider();
  const reviewBody = learn.reviewScreen.bodyTextSnippet || "";

  // Sensitive fields (account#, meter#, password) are stripped from projectFields so they
  // never reach the LLM planner. Strip them from the review-screen fields before the text
  // verifier too — they're bound at replay from the encrypted credential store, not from the
  // recipe, so a masked portal value must NOT gate recipe promotion.
  const SENSITIVE_REVIEW_RE = /\b(password|passcode|account\s*(number|no|#)?|acct|meter\s*(number|no|#)?|ssn|social security|tax\s*id|ein|routing|card\s*number|cvv|security code)\b/i;
  const nonSensitiveReviewFields = learn.reviewScreen.fields.filter((f) => !SENSITIVE_REVIEW_RE.test(f.label));

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
        reviewFields: learn.reviewScreen.fields,
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
  const reviewReadable = learn.reviewScreen.fields.length > 0 || reviewBody.trim().length > 0 || visionUsable;

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
  const { steps: boundSteps, bound: boundLiterals, ambiguous: ambiguousLiterals } =
    convertLiteralsToBoundFields(learn.steps, projectFields);
  if (ambiguousLiterals.length) {
    verification.issues.push(
      `Recorded literal value(s) match this project's data but could not be uniquely bound to a field (${ambiguousLiterals.slice(0, 6).map((a) => `"${a.value}"→${a.candidates.join("/")}`).join(", ")}). These would replay verbatim onto other projects — review before trusting.`,
    );
  }
  const bindingNote = boundLiterals.length ? ` Bound ${boundLiterals.length} literal value(s) to project fields for safe replay.` : "";

  let trusted = verification.accurate && !textContradicts && !hasHardBlockers && ambiguousLiterals.length === 0;
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
  if (trusted && selfTestEnabled) {
    input.onProgress?.({ phase: "verify", pageCount: learn.pageCount, maxPages: learn.pageCount, message: "Replay self-test: re-running the learned recipe in a fresh session…" });
    try {
      const { stageWithRecipe } = await import("../../portal-bot/src/index");
      // When the existing complete recipe is protected there's no stub row yet — synthesize the
      // replay recipe in memory (same steps/url) without touching the DB.
      const baseRecipe: PortalRecipe = stub ? getPortalRecipe(db, stub.id) : { ...existingRecipe!, portalUrl: portalUrl || existingRecipe!.portalUrl };
      const recipeForReplay: PortalRecipe = { ...baseRecipe, steps: boundSteps };
      const replayFieldValues = resolveRecipeFieldValues(db, project, portalType);
      const replay = await stageWithRecipe(recipeForReplay, project, replayFieldValues, docsByType, [], { headless: input.headless }) as Record<string, unknown>;
      const reproduced = replay.ok === true && !replay.pauseReason;
      if (!reproduced) {
        trusted = false;
        verification.issues.push(`Replay self-test did NOT reproduce the review in a fresh session (${String(replay.message || replay.pauseReason || "recipe did not reach review on replay")}). Kept as a draft for human verification.`);
        addAuditLog(db, projectId, "system", "auto-learn", "portal.replay_selftest_failed", { scope: scopeType });
      } else {
        addAuditLog(db, projectId, "system", "auto-learn", "portal.replay_selftest_passed", { scope: scopeType });
      }
    } catch (err) {
      trusted = false;
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
  savePortalRecipeSteps(db, stub.id, boundSteps, {
    status: trusted ? "complete" : "recording",
    notes: trusted
      ? `Auto-learned and verified (${verification.overallConfidence} confidence) on ${learn.pageCount} page(s).${bindingNote} Final submit recorded for the trusted-submit allowlist; never auto-clicked unless the operator opts in.`
      : `Auto-learned but NOT verified — review the captured fill and confirm before trusting.${bindingNote} Issues: ${verification.issues.join("; ") || "low confidence"}.`,
  });
  // The recipe row + steps now exist — route captured human fixes into it, and flush any
  // fixes made in the window before the row was saved (flushed AFTER the save above so the
  // baseline steps can't overwrite them).
  humanPatch.recipeId = stub.id;
  if (humanPatch.buffer.length) {
    try { appendHumanPatchSteps(db, stub.id, humanPatch.buffer.splice(0), projectFields); } catch { /* best-effort */ }
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
        ms.map((m) => SENSITIVE_REVIEW_RE.test(m.label)
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
          note: "trusted = verificationAccurate && !textContradicts. Deterministic mismatches are warnings only.",
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
  if (trusted) {
    try {
      if (scopeType === "ahj" && (project.ahj || "").trim()) {
        db.run(
          `UPDATE permit_utility_knowledge SET portal_url = ?, updated_at = ? WHERE ahj = ?`,
          [portalUrl, new Date().toISOString(), project.ahj],
        );
      } else if (scopeType === "utility" && (project.utility || "").trim()) {
        // Single canonical upsert keyed on profile_key (UNIQUE): creates the minimal
        // utility-keyed row when the KB only carries AHJ-keyed rows for this territory,
        // updates it otherwise. One key discipline — a separate UPDATE-by-utility-string
        // then INSERT-by-profile-key pair could disagree on which row is "the" row and
        // silently drop the learned URL.
        const nowTs = new Date().toISOString();
        db.run(
          `INSERT INTO permit_utility_knowledge
             (id, profile_key, state, ahj, utility, portal_url, notes, first_seen_at, last_learned_at, updated_at)
           VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_key) DO UPDATE SET portal_url = excluded.portal_url, updated_at = excluded.updated_at`,
          [id(), knowledgeProfileKey({ state: project.state, ahj: "", utility: project.utility }),
            project.state || "", project.utility, portalUrl,
            "Auto-learned utility NEM portal entry URL (trusted learn).", nowTs, nowTs, nowTs],
        );
      }
    } catch { /* KB upsert is best-effort */ }
  }

  addAuditLog(db, projectId, "system", "auto-learn", trusted ? "portal.auto_learned_trusted" : "portal.auto_learned_draft", {
    scope: scopeType, pageCount: learn.pageCount, confidence: verification.overallConfidence, finalSubmitRecorded: learn.finalSubmitRecorded,
  });

  emitDone(trusted ? "Learning complete — recipe verified and trusted." : "Learning complete — recipe saved as a draft pending your verification.");
  return finalize({
    recipe: getPortalRecipe(db, stub.id),
    status: trusted ? "trusted" : "draft",
    pauseReason: null,
    pageCount: learn.pageCount,
    finalSubmitRecorded: learn.finalSubmitRecorded,
    verification: {
      accurate: verification.accurate,
      confidence: verification.overallConfidence,
      matches: verification.matches,
      issues: verification.issues,
    },
    message: (trusted
      ? `Portal learned and verified (${verification.overallConfidence} confidence). The recipe is trusted and will replay on future ${scopeType === "utility" ? "utility" : "AHJ"} projects. Final submit stays manual unless you opt this portal into trusted auto-submit.`
      : `Portal learned but needs your verification — open the captured fill and confirm it's correct before it's trusted. ${verification.issues.length ? "Flags: " + verification.issues.slice(0, 3).join("; ") : ""}`)
      + (learn.reachedReview && !resolveHeadless(input.headless)
        ? " The browser is open at the review screen — any field you fill or fix by hand there is recorded into the recipe automatically (patch-by-demonstration)."
        : ""),
  });
}
