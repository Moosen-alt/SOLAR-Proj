// Shared review-screen scraper for hand-coded and auto-learn portal adapters.
// Reads all visible field/value pairs from the portal's review page so callers
// can compare what the portal shows against the project record before submit.
// Values are redacted (long digit runs masked) — never returns raw PII.

import { redactStatusText } from "./safeAction";
import { readReviewScreenFees, type PortalFeeReadResult } from "../../shared/src/portalFeeItems";
import type { ProjectRecord } from "../../shared/src/types";

export interface ReviewField {
  label: string;
  value: string;
  /** True when this pair came from a control a person could still type into. The scraper's
   *  own premise, made available to callers: a true review page has by definition no
   *  fillable inputs — it renders what was entered as static text, or holds it in readonly
   *  or disabled controls. A page whose every pair is EDITABLE is a form, not a summary. */
  editable?: boolean;
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
  const pairs: Array<{ label: string; value: string; editable?: boolean }> = await page
    .$$eval("input, select, textarea, dl, tr", (els: Element[]) => {
      const MAX = 100;
      const out: Array<{ label: string; value: string; editable: boolean }> = [];
      const seen = new Set<string>();
      const push = (label: string, value: string, editable = false): void => {
        if (out.length >= MAX) return;
        const v = (value || "").replace(/\s+/g, " ").trim();
        if (!v) return;
        const l = (label || "").replace(/\s+/g, " ").trim();
        const key = (l + "|" + v).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ label: l, value: v, editable });
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
          // Readonly/disabled controls are how a review page holds its values; an ordinary
          // enabled control is a form field somebody is still expected to fill.
          const ro = el.hasAttribute("readonly") || el.hasAttribute("disabled")
            || (el as HTMLInputElement).readOnly === true || (el as HTMLInputElement).disabled === true;
          push(labelFor(el), value, !ro);
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
    .catch(() => [] as Array<{ label: string; value: string; editable?: boolean }>);

  return pairs
    .slice(0, 100)
    .map((p) => ({ label: p.label, value: redactStatusText(p.value) ?? "", editable: p.editable === true }))
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
/** What a review-screen comparison actually established — not just what it complained about. */
export interface ReviewComparison {
  mismatches: ReviewMismatch[];
  /** Checks that had enough project data to run at all. */
  compared: number;
  /** Checks that ran AND found their value on the page. The only real evidence here. */
  confirmed: number;
}

/**
 * Compare a review screen against the project, and SAY HOW MUCH IT CONFIRMED.
 *
 * The mismatch list alone cannot carry that. Every check below returns early when the
 * project has no value to check — no account number, a name too short to match — so a page
 * showing four lines of boilerplate against a sparse project produces zero mismatches while
 * establishing precisely nothing. Read as "no mismatches, therefore verified", that is the
 * same error this whole ladder exists to refuse, arrived at from the other side: not "we
 * could not read the page" but "we read it and never checked anything".
 *
 * A live run made this concrete — reviewFieldsSeen: 4, zero mismatches — and one fixture fix
 * away it would have claimed the top rung on four fields of boilerplate.
 */
/**
 * WHICH UTILITY IDENTIFIERS THIS FILING TYPED (dryrun-0928 B8). The account / meter checks ran on
 * every filing whatever it was, so every Accela PERMIT review said "VERIFY BEFORE SUBMITTING —
 * meterNumber" (a permit application has no meter field), and the account's last four were
 * "confirmed" from digits Accela rendered itself. The review page is checked for an identifier
 * only when THIS filing entered it — so it is a REQUIRED argument, never an optional trailing one:
 * a default of "check" keeps the bug, a default of "skip" silently drops the NEM check.
 */
export interface UtilityIdentifiersEntered {
  accountNumber: boolean;
  meterNumber: boolean;
}

/** What a recipe's own steps typed: an identifier is "entered" when a step is bound to its key. */
export function utilityIdentifiersEnteredBySteps(steps: Array<{ field?: string | null }> | null | undefined): UtilityIdentifiersEntered {
  const bound = (key: string) => (steps ?? []).some((s) => String(s?.field ?? "") === key);
  return { accountNumber: bound("accountNumber"), meterNumber: bound("meterNumber") };
}

export function reviewComparison(
  reviewFields: ReviewField[],
  project: ProjectRecord,
  entered: UtilityIdentifiersEntered,
  bodyText = "",
): ReviewComparison {
  const mismatches: ReviewMismatch[] = [];
  let compared = 0;
  let confirmed = 0;

  // The review page's full rendered text, normalized. Used as a last-resort haystack so a
  // value shown as plain read-only text (not in a structured field we recognized) still
  // counts as present — the page IS showing it, which is what we need to confirm.
  const body = norm(bodyText);

  // Distinguish "the review screen could not be read" from "every field is wrong". With no
  // structured fields AND no rendered text, we truly have nothing to compare — report THAT
  // as one honest signal instead of emitting a phantom mismatch for every checked field
  // (which is what made a readable-but-unscraped page look like a blank application).
  if (reviewFields.length === 0 && body.length < 8) {
    return {
      mismatches: [{
        field: "reviewScreen",
        expected: "(review fields)",
        found: "(review screen could not be read — verify every field manually before submit)",
      }],
      compared: 0,
      confirmed: 0,
    };
  }

  // Pick the review fields whose (normalized) label contains one of the keywords. Falls
  // back to all fields when nothing matches, so absence is still detectable — but the
  // caller must know WHICH it got, because the two mean opposite things to a human.
  const scopeFor = (labelKeywords: string[]): { fields: ReviewField[]; labelled: boolean } => {
    const scoped = reviewFields.filter((f) => {
      const nl = norm(f.label);
      return labelKeywords.some((k) => nl.includes(k));
    });
    return scoped.length > 0 ? { fields: scoped, labelled: true } : { fields: reviewFields, labelled: false };
  };

  // "ABSENT FROM THE REVIEW PAGE" IS NOT "THE REVIEW PAGE DISAGREES".
  //
  // When no review field carries a matching label, the scope falls back to EVERY field, and
  // summarizing that produced a `found` string made of unrelated values run together. A live
  // PacifiCorp cross-project run reported `homeownerName shows "No; checked"` and
  // `projectAddress shows "checked; No Aggregation; No; c"` — neither is a name or an
  // address; the review page simply had no such field. The verdict then said "DO NOT SUBMIT
  // without checking", which would send an operator hunting for a wrong name that was never
  // rendered. Same failure family as this repo's "one warning channel carrying four
  // meanings": the finding was real (we could not confirm the value) and its DESCRIPTION was
  // fiction.
  const summarize = (scope: { fields: ReviewField[]; labelled: boolean }): string => {
    if (!scope.labelled) {
      return "(no field with this label on the review page, and the value is not in its text — could not confirm; not a disagreement)";
    }
    return scope.fields.length > 0 ? scope.fields.map((f) => f.value).join("; ").slice(0, 80) : "(not found on review page)";
  };

  // A needle is present if it appears among the label-scoped structured values OR anywhere
  // in the rendered page text. The structured/scoped match keeps precision when the portal
  // exposes real fields; the body fallback rescues read-only review pages that render values
  // as static text.
  const present = (scope: { fields: ReviewField[]; labelled: boolean }, needle: string): boolean => {
    const haystack = scope.fields.map((f) => norm(f.value)).join(" ");
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
    compared++;
    if (!present(scope, firstWord)) {
      mismatches.push({ field: fieldName, expected: String(expected ?? "").slice(0, 60), found: summarize(scope) });
    } else confirmed++;
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
    // A NEEDLE OF ALL ONE DIGIT PROVES NOTHING. bodyDigits is every digit on the page with
    // the separators stripped and run together, so "0000" turns up in a price, a timestamp,
    // or two adjacent numbers colliding — it would "confirm" an account number that was
    // never rendered. Real accounts do end 0000; for those the honest answer is that we
    // could not distinguish, which is what NOT counting it as compared says.
    if (/^(\d)\1+$/.test(needle)) return;
    const scope = scopeFor(labelKeywords);
    const scopeDigits = scope.fields.map((f) => f.value).join(" ").replace(/\D/g, "");
    compared++;
    if (!scopeDigits.includes(needle) && !(bodyDigits.length > 0 && bodyDigits.includes(needle))) {
      mismatches.push({
        field: fieldName,
        expected: opts.last4 ? `…${needle}` : String(expected ?? "").slice(0, 60),
        found: opts.last4 ? "(digits not found on review page)" : summarize(scope),
      });
    } else confirmed++;
  };

  checkText("homeownerName", project.homeownerName, ["name", "owner", "applicant", "customer", "contact"]);
  checkText("projectAddress", (project.projectAddress ?? "").split(",")[0], ["address", "street", "site", "location", "premise", "service"]);
  checkDigits("systemSizeDcKw", project.systemSizeDcKw, ["size", "kw", "kva", "dc", "capacity", "nameplate", "rating", "system"]);
  // A utility identifier is looked for only when THIS filing typed it (B8): a skipped check is not
  // compared and not confirmed — digits the portal printed for its own reasons prove nothing.
  if (entered.accountNumber) checkDigits("accountNumber", project.accountNumber, ["account"], { last4: true });
  if (entered.meterNumber) checkDigits("meterNumber", project.meterNumber, ["meter"], { last4: true });

  // NOT A REVIEW SCREEN IS NOT A WRONG APPLICATION.
  //
  // Live on PacifiCorp: the run ends on the Aggregation page — the last INPUT page, which
  // shows an aggregation choice, a yes/no and a certification box, and none of the values
  // entered eight pages earlier. Every check above then failed to find its value, and the
  // scope fallback dressed the failures in whatever text was on screen, so the verdict read
  // `homeownerName shows "No; checked"` and blamed the recipe with DO NOT SUBMIT. There was
  // nothing wrong with the filing: 97 of 98 steps, zero blanks, 47 values verified.
  //
  // If NOT ONE of the project's values is anywhere on this page, the two explanations are
  // "this is not a review screen" and "every single field is wrong" — and we cannot tell
  // them apart from here. The honest report for that is the one this codebase already
  // insists on everywhere else: WE COULD NOT CHECK. That scores clean-but-unverified, which
  // is exactly what it is, rather than a mismatch that sends someone hunting a defect that
  // is not there.
  //
  // A page where even ONE value was confirmed IS a review screen, and there the mismatches
  // are real and still reported — which is the direction that has to keep working.
  //
  // TWO SIGNALS, NOT ONE. An earlier draft suppressed on "nothing confirmed" alone, and that
  // swallowed the catch that matters most: a real review screen showing the WRONG homeowner
  // confirms nothing either, and its own smoke caught the regression immediately. The second
  // signal is the scraper's founding premise, one file up — a true review page has no
  // fillable inputs, because it renders what was entered rather than asking for it. So the
  // report is "could not check" only when nothing matched AND every pair on the page came
  // from a control somebody could still type into. PacifiCorp's Aggregation page is three
  // live controls; a review screen is definition lists, summary rows and readonly inputs.
  const anyStatic = reviewFields.some((f) => f.editable !== true);
  if (confirmed === 0 && compared > 0 && reviewFields.length > 0 && !anyStatic) {
    return { mismatches: [], compared, confirmed: 0 };
  }

  return { mismatches, compared, confirmed };
}

/**
 * Just the mismatches, for the callers that only ever wanted those.
 *
 * Kept so the learn adapter's four call sites are untouched — but note that an empty list
 * from this function is NOT evidence of a verified filing. Anything gating a decision on
 * "it matched" must use reviewComparison and look at `confirmed`.
 */
export function compareReviewFields(
  reviewFields: ReviewField[],
  project: ProjectRecord,
  entered: UtilityIdentifiersEntered,
  bodyText = "",
): ReviewMismatch[] {
  return reviewComparison(reviewFields, project, entered, bodyText).mismatches;
}

/**
 * THE FEES A REVIEW SCREEN PRINTS, read with the ONE parser the permit monitor also uses
 * (shared/src/portalFeeItems.ts) so the two doors cannot disagree about what a fee is. Read-only
 * over what scrapeReviewScreen already returned: it never touches the page, and reading a fee is
 * not paying it (hard rule 1). A review screen that prints no fee, or $0.00, comes back as a
 * refusal — never a $0 fee.
 *
 * Wiring note: the recipe replay's review check (recipeAdapter.verifyReviewScreen) returns a
 * fixed shape with no channel for this yet; the call belongs there, beside reviewComparison.
 */
export function reviewScreenFees(reviewFields: ReviewField[], bodyText = ""): PortalFeeReadResult {
  return readReviewScreenFees(reviewFields.map((f) => ({ label: f.label, value: f.value })), bodyText);
}
