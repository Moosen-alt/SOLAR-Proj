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
import readline from "node:readline";
import type { RecipeSelector, RecipeStep, StepFingerprint } from "../../shared/src/types";
import { openPortal } from "./browser";

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
  await page.exposeBinding(
    "__recordStep",
    (_src: unknown, payload: { kind: string; selector: RecipeSelector; value?: string; rawValue?: string; sensitive?: boolean; isFile?: boolean; viaFileChooser?: boolean; isFinalSubmit?: boolean; label?: string; fingerprint?: StepFingerprint }) => {
      const sel = payload.selector;
      // Heal tie-break metadata (attribute names only) — attached to form-control steps.
      const fp = payload.fingerprint ? { fingerprint: payload.fingerprint } : {};
      if (payload.kind === "click") {
        steps.push({ action: "click", selector: sel, note: payload.label });
      } else if (payload.kind === "blockedClick") {
        // A submit/pay-worded control the operator clicked mid-flow. NEVER replayable:
        // no selector, optional, so replay skips it — but the recipe keeps a visible
        // placeholder instead of a silent hole. isFinalSubmit marks submit-like clicks
        // for the operator's approval flow (safety rule 1: only a human-approved flag,
        // never button text, can ever be auto-clicked — and this step has no target).
        steps.push({
          action: "click",
          selector: {},
          optional: true,
          ...(payload.isFinalSubmit ? { isFinalSubmit: true } : {}),
          note: `BLOCKED — human clicked a submit/pay-like control ("${payload.label ?? ""}") here; not replayable. Re-record as a nav step if it was mid-flow navigation.`,
        });
      } else if (payload.kind === "fill" && payload.sensitive) {
        // Credential/secret field — never persist the typed value. The value crosses
        // ONLY this in-memory binding so it can be matched to a project field key
        // (account/meter numbers live in project data); on a match the step binds by
        // NAME and replay substitutes each project's own value. No match → the step
        // is recorded valueless (optional) and skipped at replay.
        const field = bindField(payload.value || "");
        steps.push({ action: "fill", selector: sel, ...fp, field, sensitive: true, optional: true, note: `SENSITIVE — ${field ? `bound to project field "${field}"` : "bind to credential/redacted field"} (no value stored). ${payload.label ?? ""}`.trim() });
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
      process.stdout.write(`  · captured ${payload.kind}${steps[steps.length - 1]?.field ? ` → field ${steps[steps.length - 1].field}` : ""}\n`);
    },
  );

  // Inject the capture listeners into every page/frame.
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

  // Terminal review marker so replay always stops before submit.
  steps.push({ action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." });

  // LLM-assisted binding: for fill/select steps without an exact-match field key, ask the
  // model to identify which project/client field each typed value corresponds to.
  // This is a single call at save-time (not per keystroke), so LLM latency is fine.
  let finalSteps = steps;
  if (projectId) {
    const unboundCount = steps.filter((s) => (s.action === "fill" || s.action === "select") && !s.field && s.value).length;
    if (unboundCount > 0) {
      process.stdout.write(`  · ${unboundCount} unbound step(s) — asking the model to suggest field mappings…\n`);
      try {
        const suggestRes = await fetch(`${api}/api/portal-recipes/${recipe.id}/suggest-bindings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ steps, projectId }),
        });
        if (suggestRes.ok) {
          const body = await suggestRes.json();
          finalSteps = Array.isArray(body.steps) ? body.steps : steps;
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
function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  // Shadow-aware target: the real element through composedPath() (same as humanCapture.ts).
  function target(e: Event): Element | null {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const t = (path && path[0]) || e.target;
    return t instanceof Element ? t : null;
  }
  function describe(el: Element): Record<string, unknown> {
    const role = el.getAttribute("role") || ({ INPUT: "textbox", BUTTON: "button", SELECT: "combobox", A: "link", TEXTAREA: "textbox" } as Record<string, string>)[el.tagName] || "";
    // Shadow-aware: resolve label[for] in the element's OWN root, not the top document.
    const root = el.getRootNode() as Document | ShadowRoot;
    const id = el.getAttribute("id");
    const name =
      el.getAttribute("aria-label") ||
      (id ? (root.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || "").trim() : "") ||
      (el as HTMLInputElement).placeholder ||
      (el.textContent || "").trim().slice(0, 60);
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
    return { selector: sel, label: name, ...(Object.keys(fp).length ? { fingerprint: fp } : {}) };
  }
  // Final-submit / payment intent — NEVER captured as a replayable click (same guard as
  // humanCapture.ts). A recorded bare "Submit" click must never sit in replayable
  // position. Instead of silently dropping it (leaving an invisible hole in the recipe),
  // a targetless optional placeholder is recorded — see the "blockedClick" handler.
  const OFF_LIMITS = /\b(submit|pay|pay fee|pay now|make payment|continue to payment|add to cart|proceed to (payment|checkout)|checkout|file application|confirm submission|complete submission|finalize|place order)\b/i;
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
        w.__recordStep({ kind: "select", value: optionText, ...describe(combo) });
        return;
      }
    }
    // Only actionable elements — plain page clicks are noise, not replayable steps.
    const actionable = el.closest('button,a,[role="button"],[role="link"],input[type="button"],input[type="submit"],summary');
    if (!actionable) return;
    if ((actionable as HTMLInputElement).type === "file") return; // handled by change
    const d = describe(actionable);
    const label = String((d as { label?: unknown }).label || "");
    if (OFF_LIMITS.test(label)) {
      // Record a targetless placeholder instead of losing the step: submit-like labels
      // are flagged isFinalSubmit for the approval flow (safety rule 1 — a human, not
      // button text, decides what may ever be clicked; this step has no selector).
      const isFinalSubmit = /\b(submit|confirm submission|complete submission|file application|finalize)\b/i.test(label);
      w.__recordStep({ kind: "blockedClick", selector: {}, label, isFinalSubmit });
      return;
    }
    w.__recordStep({ kind: "click", ...d });
  }, true);
  // A field whose value must never be persisted as a plaintext recipe value:
  // passwords, and anything whose name/id/autocomplete/placeholder looks like a
  // credential or portal secret (account/meter/SSN/card). The recipe still records
  // the fill STEP (so replay knows to type here) but stores no literal value — the
  // operator binds it to the encrypted credential store / redacted project data.
  function isSensitiveField(el: HTMLInputElement): boolean {
    if (el.type === "password") return true;
    const hay = [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.placeholder,
      el.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").toLowerCase();
    return /password|passcode|account\s*(no|num|#)|account number|acct|meter|ssn|social security|card\s*number|cvv|security code|mfa|otp|one.time/.test(hay);
  }
  document.addEventListener("change", (e) => {
    const el = target(e) as HTMLInputElement | null;
    if (!el || !(el instanceof Element)) return;
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
      w.__recordStep({ kind: "select", value: optLabel || el.value, rawValue: el.value, ...d });
    }
    else if (el.type === "checkbox" || el.type === "radio") {
      // A radio only ever fires change when it becomes checked; a checkbox the operator
      // UNCHECKS (portals pre-check "same as mailing" etc.) must record an uncheck step,
      // or replay silently leaves the default on every future project.
      if (el.checked) w.__recordStep({ kind: "check", ...d });
      else if (el.type === "checkbox") w.__recordStep({ kind: "uncheck", ...d });
    }
    // Sensitive: the value crosses ONLY the in-page→handler binding so it can be
    // bound to a project field key by NAME; the handler strips it before persisting.
    else if (isSensitiveField(el)) w.__recordStep({ kind: "fill", sensitive: true, value: el.value, ...d });
    else w.__recordStep({ kind: "fill", value: el.value, ...d });
  }, true);
}

main().catch((err) => {
  console.error("recordRecipe failed:", err);
  process.exit(1);
});
