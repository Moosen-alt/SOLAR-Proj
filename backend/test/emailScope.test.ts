// CROSS-TENANT EMAIL WRITE. matchProjectForEmail used to take an OPTIONAL clientId
// and, when it was absent, load EVERY project in the database and fuzzy-match the
// inbound email against all of them. clientId came from email_tracking_sources.client_id,
// which is nullable — so the unscoped branch was the DEFAULT for any source without a
// client set.
//
// That made it a cross-tenant WRITE, not just a read leak: a match records a permit
// status check, can open a correction, writes an email_project_matches row and can
// transition project status. One company's AHJ email could land on another's project.
//
// This proves the source's OWN org scopes what it can match, and that a caller cannot
// widen that scope by passing an org in.
// Browser-free. Run: tsx backend/test/emailScope.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-scope-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createProject, configureEmailTrackingSource, runEmailTracker, getEmailTrackerStatus, getProjectDetail } =
  await import("../src/repository");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const ORG_A = DEFAULT_ORG_ID;        // the operator's own tenant
const ORG_B = "org-competitor";      // a second company on the same instance
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [ORG_B, "Competitor Solar", new Date().toISOString()]);

// Two projects with DISTINCT addresses, one per org.
const projA = createProject(db, {
  owner: "Alice Anderson", street: "123 Solar Way", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Salem", utility: "PGE", dcKw: "7.0",
});
const projB = createProject(db, {
  owner: "Bob Baker", street: "999 Panel Court", city: "Bend", state: "OR", zip: "97701",
  ahj: "City of Bend", utility: "PGE", dcKw: "8.0",
});
db.run("UPDATE projects SET org_id = ? WHERE id = ?", [ORG_B, projB.project.id]);

// An inbound email that unambiguously names ORG A's project — address AND homeowner,
// which is a 80-point match, comfortably over the 55 threshold.
const mboxFor = (file: string, body: string) => {
  const p = path.join(tmpDir, file);
  fs.writeFileSync(p, `From ahj@example.gov Wed Jun 17 10:00:00 2026\nSubject: Permit correction required\nDate: Wed, 17 Jun 2026 10:00:00 -0700\n\n${body}\n`);
  return p;
};
const aimedAtOrgA = mboxFor(
  "aimed-at-a.mbox",
  "Plan review correction required for Alice Anderson at 123 Solar Way, Salem OR 97301. Please resubmit.",
);

console.log("\n[1] a source owned by ORG B cannot match ORG A's project");
configureEmailTrackingSource(db, { filePath: aimedAtOrgA, label: "org-b watched inbox", orgId: ORG_B });
const bRun = await runEmailTracker(db, { filePath: aimedAtOrgA, orgId: ORG_B });
run("no project matched", bRun.projectMatches === 0, JSON.stringify(bRun));
run("the message is reported unmatched, not silently dropped", bRun.unmatchedMessages >= 1, JSON.stringify(bRun));
run("no status check was written to A's project", getProjectDetail(db, projA.project.id).permitStatusChecks.length === 0);
run("no email match row was written to A's project", getProjectDetail(db, projA.project.id).emailProjectMatches.length === 0);

console.log("\n[2] the SAME email through ORG A's own source does match");
const aPath = mboxFor("aimed-at-a-2.mbox", "Plan review correction required for Alice Anderson at 123 Solar Way, Salem OR 97301. Please resubmit.");
configureEmailTrackingSource(db, { filePath: aPath, label: "org-a watched inbox", orgId: ORG_A });
const aRun = await runEmailTracker(db, { filePath: aPath, orgId: ORG_A });
run("the owning org matches its own project", aRun.projectMatches === 1, JSON.stringify(aRun));
run("and a status check is recorded", getProjectDetail(db, projA.project.id).permitStatusChecks.length >= 1);

console.log("\n[3] a stored source carries its own scope — a caller cannot widen it");
// The source row says ORG B. Even asking for ORG A by sourceId must use the ROW's org,
// because scope is read from the source, never from the argument.
const bSourceId = db.get<{ id: string }>(
  "SELECT id FROM email_tracking_sources WHERE org_id = ? LIMIT 1", [ORG_B],
)?.id;
assert.ok(bSourceId, "org B source row exists");
const widened = await runEmailTracker(db, { sourceId: bSourceId, orgId: ORG_A } as { sourceId: string; orgId: string });
run("passing another org's id does not widen the match set", widened.projectMatches === 0, JSON.stringify(widened));

console.log("\n[4] the tracker status view is scoped too");
const statusA = getEmailTrackerStatus(db, ORG_A);
const statusB = getEmailTrackerStatus(db, ORG_B);
run("each org sees only its own sources", statusA.sources.every((s) => !/org-b/.test(s.label)) && statusB.sources.every((s) => !/org-a/.test(s.label)),
  `A=${statusA.sources.map((s) => s.label)} B=${statusB.sources.map((s) => s.label)}`);
run("org B sees none of org A's matches", statusB.recentMatches.length === 0, JSON.stringify(statusB.recentMatches));
run("org A sees its own match", statusA.recentMatches.length >= 1);

console.log(failures === 0 ? "\nemailScope: all checks passed" : `\nemailScope: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
