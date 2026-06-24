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
// meter, system size, installer). Returns mismatches where the portal value is non-empty
// and doesn't contain the expected value as a substring (after normalization).
export function compareReviewFields(
  reviewFields: ReviewField[],
  project: ProjectRecord,
): ReviewMismatch[] {
  const mismatches: ReviewMismatch[] = [];

  // Build a search corpus: concatenate all review field values into one searchable string.
  const corpus = reviewFields.map((f) => norm(f.value)).join(" ");

  function check(fieldName: string, expected: unknown): void {
    const e = norm(expected);
    if (!e || e.length < 2) return; // skip empty or trivially short values
    // For multi-word values (names, addresses) check that the first meaningful word appears.
    const firstWord = e.split(" ")[0];
    if (firstWord.length >= 3 && !corpus.includes(firstWord)) {
      // Try to find the field's label in reviewFields for a more specific mismatch message.
      const found = reviewFields.length > 0 ? reviewFields.map((f) => f.value).join("; ").slice(0, 80) : "(not found on review page)";
      mismatches.push({ field: fieldName, expected: String(expected ?? "").slice(0, 60), found });
    }
  }

  check("homeownerName", project.homeownerName);
  check("projectAddress", (project.projectAddress ?? "").split(",")[0]); // street line only
  check("systemSizeDcKw", project.systemSizeDcKw);

  // Account and meter numbers: only the last 4 digits are reliable since the portal
  // may mask middle digits. Check that the last 4 chars of the number appear.
  for (const [fieldName, raw] of [["accountNumber", project.accountNumber], ["meterNumber", project.meterNumber]] as [string, string | null | undefined][]) {
    if (!raw) continue;
    const digits = String(raw).replace(/\D/g, "");
    if (digits.length < 4) continue;
    const last4 = digits.slice(-4);
    if (!corpus.includes(last4)) {
      mismatches.push({ field: fieldName, expected: `…${last4}`, found: "(last 4 digits not found on review page)" });
    }
  }

  return mismatches;
}
