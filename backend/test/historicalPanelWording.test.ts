// B9: THE HISTORICAL PANEL IS ABOUT OTHER PROJECTS. The operator: it "is confusing, looks like you're
// calling them out for this project not past ones". Rendered with the SHIPPED renderHistoricalFailures
// lifted out of frontend/dashboard.js (brace-balanced cut, as jurisdictionProposalRender.test does).
//
// KILL (verified red by hand): restore the "Top rejection causes" header + severity badge → (h1) fails;
// drop thisProjectLine → (h2) fails.
//
//   npx tsx backend/test/historicalPanelWording.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const bundle = ["esc", "humanize", "statusBadge", "renderHistoricalFailures"].map(cut).join("\n\n");
const render = (report: unknown): string => {
  const els: Record<string, { textContent: string; innerHTML: string }> = {};
  const $ = (id: string) => (els[id] ??= { textContent: "", innerHTML: "" });
  // eslint-disable-next-line no-new-func
  new Function("state", "$", `${bundle}\nrenderHistoricalFailures();`)({ historicalReport: report }, $);
  return els.historicalFailures.innerHTML;
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");

let failures = 0;
const check = (label: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); } };

const report = {
  summaryLabel: "13 prior Pacific Power + line-side projects", matchedProjectCount: 13, matchedFailureRecordCount: 67, matchTags: ["supply_side"],
  dataConfidence: "medium", notes: [],
  topRejectionCauses: [
    { signature: "sig-framing", title: "Missing roof framing/span evidence", count: 4, correctionBucket: "", rootCause: "span table absent", requiredAction: "Show framing.", sample: "Provide rafter span", severity: "blocker" },
    { signature: "sig-account", title: "Missing account verification", count: 2, correctionBucket: "", rootCause: "", requiredAction: "Attach bill.", sample: "", severity: "warning" },
  ],
  checklist: [
    { status: "present", id: "c1", title: "Missing roof framing/span evidence", why: "w", action: "a", evidence: ["PV1.2 truss @ 24 in"], sourceCauseSignature: "sig-framing" },
    { status: "missing", id: "c2", title: "Missing account verification", why: "w", action: "a", evidence: [], sourceCauseSignature: "sig-account" },
  ],
};

check("(h1) MUST-EXCLUDE: history reads as OTHER projects — no 'Top rejection causes', no BLOCKER badge on a past cause", () => {
  const t = text(render(report));
  assert.match(t, /Rejections seen on similar past projects/);
  assert.match(t, /not findings against this project/);
  assert.doesNotMatch(t, /Top rejection causes/);
  assert.doesNotMatch(render(report), /badge[^>]*>\s*blocker/i);
});
check("(h2) MUST-PASS: each cause says whether THIS project has the evidence", () => {
  const t = text(render(report));
  assert.match(t, /Missing roof framing\/span evidence .*This project has the evidence for this/);
  assert.match(t, /This project is MISSING the evidence for this/);
});
check("(h3) checklist rows are worded about this project, never 'PRESENT: Missing …'", () => {
  const t = text(render(report));
  assert.doesNotMatch(t, /PRESENT: Missing/);
  assert.match(t, /This project has it: roof framing\/span evidence/);
});
check("(h4) an older API with no cause↔checklist link degrades to the cause alone", () => {
  const old = { ...report, checklist: report.checklist.map(({ sourceCauseSignature: _s, ...rest }) => rest) };
  const t = text(render(old));
  assert.match(t, /Rejections seen on similar past projects/);
  assert.doesNotMatch(t, /This project has the evidence for this/);
});

if (failures) { console.error(`\n${failures} historical-panel check(s) failed.`); process.exit(1); }
console.log("\nAll historical-panel checks passed.");
process.exit(0);
