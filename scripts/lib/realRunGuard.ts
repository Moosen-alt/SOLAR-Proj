// ---------------------------------------------------------------------------
// THE RECORDER'S REAL-PORTAL GUARD — pure, so it can be proven to refuse without a browser.
//
// scripts/demo-record-portal.ts records the replay engine stopping at a portal's review screen.
// Its default target is a fictional portal on 127.0.0.1. A --real-run points it at a real,
// supervised, unfiled project on a real portal, and that is allowed ONLY when every one of
// these holds — each checked here, each with its own refusal line so the operator sees which:
//
//   · --real-run itself, and --i-am-present (a person is at the keyboard for login/MFA and
//     watches every frame);
//   · PORTAL_ALLOW_FINAL_SUBMIT is UNSET on this process — not "0", not "": unset. The
//     recorder never passes a run approval either, and this refuses if one is somehow present;
//   · the browser is HEADED (the person must be able to see it and act in it);
//   · masking is ON (a real portal's frames carry real customers; --no-mask is for the
//     fictional portal only);
//   · the recipe, once read, has a valid shape (at most one flagged final submit, last, after
//     a stopForReview marker) — the same rule the engine's own click gate applies.
//
// And the mirror image: WITHOUT --real-run, a non-loopback target host is refused outright.
// The recorder's Node-side network traps and its loopback-only browser route stay in force
// until this guard has passed with the recipe's host known.
// ---------------------------------------------------------------------------
import { recipeShapeProblems, type ShapeStep } from "../../shared/src/portalSafety";
import { isLoopbackHost } from "../demo-portal/network";

export interface RealRunGuardInput {
  realRun: boolean;
  iAmPresent: boolean;
  /** The process environment (read by the caller and passed in — the guard reads no globals). */
  env: Record<string, string | undefined>;
  /** Any run approval the caller holds. The recorder holds none; anything non-null refuses. */
  runApproval: unknown;
  headed: boolean;
  maskOn: boolean;
  /** Hosts the run would open (the recipe's portal URL, its goto steps). Undefined before the
   *  recipe is read — the pre-database phase checks everything else first. */
  targetHosts?: string[];
  /** The recipe's steps, once read. */
  recipeSteps?: ReadonlyArray<ShapeStep>;
}

/** Every reason the run is refused. Empty means it may proceed. */
export function realRunRefusals(i: RealRunGuardInput): string[] {
  const out: string[] = [];
  const hosts = (i.targetHosts ?? []).map((h) => String(h ?? "").trim()).filter(Boolean);
  const remote = hosts.filter((h) => !isLoopbackHost(h));
  if (!i.realRun) {
    if (remote.length) out.push(`the target host(s) ${remote.map((h) => JSON.stringify(h)).join(", ")} are not loopback — a real portal is recorded only with --real-run --i-am-present, supervised`);
    return out;
  }
  if (!i.iAmPresent) out.push("--real-run requires --i-am-present: a person must be at the keyboard for login/MFA and must watch every frame");
  const allow = i.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (allow !== undefined) out.push(`PORTAL_ALLOW_FINAL_SUBMIT is set on this process (${JSON.stringify(allow)}) — unset it; a recording never files`);
  if (i.runApproval !== null && i.runApproval !== undefined) out.push("a run approval is present — the recorder never carries one");
  if (!i.headed) out.push("--real-run requires --headed: the person present must see the browser to log in and to stop it");
  if (!i.maskOn) out.push("--real-run requires masking on: a real portal's frames carry real customers (--no-mask is for the fictional portal only)");
  if (i.recipeSteps) {
    for (const p of recipeShapeProblems(i.recipeSteps)) out.push(`the recipe's shape is invalid: ${p}`);
  }
  return out;
}

/** Hostnames a recipe would open: its portal URL and every goto step's URL. */
export function recipeTargetHosts(recipe: { portalUrl?: string | null; steps?: ReadonlyArray<{ action: string; value?: unknown }> | null }): string[] {
  const urls: string[] = [];
  if (recipe.portalUrl) urls.push(String(recipe.portalUrl));
  for (const s of recipe.steps ?? []) if (s.action === "goto" && typeof s.value === "string") urls.push(s.value);
  const hosts = new Set<string>();
  for (const u of urls) {
    try { hosts.add(new URL(u).hostname.toLowerCase()); } catch { hosts.add(u); }
  }
  return [...hosts];
}
