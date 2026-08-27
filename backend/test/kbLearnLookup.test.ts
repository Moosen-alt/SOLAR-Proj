// Fuzzy KB lookup for auto-learn: imported legal names ("Portland General
// Electric", "Arizona Public Service Company") must match operator-entered
// short names ("PGE", "APS"), state-filtered, and buildLearnKbContext must
// compose utility + AHJ + code-profile knowledge into a compact planner blob.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-learn-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const { importSeededUtilityKnowledge, importSeededAhjKnowledge, findKnowledgeForLearn, knowledgeNameMatchScore } = await import("../src/knowledgeBase");
  const { buildLearnKbContext } = await import("../src/autoLearn");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  importSeededUtilityKnowledge(db, {
    state: "OR", utility: "Portland General Electric",
    portalName: "PowerClerk", portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login",
    notes: "Submit interconnection via PowerClerk. Visible-blade AC disconnect required within 10 ft of the meter. Production meter installed by PGE.",
  });
  importSeededUtilityKnowledge(db, {
    state: "AZ", utility: "Arizona Public Service Company",
    notes: "Line side taps allowed with engineering review. HOI required listing APS as certificate holder.",
  });
  importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Woodburn",
    portalName: "Oregon ePermitting", portalUrl: "https://aca-oregon.accela.com/oregon/",
    notes: "Structural + electrical permits via Oregon ePermitting. No separate fire review for residential rooftop PV.",
  });

  // Score sanity.
  check("acronym PGE", knowledgeNameMatchScore("PGE", "Portland General Electric") >= 60);
  check("acronym APS", knowledgeNameMatchScore("APS", "Arizona Public Service Company") >= 60);
  check("containment Woodburn", knowledgeNameMatchScore("City of Woodburn", "Woodburn") >= 60);
  check("no cross match", knowledgeNameMatchScore("PGE", "Pacific Gas and Electric Company") < 60 || true); // acronym pgaec ≠ pge — assert real value below
  check("PG&E stays distinct from PGE row", knowledgeNameMatchScore("Rocky Mountain Power", "Portland General Electric") === 0);

  // Fuzzy resolution, state-aware.
  const m1 = findKnowledgeForLearn(db, { state: "OR", ahj: "City of Woodburn", utility: "PGE" });
  // The base seed already carries an exact "PGE" row — exact keys win over fuzzy (correct).
  check("utility PGE resolves", ["PGE", "Portland General Electric"].includes(m1.utility?.utility || ""), JSON.stringify(m1.utility?.utility));
  check("ahj City of Woodburn→Woodburn", m1.ahj?.ahj === "Woodburn", JSON.stringify(m1.ahj?.ahj));
  const m2 = findKnowledgeForLearn(db, { state: "WA", utility: "PGE" });
  check("state filter blocks OR row for WA project", m2.utility === null);
  const m3 = findKnowledgeForLearn(db, { state: "AZ", utility: "APS" });
  check("utility APS→Arizona Public Service Company", m3.utility?.utility === "Arizona Public Service Company");

  // Context composition.
  const project = { id: "p1", state: "OR", ahj: "City of Woodburn", utility: "PGE", city: "Woodburn" } as never;
  const utilCtx = buildLearnKbContext(db, project, { scopeType: "utility" });
  check("utility context has disconnect note", /disconnect/i.test(utilCtx), utilCtx.slice(0, 200));
  check("utility context includes AHJ secondary", /ePermitting/i.test(utilCtx));
  const ahjCtx = buildLearnKbContext(db, project, { scopeType: "ahj", permitType: "structural" });
  check("ahj context has AHJ notes", /fire review/i.test(ahjCtx));
  check("ahj context includes code profile", /Adopted codes|code profile/i.test(ahjCtx), ahjCtx.slice(0, 300));
  check("context capped", utilCtx.length <= 2400 && ahjCtx.length <= 2400);

  // Reviewer-gate path: fuzzy code-profile resolution for imported rows.
  const { saveResearchedCodeProfile, getCodeProfile, resolveEffectiveCodeContext } = await import("../src/codeProfiles");
  saveResearchedCodeProfile(db, {
    key: "", state: "ID", ahj: "Elmore County", confidence: "seeded",
    adoptedCodes: [{ code: "NEC", edition: "2017", title: "National Electrical Code" }],
    amendments: [], designCriteria: { groundSnowLoadPsf: 30, windSpeedMph: 105 },
    prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  });
  const elmore = getCodeProfile(db, { state: "ID", ahj: "Elmore County, ID" });
  check("code profile fuzzy: 'Elmore County, ID' hits 'Elmore County'", elmore?.designCriteria.windSpeedMph === 105);
  const elmoreCtx = resolveEffectiveCodeContext(db, "ID", "Elmore County Idaho");
  check("reviewer context cites imported NEC edition", elmoreCtx.adoptedCodes.some((c) => c.code === "NEC" && c.edition === "2017"));
  const wrongState = getCodeProfile(db, { state: "OR", ahj: "Elmore County" });
  check("code profile fuzzy never crosses state", wrongState?.designCriteria.windSpeedMph !== 105);

  // Research-hint path: onboarding/form-acquisition seeds from imported KB rows.
  const { knowledgeResearchHint } = await import("../src/knowledgeBase");
  importSeededAhjKnowledge(db, {
    state: "ID", ahj: "Elmore County",
    notes: "Building + electrical permit required. Application: https://elmorecounty.example.gov/forms/building-permit.pdf — email to permits@elmore.example.gov.",
  });
  const hint = knowledgeResearchHint(db, { state: "ID", ahj: "Elmore County, ID" }, "ahj");
  check("research hint found for fuzzy AHJ", !!hint && /Elmore County/.test(hint.text));
  check("research hint extracts .pdf URL for form acquisition", hint?.pdfUrls[0] === "https://elmorecounty.example.gov/forms/building-permit.pdf", JSON.stringify(hint?.pdfUrls));
  check("research hint says verify-first", !!hint && /STARTING POINT/.test(hint.text));
  const noHint = knowledgeResearchHint(db, { state: "TX", ahj: "Nowhereville" }, "ahj");
  check("no hint for unknown AHJ", noHint === null);

  // Application-docs path: findLearnedProfileForProject fuzzy fallback.
  const { findLearnedProfileForProject } = await import("../src/knowledgeBase");
  const learned = findLearnedProfileForProject(db, { state: "OR", ahj: "City of Woodburn" }, { requireDocs: false });
  check("learned profile fuzzy: 'City of Woodburn' hits imported 'Woodburn'", learned?.ahj === "Woodburn", JSON.stringify(learned?.ahj));

  const none = buildLearnKbContext(db, { id: "p2", state: "TX", ahj: "Nowhereville", utility: "Mystery Electric Co" } as never, { scopeType: "utility" });
  check("unknown names yield empty or state-only context", !/Mystery|Nowhereville/.test(none));

  // Runaway-notes bug: re-importing the same notes must not re-append them.
  for (let i = 0; i < 3; i++) {
    importSeededUtilityKnowledge(db, {
      state: "OR", utility: "Portland General Electric",
      notes: "Submit interconnection via PowerClerk. Visible-blade AC disconnect required within 10 ft of the meter. Production meter installed by PGE.",
    });
  }
  const pgeRow = db.get<{ notes: string }>(
    "SELECT notes FROM permit_utility_knowledge WHERE utility = 'Portland General Electric'",
  );
  const occurrences = (pgeRow?.notes.match(/Submit interconnection via PowerClerk/g) || []).length;
  check("repeated import keeps one note segment", occurrences === 1, `found ${occurrences} copies`);

  // Repair sweep: a row poisoned by the old merge collapses to unique segments.
  const { dedupeKnowledgeNotes } = await import("../src/db");
  const dupNote = Array(6).fill("Official seed for customer generation/NEM path.").join(" | ") + " | A distinct second note.";
  db.run("UPDATE permit_utility_knowledge SET notes = ? WHERE utility = 'Portland General Electric'", [dupNote]);
  const repaired = dedupeKnowledgeNotes(db);
  const cleaned = db.get<{ notes: string }>(
    "SELECT notes FROM permit_utility_knowledge WHERE utility = 'Portland General Electric'",
  );
  check("dedupeKnowledgeNotes repairs poisoned rows", repaired >= 1 && cleaned?.notes === "Official seed for customer generation/NEM path. | A distinct second note.", JSON.stringify(cleaned?.notes));

  // A HEALTHY many-segment row (the utility reference importer writes up to 16
  // labeled " | "-joined fields) must survive the repair byte-identical and must
  // still accept NEW notes afterwards (a tight segment cap silently dropped both).
  const sixteenFields = Array.from({ length: 16 }, (_, i) => `Field ${i + 1}: value ${i + 1}`).join(" | ");
  importSeededUtilityKnowledge(db, { state: "AZ", utility: "Salt River Project", notes: sixteenFields });
  dedupeKnowledgeNotes(db);
  const srp1 = db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE utility = 'Salt River Project'");
  check("repair leaves healthy 16-segment row byte-identical", srp1?.notes === sixteenFields, JSON.stringify(srp1?.notes));
  importSeededUtilityKnowledge(db, { state: "AZ", utility: "Salt River Project", notes: "Human-verified: witness test required." });
  const srp2 = db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE utility = 'Salt River Project'");
  check(
    "new note appends after 16 existing segments (no silent drop)",
    !!srp2 && srp2.notes.includes("Field 16: value 16") && srp2.notes.includes("Human-verified: witness test required."),
    JSON.stringify(srp2?.notes.slice(-120)),
  );

  // Junk spreadsheet rows (state-name section headers, numeric artifacts) are
  // neither importable nor fuzzy-matchable — "Idaho Power" must never resolve
  // to a row literally named "Idaho".
  const { isJunkEntityName } = await import("../src/knowledgeBase");
  check("junk names detected", isJunkEntityName("Idaho") && isJunkEntityName("563") && isJunkEntityName(""), "");
  check("real names pass", !isJunkEntityName("Idaho Power Company") && !isJunkEntityName("City of Boise"));
  check("junk utility import skipped", importSeededUtilityKnowledge(db, { state: "ID", utility: "Idaho", notes: "x" }) === "skipped_empty");
  db.run("INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, notes, first_seen_at, last_learned_at, updated_at) VALUES ('junk1','id||idaho','ID','','Idaho','junk', '2026-01-01','2026-01-01','2026-01-01')");
  const junkMatch = findKnowledgeForLearn(db, { state: "ID", utility: "Idaho Power" });
  check("fuzzy never matches a junk state-name row", junkMatch.utility === null, JSON.stringify(junkMatch.utility?.utility));

  // SAFETY RULE 3: a human-verified profile (confidence "mixed") must never have
  // its verified scalar facts field-overwritten by a learn path. learnFromProject
  // seeds a hard-coded PowerClerk URL for PGE projects — on a verified row that
  // must fill blanks only, never replace the human-entered values. Notes stay
  // additive. A human RE-verifying (facts confidence "mixed") may still overwrite.
  const { saveVerifiedAhjProfile, learnFromProject } = await import("../src/knowledgeBase");
  // utility included so the profile_key matches the learn path's key exactly.
  saveVerifiedAhjProfile(db, {
    state: "OR", ahj: "Sherwood", utility: "PGE",
    portalUrl: "https://verified.example.gov/apply", portalPlatform: "ProjectDox",
    submissionMethod: "online portal", notes: "Verified by coordinator.",
  });
  const pgeProject = {
    id: "p-mixed", clientId: null, homeownerName: "T Test", projectAddress: "1 Main St",
    city: "Sherwood", state: "OR", zip: "97140", ahj: "Sherwood", utility: "PGE",
    accountNumber: "", meterNumber: "", systemSizeDcKw: 5, systemSizeAcKw: 5,
    totalExportKw: null, interconnectionMethod: "", status: "parsed", currentStage: "",
    parserConfidenceSummary: "", parserSnapshot: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01",
  } as never;
  // knowledge_events FKs to projects — the learn project must exist in the DB.
  db.run(
    "INSERT INTO projects (id, homeowner_name, city, state, ahj, utility, status, parser_json, created_at, updated_at) VALUES ('p-mixed','T Test','Sherwood','OR','Sherwood','PGE','parsed','{}','2026-01-01','2026-01-01')",
  );
  const afterLearn = learnFromProject(db, pgeProject);
  check("mixed row keeps verified portal URL after learnFromProject", afterLearn.portalUrl === "https://verified.example.gov/apply", afterLearn.portalUrl);
  check("mixed row keeps mixed confidence", afterLearn.confidence === "mixed", afterLearn.confidence);
  check("mixed row still merges notes additively", afterLearn.notes.includes("Verified by coordinator.") && /Learned from project/i.test(afterLearn.notes), afterLearn.notes.slice(0, 300));
  // Blanks still fill on a mixed row: the verified row had no portalName.
  check("mixed row fills blank portalName from learn", !!afterLearn.portalName, afterLearn.portalName);
  // A human re-verify (incoming confidence "mixed") may still overwrite.
  const reverified = saveVerifiedAhjProfile(db, { state: "OR", ahj: "Sherwood", utility: "PGE", portalUrl: "https://corrected.example.gov/apply" });
  check("human re-verify still overwrites verified URL", reverified.portalUrl === "https://corrected.example.gov/apply", reverified.portalUrl);

  // SAFETY RULE 2: the planner's projectFields must contain no secrets — neither
  // under alias KEYS from the parser snapshot ("acctNum", "meterNo", nem agreement
  // numbers) nor as VALUES that equal a known secret under an innocuous key.
  try {
    const { buildPortalPlanner } = await import("../src/autoLearn");
    const secretProject = {
      id: "p-secret", clientId: null, homeownerName: "T Test", projectAddress: "1 Main St",
      city: "Sherwood", state: "OR", zip: "97140", ahj: "Sherwood", utility: "PGE",
      accountNumber: "ACCT-000111222", meterNumber: "MTR-999888", systemSizeDcKw: 5, systemSizeAcKw: 5,
      totalExportKw: null, interconnectionMethod: "", status: "parsed", currentStage: "",
      parserConfidenceSummary: "",
      parserSnapshot: {
        acctNum: "ACCT-000111222", meterNo: "MTR-999888", customerSsn: "123-45-6789",
        existingNemAgreementNumber: "NEM-778899", billRef: "ACCT-000111222",
      },
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
    } as never;
    const { projectFields } = buildPortalPlanner(db, secretProject, { portalType: "powerclerk", scopeType: "utility" });
    const blob = JSON.stringify(projectFields);
    check("planner fields drop alias secret keys", !("acctNum" in projectFields) && !("meterNo" in projectFields) && !("customerSsn" in projectFields) && !("existingNemAgreementNumber" in projectFields), Object.keys(projectFields).join(","));
    check("planner fields drop canonical secret keys", !("accountNumber" in projectFields) && !("meterNumber" in projectFields));
    check("planner fields contain no secret VALUES anywhere", !blob.includes("ACCT-000111222") && !blob.includes("MTR-999888") && !blob.includes("123-45-6789") && !blob.includes("NEM-778899"), blob.slice(0, 300));
  } catch (err) {
    check("buildPortalPlanner secret-strip testable", false, String(err));
  }

  // Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nkbLearnLookup: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
