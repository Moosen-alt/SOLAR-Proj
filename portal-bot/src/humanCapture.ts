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
//  - Sensitive fields (password/account/meter/SSN) record the STEP but never
//    persist the typed value (sensitive:true) — the merge binds it to a
//    project field key by NAME and strips the literal before anything is stored.
//  - Payment-card fields are never captured at all.
//  - Best-effort everywhere: capture can never break the open session.
//
// EVERY one of those questions is answered by shared/src/portalSafety.ts — the
// same module the recorder, the learner and replay use. The page reports what
// it saw (label, attribute names, whether the page is read-only); the decision
// is made here in Node by the shared predicates, except the card-field refusal,
// which must happen IN THE PAGE so a card value never crosses the binding. For
// that the page runs the shared factory's own source (PORTAL_SAFETY_IN_PAGE_SOURCE).
// ---------------------------------------------------------------------------
import type { Page } from "playwright";
import type { RecipeSelector, RecipeStep, StepFingerprint } from "../../shared/src/types";
import {
  capturedFieldIsSecret,
  classifyRecordedClick,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
  recordingHasFormData,
  type ControlContext,
  type FieldIdentity,
} from "../../shared/src/portalSafety";

export interface HumanCapturePayload {
  kind: "click" | "fill" | "select" | "check" | "uncheck" | "upload" | "submitObserved";
  selector: RecipeSelector;
  value?: string;
  /** Legacy: an explicit sensitive flag. The shared capturedFieldIsSecret (identity, label) is ORed in. */
  sensitive?: boolean;
  label?: string;
  /** Element attribute names for replay-heal tie-breaking (never values). */
  fingerprint?: StepFingerprint;
  /** Attribute names + label text of a form field (never its value), for the secret check. */
  identity?: FieldIdentity;
  /** For a click: the page showed no fillable control when it happened (see readOnlyPageInPage). */
  readOnlyPage?: boolean;
  /** For a click: the page named itself the review step (see reviewPageInPage). */
  reviewPage?: boolean;
  /** The page could not run the shared labeler: the click's label is UNKNOWN, so it is blocked. */
  safetyUnavailable?: boolean;
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
//
// A click is mapped ONLY when the shared classifier calls it an ordinary control: a submit-,
// file- or pay-worded click returns null here even when called directly, so no caller can turn
// one into a replayable step by skipping the sink.
export function payloadToStep(p: HumanCapturePayload, ctx?: ControlContext): RecipeStep | null {
  const note = p.label ? `human-patch: ${p.label}` : "human-patch";
  // Submit observation is a SIGNAL, not a replayable step — see HUMAN_SUBMIT_OBSERVED_NOTE.
  if (p.kind === "submitObserved") return { action: "click", selector: {}, optional: true, note: HUMAN_SUBMIT_OBSERVED_NOTE };
  if (p.kind === "click") {
    if (p.safetyUnavailable) return null;
    // Called on its own, the page context is only what the payload carries (formDataEntered
    // unknown); the sink passes its full context.
    if (classifyRecordedClick(p.label, ctx ?? { readOnlyPage: p.readOnlyPage, reviewPage: p.reviewPage }) !== "capture") return null;
    return { action: "click", selector: p.selector, note };
  }
  if ((p.kind === "fill" || p.kind === "select") && capturedFieldIsSecret(p)) {
    // The typed/chosen value rides along IN MEMORY ONLY so the backend merge can bind it to a
    // project field key (account/meter numbers are project data); appendHumanPatchSteps
    // strips the literal of every sensitive step, fill or select, before anything is persisted.
    // A secret <select> is the same as a secret <input>: its option text never reaches the
    // selector or the note (the shared labeler never reads a select's text).
    return { action: p.kind, selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), value: p.value, sensitive: true, optional: true, note: `${note} — SENSITIVE, bound at replay (no value stored)` };
  }
  if (p.kind === "fill") return { action: "fill", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), value: p.value ?? "", note };
  if (p.kind === "select") return { action: "select", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), value: p.value ?? "", note };
  if (p.kind === "check") return { action: "check", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), note };
  if (p.kind === "uncheck") return { action: "uncheck", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), note };
  if (p.kind === "upload") return { action: "upload", selector: p.selector, docType: "", note: `${note} — UPLOAD, set docType in the dashboard` };
  return null;
}

/**
 * The stateful sink one armed page reports into. A click the shared classifier calls the FINAL
 * filing click emits ONE submitObserved signal and DISARMS the session: nothing the human does
 * after filing (the confirmation page, a receipt download) is a fix to the recipe. A merely
 * submit- or pay-worded click ("Submit Documents", "Pay Fees") is dropped without disarming, so
 * the operator's remaining fixes on that page are still captured. The disarm lives here in Node,
 * so it survives the navigation the submit itself causes.
 */
