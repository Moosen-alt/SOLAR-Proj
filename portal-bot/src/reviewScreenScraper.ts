// Shared review-screen scraper for hand-coded and auto-learn portal adapters.
// Reads all visible field/value pairs from the portal's review page so callers
// can compare what the portal shows against the project record before submit.
// Values are redacted (long digit runs masked) — never returns raw PII.

import { redactStatusText } from "./safeAction";
import type { ProjectRecord } from "../../shared/src/types";

export interface ReviewField {
  label: string;
  value: string;
}

export interface ReviewMismatch {
  field: string;
  expected: string;
  found: string;
}

// Scrape all visible input/select/textarea values from the current page.
// Skips hidden, password, and file inputs. Caps at 100 fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scrapeReviewScreen(page: any): Promise<ReviewField[]> {
  if (!page) return [];
  const pairs: Array<{ label: string; value: string }> = await page
    .$$eval("input, select, textarea", (els: Element[]) => {
      function labelFor(el: Element): string {
        const id = el.getAttribute("id");
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl && lbl.textContent) return lbl.textContent.trim();
        }
        const parentLabel = el.closest("label");
        if (parentLabel && parentLabel.textContent) {
          const t = parentLabel.textContent.trim();
          if (t) return t;
        }
        return (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          ""
        ).trim();
      }
      const out: Array<{ label: string; value: string }> = [];
      for (const el of els) {
        if (out.length >= 100) break;
        const tag = el.tagName.toLowerCase();
        const typeAttr = (el.getAttribute("type") || "").toLowerCase();
        if (tag === "input" && (typeAttr === "hidden" || typeAttr === "password" || typeAttr === "file")) continue;
        let value = "";
        if (tag === "select") {
          const sel = el as HTMLSelectElement;
          const opt = sel.selectedOptions && sel.selectedOptions[0];
          value = opt ? (opt.textContent || "").trim() : sel.value;
        } else {
          value = (el as HTMLInputElement).value || "";
        }
        if (!value) continue;
        const label = labelFor(el);
        out.push({ label, value });
      }
      return out;
    })
    .catch(() => [] as Array<{ label: string; value: string }>);

  return pairs
    .slice(0, 100)
    .map((p) => ({ label: p.label, value: redactStatusText(p.value) ?? "" }))
    .filter((p) => p.value);
}

// Normalize a value for comparison: lowercase, remove non-alphanumeric, collapse whitespace.
function norm(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

// Compare the review-screen fields the portal shows against the project's canonical values.
// Only checks fields we know the portal definitely renders (homeowner, address, account,
// meter, system size). Each check is SCOPED to the review fields whose label matches that
// field's keywords — so an expected value appearing in some unrelated field (e.g. a street
// name that also occurs in an installer field) cannot mask a real mismatch. When no field
// label matches, it falls back to the whole page so a totally-absent value is still caught.
export function compareReviewFields(
  reviewFields: ReviewField[],
  project: ProjectRecord,
): ReviewMismatch[] {
  const mismatches: ReviewMismatch[] = [];

  // Pick the review fields whose (normalized) label contains one of the keywords. Falls
  // back to all fields when nothing matches, so absence is still detectable.
  const scopeFor = (labelKeywords: string[]): ReviewField[] => {
    const scoped = reviewFields.filter((f) => {
      const nl = norm(f.label);
      return labelKeywords.some((k) => nl.includes(k));
    });
    return scoped.length > 0 ? scoped : reviewFields;
  };
  const summarize = (fields: ReviewField[]): string =>
    fields.length > 0 ? fields.map((f) => f.value).join("; ").slice(0, 80) : "(not found on review page)";

  // Text check: the first meaningful word of the expected value must appear among the
  // label-scoped fields' values.
  const checkText = (fieldName: string, expected: unknown, labelKeywords: string[]): void => {
    const e = norm(expected);
    if (!e || e.length < 2) return;
    const firstWord = e.split(" ")[0];
    if (firstWord.length < 3) return; // too short to match reliably
    const scope = scopeFor(labelKeywords);
    const haystack = scope.map((f) => norm(f.value)).join(" ");
    if (!haystack.includes(firstWord)) {
      mismatches.push({ field: fieldName, expected: String(expected ?? "").slice(0, 60), found: summarize(scope) });
    }
  };

  // Digit check: the significant digit run of the expected value must appear among the
  // label-scoped fields' values (handles "7.5 kW" vs "7.50", masked account numbers, etc.).
  const checkDigits = (fieldName: string, expected: unknown, labelKeywords: string[], opts: { last4?: boolean } = {}): void => {
    const digits = String(expected ?? "").replace(/\D/g, "");
    if (digits.length < (opts.last4 ? 4 : 2)) return;
    const needle = opts.last4 ? digits.slice(-4) : digits;
    const scope = scopeFor(labelKeywords);
    const haystack = scope.map((f) => norm(f.value)).join(" ");
    if (!haystack.includes(needle)) {
      mismatches.push({
        field: fieldName,
        expected: opts.last4 ? `…${needle}` : String(expected ?? "").slice(0, 60),
        found: opts.last4 ? "(digits not found on review page)" : summarize(scope),
      });
    }
  };

  checkText("homeownerName", project.homeownerName, ["name", "owner", "applicant", "customer", "contact"]);
  checkText("projectAddress", (project.projectAddress ?? "").split(",")[0], ["address", "street", "site", "location", "premise", "service"]);
  checkDigits("systemSizeDcKw", project.systemSizeDcKw, ["size", "kw", "kva", "dc", "capacity", "nameplate", "rating", "system"]);
  checkDigits("accountNumber", project.accountNumber, ["account"], { last4: true });
  checkDigits("meterNumber", project.meterNumber, ["meter"], { last4: true });

  return mismatches;
}
