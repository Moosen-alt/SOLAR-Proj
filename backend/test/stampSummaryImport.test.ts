// THE OPERATOR'S STAMP SHEET LANDS AS KNOWLEDGE, NEVER AS A TRAP.
//
// "Stamp_Requirements_by_AHJ" opens with a totals block, hides its real header
// mid-sheet, and mixes 18 states (including the city of Oregon, OHIO). The
// importer must read exactly the data rows, keep Yes-only amendments (a
// "...: No" line would hand every text-matching consumer the words "stamp
// required" to misread), skip human-verified rows (rule 3 — the boot seed
// ships the active six VERIFIED, so this arm is the production path, not an
// edge case), and re-import without duplicating.
// Run: tsx backend/test/stampSummaryImport.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-import-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { parseStampSummarySheet, importStampSummarySheet } = await import("../src/referenceImport");
const { getCodeProfile } = await import("../src/codeProfiles");
const { listKnowledgeProfiles } = await import("../src/knowledgeBase");
import type { SheetData } from "../src/xlsxRead";

const db = await openDatabase();
let failures = 0;
const run = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}: ${(e as Error).message}`); }
};
const kbFor = (state: string, ahj: string) =>
  listKnowledgeProfiles(db).find((p) => p.state === state && p.ahj.toLowerCase() === ahj.toLowerCase());

// Build the sheet the way readXlsx yields the REAL workbook: a totals block on
// top, the true header keyed by meaningless col names, then data rows.
const mk = (cells: string[][]): SheetData => ({
  name: "Stamp Summary",
  headers: ["col0", "AHJ Engineering Stamp Requirements Summary"],
  rows: cells.map((row) => Object.fromEntries(row.map((c, i) => [i === 0 ? "col0" : i === 1 ? "AHJ Engineering Stamp Requirements Summary" : `col${i}`, c]))),
});

const SHEET = mk([
  ["", "Total Jurisdictions", "Structural Stamp Required", "Electrical Stamp Required", "Both Stamps Required"],
  ["", "5", "3", "1", "1"],
  ["", "State", "AHJ / Jurisdiction", "Structural Stamp", "Electrical Stamp", "Both Required", "Special Notes"],
  ["", "OR", "Testville", "Yes", "No", "No", "Engineering with every submission"],
  ["", "OR", "Quietburg", "No", "No", "No", "Walk-in permit"],
  ["", "OR", "Salem", "Yes", "No", "No", "2x4 rafters need engineering; ground mount electrical only"],
  ["", "OH", "Oregon", "Yes", "Yes", "Yes", "CAD will need electrical and structural stamps"],
  ["", "AZ", "Cave Creek", "", "", "", "Structural calcs may accompany plans"],
  ["", "Totals footer", "", "", "", "", ""],
]);

console.log("\n1. PARSING: the embedded header is found, the chrome is not data");
run("exactly the five data rows parse (totals block + footer excluded)", () => {
  const rows = parseStampSummarySheet(SHEET);
  assert.equal(rows.length, 5, JSON.stringify(rows.map((r) => r.ahj)));
});
run("yes/no/blank flags parse; prose never fabricates a flag", () => {
  const rows = parseStampSummarySheet(SHEET);
  const t = rows.find((r) => r.ahj === "Testville")!;
  assert.equal(t.structural, "yes");
  assert.equal(t.electrical, "no");
  const cave = rows.find((r) => r.ahj === "Cave Creek")!;
  assert.equal(cave.structural, "");
  assert.equal(cave.electrical, "");
});
run("the city of Oregon, OHIO stays in OHIO (state comes from the row, never fuzzy)", () => {
  const rows = parseStampSummarySheet(SHEET);
  assert.equal(rows.find((r) => r.ahj === "Oregon")!.state, "OH");
});

console.log("\n2. IMPORT: seeded amendments + KB notes, Yes-only, no duplication");
const first = importStampSummarySheet(db, SHEET, {});
run("every row lands somewhere or is refused for a reason — none double-counted", () => {
  assert.equal(first.imported + first.skippedVerified + first.skippedEmpty, 5, JSON.stringify(first));
});
run("MUST PASS: an unseeded AHJ gets a seeded profile with the Yes flag and the note", () => {
  const t = getCodeProfile(db, { state: "OR", ahj: "Testville" })!;
  assert.ok(t, "no Testville profile written");
  assert.equal(t.confidence, "seeded");
  const sums = t.amendments.map((a) => a.summary);
  assert.ok(sums.includes("Structural stamp required: Yes"), sums.join(" | "));
  assert.ok(sums.some((x) => /Engineering with every submission/.test(x)), "the operator's note must survive");
});
run("MUST EXCLUDE: a No row gets NO 'stamp required' amendment for matchers to misread", () => {
  const q = getCodeProfile(db, { state: "OR", ahj: "Quietburg" })!;
  const sums = q.amendments.map((a) => a.summary);
  assert.ok(!sums.some((x) => /stamp required/i.test(x)), sums.join(" | "));
});
run("the KB note carries the FULL yes/no pair as prose", () => {
  const k = kbFor("OR", "Quietburg");
  assert.ok(k, "no Quietburg KB row");
  assert.match(String(k!.notes), /structural no, electrical no/i);
});
run("re-import is idempotent — amendments do not stack", () => {
  const before = getCodeProfile(db, { state: "OR", ahj: "Testville" })!.amendments.length;
  importStampSummarySheet(db, SHEET, {});
  const after = getCodeProfile(db, { state: "OR", ahj: "Testville" })!.amendments.length;
  assert.equal(after, before, `${before} -> ${after}`);
});

console.log("\n3. RULE 3: a human-verified OPERATOR RULING vetoes the workbook in BOTH lanes");
run("premise: the seed ships Salem's KB human-verified with the per-path stamp ruling", () => {
  const k = kbFor("OR", "City of Salem") ?? kbFor("OR", "Salem");
  assert.ok(k, "no Salem KB row in the seed");
  assert.match(String(k!.notes), /does not require a pe stamp on the prescriptive path/i);
});
run("the sheet's flat 'Salem: Yes' landed NOWHERE — no contradicting amendment, ruling note untouched", () => {
  const salem = getCodeProfile(db, { state: "OR", ahj: "Salem" });
  const sums = (salem?.amendments ?? []).map((a) => a.summary);
  assert.ok(!sums.some((x) => /^(Structural|Electrical) stamp required/.test(x)), sums.join(" | "));
  const k = kbFor("OR", "City of Salem") ?? kbFor("OR", "Salem");
  assert.ok(!/Stamps \(operator reference\)/.test(String(k!.notes)), "the workbook note must not stack onto the verified ruling");
});

console.log(failures ? `\nstampSummaryImport: ${failures} check(s) FAILED` : "\nstampSummaryImport: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