export interface HumanCaptureOptions {
  /** The session is KNOWN to start before any form data was entered (armed on the portal's
   *  first page). Default false: every production caller arms at the REVIEW screen, after the
   *  automation filled the form — steps this sink never saw — so "nothing entered yet" is
   *  unknown there, and must stay undefined, never false. */
  startsFresh?: boolean;
}

export function createHumanCaptureSink(onStep: HumanStepFn, opts: HumanCaptureOptions = {}): (p: HumanCapturePayload) => void {
  let disarmed = false;
  // formDataEntered, asked of the SAME predicate the recorder uses (recordingHasFormData) over
  // the steps this sink has emitted. It only ever PROMOTES to true; it is false only for a
  // session declared fresh.
  const emitted: RecipeStep[] = [];
  const formDataEntered = (): boolean | undefined =>
    recordingHasFormData(emitted) ? true : opts.startsFresh === true ? false : undefined;
  return (p: HumanCapturePayload): void => {
    if (!p || typeof p !== "object") return;
    let ctx: ControlContext | undefined;
    if (p.kind === "click") {
      if (p.safetyUnavailable) return; // unknown label: never a replayable click
      ctx = { readOnlyPage: p.readOnlyPage, reviewPage: p.reviewPage, formDataEntered: formDataEntered() };
      const cls = classifyRecordedClick(p.label, ctx);
      if (cls === "finalSubmit") {
        if (!disarmed) {
          disarmed = true;
          onStep(payloadToStep({ kind: "submitObserved", selector: {}, label: p.label })!);
        }
        return;
      }
      if (cls === "blocked") return;
    }
    if (disarmed || p.kind === "submitObserved") return;
    const step = payloadToStep(p, ctx);
    if (step) { emitted.push(step); onStep(step); }
  };
}

