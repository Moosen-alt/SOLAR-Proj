// SALEM'S STAMP ANSWER USED TO DEPEND ON HOW THE OPERATOR SPELLED THE AHJ.
//
// The sanitized workbook import created TWO Oregon reference rows that both answered for
// Salem and DISAGREED:
//   "Marion Co/Hubbard OR/Keizer OR / Mount Angel / Salem / Gervais" → requiresStructuralStamp false
//   "Salem"                                                          → requiresStructuralStamp TRUE
// findAhjProcessProfile scored them 67–67 on a project spelled "City of Salem" (city
// "Salem"), so the combined row won on FILE ORDER — while a project entered as bare "Salem"
// with no city scored the specific row 202 and got the opposite answer. Measured before the
// fix, on the real resolver:
//   ahj="City of Salem" city="Salem" -> row="Marion Co/…/Salem/Gervais" stamp.required=false
//   ahj="Salem"         city=""      -> row="Salem"                     stamp.required=TRUE  (source=process_profile)
// That is a sealed structural letter demanded on a PRESCRIPTIVE Salem job, or not, decided
// by a spelling. Both live Salem projects are the same homeowner (Daniel Daly) entered two
// different ways — cf1c56aa as "City of Salem" and 8f4ca8dd as "City Of Salem".
//
// OPERATOR RULING 2026-09-19: Salem does NOT require a PE stamp on the prescriptive path;
// a stamp IS required on the engineered path — the same strict split as Coos Bay. The fix
// is in the reference data (Salem is its own row, requiresStructuralStamp false, and is no
// longer listed on the combined Marion County row), because resolveStampRequirement reads
// THAT, not the knowledge base. The knowledge base carries the ruling's provenance.
//
// Run: tsx backend/test/salemStampRuling.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "salem-ruling-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.MONITOR_INTERVAL_MINUTES = "0";

const { openDatabase } = await import("../src/db");
const { findAhjProcessProfile, allAhjProcessProfiles } = await import("../src/processProfiles");
const { resolveStampRequirement, resolvePermitPath } = await import("../src/permitPath");
const kb = await import("../src/knowledgeBase");

