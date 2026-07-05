// ---------------------------------------------------------------------------
// Human patch capture — PATCH-BY-DEMONSTRATION for auto-learned recipes.
//
// After an auto-learn reaches the review screen, the headed browser is left
// open for the operator to verify and finish anything the learner missed
// (a blank required dropdown, an unmapped field). This module arms that open
// page with the same interaction capture the manual recorder uses, so every
// fix the human makes — fill / select / check / upload / navigation click —
// is reported back as a RecipeStep and merged into the learned recipe
// (appendHumanPatchSteps, backend). First pass learns 95%, the human
// demonstrates the remainder ONCE, and the merged recipe covers 100% of the
// form for every future project.
//
// SAFETY:
//  - Clicks on final-submit / pay / fee controls are NEVER captured — the
//    human clicking Submit files THIS application; it must not append a
//    submit step that replay could act on.
//  - Sensitive fields (password/account/meter/SSN/card) record the STEP but
//    never the typed value (sensitive:true) — bound at replay from the
//    encrypted store, exactly like the recorder.
//  - Best-effort everywhere: capture can never break the open session.
// ---------------------------------------------------------------------------
import type { Page } from "playwright";
import type { RecipeSelector, RecipeStep } from "../../shared/src/types";

export interface HumanCapturePayload {
  kind: "click" | "fill" | "select" | "check" | "upload" | "submitObserved";
  selector: RecipeSelector;
  value?: string;
  sensitive?: boolean;
  label?: string;
}

// Marker note carried by the pseudo-step emitted when the HUMAN clicks the portal's final
// Submit in the left-open review browser. It is never merged into the recipe (the merge
// filter drops submit clicks); the backend uses it as the signal that the operator just
// DEMONSTRATED the corrected fill end-to-end — the recording is promoted to a complete,
// replayable recipe and the "recording in progress" banner clears.
export const HUMAN_SUBMIT_OBSERVED_NOTE = "__human_submit_observed__";

export type HumanStepFn = (step: RecipeStep) => void;

// Map a captured interaction onto the recipe-step contract (same mapping as the
// manual recorder in recordRecipe.ts). Values are kept literal here; the backend
// merge converts literals that match project data into reusable field bindings.
export function payloadToStep(p: HumanCapturePayload): RecipeStep | null {
  const note = p.label ? `human-patch: ${p.label}` : "human-patch";
  // Submit observation is a SIGNAL, not a replayable step — see HUMAN_SUBMIT_OBSERVED_NOTE.
  if (p.kind === "submitObserved") return { action: "click", selector: {}, optional: true, note: HUMAN_SUBMIT_OBSERVED_NOTE };
  if (p.kind === "click") return { action: "click", selector: p.selector, note };
  if (p.kind === "fill" && p.sensitive) {
    return { action: "fill", selector: p.selector, sensitive: true, optional: true, note: `${note} — SENSITIVE, bound at replay (no value stored)` };
  }
  if (p.kind === "fill") return { action: "fill", selector: p.selector, value: p.value ?? "", note };
  if (p.kind === "select") return { action: "select", selector: p.selector, value: p.value ?? "", note };
  if (p.kind === "check") return { action: "check", selector: p.selector, note };
  if (p.kind === "upload") return { action: "upload", selector: p.selector, docType: "", note: `${note} — UPLOAD, set docType in the dashboard` };
  return null;
}

