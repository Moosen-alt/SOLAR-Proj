/**
 * Portal recipe recorder — TEACH THE BOT A NEW AHJ OR UTILITY PORTAL BY DEMONSTRATION.
 *
 * Runs on the operator's machine (needs a browser + reachable portal + the running app).
 * It opens a headed browser, you log in and complete the application UP TO — but NOT
 * including — the final submit, and it captures each interaction (clicks, field fills,
 * dropdowns, checkboxes, file uploads) as a portable recipe. Values you type that match
 * the recording project's data are auto-bound to that field, so the recipe replays each
 * FUTURE project's own data. When you finish, type "save" and it stores the recipe; the
 * bot will then replay it for that AHJ/utility (always stopping at review — never submits).
 *
 * Usage:
 *   npm run portal:record -- \
 *     --scope ahj --ahj "City of Bend" --state OR \
 *     --url "https://aca-oregon.accela.com/oregon/" \
 *     --project <projectId> --profile ./.portal-profiles/accela \
 *     [--api http://localhost:4173] [--platform Accela]
 *
 * Delete / re-record from the dashboard (Portal Recipes admin) if one wasn't completed.
 */
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import type { RecipeSelector, RecipeStep, StepFingerprint } from "../../shared/src/types";
import {
  capturedFieldIsSecret,
  classifyRecordedClick,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
  recordingHasFormData,
  type FieldIdentity,
} from "../../shared/src/portalSafety";
import { openPortal } from "./browser";

/** What the in-page capture reports for one interaction. Attribute names and labels only,
 *  except `value`, which crosses this in-memory binding so it can be bound to a field key. */
export interface RecordedPayload {
  kind: string;
  selector: RecipeSelector;
  value?: string;
  rawValue?: string;
  sensitive?: boolean;
  isFile?: boolean;
  viaFileChooser?: boolean;
  label?: string;
  fingerprint?: StepFingerprint;
  identity?: FieldIdentity;
  readOnlyPage?: boolean;
  /** For a click: the page named itself the review step (see reviewPageInPage). */
  reviewPage?: boolean;
  /** The page could not run the shared labeler: the click's label is UNKNOWN, so it is blocked. */
  safetyUnavailable?: boolean;
}

/** Has the recording entered real form data yet? The shared predicate (humanCapture asks the
 *  same one) — re-exported here for the callers that imported it from the recorder. */
export { recordingHasFormData };

/**
 * Map one captured interaction onto a recipe step and append it. Every safety decision comes
 * from shared/src/portalSafety.ts:
 *   - a click is classified by classifyRecordedClick with the page's read-only state and whether
 *     this recording has entered data yet. A submit/pay-worded click becomes a TARGETLESS optional
 *     placeholder (never replayable, but the recipe shows where it happened); only THE filing
 *     click is flagged isFinalSubmit.
 *   - a fill OR a select is secret when capturedFieldIsSecret says so (the payload's flag, its
 *     identity, or its label): the step is kept, the literal and the option text are not.
 *   - a click whose page could not run the shared labeler (safetyUnavailable) is blocked.
 */
