// HARD RULE 3 LOCKS ON A PERSON, NOT ON A LABEL.
//
// confidence "mixed" used to mean BOTH "a human verified this row" and "a seeded row met a
// learned write" (confidenceFrom's automatic merge). Every rule-3 check read "mixed" as
// verified, so 25 of the 32 production "mixed" rows were locked against correction and
// against the operator's reference re-import although no person ever checked them.
// Verification now lives in verified_at, read through ONE predicate (isVerifiedKnowledge).
//
// This drives the REAL write paths: a batch-scan learn, the reference importer, the
// human-verified save, the project learn, and the v30 backfill replayed on a real DB.
import "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

async function main(): Promise<void> {
  const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
  const kb = await import("../src/knowledgeBase");
  let db = await openDatabase();
  const row = (key: string) => db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key]);

  // ── 1. learned + seeded is NOT verification: the re-import still corrects the row ──────
  kb.learnFromHistoricalDocument(db, {
    orgId: DEFAULT_ORG_ID, state: "OR", ahj: "Lockton", utility: "",
    requiredDocuments: ["Site plan"], sourceLabel: "batch:fixture.pdf", docKind: "permit_application",
  });
  const key = kb.knowledgeProfileKey({ state: "OR", ahj: "Lockton", utility: "" });
  check("SETUP: the batch learn wrote a learned row", String(row(key)?.confidence) === "learned", String(row(key)?.confidence));
  const first = kb.importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Lockton", portalUrl: "https://first.example.gov/permits", sourceLabel: "reference v1",
  });
  check("first reference import lands", first === "imported", first);
  const merged = row(key)!;
  check("seeded + learned is not labelled 'mixed'", String(merged.confidence) !== "mixed", String(merged.confidence));
  check("seeded + learned is not verified", !kb.isVerifiedKnowledge(merged), String(merged.verified_at));
  const second = kb.importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Lockton", portalUrl: "https://second.example.gov/permits", sourceLabel: "reference v2",
  });
  check("a corrected re-import is IMPORTED, not skipped_verified", second === "imported", second);
  check("…and the corrected URL actually lands", String(row(key)!.portal_url) === "https://second.example.gov/permits", String(row(key)!.portal_url));

  // ── 2. a human-verified save still refuses the re-import (rule 3 kept) ───────────────
  kb.saveVerifiedAhjProfile(db, {
    state: "OR", ahj: "Verifiedton", portalUrl: "https://human.example.gov/apply", verifiedBy: "user-abc12345",
  });
  const vKey = kb.knowledgeProfileKey({ state: "OR", ahj: "Verifiedton", utility: "" });
  const vRow = row(vKey)!;
  check("the verified save stamps verified_at", kb.isVerifiedKnowledge(vRow), String(vRow.verified_at));
  check("…and who verified it", String(vRow.verified_by) === "user-abc12345", String(vRow.verified_by));
  const refused = kb.importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Verifiedton", portalUrl: "https://import.example.gov/wrong", sourceLabel: "reference v3",
  });
  check("a verified row refuses the reference import", refused === "skipped_verified", refused);
  check("…and keeps the human URL", String(row(vKey)!.portal_url) === "https://human.example.gov/apply", String(row(vKey)!.portal_url));
  // A learn write can never clear or move the verification.
  const stampedAt = String(vRow.verified_at);
  kb.learnFromHistoricalDocument(db, { orgId: DEFAULT_ORG_ID, state: "OR", ahj: "Verifiedton", utility: "", sourceLabel: "batch:x.pdf" });
  check("a later learn leaves verified_at alone", String(row(vKey)!.verified_at) === stampedAt, String(row(vKey)!.verified_at));

  // ── 3. a seeded row learned from a real project is not promoted to 'mixed' ───────────
  kb.importSeededAhjKnowledge(db, { state: "OR", ahj: "Seedville", portalUrl: "https://seed.example.gov/", sourceLabel: "reference" });
  db.run(
    "INSERT INTO projects (id, homeowner_name, city, state, ahj, utility, status, parser_json, created_at, updated_at) VALUES ('p-seed','T Test','Seedville','OR','Seedville','','parsed','{}','2026-01-01','2026-01-01')",
  );
  const learned = kb.learnFromProject(db, {
    id: "p-seed", clientId: null, homeownerName: "T Test", projectAddress: "1 Main St", city: "Seedville", state: "OR", zip: "97000",
    ahj: "Seedville", utility: "", accountNumber: "", meterNumber: "", systemSizeDcKw: 5, systemSizeAcKw: 5, totalExportKw: null,
    interconnectionMethod: "", status: "parsed", currentStage: "", parserConfidenceSummary: "", parserSnapshot: {},
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  } as never);
  check("learnFromProject on a seeded row does not produce 'mixed'", learned.confidence !== "mixed", learned.confidence);
  check("…nor verification", !kb.isVerifiedKnowledge(learned), String(learned.verifiedAt));

  // ── 4. the v30 backfill: ONLY recorded human gestures, at the FIRST one ──────────────
  // A row a human verified before verified_at existed (event recorded, column empty)...
  const legacyKey = kb.knowledgeProfileKey({ state: "OR", ahj: "Legacyton", utility: "" });
  const officialKey = kb.knowledgeProfileKey({ state: "OR", ahj: "Officialton", utility: "" });
  const ts = "2026-01-01T00:00:00.000Z";
  for (const [k, ahj, sources] of [
    [legacyKey, "Legacyton", "[]"],
    // ...and a row carrying an 'official' source and 'mixed' but NO human event.
    [officialKey, "Officialton", JSON.stringify([{ label: "Official seed", url: "", sourceType: "official", observedAt: ts }])],
  ]) {
    db.run(
      `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, confidence, sources_json, notes, first_seen_at, last_learned_at, updated_at)
       VALUES (?, ?, 'OR', ?, '', 'https://stale.example.gov/', 'mixed', ?, '', ?, ?, ?)`,
      [`kb-${ahj}`, k, ahj, sources, ts, ts, ts],
    );
  }
  db.run("INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at) VALUES ('e1', ?, NULL, 'ahj.human_verified', '{}', '2026-03-05T00:00:00.000Z')", [legacyKey]);
  db.run("INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at) VALUES ('e2', ?, NULL, 'ahj.human_verified', '{}', '2026-02-01T00:00:00.000Z')", [legacyKey]);
  db.run("INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at) VALUES ('e3', ?, NULL, 'ahj.reference_imported', '{}', '2026-01-15T00:00:00.000Z')", [legacyKey]);
  db.run("INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at) VALUES ('e4', ?, NULL, 'ahj.reference_imported', '{}', '2026-01-15T00:00:00.000Z')", [officialKey]);
  check("SETUP: neither legacy row is verified before the backfill", !kb.isVerifiedKnowledge(row(legacyKey)) && !kb.isVerifiedKnowledge(row(officialKey)));
  db.run("DELETE FROM schema_meta WHERE version >= 30");
  db.close();
  db = await openDatabase();
  check("backfill verifies the row with a human-verification event, at its FIRST one",
    String(row(legacyKey)!.verified_at) === "2026-02-01T00:00:00.000Z", String(row(legacyKey)!.verified_at));
  check("backfill does NOT infer verification from an 'official' source or from 'mixed'",
    !kb.isVerifiedKnowledge(row(officialKey)), String(row(officialKey)!.verified_at));
  check("…so the official-but-unverified row takes a corrected re-import",
    kb.importSeededAhjKnowledge(db, { state: "OR", ahj: "Officialton", portalUrl: "https://fixed.example.gov/", sourceLabel: "reference" }) === "imported");
  // The upsert's own scalar lock must agree with the importer's skip: a legacy "mixed"
  // label with no verification may not hold the old URL in place.
  check("…and the corrected URL lands on the legacy-'mixed' row",
    String(row(officialKey)!.portal_url) === "https://fixed.example.gov/", String(row(officialKey)!.portal_url));
  check("backfill leaves the earlier human-verified save intact", String(row(vKey)!.verified_at) === stampedAt, String(row(vKey)!.verified_at));

  // ── 5. the operator ruling is verified on the date it was ruled, every boot ──────────
  const salem = row(kb.knowledgeProfileKey({ state: "OR", ahj: "Salem", utility: "" }))!;
  check("operator ruling row is verified", kb.isVerifiedKnowledge(salem), String(salem.verified_at));
  check("…as of the ruling date, not the boot", String(salem.verified_at).startsWith("2026-09-19"), String(salem.verified_at));

  // ── the project's packet card carries WHO stands behind its learned requirements ─────────
  // The KB list badges "Verified" from verifiedAt; the packet's learnedRequirements dropped it, so
  // the same operator-verified row read "Learned + seeded" on the project and "Verified" in the KB.
  {
    const R = await import("../src/repository");
    kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "Badgeton", requiredDocuments: ["Site plan", "Single-line diagram"], verifiedBy: "user-badge123" });
    const mk = (ahj: string) => R.createProject(db, { owner: `${ahj} Owner`, street: "1 Test St", city: ahj, state: "OR", zip: "97000", ahj, utility: "", dcKw: "5", acKw: "4" } as never).project.id;
    const verifiedPkg = R.getApplicationDocumentPackage(db, mk("Badgeton")).learnedRequirements;
    check("SETUP: the verified profile reaches the packet", Boolean(verifiedPkg), JSON.stringify(verifiedPkg));
    check("the packet's learnedRequirements carries verifiedAt for a verified row", Boolean(verifiedPkg?.verifiedAt) && verifiedPkg?.verifiedBy === "user-badge123", JSON.stringify(verifiedPkg));
    const learnedPkg = R.getApplicationDocumentPackage(db, mk("Lockton")).learnedRequirements;
    check("SETUP: the learned profile reaches the packet", Boolean(learnedPkg), JSON.stringify(learnedPkg));
    check("…and none for a row no person verified", !learnedPkg?.verifiedAt, JSON.stringify(learnedPkg));
  }

  db.close();
  if (failures) {
    console.error(`\nkbVerifiedLock: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nkbVerifiedLock: all passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
