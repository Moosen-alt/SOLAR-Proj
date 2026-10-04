// THE CORRECTION NOTICE PANEL (#148) — frontend/correction-notice.js, loaded here through node:vm.
//
// Pins how the dashboard draws GET /api/projects/:id/correction-notice's notice, on a synthetic one
// built by the backend's own buildCorrectionNotice (so a field renamed there breaks this test):
// the provenance line prints first, sections print in letter order with each item's number,
// weight, citation, plan statement, requirement and sheet; a blank field is left out; prior
// corrections print with their count; an empty notice says so; no notice yet says "not built";
// and every value is escaped.
//   npx tsx backend/test/correctionNoticePanel.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";
import { buildCorrectionNotice, CORRECTION_NOTICE_GROUPS } from "../src/correctionNotice";
import type { ReviewerFinding } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const src = fs.readFileSync(path.join(REPO, "frontend", "correction-notice.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "correction-notice.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CN = sandbox.window.CorrectionNotice as any;

const f = (id: string, severity: ReviewerFinding["severity"], category: ReviewerFinding["category"], over: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  id, severity, category, title: `Title ${id}`, message: "", cityFeedback: `City says ${id}`, designTeamAction: `Fix ${id}`,
  evidenceNeeded: [], codeReferences: [], installerCallout: false, ...over,
});
const notice = buildCorrectionNotice({
  projectId: "p-synthetic", generatedAt: "2026-10-04T00:00:00.000Z", matchedProcessProfile: null, installerCallouts: [],
  finalSubmitGate: { mustShowAhjPreviewWindow: false, finalSubmitButtonAloneIsEnough: false, requirements: [] },
  findings: [
    f("reviewer.core.utility", "callout", "project_data", { designTeamAction: "" }),
    f("city.elec.load-side-over-120", "blocker", "electrical", {
      title: "Backfeed <script>alert(1)</script> over 120%",
      codeReferences: [{ code: "2020 NEC", section: "705.12", title: "Load-side & supply", adoptionScope: "", sourceUrl: "", note: "" }],
      evidenceFound: [{ kind: "source_excerpt", label: "SLD", source: "Plan set", excerpt: 'Main "200A" <b>bus</b>', confidence: "high", pageHint: "PV-3", screenshotPath: "", verifier: "parser", note: "" }],
    }),
    f("city.struct.loads-missing", "warning", "structural"),
  ],
}, {
  ahj: "Sample <City>", state: "ZZ", generatedAt: "2026-10-04T12:00:00.000Z",
  codeBasis: { source: "seeded", adoptedCodes: [{ code: "NEC", edition: "2020" }] },
  priorCauses: [{ signature: "s", title: "Labels & placards", count: 2, correctionBucket: "A_we_fix", rootCause: "r", requiredAction: "Add <labels>", sample: "Synthetic Homeowner sample", severity: "warning" }],
});
const html: string = CN.renderCorrectionNotice(notice);

check("the provenance line prints first, escaped", () => {
  assert.ok(html.indexOf("cn-provenance") < html.indexOf("cn-item"), "provenance before the first item");
  assert.match(html, /Sample &lt;City&gt;, ZZ — seeded profile/);
});

check("counts and the not-issued-by-the-AHJ caveat", () => {
  assert.match(html, /1 hold\(s\) · 1 comment\(s\) · 1 informational/);
  assert.match(html, /not issued by the AHJ/);
});

check("sections in letter order; each item shows number, weight, code, comment, plan states, required, sheet", () => {
  const s = html.indexOf(">Structural<"), e = html.indexOf(">Electrical<"), l = html.indexOf(">Local requirements<");
  assert.ok(s > 0 && s < e && e < l, `order ${s},${e},${l}`);
  assert.ok(!html.includes(">Fire<"), "an empty section is not printed");
  assert.match(html, /<strong>1\.<\/strong> <span class="badge [^"]*">Comment<\/span> <strong>Title city\.struct\.loads-missing<\/strong>/);
  assert.match(html, /<strong>2\.<\/strong> <span class="badge text-danger">Hold<\/span>/);
  assert.match(html, /Code:<\/span> 2020 NEC 705\.12 — Load-side &amp; supply/);
  assert.match(html, /Plan states:<\/span> Plan set: &quot;Main &quot;200A&quot; &lt;b&gt;bus&lt;\/b&gt;&quot;/);
  assert.match(html, /Required:<\/span> Fix city\.elec\.load-side-over-120/);
  assert.match(html, /Sheet:<\/span> PV-3/);
});

check("a blank field is left out, never printed empty", () => {
  const item = html.split('class="cn-item').find((chunk) => chunk.includes('data-finding-id="reviewer.core.utility"')) || "";
  assert.ok(item, "the utility item renders");
  assert.doesNotMatch(item, /Required:|Sheet:|Code:/);
});

check("every value is escaped: no raw markup from findings reaches the HTML", () => {
  assert.ok(!html.includes("<script>"), "raw <script> in the panel");
  assert.ok(!html.includes("<b>bus"), "raw <b> from a plan excerpt");
  assert.match(html, /Backfeed &lt;script&gt;alert\(1\)&lt;\/script&gt; over 120%/);
});

check("prior corrections print with their count, escaped, and without the raw sample", () => {
  assert.match(html, /Labels &amp; placards <span class="muted">\(×2\)<\/span> — Add &lt;labels&gt;/);
  assert.ok(!html.includes("Synthetic Homeowner"));
});

check("an empty notice says so; no notice yet says not built", () => {
  const empty = CN.renderCorrectionNotice({ ...notice, items: [], priorCorrections: [], counts: { hold: 0, comment: 0, info: 0 } });
  assert.match(empty, /No corrections: the gate found nothing to hold or comment on\./);
  assert.doesNotMatch(empty, /Prior corrections/);
  assert.match(CN.renderCorrectionNotice(null), /Not built yet/);
});

check("the panel's sections are the backend's groups, in the same order", () => {
  assert.deepEqual([...CN.GROUPS], [...CORRECTION_NOTICE_GROUPS]);
});

if (failures) {
  console.error(`\ncorrectionNoticePanel: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ncorrectionNoticePanel: all checks passed");
