// THE KPI PANEL'S FILING MEASURES (#74) — frontend/kpi-filings.js, loaded here through node:vm.
//
// #49 added KpiReport.filings to GET /api/kpi; this pins how the dashboard shows it, on a
// synthetic report: every rate carries n / of and greys when smallN, every cycle stat shows
// median / p90 / n with a dash (never 0) for a null median, "Unclassified" has its own line,
// the two AHJ tables each say what they are keyed on, open past p90 links to the project (and
// says so when empty), the report's notes print as caveats, and every value is escaped.
//   npx tsx backend/test/kpiFilingsPanel.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";
import { kpiRate, type FilingKpis } from "../src/kpi";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const src = fs.readFileSync(path.join(REPO, "frontend", "kpi-filings.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "kpi-filings.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const KF = sandbox.window.KpiFilings as any;

const empty = { median: null, p90: null, n: 0 };
// Typed against the backend's FilingKpis, so a field renamed there breaks this fixture at typecheck.
const report: FilingKpis = {
  firstPass: {
    overall: kpiRate(2, 4),
    byTrack: [{ key: "building", ...kpiRate(9, 12) }],
    byAhj: [{ key: "City of <Sample>", ...kpiRate(1, 3) }],
  },
  correctionCycles: {
    permits: 4,
    byCause: [
      { cause: "keelix_catchable", notices: 1, perPermit: 0.25 },
      { cause: "design", notices: 0, perPermit: 0 },
      { cause: "ahj_discretionary", notices: 0, perPermit: 0 },
      { cause: "unclassified", notices: 2, perPermit: 0.5 },
    ],
    keelixPer100ByMonth: [{ month: "2026-08", notices: 1, permits: 4, per100: 25 }],
  },
  submitToIssued: { overall: empty, byAhj: [{ key: "zz|sample-county", median: 14.5, p90: 30, n: 6 }] },
  interconnection: {
    deficiencyRate: kpiRate(0, 0),
    cureDays: empty,
    cureBreaches: kpiRate(0, 0),
    submitToApproved: { median: 21, p90: 40, n: 11 },
  },
  reviewerGate: { falseNegatives: kpiRate(1, 20), falsePositives: kpiRate(0, 2) },
  humanMinutes: { median: 12, p90: 45, n: 3 },
  blanksFilledPerRun: { avg: 1.5, of: 4 },
  humanQueue: { n: 2, oldestDays: 3, olderThanDays: 2, overAge: 1 },
  openPastP90: { n: 0, items: [] },
  notes: ["Cycle medians exclude filings that have not closed.", "A gate miss is a lower bound & <b>not</b> exact."],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sections: Array<{ title: string; keyedOn?: string; empty?: string; rows: any[] }> = KF.buildFilingKpiRows(report);
const section = (prefix: string) => {
  const s = sections.find((x) => x.title.startsWith(prefix));
  assert.ok(s, `no section titled "${prefix}…"`);
  return s;
};
const row = (prefix: string, label: string) => {
  const r = section(prefix).rows.find((x) => x.label === label);
  assert.ok(r, `no row "${label}" in "${prefix}"`);
  return r;
};
const html: string = KF.renderFilingKpis(report);

check("a rate shows its percent with n / of beside it", () => {
  const r = row("First-pass rate", "All permits");
  assert.equal(r.value, "50%");
  assert.equal(r.detail, "2 / 4");
});
check("smallN rates are flagged and render greyed, n still shown", () => {
  assert.equal(row("First-pass rate", "All permits").smallN, true);
  assert.equal(row("First pass by track", "building").smallN, false);
  assert.match(html, /<tr class="kpi-smalln"[^>]*>\s*<td>All permits<\/td>\s*<td>50%<\/td>\s*<td>2 \/ 4<\/td>/);
});
check("a rate with no denominator is a dash, not 0%", () => {
  const r = row("Interconnection", "Filings with a deficiency");
  assert.equal(r.value, "—");
  assert.equal(r.detail, "0 / 0");
});
check("a cycle stat shows median, p90 and n", () => {
  const r = row("Interconnection", "Submitted → approved");
  assert.equal(r.value, "21d");
  assert.equal(r.detail, "p90 40d · n 11");
  assert.equal(row("Human work", "Minutes from staged to sent").detail, "p90 45 min · n 3");
});
check("a null median shows a dash, never 0", () => {
  const r = row("Submitted → issued", "This period's permits");
  assert.equal(r.value, "—");
  assert.equal(r.detail, "p90 — · n 0");
  assert.equal(row("Interconnection", "Cure days (closed notices)").value, "—");
});
check("Unclassified cause is its own line", () => {
  const r = row("Correction cycles", "Unclassified (no cause bucket)");
  assert.equal(r.value, "2");
  assert.equal(r.detail, "0.5");
});
check("the Keelix-catchable per-100 monthly trend renders", () => {
  const r = row("Keelix-catchable", "2026-08");
  assert.equal(r.value, "25");
  assert.equal(r.detail, "1 / 4");
});
check("the two AHJ tables each say what they are keyed on (not merged)", () => {
  assert.equal(section("First pass by AHJ").keyedOn, "the project's AHJ as entered");
  assert.equal(section("Submitted → issued by AHJ").keyedOn, "the KB profile key (state + AHJ)");
  assert.ok(row("Submitted → issued by AHJ", "zz|sample-county"));
  assert.ok(row("First pass by AHJ", "City of <Sample>"));
});
check("reviewer gate false negatives and positives render as rates", () => {
  assert.equal(row("Reviewer gate", "False negatives (bucket-A notice the gate did not flag)").detail, "1 / 20");
  assert.equal(row("Reviewer gate", "False positives (blocked, then overridden)").smallN, true);
});
check("human queue and blanks per run render with their denominators", () => {
  assert.equal(row("Human work", "Waiting on a person to submit").detail, "oldest 3d · 1 over 2d");
  assert.equal(row("Human work", "Required fields left blank per run").detail, "of 4 measured run(s)");
});
check("an empty open-past-p90 list says so", () => {
  const s = section("Open past p90");
  assert.equal(s.title, "Open past p90 (0)");
  assert.equal(s.rows.length, 0);
  assert.match(html, /No open filing is past its p90\./);
});
check("open past p90 lists each filing linked to its project", () => {
  const withOpen = { ...report, openPastP90: { n: 1, items: [{ submissionId: "s1", projectId: "proj-1", track: "building", openDays: 40, p90Days: 30 }] } };
  const h: string = KF.renderFilingKpis(withOpen);
  assert.match(h, /<a href="#\/project\/proj-1">proj-1<\/a>/);
  assert.match(h, /40d/);
  assert.match(h, /building · p90 30d/);
});
check("filings.notes print as caveats under the panel", () => {
  assert.match(html, /<ul class="muted kpi-notes"[^>]*>.*Cycle medians exclude filings that have not closed\./s);
});
check("every interpolated value is escaped", () => {
  assert.ok(html.includes("City of &lt;Sample&gt;"), "AHJ key not escaped");
  assert.ok(!html.includes("<Sample>"));
  assert.ok(html.includes("lower bound &amp; &lt;b&gt;not&lt;/b&gt; exact"), "note not escaped");
  const hostile = { ...report, openPastP90: { n: 1, items: [{ submissionId: "s", projectId: '"><img src=x onerror=1>', track: "<t>", openDays: 1, p90Days: 0 }] } };
  const h: string = KF.renderFilingKpis(hostile);
  assert.ok(!h.includes("<img"), "project id reached innerHTML raw");
  assert.ok(!h.includes("<t>"), "track reached innerHTML raw");
});
check("no report renders nothing", () => {
  assert.equal(KF.renderFilingKpis(undefined), "");
  assert.equal(KF.buildFilingKpiRows(null).length, 0);
});

console.log(failures === 0 ? "\nkpiFilingsPanel: all checks passed." : `\nkpiFilingsPanel: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
