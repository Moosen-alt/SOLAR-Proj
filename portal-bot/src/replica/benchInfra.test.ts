// benchInfra: an infrastructure failure is never scored as a bot result (replay skeptic MF6).
//
// MUST-EXCLUDE: the after2.log shape — every browser launch failed, cells of 0.5 s with
//   "browserType.launch: Target page, context or browser has been closed" — is NOT MEASURED.
// MUST-PASS: a normal run's cells (real bot failures included: timeouts, validation, a browser the
//   harness closed minutes in) stay measured and scored as today.
//
// Run: npx tsx portal-bot/src/replica/benchInfra.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { infrastructureFailure, runValidity, type CellForInfra } from "./benchInfra";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

// after2.json's own messages (synthetic replica run, no customer data).
const LAUNCH_REPLAY = "Login failed before the recipe ran: Recipe login failed: browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launching> C:\\...\\chrome-headless-shell.exe";
const LAUNCH_LEARN = "Auto-learn login failed: browserType.launch: Target page, context or browser has been closed\nBrowser logs:";
const after2: CellForInfra[] = [
  { cell: "accela/base (learn)", seconds: 82.9, messages: ["Human review required. Verify all fields and click submit manually."] },
  { cell: "powerclerk/base (learn)", seconds: 210.9, messages: ["Human review required."] },
  { cell: "spa/base (learn)", seconds: 0.6, messages: [LAUNCH_LEARN] },
  ...Array.from({ length: 24 }, (_x, i) => ({ cell: `replay ${i}`, seconds: 0.5, messages: [LAUNCH_REPLAY] })),
  { cell: "accela/one_page_fewer [isolated]", seconds: 0.5, messages: [LAUNCH_REPLAY] },
];
// A normal run: the bot's own failures, which ARE results.
const normal: CellForInfra[] = [
  { cell: "accela/base", seconds: 61.2, messages: ["Replayed 30 recorded step(s); stopped at review."] },
  { cell: "spa/base", seconds: 174.3, messages: ["Recipe step failed (upload — upload plan_set: Plan set (PDF) *): locator.setInputFiles: Timeout 30000ms exceeded."] },
  { cell: "powerclerk/relabelled", seconds: 180, messages: ["", "HARNESS TIMEOUT: replay powerclerk/relabelled exceeded 180s"] },
  // A browser closed minutes into a run can be the bot's own doing — scored, not excused.
  { cell: "powerclerk/slow_x3", seconds: 143.8, messages: ["locator.fill: Target page, context or browser has been closed"] },
  { cell: "accela/relabelled", seconds: 88, messages: ["Replayed 29 step(s); 1 skipped"] },
];

check("MUST-EXCLUDE: a launch failure is infrastructure at any duration", () => {
  assert.match(String(infrastructureFailure({ cell: "x", seconds: 0.5, messages: [LAUNCH_REPLAY] })), /^infrastructure: the browser did not launch/);
  assert.match(String(infrastructureFailure({ cell: "x", seconds: 12, messages: [LAUNCH_LEARN] })), /^infrastructure/);
});
check("MUST-EXCLUDE: 'browser has been closed' in a cell that did no work (< 1 s) is infrastructure", () => {
  assert.match(String(infrastructureFailure({ cell: "x", seconds: 0.4, messages: ["page.goto: Target page, context or browser has been closed"] })), /^infrastructure: the browser was closed/);
});
check("MUST-EXCLUDE: the after2.log shape is NOT MEASURED, naming the infrastructure cells", () => {
  const v = runValidity(after2);
  assert.equal(v.measured, false);
  assert.equal(v.infrastructureCells.length, 26, JSON.stringify(v.infrastructureCells.map((c) => c.cell)));
  assert.match(v.summary, /^NOT MEASURED — 26 of 28 cell\(s\) failed on infrastructure/);
});
check("MUST-PASS: a normal run (real bot failures included) is measured", () => {
  const v = runValidity(normal);
  assert.equal(v.measured, true, v.summary);
  for (const c of normal) assert.equal(infrastructureFailure(c), null, `${c.cell} was excused as infrastructure`);
});

// The real reports, when this checkout has them (the .probe scratch is not in git): after2.json is
// NOT MEASURED; the healthy corrected baseline and the mid-stage after.json are measured.
{
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../.probe/brar2-replay-engine");
  const load = (f: string): CellForInfra[] | null => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { learns?: Array<Record<string, unknown>>; replays?: Array<Record<string, unknown>>; probes?: Array<Record<string, unknown>> };
    return [...(j.learns ?? []).filter((l) => !l.reusedFrom), ...(j.replays ?? []), ...(j.probes ?? [])]
      .map((r) => ({ cell: String(r.cell), seconds: Number(r.seconds), messages: [String(r.message ?? ""), String(r.skipReason ?? "")] }));
  };
  const a2 = load("after2.json");
  const base = load("baseline-corrected.json");
  const mid = load("after.json");
  if (a2 && base && mid) {
    check("REAL REPORTS: after2.json is NOT MEASURED; baseline-corrected.json and after.json are measured", () => {
      assert.equal(runValidity(a2).measured, false);
      assert.equal(runValidity(base).measured, true, runValidity(base).summary);
      assert.equal(runValidity(mid).measured, true, runValidity(mid).summary);
    });
  } else {
    console.log("  (skipped: the .probe bench reports are not in this checkout — the inline shapes above still ran)");
  }
}

if (failures) { console.error(`\n${failures} bench-infra check(s) FAILED.`); process.exit(1); }
console.log("\nAll bench-infra checks passed.");
process.exit(0);