let failures = 0;
const check = (name: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${name}`); }
  catch (err) { failures++; console.error(`  FAIL - ${name}\n         ${(err as Error).message}`); }
};

// The live prescriptive shape: microinverter roof mount whose structural inputs clear the
// screen. resolvePermitPath must call this "prescriptive" or the test is exercising the
// engineered branch and proves nothing about the ruling.
const PRESCRIPTIVE_SNAPSHOT: Record<string, string> = {
  mounting: "roof-mounted", pvMicroMake: "AP Systems", pvMicroModel: "DS3-L",
  snow: "25", deadLoad: "3.1", roofRafterSpacing: "24", wind: "B", windSpeed: "98",
};

const salemProject = (ahj: string, city: string, snapshot = PRESCRIPTIVE_SNAPSHOT) => ({
  ahj, city, state: "OR", utility: "PGE", systemSizeDcKw: 7.48, parserSnapshot: snapshot,
}) as never;

// Every spelling the live database and the two intake surfaces can produce.
const SPELLINGS: Array<[string, string]> = [
  ["City of Salem", "Salem"],   // live project cf1c56aa
  ["City Of Salem", "Salem"],   // live project 8f4ca8dd
  ["Salem", "Salem"],
  ["Salem", ""],                // the spelling that used to flip the answer
  ["City of Salem", ""],
  ["SALEM", ""],
  ["Salem, OR", ""],
  ["city of salem", ""],
];

check("the prescriptive fixture really resolves to the prescriptive path", () => {
  const res = resolvePermitPath(salemProject("City of Salem", "Salem"));
  assert.equal(res.path, "prescriptive",
    `the fixture resolves ${res.path}, so the stamp assertions below would be testing the wrong branch: ${res.basis.join(" | ")}`);
});

check("EXACTLY ONE Oregon reference row answers for Salem", () => {
  const answering = allAhjProcessProfiles().filter(
    (p) => p.state.toUpperCase() === "OR" && /\bsalem\b/i.test(p.ahj));
  assert.deepEqual(answering.map((p) => p.ahj), ["Salem"],
    `more than one OR reference row still claims Salem: ${JSON.stringify(answering.map((p) => p.ahj))}`);
});

check("every Salem spelling resolves to the SAME reference row", () => {
  const rows = SPELLINGS.map(([ahj, city]) => findAhjProcessProfile(salemProject(ahj, city))?.ahj ?? null);
  const distinct = [...new Set(rows)];
  assert.deepEqual(distinct, ["Salem"],
    `Salem spellings resolved to ${JSON.stringify(distinct)} — the answer still depends on the spelling`);
});

check("no Salem spelling demands a PE stamp on the PRESCRIPTIVE path", () => {
  for (const [ahj, city] of SPELLINGS) {
    const project = salemProject(ahj, city);
    const profile = findAhjProcessProfile(project);
    const stamp = resolveStampRequirement(project, {
      processProfileRequiresStamp: profile?.requiresStructuralStamp,
      jurisdictionLabel: profile?.ahj,
    });
    assert.equal(stamp.required, false,
      `ahj=${JSON.stringify(ahj)} city=${JSON.stringify(city)} demanded a stamp on a prescriptive job `
      + `(row=${JSON.stringify(profile?.ahj)}, source=${stamp.source}): ${stamp.reason}`);
  }
});

check("the ENGINEERED path still requires the stamp, for every spelling", () => {
  for (const [ahj, city] of SPELLINGS) {
    const project = salemProject(ahj, city, { permitPathOverride: "engineered" });
    const profile = findAhjProcessProfile(project);
    const stamp = resolveStampRequirement(project, {
      processProfileRequiresStamp: profile?.requiresStructuralStamp,
      jurisdictionLabel: profile?.ahj,
    });
    assert.equal(stamp.required, true, `ahj=${JSON.stringify(ahj)} lost the engineered stamp requirement`);
    assert.equal(stamp.source, "engineered_path", `ahj=${JSON.stringify(ahj)} source=${stamp.source}`);
  }
});

check("the ruling is recorded in the reference row itself, with its date", () => {
  const salem = allAhjProcessProfiles().find((p) => p.state.toUpperCase() === "OR" && p.ahj === "Salem");
  assert.ok(salem, "the Salem reference row is gone");
  assert.match(salem!.reviewerNotes, /OPERATOR RULING 2026-09-19/,
    "the Salem row's flag was changed with no record of who decided it or when — an undated flip reads as a typo");
  // The merge: the combined row's portal must not be lost when Salem is split out of it.
  assert.equal(salem!.submissionMethod, "OR E-permitting",
    "Salem lost its submission method when it was split off the combined Marion County row");
});

check("RETIRING SALEM DID NOT STRAND ITS NEIGHBOURS on the combined row", () => {
  for (const neighbour of ["Keizer", "Hubbard", "Gervais", "Mount Angel"]) {
    const row = findAhjProcessProfile(salemProject(neighbour, ""))?.ahj ?? "";
    assert.match(row, /Marion Co\/Hubbard/,
      `${neighbour} no longer resolves the combined Marion County row (got ${JSON.stringify(row)})`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// The knowledge base: the ruling's PROVENANCE, on both stored AHJ spellings.
// ═══════════════════════════════════════════════════════════════════════════════

const db = await openDatabase();
kb.seedInitialKnowledgeBase(db);

const RULING_SOURCE = "Operator ruling 2026-09-19";
const ruledRowFor = (ahj: string) => kb.findLearnedProfileForProject(db, { state: "OR", ahj }, { requireDocs: false });

check("both stored Salem spellings resolve to a row carrying the operator provenance", () => {
  const keys = new Set<string>();
  for (const ahj of ["Salem", "City of Salem", "City Of Salem"]) {
    const row = ruledRowFor(ahj);
    assert.ok(row, `no knowledge row resolves for ${JSON.stringify(ahj)}`);
    keys.add(row!.profileKey);
    assert.match(row!.notes, /OPERATOR RULING 2026-09-19/,
      `${row!.profileKey} does not carry the ruling`);
    const source = row!.sources.find((s) => s.label === RULING_SOURCE);
    assert.ok(source, `${row!.profileKey} carries the ruling with no operator source: ${JSON.stringify(row!.sources.map((s) => s.label))}`);
    // THE DATE OF THE DECISION, not of the boot that wrote it.
    assert.match(source!.observedAt, /^2026-09-19/, `${row!.profileKey} source observedAt=${source!.observedAt}`);
    assert.equal(row!.confidence, "mixed",
      `${row!.profileKey} is ${row!.confidence} — an operator ruling IS a human gesture and must be human-verified`);
  }
  // The two case spellings are the same stored row; "Salem" is the other.
  assert.ok(keys.size <= 2, `Salem spellings spread over ${keys.size} knowledge rows: ${[...keys].join(", ")}`);
  assert.equal(ruledRowFor("City of Salem")!.profileKey, ruledRowFor("City Of Salem")!.profileKey,
    "\"City of Salem\" and \"City Of Salem\" resolve to different knowledge rows");
});

check("the superseded combined row says where Salem's answer moved", () => {
  // The live database carries the PRE-SPLIT combined row (it was seeded from the workbook
  // before Salem was split out) and will keep carrying it: a stored profile_key is a
  // matching key, so the row is stamped rather than deleted. A fresh test database has no
  // such row, so create it the way the workbook import does and then re-seed — otherwise
  // this check passes by finding nothing, which is not the same as passing.
  const legacyKey = "or|marion co hubbard or keizer or mount angel salem gervais|unknown";
  kb.importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Marion Co/Hubbard OR/Keizer OR / Mount Angel / Salem / Gervais",
    sourceLabel: "Sanitized Infinity AHJ process workbook", notes: "Pre-split combined row.",
  });
  assert.ok(db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE profile_key = ?", [legacyKey]),
    "could not recreate the pre-split combined row, so this check would prove nothing");
  kb.seedInitialKnowledgeBase(db);
  const row = db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE profile_key = ?", [legacyKey]);
  assert.ok(row, "the pre-split combined row vanished — a stored key must never be deleted out from under an old lookup");
  assert.match(row!.notes, /SALEM SPLIT OUT 2026-09-19/,
    "the pre-split combined row is still reachable and says nothing about Salem having moved");
});

check("re-seeding is idempotent — the ruling does not grow or re-date on every boot", () => {
  const snap = () => db.query<{ profile_key: string; notes: string; sources_json: string; confidence: string }>(
    "SELECT profile_key, notes, sources_json, confidence FROM permit_utility_knowledge WHERE profile_key IN ('or|salem|unknown','or|city of salem|unknown') ORDER BY profile_key");
  const before = snap();
  kb.seedInitialKnowledgeBase(db);
  const after = snap();
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    const rulingSource = (json: string) => JSON.parse(json).filter((s: { label: string }) => s.label === RULING_SOURCE);
    assert.equal(after[i].notes, before[i].notes, `${after[i].profile_key} notes changed on re-seed`);
    assert.equal(after[i].confidence, before[i].confidence, `${after[i].profile_key} confidence changed on re-seed`);
    assert.deepEqual(rulingSource(after[i].sources_json), rulingSource(before[i].sources_json),
      `${after[i].profile_key} operator source changed on re-seed`);
  }
});

if (failures) {
  console.error(`\nsalemStampRuling: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nsalemStampRuling: all checks passed.");
