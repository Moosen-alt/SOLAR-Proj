// Portal channel resolution — the single, explicit decision of HOW a project's
// submission is staged.
//
// This is the capability registry: one place that ranks the available channels for
// a given (client, portal) and returns the winner, instead of the routing being an
// inline `if` ladder buried in prepareSubmission(). The universal-scrape channels
// (recipe → autolearn → handcoded) are the spine and carry every submission today.
// The `api` tier is RESERVED but never selected yet — there is no API adapter and no
// API credentials. It exists so that, when an installer eventually has working API
// access, enabling it is a localized change here (flip `apiAvailable`) rather than a
// rewrite of the dispatch.
//
// The pure precedence helpers (selectAdapterActor / selectStagingActor /
// seedOutcomeToStageResult) live here too — they used to live in repository.ts and
// are re-exported from there for backwards compatibility. Keeping them beside the
// resolver avoids a circular import (repository imports this module, not vice versa).

export type PortalChannel =
  | "api" // reserved — never selected in this build
  | "recipe" // replay a recorded complete recipe (primary)
  | "autolearn" // self-seed a recipe by learning the portal live
  | "handcoded" // platform-specific adapter (Accela / PowerClerk), legacy fallback
  | "mock" // dev / no real portal to drive
  | "manual"; // kill-switch tripped → operator handoff, no automation

export interface PortalChannelDecision {
  channel: PortalChannel;
  // The adapter label the prepareSubmission dispatch switches on. Kept identical to
  // what selectStagingActor() returned historically so threading this resolver in is
  // behaviour-preserving.
  adapterLabel: string;
  reason: string;
  blocked: boolean;
}

// The PLATFORM identity used for field validation (which required fields a portal
// expects). Distinct from the runtime staging actor below: this names the platform
// even when a recipe will actually do the driving.
export function selectAdapterActor(hasRecipe: boolean, isAccela: boolean, isPowerClerk: boolean): string {
  if (hasRecipe) return "RecipeAdapter";
  if (isAccela) return "OregonEPermittingAdapter";
  if (isPowerClerk) return "PowerClerkAdapter";
  return "MockPortalAdapter";
}

// Which actor actually RUNS a stage under the UNIVERSAL-FIRST + SELF-SEED policy. Distinct from
// selectAdapterActor() (which names the PLATFORM for field validation): once a portal has no
// recorded complete recipe, the universal learner SEEDS one on this very stage (AutoLearnAdapter)
// — it records a recipe AND stages this project to review in one pass, auto-promoting to
// "complete" only on a clean triple-verification so the NEXT stage replays it deterministically.
// On a learn failure we STOP AND SURFACE to the operator (no silent drop to the hand-coded path).
// The hand-coded Accela/PowerClerk adapters are reachable ONLY as the legacy fallback when
// auto-seed is disabled (PORTAL_AUTOSEED=0). Pure + exported so the precedence is unit-tested
// without a browser/DB.
export function selectStagingActor(opts: {
  hasRecipe: boolean;
  isRealPortal: boolean;
  isAccela: boolean;
  isPowerClerk: boolean;
  autoSeedEnabled: boolean;
  /** EXPLICIT simulation switch (MOCK_PORTAL=1) — set by the smoke test and the
   *  simulated rehearsal, never in a production .env. */
  simulationEnabled?: boolean;
}): string {
  if (opts.hasRecipe) return "RecipeAdapter";
  if (opts.isRealPortal && opts.autoSeedEnabled) return "AutoLearnAdapter";
  if (opts.isRealPortal && opts.isAccela) return "OregonEPermittingAdapter";
  if (opts.isRealPortal && opts.isPowerClerk) return "PowerClerkAdapter";
  // The mock is reachable ONLY by explicit opt-in. PORTAL_AUTOSEED=0 alone used to
  // fall through here for any real portal without a hand-coded adapter — the mock
  // reported a successful "staged to review" that never touched the portal, the
  // real filing moved to awaiting_human_submit, and the approve path fabricated
  // MOCK-/CONF- permit numbers staff would trust. Disabling auto-learn must mean
  // "surface a blocker", never "silently simulate".
  if (opts.simulationEnabled) return "MockPortalAdapter";
  if (opts.isRealPortal) return "NoAdapter";
  return "MockPortalAdapter";
}

const ADAPTER_TO_CHANNEL: Record<string, PortalChannel> = {
  RecipeAdapter: "recipe",
  AutoLearnAdapter: "autolearn",
  OregonEPermittingAdapter: "handcoded",
  PowerClerkAdapter: "handcoded",
  MockPortalAdapter: "mock",
  NoAdapter: "manual",
};

