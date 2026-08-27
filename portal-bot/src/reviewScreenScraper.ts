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

// Scrape the label/value pairs a review screen shows, from BOTH editable form controls
// AND read-only rendered markup. A true review/confirm page (Accela "Step N: Review",
// PowerClerk's summary) has by definition no fillable inputs — it renders the entered data
// as static text (definition lists, summary tables, label+value rows). Reading only
// input/select/textarea therefore returns nothing on exactly the pages this exists to read,
// which is what made verification come back "almost blank". So we also harvest:
//   • <dl> → each <dt> label paired with the following <dd> value;
//   • two-cell table rows (<tr><th>label</th><td>value</td></tr> or td/td);
//   • editable controls (skip hidden/password/file) — covers form pages and review screens
//     that keep values in disabled/readonly inputs.
// Skips passwords. Caps at 100 fields. Values are redacted (long digit runs masked).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scrapeReviewScreen(page: any): Promise<ReviewField[]> {
  if (!page) return [];
  // Broadened selector keeps using $$eval (so existing fakes/tests still drive it) while
  // letting the in-page extractor branch on the element kind.
  const pairs: Array<{ label: string; value: string }> = await page
    .$$eval("input, select, textarea, dl, tr", (els: Element[]) => {
      const MAX = 100;
      const out: Array<{ label: string; value: string }> = [];
      const seen = new Set<string>();
      const push = (label: string, value: string): void => {
        if (out.length >= MAX) return;
        const v = (value || "").replace(/\s+/g, " ").trim();
        if (!v) return;
        const l = (label || "").replace(/\s+/g, " ").trim();
        const key = (l + "|" + v).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ label: l, value: v });
      };

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

      const cellText = (c: Element): string => (c.textContent || "").trim();

      for (const el of els) {
        if (out.length >= MAX) break;
        const tag = el.tagName.toLowerCase();

        if (tag === "input" || tag === "select" || tag === "textarea") {
          const typeAttr = (el.getAttribute("type") || "").toLowerCase();
          if (tag === "input" && (typeAttr === "hidden" || typeAttr === "password" || typeAttr === "file")) continue;
          let value = "";
          if (tag === "select") {
            const sel = el as HTMLSelectElement;
            const opt = sel.selectedOptions && sel.selectedOptions[0];
            value = opt ? (opt.textContent || "").trim() : sel.value;
          } else if (typeAttr === "checkbox" || typeAttr === "radio") {
            // A checkbox's .value is "on" (the HTML default) whether or not it is CHECKED —
            // scraping it made every unchecked box read as filled, and the LLM verifier
            // flagged phantom "checked but shouldn't be" contradictions (live PGE:
            // "Alternative Billing Contact" blocked recipe promotion on every run).
            // Report the actual state; skip unchecked boxes entirely (no value = no row).
            value = (el as HTMLInputElement).checked ? "checked" : "";
          } else {
            value = (el as HTMLInputElement).value || "";
          }
          push(labelFor(el), value);
          continue;
        }

        if (tag === "dl") {
          const kids = Array.from(el.children);
          for (let i = 0; i < kids.length; i++) {
            if (kids[i].tagName.toLowerCase() !== "dt") continue;
            let j = i + 1;
            while (j < kids.length && kids[j].tagName.toLowerCase() !== "dd") j++;
            if (j < kids.length) push(cellText(kids[i]), cellText(kids[j]));
          }
          continue;
        }

        if (tag === "tr") {
          const cells = Array.from(el.children).filter((c) => {
            const t = c.tagName.toLowerCase();
            return t === "td" || t === "th";
          });
          // Two-cell rows are the canonical "label | value" summary shape. Rows with a
          // different cell count are layout/header rows — skip them to avoid noise.
          if (cells.length === 2) push(cellText(cells[0]), cellText(cells[1]));
          continue;
        }
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
  bodyText = "",
): ReviewMismatch[] {
  const mismatches: ReviewMismatch[] = [];

  // The review page's full rendered text, normalized. Used as a last-resort haystack so a
  // value shown as plain read-only text (not in a structured field we recognized) still
  // counts as present — the page IS showing it, which is what we need to confirm.
  const body = norm(bodyText);

  // Distinguish "the review screen could not be read" from "every field is wrong". With no
  // structured fields AND no rendered text, we truly have nothing to compare — report THAT
  // as one honest signal instead of emitting a phantom mismatch for every checked field
  // (which is what made a readable-but-unscraped page look like a blank application).
  if (reviewFields.length === 0 && body.length < 8) {
    return [{
      field: "reviewScreen",
      expected: "(review fields)",
      found: "(review screen could not be read — verify every field manually before submit)",
    }];
  }

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

  // A needle is present if it appears among the label-scoped structured values OR anywhere
  // in the rendered page text. The structured/scoped match keeps precision when the portal
  // exposes real fields; the body fallback rescues read-only review pages that render values
  // as static text.
  const present = (scope: ReviewField[], needle: string): boolean => {
    const haystack = scope.map((f) => norm(f.value)).join(" ");
    return haystack.includes(needle) || (body.length > 0 && body.includes(needle));
  };

  // Text check: the first meaningful word of the expected value must appear among the
  // label-scoped fields' values (or the page text).
  const checkText = (fieldName: string, expected: unknown, labelKeywords: string[]): void => {
    const e = norm(expected);
    if (!e || e.length < 2) return;
    const firstWord = e.split(" ")[0];
    if (firstWord.length < 3) return; // too short to match reliably
    const scope = scopeFor(labelKeywords);
    if (!present(scope, firstWord)) {
      mismatches.push({ field: fieldName, expected: String(expected ?? "").slice(0, 60), found: summarize(scope) });
    }
  };

  // Digit check: the significant digit run of the expected value must appear among the
  // label-scoped fields' values, or the page text. Compared digits-ONLY on both sides (all
  // non-digits stripped) so "9.89" matches "9.89 kW", "7.5" matches "7.50", and a masked
  // "******0000" matches the last-4 of an account number — none of which line up once a
  // decimal point or space splits the run.
  const bodyDigits = String(bodyText ?? "").replace(/\D/g, "");
  const checkDigits = (fieldName: string, expected: unknown, labelKeywords: string[], opts: { last4?: boolean } = {}): void => {
    const digits = String(expected ?? "").replace(/\D/g, "");
    if (digits.length < (opts.last4 ? 4 : 2)) return;
    const needle = opts.last4 ? digits.slice(-4) : digits;
    const scope = scopeFor(labelKeywords);
    const scopeDigits = scope.map((f) => f.value).join(" ").replace(/\D/g, "");
    if (!scopeDigits.includes(needle) && !(bodyDigits.length > 0 && bodyDigits.includes(needle))) {
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
