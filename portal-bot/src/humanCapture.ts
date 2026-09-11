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
//    never persist the typed value (sensitive:true) — the merge binds it to a
//    project field key by NAME and strips the literal before anything is stored.
//  - Best-effort everywhere: capture can never break the open session.
// ---------------------------------------------------------------------------
import type { Page } from "playwright";
import type { RecipeSelector, RecipeStep, StepFingerprint } from "../../shared/src/types";

export interface HumanCapturePayload {
  kind: "click" | "fill" | "select" | "check" | "uncheck" | "upload" | "submitObserved";
  selector: RecipeSelector;
  value?: string;
  sensitive?: boolean;
  label?: string;
  /** Element attribute names for replay-heal tie-breaking (never values). */
  fingerprint?: StepFingerprint;
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
    // The typed value rides along IN MEMORY ONLY so the backend merge can bind it to a
    // project field key (account/meter numbers are project data); appendHumanPatchSteps
    // strips the literal unconditionally before anything is persisted.
    return { action: "fill", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), value: p.value, sensitive: true, optional: true, note: `${note} — SENSITIVE, bound at replay (no value stored)` };
  }
  if (p.kind === "fill") return { action: "fill", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), value: p.value ?? "", note };
  if (p.kind === "select") return { action: "select", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), value: p.value ?? "", note };
  if (p.kind === "check") return { action: "check", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), note };
  if (p.kind === "uncheck") return { action: "uncheck", selector: p.selector, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}), note };
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

  function describe(el: Element): { selector: Record<string, unknown>; label: string; fingerprint?: Record<string, string> } {
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
    return { selector: sel, label: name, fingerprint: Object.keys(fp).length ? fp : undefined };
  }

  // The field's identity as a HUMAN sees it, not just as the DOM names it. The CVV that
  // reached a shared recipe as a literal ("520") had NO matching attribute — Accela labels
  // it with a plain <label>CVV:</label> while the input's own name/id say nothing. Reading
  // only attributes is why the card NUMBER (autocomplete-tagged) was caught and its three
  // neighbours (CVV, Name on Card, expiry) were not.
  function fieldIdentity(el: HTMLInputElement): string {
    const bits = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("autocomplete"), el.placeholder, el.getAttribute("aria-label")];
    const id = el.getAttribute("id");
    if (id) {
      try {
        const root = (el.getRootNode ? el.getRootNode() : document) as Document;
        const lbl = root.querySelector ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (lbl && lbl.textContent) bits.push(lbl.textContent);
      } catch { /* CSS.escape absent on ancient pages — attributes still checked */ }
    }
    const wrap = el.closest ? el.closest("label") : null;
    if (wrap && wrap.textContent) bits.push(wrap.textContent);
    return bits.filter(Boolean).join(" ").toLowerCase();
  }

  // PAYMENT-CARD FIELDS ARE NEVER CAPTURED AT ALL — not even sensitively-bound. A card step
  // in a recipe is a step with no legitimate replayer: replay must never drive a payment
  // form (hard rule 1), and "bound at replay" still teaches replay WHERE the card fields
  // are. The human paying the fee is the designed flow; the recipe's job ends at the fee
  // page. A Coos Bay human-patch session proved the cost of getting this wrong: CVV "520",
  // the cardholder's name and the expiry sat in the SHARED portal_recipes table for nine
  // days, in a row every tenant's replay resolves.
  function isPaymentCardField(el: HTMLInputElement): boolean {
    const hay = fieldIdentity(el);
    if (/^cc-/.test(el.getAttribute("autocomplete") || "")) return true;
    return /\bcvv\b|\bcvc\b|card\s*number|name\s*on\s*card|cardholder|card\s*type|expir(y|ation)?\s*(date|month|year)?|billing\s*zip/.test(hay);
  }

  function isSensitiveField(el: HTMLInputElement): boolean {
    if (el.type === "password") return true;
    const hay = fieldIdentity(el);
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
    // Payment-card fields: refuse BEFORE any kind branches, so a card-type <select>, an
    // expiry <select>, an autofill checkbox and the CVV <input> are all equally invisible
    // to the recipe. The human still types them; the recording simply never sees it.
    if (isPaymentCardField(el)) return;
    if (el.type === "file") w.__alPatchStep({ kind: "upload", ...d });
    else if (el.tagName === "SELECT") w.__alPatchStep({ kind: "select", value: el.value, ...d });
    else if (el.type === "checkbox" || el.type === "radio") {
      // Unchecking a pre-checked checkbox is a real fix — record it (radios only ever
      // fire change when they become checked).
      if (el.checked) w.__alPatchStep({ kind: "check", ...d });
      else if (el.type === "checkbox") w.__alPatchStep({ kind: "uncheck", ...d });
    }
    else if (isSensitiveField(el)) w.__alPatchStep({ kind: "fill", sensitive: true, value: el.value, ...d });
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