export interface PortalChannelInputs {
  hasRecipe: boolean;
  isRealPortal: boolean;
  isAccela: boolean;
  isPowerClerk: boolean;
  autoSeedEnabled: boolean;
  /** EXPLICIT simulation opt-in (MOCK_PORTAL=1) — smoke/rehearsal only. */
  simulationEnabled?: boolean;
  // RESERVED: an installer with working API access for this portal. Always false in
  // this build (no API adapter); wired up the day API access lands.
  apiAvailable?: boolean;
  // Per-portal legal kill-switch (cease-and-desist, IP/bot block). When paused, we do
  // NOT drive any automation — the decision is `manual` and the operator submits by hand.
  portalPaused?: boolean;
}

// Resolve the staging channel for a project. Behaviour-preserving wrapper around
// selectStagingActor: with apiAvailable=false and portalPaused=false (today's only
// callers) the returned adapterLabel is exactly what selectStagingActor produced.
export function resolvePortalChannel(input: PortalChannelInputs): PortalChannelDecision {
  // Kill-switch wins over everything: a paused portal means hands-off, full stop.
  if (input.portalPaused) {
    return {
      channel: "manual",
      adapterLabel: "ManualHandoff",
      reason: "Portal is paused (legal kill-switch) — operator must submit manually.",
      blocked: true,
    };
  }
  // RESERVED API tier — never taken in this build. Left here as the single seam to
  // enable an API channel later without touching the dispatch.
  if (input.apiAvailable) {
    return {
      channel: "api",
      adapterLabel: "ApiPortalAdapter",
      reason: "Installer has API access for this portal.",
      blocked: false,
    };
  }
  const adapterLabel = selectStagingActor({
    hasRecipe: input.hasRecipe,
    isRealPortal: input.isRealPortal,
    isAccela: input.isAccela,
    isPowerClerk: input.isPowerClerk,
    autoSeedEnabled: input.autoSeedEnabled,
    simulationEnabled: input.simulationEnabled,
  });
  const channel = ADAPTER_TO_CHANNEL[adapterLabel] ?? "mock";
  const reason =
    channel === "recipe"
      ? "Recorded complete recipe replays deterministically."
      : channel === "autolearn"
        ? "No recipe yet — universal learner self-seeds one on this stage."
        : channel === "handcoded"
          ? "Auto-seed disabled — hand-coded platform adapter (legacy fallback)."
          : "No real portal to drive (dev / mock).";
  return { channel, adapterLabel, reason, blocked: false };
}

// Map a universal self-seed (auto-learn) outcome onto the staging-result contract the
// prepareSubmission persistence block reads ({ ok, finalSubmitClicked, pauseReason, message,
// steps }). The learner NEVER clicks final submit, so finalSubmitClicked is ALWAYS false:
//   trusted | draft → reached the review screen and stopped there (→ awaiting_human_submit;
//                     trusted seeded a reusable recipe, draft will re-seed next stage);
//   paused          → an MFA/CAPTCHA challenge halted the learn (→ paused_for_human);
//   failed          → couldn't learn (→ failed: stop and surface; no hand-coded fallback).
// Exported pure so the mapping is unit-tested.
export function seedOutcomeToStageResult(seed: {
  status: "trusted" | "draft" | "paused" | "failed";
  pauseReason: string | null;
  message: string;
  // Path of the learn run's debug bundle — threaded into portal_runs.logs_path so a failed
  // stage links straight to its forensic artifacts (screenshots, trace, LLM call log).
  debugDir?: string | null;
}): Record<string, unknown> {
  const debugDir = seed.debugDir ?? null;
  if (seed.status === "paused") {
    return { ok: false, finalSubmitClicked: false, pauseReason: seed.pauseReason, message: seed.message, steps: [], debugDir };
  }
  if (seed.status === "failed") {
    return { ok: false, finalSubmitClicked: false, pauseReason: null, message: seed.message, steps: [{ ok: false, message: seed.message }], debugDir };
  }
  return { ok: true, finalSubmitClicked: false, pauseReason: null, message: seed.message, steps: [], debugDir };
}


// ── Utility-platform host knowledge ─────────────────────────────────────────────────────
// The ONE place that knows which URL hosts are utility interconnection platforms — used by
// the staging track/host gates so a permit (AHJ) track never launches or replays against a
// utility NEM portal (the wrong-system filing bug). Add hosts here as new utility platforms
// enter the knowledge base; the runtime gates pick them up automatically. (Migration v8's
// SQL predicate is deliberately NOT derived from this: a shipped data-repair migration
// stays frozen.)
const UTILITY_PLATFORM_HOSTS = ["powerclerk.com"];
export function isUtilityPlatformUrl(url: string | null | undefined): boolean {
  const u = (url || "").toLowerCase();
  return UTILITY_PLATFORM_HOSTS.some((host) => u.includes(host));
}

// Single parse of the PORTAL_AUTOSEED mode switch — hand-rolled copies of this predicate
// had already started to drift across the staging dispatch, the autopilot mock gate, and
// the monitor's fabricated-status gate.
export function isAutoSeedDisabled(): boolean {
  return process.env.PORTAL_AUTOSEED === "0" || process.env.PORTAL_AUTOSEED === "false";
}
