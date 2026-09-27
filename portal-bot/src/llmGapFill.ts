import {
  EXTRACT_SEL,
  extractFieldsInPage,
  toExtractedField,
  isPayFee,
  isSensitiveLabel,
  type ExtractedField,
  type RawField,
  type LearnPlanner,
  type LearnPlanRequest,
} from "./adapters/autoLearnAdapter";
import { buildLocator } from "./adapters/loginFlow";
import { selectWithFallback } from "./comboboxFill";
import { redactStatusText } from "./safeAction";

// ---------------------------------------------------------------------------
// LLM-assisted gap-fill (hybrid staging).
//
// The hand-coded adapters fill the fields they were taught by fixed selectors, but a
// portal evolves and adds fields, so they silently skip whatever their selectors don't
// match (Estimated Commissioning Date, Smart Inverter Settings, Single Phase Voltage, …).
// After the hand-coded fills on each page, this runs the SAME LLM planner the auto-learn
// engine uses to fill ANY required field still empty — making staging universal without
// throwing away the adapter's known-good critical-field bindings.
//
// PROPER DATA, NOT GUESSING (hard guardrail): a planned fill is applied ONLY when it is
// grounded in real data —
//   • a select/radio/checkbox value that matches one of the field's OWN portal options
//     (the portal offered it; it can't be fabricated), or
//   • a fill the planner bound to a real project-field key that resolves to a value, or
//   • free text that traces back to an actual project-record value.
// Anything else is dropped and reported, so a field with no backing data is left BLANK for
// the human rather than filled with an invented value. Secrets (account/meter/SSN/password)
// are never touched here — those are bound deterministically by the adapter.
// ---------------------------------------------------------------------------

export interface GapFillOutcome {
  /** Field labels the LLM filled this page (non-PII labels only). */
  filled: string[];
  /** Planned fills rejected because they weren't grounded in real project data. */
  skippedUngrounded: string[];
  /** Required, empty fields the PROJECT GENUINELY LACKS — surfaced so the human can act. */
  reportedMissing: string[];
  /** Required fields left empty even though the project HOLDS a value for them. That is an
   *  engine defect (the planner never proposed it, or the fill did not stick), not the
   *  operator's data problem — kept separate so nobody is sent to re-type data already on
   *  file, which is what the single undifferentiated list was causing. */
  unfilledDespiteData: string[];
}

function emptyOutcome(): GapFillOutcome {
  return { filled: [], skippedUngrounded: [], reportedMissing: [], unfilledDespiteData: [] };
}

function normalize(v: string): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// DOES THIS ANSWER ACTUALLY COME FROM THAT PROJECT VALUE?
//
// The planner naming a project field was being treated as proof the planner's ANSWER was
// that field's value. It is not: an outside review demonstrated `999` accepted against a
// systemSizeKw of `8`, because the only test was that systemSizeKw held something non-empty.
//
// So the binding has to be checked, not trusted — while still allowing the REFORMATTINGS the
// old fall-through existed for: a date written the portal's way, an account number with its
// dashes stripped (Ameren wants 16-0001 as 160001), a size the portal wants in watts when the
// project records kilowatts. Anything that is not a recognisable rendering of the project's
// own value is a guess, and a guess on a live application is the failure this whole helper
// was written to prevent.
function tracesTo(value: string, projectValue: string): boolean {
  const nv = normalize(value);
  const npv = normalize(projectValue);
  if (!nv || !npv) return false;
  // Same text, or one is a fuller rendering of the other ("roof" -> "Roof Mounted",
  // "No" -> "No, I do not have storage").
  if (nv === npv || nv.includes(npv) || npv.includes(nv)) return true;
  // Same digits, different punctuation: 16-0001 -> 160001, (555) 123-4567 -> 5551234567.
  const dv = value.replace(/\D/g, "");
  const dpv = projectValue.replace(/\D/g, "");
  if (dv.length >= 4 && dv === dpv) return true;
  // Same quantity, different unit scale: 8 kW recorded, 8000 W wanted (or the reverse).
  const numV = Number(String(value).replace(/[^0-9.]/g, ""));
  const numP = Number(String(projectValue).replace(/[^0-9.]/g, ""));
  if (Number.isFinite(numV) && Number.isFinite(numP) && numV > 0 && numP > 0) {
    for (const factor of [1, 1000, 0.001, 100, 0.01]) {
      if (Math.abs(numV - numP * factor) < Math.max(numP * factor, numV) * 0.005) return true;
    }
  }
  // Same day, written differently: 2026-09-10 -> 09/10/2026.
  const dateV = new Date(value);
  const dateP = new Date(projectValue);
  if (!Number.isNaN(dateV.getTime()) && !Number.isNaN(dateP.getTime())
    && dateV.toISOString().slice(0, 10) === dateP.toISOString().slice(0, 10)) return true;
  return false;
}

