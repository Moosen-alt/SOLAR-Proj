// HISTORICAL FAILURE EXAMPLES NEVER CROSS ORGS, AND THE SHARED ROLLUP CARRIES NO SAMPLE TEXT.
//
// historical_failure_examples holds raw correction excerpts — homeowner and co-customer names,
// filing history. CLAUDE.md always said it was org-scoped; it was not (no org column at all,
// and 224 of 226 production rows have no project to scope through). Every write now stamps
// org_id from the project row or the session/job, the risk report reads only the project's
// org, and the SHARED permit_utility_knowledge rollup keeps bucket/rootCause/requiredAction/
// count/lastSeenAt — never the excerpt.
//
// Drives the REAL write paths (learnFromCorrection, learnFromHistoricalDocument, the mbox
// importer) and the real report, the same shape routeScope uses: org A's row, org B's view.
import "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

async function main(): Promise<void> {
  const { openDatabase } = await import("../src/db");
  const kb = await import("../src/knowledgeBase");
  const { classifyCorrection } = await import("../src/corrections");
  const { buildHistoricalFailureReport } = await import("../src/historicalFailures");
  const { deleteProject } = await import("../src/repository");
  const db = await openDatabase();

  const ORG_A = "org-aaaa1111";
  const ORG_B = "org-bbbb2222";
  const now = new Date().toISOString();
  for (const org of [ORG_A, ORG_B]) db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [org, org, now]);

  const mkProject = (id: string, orgId: string) => {
    db.run(
      `INSERT INTO projects (id, org_id, homeowner_name, city, state, ahj, utility, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'T Test', 'Coos Bay', 'OR', 'City of Coos Bay', 'Pacific Power', 'parsed', '{}', ?, ?)`,
      [id, orgId, now, now],
    );
    return {
      id, clientId: null, homeownerName: "T Test", projectAddress: "1 Main St", city: "Coos Bay", state: "OR", zip: "97420",
      ahj: "City of Coos Bay", utility: "Pacific Power", accountNumber: "", meterNumber: "", systemSizeDcKw: 5, systemSizeAcKw: 5,
      totalExportKw: null, interconnectionMethod: "", status: "parsed", currentStage: "", parserConfidenceSummary: "",
      parserSnapshot: {}, createdAt: now, updatedAt: now,
    } as never as Parameters<typeof kb.learnFromCorrection>[1];
  };
  const projA = mkProject("proj-aaaa", ORG_A);
  const projB = mkProject("proj-bbbb", ORG_B);

  // A correction excerpt naming a co-customer, learned from org A's project.
  const SECRET_NAME = "Quentin Marlowe";
  const correctionText = `Hi ${SECRET_NAME}, the application is missing the meter photo and the account number does not match the utility bill. Please revise and resubmit.`;
  kb.learnFromCorrection(db, projA, null, classifyCorrection(correctionText), correctionText, "manual");

  const hfe = db.query<{ org_id: string; project_id: string; sample: string }>("SELECT org_id, project_id, sample FROM historical_failure_examples");
  check("SETUP: the correction wrote a historical failure row", hfe.length === 1, String(hfe.length));
  check("the row is stamped with the PROJECT's org", hfe[0]?.org_id === ORG_A, String(hfe[0]?.org_id));

  const reportA = buildHistoricalFailureReport(db, projA.id, null);
  check("positive control: org A's own report sees its failure record", reportA.matchedFailureRecordCount >= 1, String(reportA.matchedFailureRecordCount));
  const reportB = buildHistoricalFailureReport(db, projB.id, null);
  check("org B's report for the SAME state/AHJ/utility sees none of org A's records",
    reportB.matchedFailureRecordCount === 0, String(reportB.matchedFailureRecordCount));
  check("…and no learned cause at all", !reportB.topRejectionCauses.some((c) => c.count > 0));
  check("…and org A's excerpt appears nowhere in org B's report", !JSON.stringify(reportB).includes(SECRET_NAME));
  // Even a superadmin (null) viewing B's project gets B's history, not the pool.
  let crossed = "";
  try { buildHistoricalFailureReport(db, projA.id, ORG_B); crossed = "returned"; } catch (err) { crossed = String((err as { status?: number }).status ?? err); }
  check("a caller scoped to org B asking for org A's project gets 404", crossed === "404", crossed);

  // The SHARED rollup: counts and causes pool, the excerpt never does.
  const key = kb.knowledgeProfileKey({ state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power" });
  const sharedRaw = (): string => String(db.get<{ c: string }>("SELECT common_corrections_json c FROM permit_utility_knowledge WHERE profile_key = ?", [key])?.c ?? "");
  check("SETUP: the shared row learned the pattern", sharedRaw().includes("rootCause"), sharedRaw().slice(0, 120));
  check("the shared rollup stores no sample text on learn", !sharedRaw().includes('"sample"') && !sharedRaw().includes(SECRET_NAME), sharedRaw().slice(0, 300));

  // An mbox import and a batch scan under org B stamp org B (session / job org, not a body field).
  const before = db.query<{ id: string }>("SELECT id FROM historical_failure_examples").map((r) => r.id);
  await kb.importMboxKnowledge(db, {
    orgId: ORG_B,
    sourceLabel: "fixture.mbox",
    mboxText: `From reviewer@example.com Mon Jun 15 10:00:00 2026
Subject: Pacific Power PowerClerk correction required
Date: Mon, 15 Jun 2026 10:00:00 -0700

Correction required. Pacific Power PowerClerk application is missing meter photo and UL 1741 SB inverter settings. Please revise and resubmit.
`,
  });
  kb.learnFromHistoricalDocument(db, {
    orgId: ORG_B, state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    sourceLabel: `batch:${SECRET_NAME} - Coos Bay, OR.pdf`, docKind: "correction",
    correctionText: "Provide rafter span calculations stamped by an engineer.",
  });
  const added = db.query<{ id: string; org_id: string; source_type: string }>("SELECT id, org_id, source_type FROM historical_failure_examples")
    .filter((r) => !before.includes(r.id));
  check("SETUP: the mbox import and the batch scan each wrote a failure row",
    added.some((r) => r.source_type === "mbox") && added.some((r) => r.source_type === "batch_import"), JSON.stringify(added.map((r) => r.source_type)));
  check("…both stamped with the importing org", added.length > 0 && added.every((r) => r.org_id === ORG_B), JSON.stringify(added.map((r) => r.org_id)));
  check("org A's report still sees only org A's history",
    buildHistoricalFailureReport(db, projA.id, null).matchedFailureRecordCount === reportA.matchedFailureRecordCount);

  // A batch file name is "First Last - City, ST.pdf". It may reach the org-scoped row, never the shared one.
  const sharedRow = db.get<{ sources_json: string }>("SELECT sources_json FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
  check("the shared profile's sources never carry the batch file name", !String(sharedRow?.sources_json).includes(SECRET_NAME), String(sharedRow?.sources_json).slice(0, 300));
  const sharedEvents = db.query<{ details: string }>("SELECT details FROM knowledge_events WHERE profile_key = ?", [key]);
  check("…nor do the shared knowledge events", !sharedEvents.some((e) => e.details.includes(SECRET_NAME)));

  // The rebuild path (deleteProject → rebuildKnowledgeRollup) must not copy samples either.
  deleteProject(db, projA.id);
  check("the rollup REBUILD stores no sample text", !sharedRaw().includes('"sample"'), sharedRaw().slice(0, 300));
  check("…and the KB API never serves a sample key",
    !kb.listKnowledgeProfiles(db).some((p) => p.commonCorrections.some((c) => "sample" in (c as object))));

  db.close();
  if (failures) {
    console.error(`\nhfeOrgScope: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nhfeOrgScope: all passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