// Browser-side listener set. Serialized into the page (no closures over Node state).
// Shadow-aware: reads the real target through composedPath(), and resolves label[for]
// in the element's own root. Guarded so re-arming never double-registers.
function patchCaptureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__alPatchArmed) return;
  w.__alPatchArmed = true;

  function target(e: Event): Element | null {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const t = (path && path[0]) || e.target;
    return t instanceof Element ? t : null;
  }

  function describe(el: Element): { selector: Record<string, unknown>; label: string; fingerprint?: Record<string, string>; safetyUnavailable?: boolean } {
    // Role and label come from the SHARED labeler (window.__portalSafety), the same one the
    // recorder uses: a button's value, an image's alt and a title are read, and a <select>'s
    // option text never is. FAIL CLOSED: without it the payload says so and the sink blocks.
    const ps = w.__portalSafety;
    const safetyUnavailable = !ps || typeof ps.controlLabelInPage !== "function" || typeof ps.controlRoleInPage !== "function";
    let role = "";
    let name = "";
    if (!safetyUnavailable) {
      try { role = String(ps.controlRoleInPage(el) || ""); name = String(ps.controlLabelInPage(el) || ""); } catch { /* label stays empty */ }
    }
    const id = el.getAttribute("id");
    const sel: Record<string, unknown> = {};
    const frameName = window.name || undefined;
    if (frameName) sel.frame = frameName;
    if (role && name) { sel.role = role; sel.name = name; }
    else if (el.getAttribute("aria-label")) sel.label = el.getAttribute("aria-label");
    else if ((el as HTMLInputElement).placeholder) sel.placeholder = (el as HTMLInputElement).placeholder;
    else if (id) sel.css = `#${CSS.escape(id)}`;
    else if (el.getAttribute("name")) sel.css = `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    else if (name) sel.text = name;
    // Fingerprint: attribute NAMES only (id/name/placeholder/aria-label/section)
    // for replay-heal tie-breaking — never element values.
    const fp: Record<string, string> = {};
    if (id) fp.id = id;
    const nameAttr = el.getAttribute("name");
    if (nameAttr) fp.name = nameAttr;
    const ph = (el as HTMLInputElement).placeholder;
    if (ph) fp.placeholder = ph;
    const ariaAttr = el.getAttribute("aria-label");
    if (ariaAttr) fp.ariaLabel = ariaAttr;
    const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
    if (legend) fp.section = legend;
    return { selector: sel, label: name, fingerprint: Object.keys(fp).length ? fp : undefined, ...(safetyUnavailable ? { safetyUnavailable: true } : {}) };
  }

  // The field identity (attribute NAMES + label text, never the value) and the card-field
  // refusal both come from the shared predicates the page was given (window.__portalSafety).
  //
  // PAYMENT-CARD FIELDS ARE NEVER CAPTURED AT ALL — not even sensitively-bound. A card step
  // in a recipe is a step with no legitimate replayer: replay must never drive a payment
  // form (hard rule 1), and "bound at replay" still teaches replay WHERE the card fields
  // are. The human paying the fee is the designed flow; the recipe's job ends at the fee
  // page. A Coos Bay human-patch session proved the cost of getting this wrong: CVV "520",
  // the cardholder's name and the expiry sat in the SHARED portal_recipes table for nine
  // days, in a row every tenant's replay resolves.
  //
  // FAIL CLOSED: if the shared predicates did not install, no field event is reported at all.
  function fieldIdentity(el: Element): Record<string, string> {
    const ps = w.__portalSafety;
    return ps && typeof ps.fieldIdentityInPage === "function" ? ps.fieldIdentityInPage(el) : {};
  }
  function isPaymentCardField(el: Element): boolean {
    const ps = w.__portalSafety;
    if (!ps || typeof ps.isPaymentElementInPage !== "function") return true;
    try { return ps.isPaymentElementInPage(el) === true; } catch { return true; }
  }

  function reviewPage(): boolean | undefined {
    const ps = w.__portalSafety;
    try { return ps && typeof ps.reviewPageInPage === "function" ? ps.reviewPageInPage() : undefined; } catch { return undefined; }
  }
  function readOnlyPage(): boolean | undefined {
    const ps = w.__portalSafety;
    try { return ps && typeof ps.readOnlyPageInPage === "function" ? ps.readOnlyPageInPage() : undefined; } catch { return undefined; }
  }

  document.addEventListener("click", (e) => {
    const el = target(e);
    if (!el) return;
    // input[type=submit|button|image] included: a portal whose Submit is an <input> was never
    // reported at all, so the filing click went unobserved.
    const actionable = el.closest("button,a,[role=button],[role=link],input[type=submit],input[type=button],input[type=image],summary");
    if (!actionable) return; // plain page click — not a replayable action
    if ((actionable as HTMLInputElement).type === "file") return; // handled by change
    // Reported with the page's read-only state; the SHARED classifier in Node decides whether it
    // is an ordinary click, a blocked submit/pay control, or the final filing click.
    if (typeof w.__alPatchStep === "function") w.__alPatchStep({ kind: "click", ...describe(actionable), readOnlyPage: readOnlyPage(), reviewPage: reviewPage() });
  }, true);

  document.addEventListener("change", (e) => {
    const el = target(e) as HTMLInputElement | null;
    if (!el || !(el instanceof Element)) return;
    if (typeof w.__alPatchStep !== "function") return;
    // Payment-card fields: refuse BEFORE any kind branches, so a card-type <select>, an
    // expiry <select>, an autofill checkbox and the CVV <input> are all equally invisible
    // to the recipe. The human still types them; the recording simply never sees it.
    if (isPaymentCardField(el)) return;
    const d = describe(el);
    const identity = fieldIdentity(el);
    if (el.type === "file") w.__alPatchStep({ kind: "upload", ...d });
    else if (el.tagName === "SELECT") w.__alPatchStep({ kind: "select", value: el.value, identity, ...d });
    else if (el.type === "checkbox" || el.type === "radio") {
      // Unchecking a pre-checked checkbox is a real fix — record it (radios only ever
      // fire change when they become checked).
      if (el.checked) w.__alPatchStep({ kind: "check", ...d });
      else if (el.type === "checkbox") w.__alPatchStep({ kind: "uncheck", ...d });
    }
    else w.__alPatchStep({ kind: "fill", value: el.value, identity, ...d });
  }, true);
}

/** Arm the open page: expose the step binding, install the shared safety predicates and the
 *  capture listeners on the current document AND on every future navigation, and report each
 *  interaction as a RecipeStep. Returns true when armed; never throws. */
export async function armHumanCaptureOnPage(page: Page, onStep: HumanStepFn, opts: HumanCaptureOptions = {}): Promise<boolean> {
  if (!page || typeof page.evaluate !== "function") return false;
  try {
    const sink = createHumanCaptureSink(onStep, opts);
    try {
      await page.exposeBinding("__alPatchStep", (_src, payload: HumanCapturePayload) => {
        try { sink(payload); } catch { /* the sink must never break the page */ }
      });
    } catch {
      // Already exposed on this page (re-arm) — listeners below are idempotent too.
    }
    // PORTAL_SAFETY_IN_PAGE_SOURCE carries the __name shim (esbuild/tsx serializes in-page
    // functions with __name helper calls) and installs window.__portalSafety.
    if (typeof page.addInitScript === "function") {
      await page.addInitScript({ content: PORTAL_SAFETY_IN_PAGE_SOURCE }).catch(() => null);
      await page.addInitScript(patchCaptureScript).catch(() => null);
    }
    await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
    await page.evaluate(patchCaptureScript);
    return true;
  } catch {
    return false;
  }
}
