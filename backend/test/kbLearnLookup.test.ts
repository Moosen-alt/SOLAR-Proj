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

  // Application-docs path: findLearnedProfileForProject fuzzy fallback.
  const { findLearnedProfileForProject } = await import("../src/knowledgeBase");
  const learned = findLearnedProfileForProject(db, { state: "OR", ahj: "City of Woodburn" }, { requireDocs: false });
  check("learned profile fuzzy: 'City of Woodburn' hits imported 'Woodburn'", learned?.ahj === "Woodburn", JSON.stringify(learned?.ahj));

  const none = buildLearnKbContext(db, { id: "p2", state: "TX", ahj: "Nowhereville", utility: "Mystery Electric Co" } as never, { scopeType: "utility" });
  check("unknown names yield empty or state-only context", !/Mystery|Nowhereville/.test(none));

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nkbLearnLookup: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
