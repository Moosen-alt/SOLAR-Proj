// THE PRE-SUBMITTAL CORRECTION NOTICE (#148) — backend/src/correctionNotice.ts.
//
// Pins, on synthetic findings: the AHJ-letter grouping (fire-pathway checks under Fire, not Plan),
// holds before comments before info within a group, numbering through the whole letter, "pass"
// findings left out, the weight taken from the gate's severity as is (a warning never becomes a
// hold here), citations from the finding's own adopted-edition references, the three provenance
// lines (verified / seeded / defaults), prior corrections only when they MATCHED (count > 0) and
// never with their raw sample, and the plain-text rendering. Then, on a scratch database: the
// db-holding read writes NOTHING (not even the code-research enqueue for an un-profiled AHJ) and
// the route sits under the scoped /api/projects/:id prefix.
//   npx tsx backend/test/correctionNotice.test.ts
import { REPO } from "./_isolate"; // FIRST: temp cwd, off the network
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HistoricalFailureCause, ReviewerFinding, ReviewerReport } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-notice-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.SKIP_CODE_RESEARCH;

const { buildCorrectionNotice, renderCorrectionNoticeText, readCorrectionNotice, correctionNoticeGroupFor, provenanceLineFor } = await import("../src/correctionNotice");

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const f = (id: string, severity: ReviewerFinding["severity"], category: ReviewerFinding["category"], over: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  id, severity, category, title: `Title ${id}`, message: `Message ${id}`, cityFeedback: `City says ${id}`,
  designTeamAction: `Fix ${id}`, evidenceNeeded: [], codeReferences: [], installerCallout: false, ...over,
});

