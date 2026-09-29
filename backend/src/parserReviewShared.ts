// THE PARSER PAGE'S PURE REVIEW MODULE, ON THE SERVER.
//
// frontend/parser-review.js is written to run in both places (no DOM, no network, no clock): the
// parser page loads it as a classic script, and it attaches `ParserReview` to whatever global it
// finds. Importing it here runs that same file once in this process, so a rule the page applies
// at intake and a rule the server applies at read time are ONE rule — never a TypeScript copy of
// the page's regexes that drifts from them (one question, one predicate).
//
// Only the functions the server reads are typed here; add one when a server module needs it.
import "../../frontend/parser-review.js";

export interface StructureBasis {
  /** One of STRUCTURE_OPTIONS, or "" — no answer (still asked). */
  option: string;
  /** The words that decided it (or why no answer was taken); "" when nothing was found. */
  basis: string;
  /** Only the manufactured-home predicate can settle it and no verdict was passed. */
  defer?: boolean;
}

interface ParserReviewApi {
  structureBasis(planText: string, opts?: {
    reading?: { value?: unknown; excerpt?: unknown } | unknown;
    dwellingUnits?: unknown;
    /** codeReviewRules.structureType's verdict — the one manufactured-home predicate. */
    manufactured?: "yes" | "no";
    manufacturedBasis?: string;
  }): StructureBasis;
  structureOption(value: unknown): string;
  /** The other-building words the text names (the attached-garage exception skipped) — the words
   *  the structure derivation abstains on. */
  otherBuildingWords(planText: string): string[];
  STRUCTURE_OPTIONS: string[];
}

const api = (globalThis as { ParserReview?: ParserReviewApi }).ParserReview;
if (!api || typeof api.structureBasis !== "function") {
  throw new Error("frontend/parser-review.js did not attach ParserReview.structureBasis — the server's structure derivation cannot load");
}

export const parserReview: ParserReviewApi = api;