// Is `value` grounded in real data for this field — i.e. NOT a guess? Exported for tests.
export function isGrounded(
  field: ExtractedField,
  value: string,
  mappedKey: string | undefined,
  projectFields: Record<string, string>,
): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;

  // Checkbox/radio: the planner is choosing WHICH portal-provided control to toggle, so a
  // boolean-ish value is grounded by the control's own existence on the page — UNLESS it
  // named a project field, in which case the project's answer decides. "Yes" against a
  // hasBattery of "No" declares storage the customer does not own.
  if (field.fieldType === "checkbox" || field.fieldType === "radio") {
    if (!/^(true|false|yes|no|on|off|1|0)$/i.test(v)) return false;
    const bound = mappedKey ? projectFields[mappedKey] : "";
    if (bound) return tracesTo(v, bound) || boolAgrees(v, bound);
    return true;
  }

  // Select: the value must be one of the field's OWN options (the portal's fixed list) — and
  // option membership proves the answer is ALLOWED by the form, never that it is TRUE for
  // this project. When the planner named a project field, that field decides.
  if (field.fieldType === "select") {
    const opts = (field.options ?? []).map(normalize).filter(Boolean);
    const bound = mappedKey ? projectFields[mappedKey] : "";
    if (opts.length > 0) {
      const nv = normalize(v);
      const offered = opts.some((o) => o === nv || o.includes(nv) || nv.includes(o));
      if (!offered) return false;
      return bound ? (tracesTo(v, bound) || boolAgrees(v, bound)) : true;
    }
    // Custom combobox with no captured options → require a real project-field binding, and
    // require the answer to actually be that field's value.
    return Boolean(bound) && tracesTo(v, bound);
  }

  // Free text/other: a planner binding is a CLAIM about where the answer came from — check it.
  if (mappedKey && projectFields[mappedKey]) return tracesTo(v, projectFields[mappedKey]);
  const nv = normalize(v);
  if (nv.length < 2) return false;
  for (const pv of Object.values(projectFields)) {
    const npv = normalize(pv);
    if (npv.length >= 2 && (npv.includes(nv) || nv.includes(npv))) return true;
  }
  return false;
}

// DOES THE PROJECT ALREADY HOLD A VALUE FOR THIS PORTAL FIELD? Exported for tests.
//
// WHICH WAY THIS FAILS MATTERS MORE THAN HOW OFTEN. Answering "yes" when the project does
// NOT have the data suppresses the add-data prompt, and the operator never learns a required
// field is empty — worse than the false alarm the two-list split was written to fix. A bare
// substring test fails exactly that way: the portal label "Account Holder Name" contains the
// project key "account", so a genuinely missing name would be waved through as the engine's
// problem and silently dropped.
//
// So matching is by whole TOKEN and EVERY word of the key must appear in the label:
// accountNumber matches "Account Number", not "Account Holder Name". When in doubt this
// returns false, which routes the field to reportedMissing — the prompt a person can act on.
export function projectHasValueForLabel(label: string, projectFields: Record<string, string>): boolean {
  const tokens = (value: string): string[] =>
    value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const labelTokens = new Set(tokens(label));
  if (!labelTokens.size) return false;
  return Object.entries(projectFields).some(([key, value]) => {
    if (value == null || String(value).trim() === "") return false;
    // camelCase keys carry their own word boundaries: accountNumber -> account, number.
    const keyTokens = tokens(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
    if (!keyTokens.length) return false;
    return keyTokens.every((t) => labelTokens.has(t));
  });
}

/** "Yes"/"true"/"1" and "No"/"false"/"0" agreeing across spellings. */
function boolAgrees(a: string, b: string): boolean {
  const truth = (s: string): boolean | null => {
    const t = s.trim().toLowerCase();
    if (/^(true|yes|on|1|y)$/.test(t)) return true;
    if (/^(false|no|off|0|n|none)$/.test(t)) return false;
    return null;
  };
  const ta = truth(a); const tb = truth(b);
  return ta !== null && tb !== null && ta === tb;
}

// Best-effort: neutralize the transparent loading scrims / onboarding popovers that
// intercept clicks so the gap-fill's fills actually land. Portal-agnostic — covers
// PowerClerk's Vue scrim + "new feature" popover and Accela's ExtJS .x-mask. Never throws.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function neutralizeOverlays(page: any): Promise<void> {
  if (!page || typeof page.evaluate !== "function") return;
  try {
    await page.evaluate(() => {
      const sel = [
        "div.position-absolute.opacity-50.bg-black",
        ".modal-backdrop",
        ".popover.new-feature-popper",
        ".new-feature-popper",
        "[class*='loading-overlay']",
        "[class*='spinner-overlay']",
        ".x-mask",
        ".x-mask-loading",
        "#divGlobalCover",
        "[id*='loadingMask']",
        "[id*='LoadingMask']",
        ".blockUI",
        ".ui-widget-overlay",
      ].join(", ");
      document.querySelectorAll(sel).forEach((el) => el.remove());
      if (!document.getElementById("__gapfill_scrim_bypass")) {
        const style = document.createElement("style");
        style.id = "__gapfill_scrim_bypass";
        style.textContent = sel + " { pointer-events: none !important; }";
        document.head.appendChild(style);
      }
    });
  } catch { /* mock page or no DOM — non-fatal */ }
}

