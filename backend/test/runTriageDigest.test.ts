// Unit test for the run-triage deterministic digest. Runs against a real captured
// learn-run bundle (backend/test/fixtures/learn-run-sample) — the PGE run where the
// PV-spec equipment dropdowns were left blank and the export-capacity question was
// unanswered. No LLM/API key needed: the digest is pure parsing.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestBundle } from "../src/runTriage";

const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   - ${name}`);
  } else {
    failures++;
    console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const dir = path.resolve(here, "fixtures", "learn-run-sample");
const { summary, pages, misses } = digestBundle(dir);

console.log("--- digest summary ---\n" + summary + "\n----------------------");

check("digest is non-empty", summary.length > 50);
check("captures the run status line", /RUN .*status=/.test(summary));
check("reports required-field miss (export capacity)", misses.some((m) => /export capacity/i.test(m)), JSON.stringify(misses));
check("page 7 parsed with unfilled fields", pages.some((p) => p.page === 7 && p.unfilled.length > 0));
check(
  "surfaces an unfilled equipment/spec control on page 7",
  pages.some((p) => p.page === 7 && p.unfilled.some((l) => /not listed|equipment|spec/i.test(l))) || /page 7:/.test(summary),
);
check("does not leak the noise checkbox 'Program homepage'", !/Program homepage/.test(summary));

if (failures) {
  console.error(`\nrun-triage digest test FAILED (${failures} check(s)).`);
  process.exit(1);
}
console.log("\nrun-triage digest test passed.");