export function createRecorderSink(
  steps: RecipeStep[],
  bindField: (typed: string) => string | undefined,
  opts: {
    /** The recording starts at the portal's front door (the CLI opened --url itself), so an
     *  empty recording KNOWS nothing was entered. false = it may start mid-flow (a resumed
     *  draft): until this recording enters data, formDataEntered stays UNKNOWN, never false. */
    startsFresh?: boolean;
  } = {},
): (payload: RecordedPayload) => void {
  // UNKNOWN BY DEFAULT, like createHumanCaptureSink: only a caller that KNOWS it opened the
  // portal at its front door says so. Defaulting to fresh failed open — with no opts, a read-only
  // page's "Continue Application" with nothing entered was captured as replayable navigation
  // (recorder skeptic probe G-f).
  const startsFresh = opts.startsFresh === true;
  return (payload: RecordedPayload): void => {
    const sel = payload.selector;
    // Heal tie-break metadata (attribute names only) — attached to form-control steps.
    const fp = payload.fingerprint ? { fingerprint: payload.fingerprint } : {};
    if (payload.kind === "click") {
      // A page that could not run the shared labeler reports an UNKNOWN label: blocked, never
      // a replayable click (an empty label reads as "not submit" to every classifier).
      const cls = payload.safetyUnavailable
        ? "blocked"
        : classifyRecordedClick(payload.label, {
          readOnlyPage: payload.readOnlyPage,
          reviewPage: payload.reviewPage,
          // The recorder opens the portal itself and sees every step from the first page, so an
          // empty recording is KNOWN to have entered nothing (the entry disclaimer's advance is a
          // pass-through). A review page still files: reviewPage outranks this.
          formDataEntered: recordingHasFormData(steps) ? true : startsFresh ? false : undefined,
        });
      if (cls === "capture") {
        steps.push({ action: "click", selector: sel, note: payload.label });
        return;
      }
      // A submit/pay-worded control the operator clicked. NEVER replayable: no selector,
      // optional, so replay skips it — but the recipe keeps a visible placeholder instead of
      // a silent hole. Only the filing click itself carries isFinalSubmit (and
      // finalizeRecordedSteps keeps that flag only in the one valid terminal position).
      steps.push({
        action: "click",
        selector: {},
        optional: true,
        ...(cls === "finalSubmit" ? { isFinalSubmit: true } : {}),
        note: `BLOCKED — human clicked a submit/pay-like control ("${payload.label ?? ""}") here; not replayable. Re-record as a nav step if it was mid-flow navigation.`,
      });
    } else if ((payload.kind === "fill" || payload.kind === "select") && capturedFieldIsSecret(payload)) {
      // Credential/secret field — never persist the typed value. The value crosses
      // ONLY this in-memory binding so it can be matched to a project field key
      // (account/meter numbers live in project data); on a match the step binds by
      // NAME and replay substitutes each project's own value. No match → the step
      // is recorded valueless (optional) and skipped at replay.
      // A secret <select> is the same: the chosen option (label or raw value) may bind, and
      // neither ever reaches the step — no value, and no option text in the note.
      const field = bindField(payload.value || "") || (payload.kind === "select" ? bindField(payload.rawValue || "") : undefined);
      // A SENSITIVE STEP KEEPS NO NUMBER-SHAPED TEXT in the parts that are stored. A label[for]
      // that wraps a read-only span showing the STORED account number ("Account Number
      // <span>5550001111</span>") made that number part of the field's accessible name, so it
      // reached selector.name and the note (checker close-mustfix, bypass-label.log
      // for-wraps-span). Digit runs of six or more are removed from the human-text parts (name,
      // label, text, placeholder, note, fingerprint text); attribute keys (css, id, name) stay,
      // because they are the replay's matching key and a customer's value is not an id.
      const strip = (s: unknown): string => String(s ?? "").replace(/\d(?:[\s.\-/]?\d){5,}/g, " ").replace(/\s+/g, " ").trim();
      const kept = { ...(sel as Record<string, unknown>) } as RecipeSelector & Record<string, unknown>;
      for (const k of ["name", "label", "text", "placeholder"]) if (typeof kept[k] === "string") kept[k] = strip(kept[k]);
      const fpKept = payload.fingerprint
        ? { fingerprint: Object.fromEntries(Object.entries(payload.fingerprint).map(([k, v]) => [k, typeof v === "string" && k !== "id" && k !== "name" ? strip(v) : v])) as StepFingerprint }
        : {};
      steps.push({ action: payload.kind === "select" ? "select" : "fill", selector: kept, ...fpKept, field, sensitive: true, optional: true, note: `SENSITIVE — ${field ? `bound to project field "${field}"` : "bind to credential/redacted field"} (no value stored). ${strip(payload.label)}`.trim() });
    } else if (payload.kind === "fill") {
      const field = bindField(payload.value || "");
      steps.push(field ? { action: "fill", selector: sel, ...fp, field, note: payload.label } : { action: "fill", selector: sel, ...fp, value: payload.value, note: payload.label });
    } else if (payload.kind === "select") {
      // payload.value is the selected option's LABEL (replay's selectWithFallback
      // matches label first); rawValue is the option's value attribute, kept in the
      // note for debugging. Try binding on either — project data may hold one or the other.
      const field = bindField(payload.value || "") || bindField(payload.rawValue || "");
      const note = [payload.label, payload.rawValue && payload.rawValue !== payload.value ? `(option value: ${payload.rawValue})` : ""].filter(Boolean).join(" ");
      steps.push(field ? { action: "select", selector: sel, ...fp, field, note } : { action: "select", selector: sel, ...fp, value: payload.value, note });
    } else if (payload.kind === "check") {
      steps.push({ action: "check", selector: sel, ...fp, note: payload.label });
    } else if (payload.kind === "uncheck") {
      steps.push({ action: "uncheck", selector: sel, ...fp, note: payload.label });
    } else if (payload.kind === "upload") {
      steps.push({ action: "upload", selector: sel, docType: "", ...(payload.viaFileChooser ? { viaFileChooser: true } : {}), note: `UPLOAD — set docType (e.g. sld, site_plan) in the dashboard. ${payload.label ?? ""}` });
    }
  };
}