// Browser-side listener set. Serialized into the page (no closures over Node state).
// Shadow-aware: reads the real target through composedPath(), and resolves label[for]
// in the element's own root. Guarded so re-arming never double-registers.
function patchCaptureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__alPatchArmed) return;
  w.__alPatchArmed = true;

  // Final-submit / payment intent — NEVER captured (see module SAFETY note). A BARE
  // "Submit"/"Pay" button counts: PGE PowerClerk's final button is literally "Submit",
  // and a real run recorded that click into the recipe before this was broadened.
  const OFF_LIMITS = /\b(submit|pay|pay fee|pay now|make payment|continue to payment|add to cart|proceed to (payment|checkout)|checkout|file application|confirm submission|complete submission|finalize|place order)\b/i;

  function target(e: Event): Element | null {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const t = (path && path[0]) || e.target;
    return t instanceof Element ? t : null;
  }

  function describe(el: Element): { selector: Record<string, unknown>; label: string } {
    const role = el.getAttribute("role") || ({ INPUT: "textbox", BUTTON: "button", SELECT: "combobox", A: "link", TEXTAREA: "textbox" } as Record<string, string>)[el.tagName] || "";
    const root = el.getRootNode() as Document | ShadowRoot;
    const id = el.getAttribute("id");
    const name =
      el.getAttribute("aria-label") ||
      (id ? (root.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || "").trim() : "") ||
      (el as HTMLInputElement).placeholder ||
      (el.textContent || "").trim().slice(0, 60);
    const sel: Record<string, unknown> = {};
    const frameName = window.name || undefined;
    if (frameName) sel.frame = frameName;
    if (role && name) { sel.role = role; sel.name = name; }
    else if (el.getAttribute("aria-label")) sel.label = el.getAttribute("aria-label");
    else if ((el as HTMLInputElement).placeholder) sel.placeholder = (el as HTMLInputElement).placeholder;
    else if (id) sel.css = `#${CSS.escape(id)}`;
    else if (el.getAttribute("name")) sel.css = `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    else if (name) sel.text = name;
    return { selector: sel, label: name };
  }

  function isSensitiveField(el: HTMLInputElement): boolean {
    if (el.type === "password") return true;
    const hay = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("autocomplete"), el.placeholder, el.getAttribute("aria-label")]
      .filter(Boolean).join(" ").toLowerCase();
    return /password|passcode|account\s*(no|num|#)|account number|acct|meter|ssn|social security|card\s*number|cvv|security code|mfa|otp|one.time/.test(hay);
  }

  document.addEventListener("click", (e) => {
    const el = target(e);
    if (!el) return;
    const actionable = el.closest("button,a,[role=button],[role=link]");
    if (!actionable) return; // plain page click — not a replayable action
    if ((actionable as HTMLInputElement).type === "file") return; // handled by change
    const d = describe(actionable);
    if (OFF_LIMITS.test(d.label)) {
      // A submit/pay-worded click is NEVER captured as a replayable step (broad match —
      // losing a mid-flow "Submit Documents" nav click from a patch is safer than
      // replaying one). But only the FINAL application submit disarms capture and emits
      // the submit-observed promotion signal: a mid-flow "Submit Documents" / "Submit
      // for Review" / "Save and Submit Later" must not promote a half-corrected
      // recording or stop capturing the operator's remaining fixes. Final = a bare
      // "Submit"/"Submit Application" style label, or explicit filing phrases.
      const label = (d.label || "").trim();
      const isFinalSubmit = /^(submit|submit application|submit & pay|submit and pay)$/i.test(label)
        || /\b(confirm submission|complete submission|file application)\b/i.test(label);
      if (isFinalSubmit) {
        const alreadyDisarmed = w.__alPatchDisarmed === true;
        w.__alPatchDisarmed = true;
        if (!alreadyDisarmed && typeof w.__alPatchStep === "function") {
          w.__alPatchStep({ kind: "submitObserved", selector: {}, label });
        }
      }
      return;
    }
    if (w.__alPatchDisarmed) return;
    if (typeof w.__alPatchStep === "function") w.__alPatchStep({ kind: "click", ...d });
  }, true);

  document.addEventListener("change", (e) => {
    const el = target(e) as HTMLInputElement | null;
    if (!el || !(el instanceof Element)) return;
    const d = describe(el);
    if (w.__alPatchDisarmed) return;
    if (typeof w.__alPatchStep !== "function") return;
    if (el.type === "file") w.__alPatchStep({ kind: "upload", ...d });
    else if (el.tagName === "SELECT") w.__alPatchStep({ kind: "select", value: el.value, ...d });
    else if (el.type === "checkbox" || el.type === "radio") { if (el.checked) w.__alPatchStep({ kind: "check", ...d }); }
    else if (isSensitiveField(el)) w.__alPatchStep({ kind: "fill", sensitive: true, ...d });
    else w.__alPatchStep({ kind: "fill", value: el.value, ...d });
  }, true);
}

/** Arm the open page: expose the step binding, install the capture listeners on the
 *  current document AND on every future navigation, and report each interaction as a
 *  RecipeStep. Returns true when armed; never throws. */
export async function armHumanCaptureOnPage(page: Page, onStep: HumanStepFn): Promise<boolean> {
  if (!page || typeof page.evaluate !== "function") return false;
  try {
    try {
      await page.exposeBinding("__alPatchStep", (_src, payload: HumanCapturePayload) => {
        try {
          const step = payloadToStep(payload);
          if (step) onStep(step);
        } catch { /* the sink must never break the page */ }
      });
    } catch {
      // Already exposed on this page (re-arm) — listeners below are idempotent too.
    }
    // esbuild/tsx serializes in-page functions with __name helper calls; openPortal pages
    // carry the shim already, but be self-sufficient so capture arms on ANY page.
    const NAME_SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";
    if (typeof page.addInitScript === "function") {
      await page.addInitScript({ content: NAME_SHIM }).catch(() => null);
      await page.addInitScript(patchCaptureScript).catch(() => null);
    }
    await page.evaluate(NAME_SHIM);
    await page.evaluate(patchCaptureScript);
    return true;
  } catch {
    return false;
  }
}