const findings: ReviewerFinding[] = [
  f("reviewer.core.utility", "warning", "project_data"),
  f("city.elec.labels-missing", "callout", "electrical"),
  f("city.struct.attachment-detail-missing", "warning", "structural"),
  f("city.fire.pathways-missing", "blocker", "plan_set", {
    codeReferences: [{ code: "2021 IRC", section: "R324.6", title: "Roof access and pathways", adoptionScope: "Sample City: adopted IRC 2021.", sourceUrl: "", note: "" }],
    evidenceFound: [{ kind: "absence_check", label: "Fire pathway — not found in the package", source: "Parsed project package", excerpt: "No matching evidence found.", confidence: "low", pageHint: "", screenshotPath: "", verifier: "rule_engine", note: "" }],
  }),
  f("city.elec.load-side-over-120", "blocker", "electrical", {
    codeReferences: [
      { code: "2020 NEC", section: "705.12(B)(3)(2)", title: "120% rule", adoptionScope: "", sourceUrl: "", note: "" },
      { code: "2020 NEC", section: "705.12(B)(3)(2)", title: "120% rule", adoptionScope: "", sourceUrl: "", note: "" },
    ],
    evidenceFound: [
      { kind: "source_excerpt", label: "SLD evidence", source: "Plan set", excerpt: "200A bus, 200A main, 60A PV breaker", confidence: "high", pageHint: "PV-3 single line", screenshotPath: "", verifier: "parser", note: "" },
      { kind: "screenshot_placeholder", label: "crop", source: "Plan set", excerpt: "", confidence: "high", pageHint: "PV-3 single line", screenshotPath: "/x", verifier: "parser", note: "" },
    ],
  }),
  f("reviewer.plan.site", "warning", "plan_set", {
    evidenceFound: [{ kind: "field_value", label: "Site", source: "Normalized project field", excerpt: "Roof plan <b>v2</b>", confidence: "medium", pageHint: "Project field", screenshotPath: "", verifier: "normalized_field", note: "" }],
  }),
  f("city.struct.loads-missing", "blocker", "structural"),
  f("reviewer.core.ahj", "pass", "project_data"),
  f("city.elec.rapid-shutdown-missing", "warning", "electrical"),
];
const report: ReviewerReport = {
  projectId: "p-synthetic", generatedAt: "2026-10-04T00:00:00.000Z", matchedProcessProfile: null, findings, installerCallouts: [],
  finalSubmitGate: { mustShowAhjPreviewWindow: false, finalSubmitButtonAloneIsEnough: false, requirements: [] },
};
const cause = (title: string, count: number): HistoricalFailureCause => ({
  signature: title.toLowerCase(), title, count, correctionBucket: "A_we_fix", rootCause: `${title} root`, requiredAction: `Do ${title}`,
  sample: "Sample Homeowner at 1 Synthetic Lane was asked to fix this", severity: "warning",
});
const ctx = {
  ahj: "Sample City", state: "ZZ", generatedAt: "2026-10-04T12:00:00.000Z",
  codeBasis: { source: "verified" as const, adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2020" }] },
  priorCauses: [cause("Fire pathway not dimensioned", 3), cause("Baseline prevention check", 0)],
};
const notice = buildCorrectionNotice(report, ctx);

await check("grouped like an AHJ letter, in letter order; fire-pathway checks under Fire, not Plan", () => {
  assert.deepEqual(notice.items.map((i) => i.group), [
    "Structural", "Structural", "Electrical", "Electrical", "Electrical", "Fire", "Plan completeness", "Local requirements",
  ]);
  assert.equal(correctionNoticeGroupFor({ id: "reviewer.plan.fire-path", category: "plan_set" }), "Fire");
  assert.equal(correctionNoticeGroupFor({ id: "reviewer.plan.rapid-shutdown", category: "plan_set" }), "Electrical");
  assert.equal(correctionNoticeGroupFor({ id: "reviewer.profile.structural-stamp", category: "ahj_profile" }), "Structural");
  assert.equal(correctionNoticeGroupFor({ id: "reviewer.submit.valuation-missing", category: "portal" }), "Local requirements");
});

await check("holds first within each group, then comments, then info; numbered 1..n through the letter", () => {
  assert.deepEqual(notice.items.map((i) => i.findingId), [
    "city.struct.loads-missing", "city.struct.attachment-detail-missing",
    "city.elec.load-side-over-120", "city.elec.rapid-shutdown-missing", "city.elec.labels-missing",
    "city.fire.pathways-missing", "reviewer.plan.site", "reviewer.core.utility",
  ]);
  assert.deepEqual(notice.items.map((i) => i.number), [1, 2, 3, 4, 5, 6, 7, 8]);
});

await check("weight is the gate's severity, unchanged (blocker→hold, warning→comment, callout→info); pass is left out", () => {
  const w = Object.fromEntries(notice.items.map((i) => [i.findingId, i.weight]));
  assert.equal(w["city.struct.loads-missing"], "hold");
  assert.equal(w["city.struct.attachment-detail-missing"], "comment");
  assert.equal(w["city.elec.labels-missing"], "info");
  assert.ok(!notice.items.some((i) => i.findingId === "reviewer.core.ahj"), "a pass finding is not a correction");
  assert.deepEqual(notice.counts, { hold: 3, comment: 4, info: 1 });
});

await check("citations are the finding's own adopted-edition references, deduped", () => {
  const elec = notice.items.find((i) => i.findingId === "city.elec.load-side-over-120")!;
  assert.deepEqual(elec.citations, ["2020 NEC 705.12(B)(3)(2) — 120% rule"]);
  const fire = notice.items.find((i) => i.findingId === "city.fire.pathways-missing")!;
  assert.deepEqual(fire.citations, ["2021 IRC R324.6 — Roof access and pathways"]);
});

await check("plan states / required / sheet: from the evidence, and the sheet only where plan text was read", () => {
  const elec = notice.items.find((i) => i.findingId === "city.elec.load-side-over-120")!;
  assert.equal(elec.planStates, 'Plan set: "200A bus, 200A main, 60A PV breaker"');
  assert.equal(elec.sheet, "PV-3 single line");
  assert.equal(elec.required, "Fix city.elec.load-side-over-120");
  assert.equal(elec.comment, "City says city.elec.load-side-over-120");
  const fire = notice.items.find((i) => i.findingId === "city.fire.pathways-missing")!;
  assert.equal(fire.planStates, "Not shown in the submitted package.");
  assert.equal(fire.sheet, "");
  const site = notice.items.find((i) => i.findingId === "reviewer.plan.site")!;
  assert.equal(site.sheet, "", "a recorded field's 'Project field' hint is not a sheet");
  assert.match(site.planStates, /Normalized project field/);
});

await check("provenance line: verified, seeded and model-code defaults each say which they are", () => {
  assert.equal(notice.provenance, "verified");
  assert.match(notice.provenanceLine, /verified jurisdiction profile/);
  assert.match(notice.provenanceLine, /2021 IRC, 2020 NEC/);
  const seeded = provenanceLineFor({ ahj: "Sample City", state: "ZZ", codeBasis: { source: "seeded", adoptedCodes: [{ code: "NEC", edition: "2023" }] } });
  assert.match(seeded, /seeded profile \(researched, not yet verified/);
  assert.match(seeded, /Confirm the adopted editions/);
  assert.doesNotMatch(seeded, /verified jurisdiction profile/);
  const defaults = provenanceLineFor({ ahj: "Sample City", state: "ZZ", codeBasis: { source: "defaults", adoptedCodes: [] } });
  assert.match(defaults, /no adopted-code record for Sample City, ZZ — model-code defaults/);
});

await check("prior corrections: only the matched ones (count > 0), never the raw sample", () => {
  assert.deepEqual(notice.priorCorrections, [{ title: "Fire pathway not dimensioned", count: 3, requiredAction: "Do Fire pathway not dimensioned" }]);
  assert.doesNotMatch(JSON.stringify(notice), /Synthetic Lane|Sample Homeowner/);
});

await check("plain text: header, provenance, counts, sections in order, each item's fields, prior corrections", () => {
  const text = renderCorrectionNoticeText(notice);
  assert.match(text, /^PRE-SUBMITTAL CORRECTION NOTICE — Sample City, ZZ\n/);
  assert.match(text, /Not issued by the AHJ\./);
  assert.ok(text.includes(notice.provenanceLine));
  assert.match(text, /3 hold\(s\) · 4 comment\(s\) · 1 informational/);
  const order = ["STRUCTURAL", "ELECTRICAL", "FIRE", "PLAN COMPLETENESS", "LOCAL REQUIREMENTS", "PRIOR CORRECTIONS"].map((h) => text.indexOf(`\n${h}`));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `section order ${order.join(",")}`);
  assert.match(text, / 3\. \[HOLD\] Title city\.elec\.load-side-over-120\n {4}Code: 2020 NEC 705\.12\(B\)\(3\)\(2\) — 120% rule\n/);
  assert.match(text, /Sheet: PV-3 single line/);
  assert.match(text, /- Fire pathway not dimensioned \(×3\): Do Fire pathway not dimensioned/);
  const empty = renderCorrectionNoticeText(buildCorrectionNotice({ ...report, findings: [f("x", "pass", "project_data")] }, { ...ctx, priorCauses: [] }));
  assert.match(empty, /No corrections: the gate found nothing to hold or comment on\./);
  assert.doesNotMatch(empty, /PRIOR CORRECTIONS/);
});

// ── On a scratch database ─────────────────────────────────────────────────────────────────
const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const db = await openDatabase();
const client = createClient(db, {
  companyName: "Notice Test Solar LLC", legalBusinessName: "Notice Test Solar LLC", ccbLicenseNumber: "000001",
  electricalLicenseNumber: "C0001", businessEmail: "ops@notice.test", businessPhone: "(555) 555-0100",
});
process.env.SKIP_CODE_RESEARCH = "1"; // created with research suppressed: nothing in flight for this AHJ
const project = createProject(db, {
  clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Nowhereville", state: "ZZ", zip: "00000",
  ahj: "Nowhereville Building Division", utility: "Remote Power Co", dcKw: "8.6", acKw: "6.5",
  busRating: "200", mainBreaker: "200", pvBreaker: "60", interco: "Load-side breaker",
}).project;
delete process.env.SKIP_CODE_RESEARCH;

const trapWrites = <T>(fn: () => T): { value: T; writes: string[] } => {
  const writes: string[] = [];
  const orig = { run: db.run, exec: db.exec, transaction: db.transaction };
  db.run = ((sql: string) => { writes.push(sql.trim().slice(0, 60)); }) as typeof db.run;
  db.exec = ((sql: string) => { writes.push(sql.trim().slice(0, 60)); }) as typeof db.exec;
  db.transaction = (<R>(fn2: () => R): R => { writes.push("transaction"); return fn2(); }) as typeof db.transaction;
  try { return { value: fn(), writes }; } finally { db.run = orig.run; db.exec = orig.exec; db.transaction = orig.transaction; }
};

await check("readCorrectionNotice writes NOTHING — not even code research for an un-profiled AHJ", async () => {
  const researchJobs = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'code_research'")?.n ?? 0);
  const before = researchJobs();
  const { value, writes } = trapWrites(() => readCorrectionNotice(db, project.id));
  assert.deepEqual(writes, [], `readCorrectionNotice wrote: ${writes.join(" | ")}`);
  await new Promise((r) => setTimeout(r, 300)); // an enqueue would be a void import().then
  assert.equal(researchJobs(), before, "the read queued jurisdiction code research");
  assert.equal(process.env.SKIP_CODE_RESEARCH, undefined, "the suppression leaked out of the read");
  assert.equal(value.projectId, project.id);
  assert.equal(value.provenance, "defaults", "an un-profiled AHJ reads as model-code defaults, never verified");
  assert.ok(value.items.length > 0, "the gate's findings on a thin project become notice items");
  assert.ok(value.items.every((i, n) => i.number === n + 1));
});

await check("the route lives under the scoped /api/projects/:id prefix (rule 6)", () => {
  const server = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
  assert.match(server, /app\.get\("\/api\/projects\/:id\/correction-notice"/);
  assert.match(server, /app\.use\("\/api\/projects\/:id",\s*scopeGuard\(/);
});

fs.rmSync(path.resolve("backend/data/filled", project.id), { recursive: true, force: true });

if (failures) {
  console.error(`\ncorrectionNotice: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ncorrectionNotice: all checks passed");