/**
 * Close a recording into the one valid recipe shape (shared validateRecipeShape): replay always
 * stops at a stopForReview marker, and an isFinalSubmit step may exist only as the single LAST
 * step, immediately after that marker. If the operator's last action was the filing click, it is
 * kept there as the (targetless) terminal flagged step; every other flag is dropped — a flagged
 * step mid-recipe is exactly the three-flagged shape the gate must refuse.
 */
export function finalizeRecordedSteps(steps: ReadonlyArray<RecipeStep>): RecipeStep[] {
  const review: RecipeStep = { action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." };
  const last = steps[steps.length - 1];
  const terminal = last && last.isFinalSubmit === true ? last : null;
  const body = (terminal ? steps.slice(0, -1) : steps.slice()).map((s) => {
    if (s.isFinalSubmit !== true) return s;
    const { isFinalSubmit: _drop, ...rest } = s;
    return rest as RecipeStep;
  });
  return terminal ? [...body, review, terminal] : [...body, review];
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

async function main(): Promise<void> {
  const scope = arg("scope", "ahj") === "utility" ? "utility" : "ahj";
  const ahj = arg("ahj");
  const utility = arg("utility");
  const state = arg("state");
  const url = arg("url");
  const platform = arg("platform");
  const projectId = arg("project");
  const profileDir = arg("profile", "./.portal-profiles/recorder");
  const api = arg("api", process.env.API_BASE || "http://localhost:4173");
  if (scope === "ahj" && !ahj) throw new Error("--ahj is required for an AHJ recipe.");
  if (scope === "utility" && !utility) throw new Error("--utility is required for a utility recipe.");

  // 1) Start (or reset) the recording row + fetch the recording project's field values
  //    so we can auto-bind typed values to their field key.
  const startRes = await fetch(`${api}/api/portal-recipes/record`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopeType: scope, ahj, utility, state, portalPlatform: platform, portalUrl: url }),
  });
  if (!startRes.ok) throw new Error(`Failed to start recording: ${startRes.status} ${await startRes.text()}`);
  const recipe = await startRes.json();

  let fieldValues: Record<string, string> = {};
  if (projectId) {
    const fvRes = await fetch(`${api}/api/projects/${projectId}/staging-field-values`);
    if (fvRes.ok) fieldValues = (await fvRes.json()).fieldValues ?? {};
  }
  // Reverse map: normalized value -> field key (longest values first to avoid collisions).
  const valueToField = new Map<string, string>();
  for (const [field, value] of Object.entries(fieldValues)) {
    const v = String(value || "").trim().toLowerCase();
    if (v.length >= 3 && !valueToField.has(v)) valueToField.set(v, field);
  }
  const bindField = (typed: string): string | undefined => valueToField.get(String(typed || "").trim().toLowerCase());

  const steps: RecipeStep[] = [];

  // 2) Open the browser with a persistent profile (login persists across runs).
  const { page } = await openPortal({ userDataDir: profileDir, headless: false });

  // The page calls this binding for every captured interaction.
  // Fresh only when this CLI opens the portal itself; without --url the operator's persistent
  // profile may resume a draft mid-flow.
  const sink = createRecorderSink(steps, bindField, { startsFresh: !!url });
  await page.exposeBinding("__recordStep", (_src: unknown, payload: RecordedPayload) => {
    const before = steps.length;
    sink(payload);
    if (steps.length > before) {
      const s = steps[steps.length - 1];
      process.stdout.write(`  · captured ${payload.kind}${s.isFinalSubmit ? " (FINAL SUBMIT — blocked, flagged)" : !s.selector || !Object.keys(s.selector).length ? " (blocked, not replayable)" : ""}${s.field ? ` → field ${s.field}` : ""}\n`);
    }
  });

  // Inject the shared safety predicates, then the capture listeners, into every page/frame.
  await page.addInitScript({ content: PORTAL_SAFETY_IN_PAGE_SOURCE });
  await page.addInitScript(captureScript);
  if (url) await page.goto(url);

  console.log(`\nRecording "${ahj || utility}" (${platform || "portal"}).`);
  console.log("→ Log in and complete the application UP TO the final review/submit screen.");
  console.log("→ Do NOT click the final Submit/Pay. When done, come back here and type: save\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (line.trim().toLowerCase() === "save") resolve();
    });
  });
  rl.close();

  // Terminal review marker so replay always stops before submit — in the one valid shape.
  const closed = finalizeRecordedSteps(steps);

  // LLM-assisted binding: for fill/select steps without an exact-match field key, ask the
  // model to identify which project/client field each typed value corresponds to.
  // This is a single call at save-time (not per keystroke), so LLM latency is fine.
  let finalSteps = closed;
  if (projectId) {
    const unboundCount = closed.filter((s) => (s.action === "fill" || s.action === "select") && !s.field && s.value).length;
    if (unboundCount > 0) {
      process.stdout.write(`  · ${unboundCount} unbound step(s) — asking the model to suggest field mappings…\n`);
      try {
        const suggestRes = await fetch(`${api}/api/portal-recipes/${recipe.id}/suggest-bindings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ steps: closed, projectId }),
        });
        if (suggestRes.ok) {
          const body = await suggestRes.json();
          finalSteps = Array.isArray(body.steps) ? body.steps : closed;
          const applied = body.suggestionsApplied ?? 0;
          if (applied > 0) process.stdout.write(`  · LLM bound ${applied} additional field(s) automatically.\n`);
          if (body.warning) process.stdout.write(`  · ${body.warning}\n`);
        }
      } catch (err) {
        process.stdout.write(`  · LLM field-binding skipped (${err instanceof Error ? err.message : String(err)}); steps saved as-is.\n`);
      }
    }
  }

  const saveRes = await fetch(`${api}/api/portal-recipes/${recipe.id}/steps`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: finalSteps, status: "complete" }),
  });
  if (!saveRes.ok) throw new Error(`Failed to save recipe: ${saveRes.status} ${await saveRes.text()}`);
  const boundCount = finalSteps.filter((s: RecipeStep) => s.field).length;
  console.log(`\nSaved ${finalSteps.length} step(s) to recipe ${recipe.id} (${boundCount} data-bound). Set any UPLOAD docTypes in the dashboard, then the bot will replay it.`);
  process.exit(0);
}

// Browser-side capture: generates a portable selector for the target element and reports
// each interaction back to the recorder via window.__recordStep.
// Exported so a DOM smoke can drive the REAL recorder page-side code (it had no test at all).
export function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  // Shadow-aware target: the real element through composedPath() (same as humanCapture.ts).
  function target(e: Event): Element | null {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const t = (path && path[0]) || e.target;
    return t instanceof Element ? t : null;
  }
  function describe(el: Element): Record<string, unknown> {
    // Role and label come from the SHARED labeler (window.__portalSafety): the label is what the
    // click classifier is asked about, so it reads a button's value, an image's alt and a title,
    // and never a <select>'s option text. FAIL CLOSED: without the shared predicates the payload
    // says so, and the sink treats the click as blocked (see createRecorderSink).
    const ps = w.__portalSafety;
    const safetyUnavailable = !ps || typeof ps.controlLabelInPage !== "function" || typeof ps.controlRoleInPage !== "function";
    let role = "";
    let name = "";
    if (!safetyUnavailable) {
      try { role = String(ps.controlRoleInPage(el) || ""); name = String(ps.controlLabelInPage(el) || ""); } catch { /* reported below */ }
    }
    const id = el.getAttribute("id");
    const sel: Record<string, unknown> = {};
    // Frame key replay understands (safeAction.frameSelectorFor): the frame element's
    // name, or "src:<pathname>" for unnamed frames (matched on the parent's iframe[src]).
    const frameName = window.name || (window !== window.top ? `src:${window.location.pathname}` : "");
    if (frameName) sel.frame = frameName;
    if (role && name) { sel.role = role; sel.name = name; }
    else if (el.getAttribute("aria-label")) sel.label = el.getAttribute("aria-label");
    else if ((el as HTMLInputElement).placeholder) sel.placeholder = (el as HTMLInputElement).placeholder;
    else if (id) sel.css = `#${CSS.escape(id)}`;
    else if (el.getAttribute("name")) sel.css = `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    else if (name) sel.text = name;
    // Fingerprint: attribute NAMES only for replay-heal tie-breaking — never values.
    const fp: Record<string, string> = {};
    if (id) fp.id = id;
    if (el.getAttribute("name")) fp.name = el.getAttribute("name") as string;
    if ((el as HTMLInputElement).placeholder) fp.placeholder = (el as HTMLInputElement).placeholder;
    if (el.getAttribute("aria-label")) fp.ariaLabel = el.getAttribute("aria-label") as string;
    const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
    if (legend) fp.section = legend;
    return { selector: sel, label: name, ...(Object.keys(fp).length ? { fingerprint: fp } : {}), ...(safetyUnavailable ? { safetyUnavailable: true } : {}) };
  }
  // Every safety decision is made in Node by shared/src/portalSafety.ts (see createRecorderSink):
  // a click is REPORTED with the page's read-only state, and the shared classifier decides
  // whether it is an ordinary click, a blocked submit/pay placeholder, or the filing click. The
  // one decision made here is the card-field refusal, so a card value never crosses the binding.
  // FAIL CLOSED: without the shared predicates, no field event is reported at all.
  function isPaymentCardField(el: Element): boolean {
    const ps = w.__portalSafety;
    if (!ps || typeof ps.isPaymentElementInPage !== "function") return true;
    try { return ps.isPaymentElementInPage(el) === true; } catch { return true; }
  }
  function identityOf(el: Element): Record<string, string> {
    const ps = w.__portalSafety;
    return ps && typeof ps.fieldIdentityInPage === "function" ? ps.fieldIdentityInPage(el) : {};
  }
  function readOnlyPage(): boolean | undefined {
    const ps = w.__portalSafety;
    try { return ps && typeof ps.readOnlyPageInPage === "function" ? ps.readOnlyPageInPage() : undefined; } catch { return undefined; }
  }
  function reviewPage(): boolean | undefined {
    const ps = w.__portalSafety;
    try { return ps && typeof ps.reviewPageInPage === "function" ? ps.reviewPageInPage() : undefined; } catch { return undefined; }
  }
  document.addEventListener("click", (e) => {
    const el = target(e);
    if (!el) return;
    // Custom (non-native) dropdown: a click on an option-like element is recorded as a
    // SELECT step against the owning combobox so replay goes through selectWithFallback
    // (label-first matching) instead of a brittle click on a transient option node.
    const option = el.closest('[role="option"], .select2-results li, .select2-results__option, ul.ui-autocomplete li, .ui-menu-item');
    if (option) {
      const optionText = (option.textContent || "").trim();
      if (optionText) {
        const listbox = option.closest('[role="listbox"], .select2-results, .select2-drop, .select2-dropdown, ul.ui-autocomplete, .ui-menu') || option.parentElement;
        const root = option.getRootNode() as Document | ShadowRoot;
        // The owning control: an expanded combobox, or one wired to the listbox via
        // aria-owns/aria-controls. Fall back to the listbox container itself.
        const listboxId = listbox?.getAttribute("id");
        const combo =
          (listboxId ? root.querySelector(`[aria-owns~="${CSS.escape(listboxId)}"], [aria-controls~="${CSS.escape(listboxId)}"]`) : null) ||
          root.querySelector('[role="combobox"][aria-expanded="true"]') ||
          listbox || option;
        // THE NATIVE CONTROL THE WIDGET FRONTS, when there is one (recorder skeptic F5, probe G-b).
        // A select2/chosen face is labelled by aria-labelledby -> its rendered selection, i.e. the
        // CURRENT VALUE, and carries none of the native control's name/id/label[for]. So a select2
        // over <select name=meterNumber> with <label for>Meter Number</label> recorded
        // {role:combobox, name:'Select...'} sensitive:false with the meter number as the literal
        // (real select2 fires change through jQuery: the native change branch never runs). The
        // identity AND the label come from the native select: select2's "select2-<id>-container|
        // results" ids, the select.select2-hidden-accessible / chosen select just before the
        // container, or chosen's "<id>_chosen" container id.
        const native = ((): Element | null => {
          const ids = [combo.getAttribute("aria-labelledby"), combo.getAttribute("aria-owns"), combo.getAttribute("aria-controls"), listboxId, combo.getAttribute("id")].filter(Boolean).join(" ");
          const m = /select2-(\S+?)-(container|results)\b/.exec(ids);
          const byId = (id: string): Element | null => { try { return (root as Document).getElementById ? (root as Document).getElementById(id) : root.querySelector(`#${CSS.escape(id)}`); } catch { return null; } };
          if (m) { const s = byId(m[1]); if (s && s.tagName === "SELECT") return s; }
          const cont = combo.closest(".select2-container, .chosen-container");
          if (cont) {
            let p = cont.previousElementSibling;
            while (p && p.tagName !== "SELECT" && /select2-container|chosen-container/.test(String(p.getAttribute("class") || ""))) p = p.previousElementSibling;
            if (p && p.tagName === "SELECT") return p;
            const cid = cont.getAttribute("id") || "";
            if (/_chosen$/.test(cid)) { const s = byId(cid.replace(/_chosen$/, "")); if (s && s.tagName === "SELECT") return s; }
          }
          return null;
        })();
        const owner = native || combo;
        w.__recordStep({ kind: "select", value: optionText, identity: identityOf(owner), ...describe(owner) });
        return;
      }
    }
    // Only actionable elements — plain page clicks are noise, not replayable steps.
    const actionable = el.closest('button,a,[role="button"],[role="link"],input[type="button"],input[type="submit"],input[type="image"],summary');
    if (!actionable) return;
    if ((actionable as HTMLInputElement).type === "file") return; // handled by change
    w.__recordStep({ kind: "click", ...describe(actionable), readOnlyPage: readOnlyPage(), reviewPage: reviewPage() });
  }, true);
  document.addEventListener("change", (e) => {
    const el = target(e) as HTMLInputElement | null;
    if (!el || !(el instanceof Element)) return;
    // Payment-card fields are refused before any kind branches: no step, no value, of any kind.
    if (isPaymentCardField(el)) return;
    const d = describe(el);
    if (el.type === "file") {
      // A hidden/offscreen file input belongs to a custom Browse widget — replay must
      // go through the file-chooser dialog (click + setFiles), not setInputFiles.
      const viaFileChooser = !(el as unknown as HTMLElement).offsetParent && getComputedStyle(el).position !== "fixed";
      w.__recordStep({ kind: "upload", viaFileChooser, ...d });
    }
    else if (el.tagName === "SELECT") {
      // Record the option's LABEL as the value (replay's selectWithFallback matches
      // label first, and labels survive portals whose option values are opaque ids);
      // the raw value rides along for the note/binding.
      const opt = (el as unknown as HTMLSelectElement).selectedOptions[0];
      const optLabel = (opt?.textContent || "").trim();
      w.__recordStep({ kind: "select", value: optLabel || el.value, rawValue: el.value, identity: identityOf(el), ...d });
    }
    else if (el.type === "checkbox" || el.type === "radio") {
      // A radio only ever fires change when it becomes checked; a checkbox the operator
      // UNCHECKS (portals pre-check "same as mailing" etc.) must record an uncheck step,
      // or replay silently leaves the default on every future project.
      if (el.checked) w.__recordStep({ kind: "check", ...d });
      else if (el.type === "checkbox") w.__recordStep({ kind: "uncheck", ...d });
    }
    // The value crosses ONLY the in-page→handler binding. A SECRET field (the shared
    // isSecretField over this identity, decided in Node) is bound to a project field key by
    // NAME and its literal is never persisted.
    else w.__recordStep({ kind: "fill", value: el.value, identity: identityOf(el), ...d });
  }, true);
}

// Run only as the CLI (npm run portal:record). Importing this module — the golden safety test
// does, to drive createRecorderSink and finalizeRecordedSteps — must not open a browser.
const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invokedAs === import.meta.url.toLowerCase()) {
  main().catch((err) => {
    console.error("recordRecipe failed:", err);
    process.exit(1);
  });
}
