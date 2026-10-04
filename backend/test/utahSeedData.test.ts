// UTAH SEED DATA (issue #109): the four shipped Utah AHJ process rows in
// backend/data/reference-ahj-processes.json (Salt Lake City, Provo, Lehi, Spanish Fork).
// Utah is the next test jurisdiction and had ZERO process rows, so findAhjProcessProfile
// answered null for every Utah project. Pins:
//   - each row resolves for its own city (and only its own: Salt Lake COUNTY is not the city);
//   - each row is web-researched, cites official .gov sources, and says it is seeded, not
//     verified (hard rule 3) — the KB row the boot seed writes from it is "seeded";
//   - no row names a bare information page as its submission method (hard rule 5);
//   - the rows pass the reference importer's own validation (importAhjProcessSheet, dry run).
// Run: tsx backend/test/utahSeedData.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile, ProjectRecord } from "../../shared/src/types";
import type { SheetData } from "../src/xlsxRead";

const { openDatabase } = await import("../src/db");
const { findAhjProcessProfile, ahjProcessKnowledgeStatus } = await import("../src/processProfiles");
const { importAhjProcessSheet } = await import("../src/referenceImport");
const { findKnowledgeForLearn } = await import("../src/knowledgeBase");

const db = await openDatabase();

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const file = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8")) as { count: number; profiles: AhjProcessProfile[] };
const UT_CITIES = ["Salt Lake City", "Provo", "Lehi", "Spanish Fork"];
const utRows = file.profiles.filter((p) => p.state === "UT");
const project = (ahj: string) => ({ state: "UT", ahj, city: ahj }) as unknown as ProjectRecord;

await run("the reference ships exactly the four researched Utah process rows; count stays true", () => {
  assert.deepEqual(utRows.map((r) => r.ahj).sort(), [...UT_CITIES].sort());
  assert.equal(file.count, file.profiles.length, "header count matches the rows");
  assert.equal(ahjProcessKnowledgeStatus().status, "resolved");
});

await run("each Utah city resolves to its own row; Salt Lake County does not read the city's", () => {
  for (const city of UT_CITIES) {
    const p = findAhjProcessProfile(project(city));
    assert.ok(p, `${city}: a process row`);
    assert.equal(p!.state, "UT");
    assert.equal(p!.ahj, city);
  }
  const county = findAhjProcessProfile({ state: "UT", ahj: "Salt Lake County" } as unknown as ProjectRecord);
  assert.notEqual(county?.ahj, "Salt Lake City", "a county project is not handed the city's process");
});

await run("every Utah row is seeded, cites official city sources, and names a portal (never an info page)", () => {
  for (const r of utRows) {
    assert.match(r.sourceSheet, /seeded/i, `${r.ahj}: sourceSheet says seeded`);
    assert.match(r.reviewerNotes, /NOT verified/, `${r.ahj}: notes say not verified`);
    const urls = r.reviewerNotes.match(/https:\/\/[^\s;]+/g) ?? [];
    assert.ok(urls.length > 0, `${r.ahj}: at least one source URL`);
    for (const u of urls) assert.match(new URL(u).hostname, /(^|\.)(slc|provo|lehi-ut|spanishfork)\.gov$/, `${r.ahj}: official source ${u}`);
    // Hard rule 5: the submission method names the permit platform, not a city information page.
    assert.match(r.submissionMethod, /\b(accela|cityview|iworq|citizenserve)\b/i, `${r.ahj}: platform named`);
    assert.doesNotMatch(r.submissionMethod, /https?:\/\//i, `${r.ahj}: no bare URL as the method`);
    for (const u of urls) {
      const page = new URL(u);
      assert.ok(!r.submissionMethod.toLowerCase().includes(`${page.hostname}${page.pathname}`.toLowerCase()), `${r.ahj}: the cited information page ${u} is not the portal`);
    }
  }
});

await run("boot seed writes each Utah row into the KB as SEEDED, never verified", () => {
  for (const city of UT_CITIES) {
    const kb = findKnowledgeForLearn(db, { state: "UT", ahj: city }).ahj;
    assert.ok(kb, `${city}: KB row`);
    assert.equal(kb!.confidence, "seeded", `${city}: seeded`);
    assert.ok(!kb!.verifiedAt, `${city}: never verified by the seed`);
  }
});

await run("reference-import dry run: the Utah rows pass the importer's validation and write nothing", () => {
  const sheet: SheetData = {
    name: "UT PROCESS",
    headers: ["Municipality", "Permit Search Website", "Special Notes"],
    rows: utRows.map((r) => ({ Municipality: r.ahj, "Permit Search Website": r.submissionMethod, "Special Notes": r.otherRequirements })),
  };
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge")!.n;
  const summary = importAhjProcessSheet(db, sheet, { dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.imported, utRows.length, `every row accepted (${JSON.stringify(summary)})`);
  assert.equal(summary.skippedEmpty, 0);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge")!.n, before, "dry run wrote nothing");
});

db.close();
if (failures > 0) {
  console.error(`\n${failures} Utah seed-data test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll Utah seed-data tests passed.`);
process.exit(0);
