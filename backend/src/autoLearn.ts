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
import pLimit from "p-limit";
import type { AppDb } from "./db";
import type { PortalRecipe, ProjectRecord } from "../../shared/src/types";
import { learnPortal } from "../../portal-bot/src/index";
import type { LearnPlanRequest, LearnPlanResponse } from "../../portal-bot/src/adapters/autoLearnAdapter";
import { createLLMProvider } from "./llm";
import { getDecryptedCredential, getDecryptedCredentialByUrl, getDecryptedCredentialAny } from "./portalCredentials";
import { resolveRecipeFieldValues, startPortalRecording, savePortalRecipeSteps, getPortalRecipe } from "./portalRecipes";
import { projectDocsByType } from "./projectDocuments";
import { buildUtilityPackage } from "./docSplitter";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";

// At most 2 Playwright browser instances open simultaneously. Each consumes ~200 MB;
// more than 2-3 on a typical dev/server machine causes OOM and Chrome sandbox failures.
const portalLimiter = pLimit(Number(process.env.MAX_CONCURRENT_PORTAL_RUNS ?? 2));

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
    // Optional live-progress sink (drives the UI progress bar). Non-PII signals only.
    onProgress?: import("../../portal-bot/src/adapters/autoLearnAdapter").LearnProgressFn;
  },
): Promise<AutoLearnResult> {
  const projectRow = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) throw new HttpError(404, "Project not found.");
  // getProjectDetail is the canonical mapper; import lazily to avoid a cycle.
  const { getProjectDetail } = await import("./repository");
  const project: ProjectRecord = getProjectDetail(db, projectId).project;

  const scopeType = input.scope === "utility" ? "utility" : "ahj";
  const portalUrl = (input.portalUrl || "").trim();
  if (!portalUrl) throw new HttpError(400, "portalUrl is required to learn a portal.");
  if (scopeType === "ahj" && !(project.ahj || "").trim()) throw new HttpError(400, "Project has no AHJ to key the recipe on.");
  if (scopeType === "utility" && !(project.utility || "").trim()) throw new HttpError(400, "Project has no utility to key the recipe on.");

  const portalType = scopeType === "utility" ? "utility" : "AHJ";
  const fieldValues = resolveRecipeFieldValues(db, project, portalType);
  // Secrets must never reach the LLM planner — strip account/meter (the adapter binds
  // them from the encrypted credential store, not from planner output).
  const projectFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldValues)) {
    if (/password|accountNumber|meterNumber|ssn/i.test(k)) continue;
    if (v) projectFields[k] = v;
  }

  // Fetch KB context for this AHJ/utility to guide the planner
  let kbContext = "";
  try {
    const kbEntry = db.get<{ portal_name: string; portal_url: string; notes: string }>(
      `SELECT portal_name, portal_url, notes FROM permit_utility_knowledge WHERE (ahj = ? OR utility = ?) LIMIT 1`,
      [project.ahj, project.utility],
    ) as any;
    if (kbEntry) {
      kbContext = `KB CONTEXT for this AHJ/utility:\nPortal: ${kbEntry.portal_name || ""}\nURL: ${kbEntry.portal_url || ""}\nNotes: ${kbEntry.notes || ""}`.trim();
    }
  } catch { /* KB table may not exist yet */ }

  // Jurisdiction + permit-discipline context for portals (Accela / Oregon ePermitting)
  // where the same street address resolves to both a CITY and a COUNTY authority, each with
  // its own application-type list. Tells the planner which results row to Select and which
  // application type (structural vs electrical) to check. Defaults to structural — the prior
  // hardcoded behavior — so single-discipline runs are unchanged.
  let jurisdictionContext = "";
  if (scopeType === "ahj") {
    const discipline = input.permitType === "electrical" ? "electrical" : "structural";
    jurisdictionContext = [
      `permitDiscipline: ${discipline}`,
      project.ahj ? `targetJurisdiction (AHJ): ${project.ahj}` : "",
      project.city ? `projectCity: ${project.city}` : "",
      project.state ? `state: ${project.state}` : "",
    ].filter(Boolean).join("\n");
  }

  const llm = createLLMProvider();
  // The planner the adapter calls when it has the live fields on a page. The adapter
  // passes fields positionally (ExtractedField[]); we index them for the LLM and map the
  // response indices back to selector positions.
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
    learn = await portalLimiter(() => learnPortal({
      portalName: scopeType === "utility" ? project.utility : project.ahj,
      portalUrl,
      project,
      planner,
      credential,
      userDataDir,
      docsByType,
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

  // VERIFY the fill against the project data before trusting the recipe.
  input.onProgress?.({
    phase: "verify",
    pageCount: learn.pageCount,
    maxPages: learn.pageCount,
    message: "Verifying the filled values against the project record…",
  });
  const verification = await llm.verifyPortalFill({
    reviewFields: learn.reviewScreen.fields,
    projectFields,
    bodyText: learn.reviewScreen.bodyTextSnippet,
  });

  // Promote to "complete" (trusted for deterministic replay) ONLY when the fill verified
  // accurate. Otherwise keep it a draft pending human verification.
  const trusted = verification.accurate;
  savePortalRecipeSteps(db, stub.id, learn.steps, {
    status: trusted ? "complete" : "recording",
    notes: trusted
      ? `Auto-learned and verified (${verification.overallConfidence} confidence) on ${learn.pageCount} page(s). Final submit recorded for the trusted-submit allowlist; never auto-clicked unless the operator opts in.`
      : `Auto-learned but NOT verified — review the captured fill and confirm before trusting. Issues: ${verification.issues.join("; ") || "low confidence"}.`,
  });

  // Write review screenshot to disk if captured.
  if (learn.reviewScreenshotBase64) {
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