/** How long ONE candidate's value read may take. A control that is on the page answers at once. */
const GAP_READ_TIMEOUT_MS = 1500;

/** Is this candidate an EMPTY control the gap-fill could fill? null = the recorded selector finds
 *  nothing on the page (or the read fails) — not a candidate at all: nothing can be typed into a
 *  control that is not there.
 *
 *  A WAIT FOR A CONTROL THAT NEVER APPEARS IS NOT A READ (runs-finish item 5). This called
 *  inputValue() / isChecked() with Playwright's DEFAULT timeout (30 s — production sets none), so
 *  every candidate whose selector resolves to nothing — a radio / checkbox the extractor names by
 *  its neighbouring text, which getByLabel can never find — waited the whole 30 s. Live run
 *  191e45c8: "save new contact" spent 60,063 ms in gap-fill (two such controls) and filled nothing.
 *  Now: count() first (immediate), then a bounded read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isFieldEmpty(loc: any, fieldType: ExtractedField["fieldType"]): Promise<boolean | null> {
  try {
    if (typeof loc.count === "function" && (await loc.count().catch(() => 0)) === 0) return null;
    if (fieldType === "checkbox" || fieldType === "radio") {
      const checked = await loc.isChecked({ timeout: GAP_READ_TIMEOUT_MS }).catch(() => null);
      return checked === null ? null : !checked;
    }
    const v = await loc.inputValue({ timeout: GAP_READ_TIMEOUT_MS }).catch(() => null);
    return v === null ? null : !String(v ?? "").trim();
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyGrounded(page: any, loc: any, field: ExtractedField, value: string): Promise<boolean> {
  try {
    if (field.fieldType === "select") {
      await selectWithFallback(page, loc, value);
    } else if (field.fieldType === "checkbox" || field.fieldType === "radio") {
      const on = /^(true|yes|on|1)$/i.test(value);
      if (on) await loc.check({ timeout: 6000 });
      else if (typeof loc.uncheck === "function") await loc.uncheck({ timeout: 6000 }).catch(() => {});
    } else {
      await loc.fill(value, { timeout: 6000 });
      // Blur to COMMIT the value into the portal's JS model (PowerClerk's Vue autosaves on blur).
      if (typeof loc.blur === "function") await loc.blur().catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

// Fill the gaps on the CURRENT page: extract every fillable control, ask the planner what to
// put in the still-empty ones, and apply ONLY the grounded fills. Never clicks Next/submit
// and never touches sensitive/file/pay controls — purely a same-page fill pass. Best-effort:
// any failure returns what was filled so far and never throws (staging must not crash here).
export async function gapFillCurrentPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  planner: LearnPlanner,
  projectFields: Record<string, string>,
  alreadyFilled: string[] = [],
): Promise<GapFillOutcome> {
  const out = emptyOutcome();
  if (!page || typeof page.$$eval !== "function") return out;
  try {
    await neutralizeOverlays(page);
    const raws: RawField[] = await page.$$eval(EXTRACT_SEL, extractFieldsInPage).catch(() => [] as RawField[]);
    const candidates = raws
      .map(toExtractedField)
      .filter((f) =>
        f.fieldType !== "button" &&
        f.fieldType !== "file" &&
        !isSensitiveLabel(f.label) &&
        !isPayFee(f.label));
    if (candidates.length === 0) return out;
    // NOTHING REQUIRED ON THE PAGE, NOTHING TO DO. The LLM call below is spent only on a REQUIRED
    // empty control, so a page with no required control at all is answered here — before a single
    // value is read.
    if (!candidates.some((f) => f.required)) return out;

    // Keep only the still-empty controls (don't overwrite the adapter's deterministic fills).
    const empties: Array<{ field: ExtractedField; loc: unknown }> = [];
    for (const field of candidates) {
      const loc = buildLocator(page, field.selector);
      if (!loc) continue;
      if ((await isFieldEmpty(loc, field.fieldType)) === true) empties.push({ field, loc });
    }
    if (empties.length === 0) return out;
    // Only spend an LLM call when a REQUIRED field is still empty. Portal pages always
    // carry empty optionals (address line 2, alt-billing email, ...), so gating on "any
    // empty field" invoked the full planner on EVERY page of a recipe replay - making
    // replay nearly as slow (and as expensive) as the original learn. When a required
    // gap does exist, the optionals ride along in the same request.
    if (!empties.some((e) => e.field.required)) return out;

    const url = typeof page.url === "function" ? String(page.url() ?? "") : "";
    const pageTitle = typeof page.title === "function" ? String((await page.title().catch(() => "")) ?? "") : "";
    const rawBody = await page.locator("body").innerText().catch(() => "");
    const bodyText = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);

    const req: LearnPlanRequest = {
      url,
      pageTitle,
      fields: empties.map((e) => e.field),
      bodyText,
      alreadyFilledLabels: alreadyFilled,
      isDashboard: false,
    };

    let plan;
    try {
      plan = await planner(req);
    } catch {
      return out; // planner/LLM unavailable — leave the page as the adapter left it.
    }

    for (const fill of plan.fills ?? []) {
      const slot = empties[fill.selectorIndex];
      if (!slot) continue;
      const { field, loc } = slot;
      if (isPayFee(field.label) || isSensitiveLabel(field.label)) continue;
      if (!isGrounded(field, fill.value, fill.field, projectFields)) {
        out.skippedUngrounded.push(field.label || field.fieldType);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const applied = await applyGrounded(page, loc as any, field, fill.value);
      if (applied) out.filled.push(field.label || field.fieldType);
    }

    // A REQUIRED FIELD LEFT EMPTY IS NOT PROOF THE PROJECT LACKS THE DATA.
    //
    // This swept every still-empty required field into reportedMissing with no test for
    // whether the project actually holds a value, and autopilot then told the operator
    // those fields "had no project data — add them to the project and re-stage". So an
    // operator was sent to type in data the project already carried, for a field the
    // planner simply did not propose or whose fill did not stick. Measured 2026-09-22 at
    // ~80 false interruptions per 100 projects — the third-largest avoidable cost in the
    // product, and the only one that sends someone to do work that is already done.
    //
    // Three outcomes now, and they are different facts:
    //   · genuinely absent from the project  → reportedMissing (the operator CAN fix it)
    //   · the project HAS a value            → unfilledDespiteData (the ENGINE's problem;
    //                                          never ask a person to re-enter it)
    //   · a value was proposed but refused as ungrounded → skippedUngrounded, as before.
    // WHICH WAY THIS HEURISTIC FAILS MATTERS MORE THAN HOW OFTEN.
    //
    // Saying "the project has this" when it does not SUPPRESSES the add-data prompt, and the
    // operator never learns a required field is empty — worse than the false alarm this
    // whole change set out to fix. A bare substring test fails exactly that way: the portal
    // label "Account Holder Name" contains the project key "account", so a genuinely missing
    // name would be waved through as the engine's problem.
    //
    // So the match is by whole TOKEN, not substring, and a one- or two-token key must be a
    // token of the label rather than merely appear inside one of its words. When in doubt
    // this returns false, which routes the field to reportedMissing — the prompt an operator
    // can act on.
    const projectHasValueFor = (field: { label?: string; fieldType?: string }): boolean =>
      projectHasValueForLabel(`${field.label || ""} ${field.fieldType || ""}`, projectFields);
    for (const { field } of empties) {
      if (!field.required) continue;
      const lbl = field.label || field.fieldType;
      if (out.filled.includes(lbl)) continue;
      if (projectHasValueFor(field)) {
        if (!out.unfilledDespiteData.includes(lbl)) out.unfilledDespiteData.push(lbl);
        continue;
      }
      if (!out.reportedMissing.includes(lbl)) out.reportedMissing.push(lbl);
    }
    return out;
  } catch {
    return out;
  }
}
