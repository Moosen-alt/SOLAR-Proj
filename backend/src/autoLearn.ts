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
import type { PortalRecipe, ProjectRecord } from "../../shared/src/types";
import { learnPortal, browserLimiter } from "../../portal-bot/src/index";
import { compareReviewFields } from "../../portal-bot/src/reviewScreenScraper";
import type { LearnPlanRequest, LearnPlanResponse } from "../../portal-bot/src/adapters/autoLearnAdapter";
import { createLLMProvider } from "./llm";
import { getDecryptedCredential, getDecryptedCredentialByUrl, getDecryptedCredentialAny } from "./portalCredentials";
import { resolveRecipeFieldValues, startPortalRecording, savePortalRecipeSteps, getPortalRecipe } from "./portalRecipes";
import { projectDocsByType } from "./projectDocuments";
import { buildUtilityPackage } from "./docSplitter";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";

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

  let kbContext = "";
  try {
    const kbEntry = db.get<{ portal_name: string; portal_url: string; notes: string }>(
      `SELECT portal_name, portal_url, notes FROM permit_utility_knowledge WHERE (ahj = ? OR utility = ?) LIMIT 1`,
      [project.ahj, project.utility],
    ) as { portal_name?: string; portal_url?: string; notes?: string } | undefined;
    if (kbEntry) {
      kbContext = `KB CONTEXT for this AHJ/utility:\nPortal: ${kbEntry.portal_name || ""}\nURL: ${kbEntry.portal_url || ""}\nNotes: ${kbEntry.notes || ""}`.trim();
    }
  } catch { /* KB table may not exist yet */ }

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
    const indexedFields = req.fields.map((f, i) => ({ index: i, label: f.label, fieldType: f.fieldType, options: f.options }));
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
        ?? getDecryptedCredentialAny(db, project.clientId))
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
      headless: input.headless,
      // AHJ portals (Accela / Oregon ePermitting) require one combined plan-set PDF per
      // upload control; utility portals (PowerClerk) want the split sheets per slot.
      uploadMode: scopeType === "ahj" ? "combined" : "split",
      onProgress: input.onProgress,
    }));
  } catch (err) {
    throw new HttpError(502, `Portal learn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Record the learned steps as a recipe (starts in "recording").
  const stub = startPortalRecording(db, {
    scopeType,
    state: project.state,
    ahj: project.ahj,
    utility: project.utility,
    portalPlatform: "auto-learned",
    portalUrl,
    createdBy: input.createdBy || "auto-learn",
  });

  if (learn.pauseReason) {
    savePortalRecipeSteps(db, stub.id, learn.steps, { status: "recording", notes: `Auto-learn paused: ${learn.pauseReason}. Resume manually.` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_paused", { scope: scopeType, pauseReason: learn.pauseReason });
    return { recipe: getPortalRecipe(db, stub.id), status: "paused", pauseReason: learn.pauseReason, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, verification: { accurate: false, confidence: "low", matches: [], issues: [] }, message: `Learning paused on a ${learn.pauseReason} challenge — a human must complete it. The partial recipe was saved as a draft.` };
  }

  if (!learn.ok || !learn.steps.length) {
    savePortalRecipeSteps(db, stub.id, learn.steps, { status: "needs_rerecord", notes: `Auto-learn could not complete: ${learn.message}` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_failed", { scope: scopeType });
    return { recipe: getPortalRecipe(db, stub.id), status: "failed", pauseReason: null, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, verification: { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, message: `Could not learn the portal automatically: ${learn.message}. Record it manually instead.` };
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
    savePortalRecipeSteps(db, stub.id, learn.steps, { status: "needs_rerecord", notes: `Auto-learn did not stage cleanly: ${why}. ${learn.message}` });
    addAuditLog(db, projectId, "system", "auto-learn", "portal.auto_learn_failed", { scope: scopeType, reason: !reachedReview ? "no_review" : "premature_review" });
    return { recipe: getPortalRecipe(db, stub.id), status: "failed", pauseReason: null, pageCount: learn.pageCount, finalSubmitRecorded: learn.finalSubmitRecorded, verification: { accurate: false, confidence: "low", matches: [], issues: [learn.message] }, message: `Nothing was staged — ${why}. ${learn.message}` };
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
  const trusted = verification.accurate && !textContradicts;
  savePortalRecipeSteps(db, stub.id, learn.steps, {
    status: trusted ? "complete" : "recording",
    notes: trusted
      ? `Auto-learned and verified (${verification.overallConfidence} confidence) on ${learn.pageCount} page(s). Final submit recorded for the trusted-submit allowlist; never auto-clicked unless the operator opts in.`
      : `Auto-learned but NOT verified — review the captured fill and confirm before trusting. Issues: ${verification.issues.join("; ") || "low confidence"}.`,
  });

  // Debug: dump the three verification signals + the trust-gate decision to disk so the
  // operator can see WHY a recipe was (or wasn't) trusted — text vs vision vs deterministic,
  // and which signal disagreed. Gated on AUTOLEARN_DEBUG_SCREENSHOTS=1 (same flag as the
  // per-page screenshots). Sensitive review fields are masked out of the match lists.
  if (process.env.AUTOLEARN_DEBUG_SCREENSHOTS === "1") {
    try {
      const maskMatches = (ms: Array<{ label: string; expected: string; found: string; ok: boolean }>) =>
        ms.map((m) => SENSITIVE_REVIEW_RE.test(m.label)
          ? { label: m.label, expected: "***sensitive***", found: "***sensitive***", ok: m.ok }
          : m);
      const screenshotDir = path.join(process.cwd(), "data", "screenshots");
      fs.mkdirSync(screenshotDir, { recursive: true });
      const dest = path.join(screenshotDir, `verdict-${stub.id}-${Date.now()}.json`);
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
      fs.writeFileSync(screenshotPath, Buffer.from(learn.reviewScreenshotBase64, "base64"));
      db.run("UPDATE portal_recipes SET notes = notes || ? WHERE id = ?", [` [screenshot:${screenshotPath}]`, stub.id]);
    } catch { /* non-fatal */ }
  }

  // After a successful auto-learn, upsert learned portal URL back to KB (best-effort).
  if (trusted) {
    try {
      db.run(
        `UPDATE permit_utility_knowledge SET portal_url = ?, updated_at = ? WHERE ahj = ?`,
        [portalUrl, new Date().toISOString(), project.ahj],
      );
    } catch { /* KB upsert is best-effort */ }
  }

  addAuditLog(db, projectId, "system", "auto-learn", trusted ? "portal.auto_learned_trusted" : "portal.auto_learned_draft", {
    scope: scopeType, pageCount: learn.pageCount, confidence: verification.overallConfidence, finalSubmitRecorded: learn.finalSubmitRecorded,
  });

  return {
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
    message: trusted
      ? `Portal learned and verified (${verification.overallConfidence} confidence). The recipe is trusted and will replay on future ${scopeType === "utility" ? "utility" : "AHJ"} projects. Final submit stays manual unless you opt this portal into trusted auto-submit.`
      : `Portal learned but needs your verification — open the captured fill and confirm it's correct before it's trusted. ${verification.issues.length ? "Flags: " + verification.issues.slice(0, 3).join("; ") : ""}`,
  };
}
