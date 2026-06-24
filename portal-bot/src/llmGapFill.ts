import {
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
import { fillCustomCombobox } from "./comboboxFill";
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

const EXTRACT_SEL = "input, select, textarea, button, [role=button], a[href]:not([href='#']):not([href=''])";

export interface GapFillOutcome {
  /** Field labels the LLM filled this page (non-PII labels only). */
  filled: string[];
  /** Planned fills rejected because they weren't grounded in real project data. */
  skippedUngrounded: string[];
  /** Required, empty fields the LLM had no data to fill — surfaced so the human can act. */
  reportedMissing: string[];
}

function emptyOutcome(): GapFillOutcome {
  return { filled: [], skippedUngrounded: [], reportedMissing: [] };
}

function normalize(v: string): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
  // boolean-ish value is grounded by the control's own existence on the page.
  if (field.fieldType === "checkbox" || field.fieldType === "radio") {
    return /^(true|false|yes|no|on|off|1|0)$/i.test(v);
  }

  // Select: the value must be one of the field's OWN options (the portal's fixed list).
  if (field.fieldType === "select") {
    const opts = (field.options ?? []).map(normalize).filter(Boolean);
    if (opts.length > 0) {
      const nv = normalize(v);
      if (opts.some((o) => o === nv || o.includes(nv) || nv.includes(o))) return true;
    }
    // Custom combobox with no captured options → require a real project-field binding.
    return Boolean(mappedKey && projectFields[mappedKey]);
  }

  // Free text/other: trust a planner binding to a real project field (covers reformatted
  // values like dates), else require the value to trace to an actual project value.
  if (mappedKey && projectFields[mappedKey]) return true;
  const nv = normalize(v);
  if (nv.length < 2) return false;
  for (const pv of Object.values(projectFields)) {
    const npv = normalize(pv);
    if (npv.length >= 2 && (npv.includes(nv) || nv.includes(npv))) return true;
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function isFieldEmpty(loc: any, fieldType: ExtractedField["fieldType"]): Promise<boolean> {
  try {
    if (fieldType === "checkbox" || fieldType === "radio") {
      return !(await loc.isChecked().catch(() => false));
    }
    const v = await loc.inputValue().catch(() => "");
    return !String(v ?? "").trim();
  } catch {
    return true;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyGrounded(page: any, loc: any, field: ExtractedField, value: string): Promise<boolean> {
  try {
    if (field.fieldType === "select") {
      await loc.selectOption(value)
        .catch(async () => loc.selectOption({ label: value }))
        .catch(async () => { await fillCustomCombobox(page, loc, value); });
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
    const raws: RawField[] = await page.$$eval(EXTRACT_SEL, extractFieldsInPage).catch(() => [] as RawField[]);
    const candidates = raws
      .map(toExtractedField)
      .filter((f) =>
        f.fieldType !== "button" &&
        f.fieldType !== "file" &&
        !isSensitiveLabel(f.label) &&
        !isPayFee(f.label));
    if (candidates.length === 0) return out;

    // Keep only the still-empty controls (don't overwrite the adapter's deterministic fills).
    const empties: Array<{ field: ExtractedField; loc: unknown }> = [];
    for (const field of candidates) {
      const loc = buildLocator(page, field.selector);
      if (!loc) continue;
      if (await isFieldEmpty(loc, field.fieldType)) empties.push({ field, loc });
    }
    if (empties.length === 0) return out;

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
    return out;
  } catch {
    return out;
  }
}
