// A PROFILE KEY IS NOT A UNIQUE ADDRESS FOR A RECIPE, AND THE QUESTION BANK ASSUMED IT WAS.
//
// Measured on the live database. City of Coos Bay holds TWO complete recipes under the one
// key "or|city of coos bay|pacific power" — the city/STRUCTURAL filing and the
// county/ELECTRICAL one, which is the whole reason recipes grew a discipline dimension.
// recipeForProfileKey ended in `LIMIT 1` and returned whichever sorted first.
//
// What that cost, before this fix:
//   · `npm run portal:triage` listed the ELECTRICAL recipe's questions TWICE and never once
//     showed the structural recipe's own. Its unknown question ("Residential - Structural"),
//     its per-job geometry (building height, stories, floor areas, dwelling units, number of
//     buildings) and its "Plans - Structural" attachment type were unreachable — no amount of
//     triaging could have surfaced them.
//   · apply-question-bindings read the electrical question set and then walked the STRUCTURAL
//     recipe's steps. Every structural label was absent from its `wanted` map, so it bound
//     nothing — a silent under-bind indistinguishable from "this recipe had nothing to bind".
//   · Both callers wrapped the call in `catch { = [] }`, so any failure became "this portal
//     asks no questions" — the same shape as success.
//
//   MUST PASS    — each recipe yields ITS OWN questions when the recipe is passed.
//   MUST EXCLUDE — an ambiguous profile key THROWS, naming both disciplines, instead of
//                  silently answering for one of them; a key with a single recipe still
//                  resolves by string (every older caller keeps working); and an unknown key
//                  is still an empty list, which is a different fact from an ambiguous one.
//
//   npx tsx backend/test/questionBankDiscipline.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "question-bank-discipline-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { startPortalRecording, getPortalRecipe } = await import("../src/portalRecipes");
const { extractPortalQuestions } = await import("../src/portalQuestionBank");

const db = await openDatabase();

let failures = 0;
const run = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const check = (label: string, value: string): RecipeStep => ({
  action: "check", phase: "fill", selector: { label }, note: label,
});
const fill = (label: string, value: string): RecipeStep => ({
  action: "fill", phase: "fill", selector: { label }, note: label, value,
});

// The two recipes, with the REAL labels each one carries on the live portal — different
// record types, and geometry that exists only on the structural side.
const STRUCTURAL: RecipeStep[] = [
  { action: "goto", phase: "login", value: "https://aca-oregon.accela.com/oregon/" },
  check("Residential - Structural", ""),
  fill("Building Height - Feet:", "15"),
  fill("Number of Stories:", "1"),
  fill("Existing Building Area:", "1675"),
  fill("attachment: document type", "Plans - Structural"),
];
const ELECTRICAL: RecipeStep[] = [
  { action: "goto", phase: "login", value: "https://aca-oregon.accela.com/oregon/" },
  check("Residential - Electrical", ""),
  fill("Project includes any of the following:", "01-Not Applicable"),
  fill("Renewable energy for electrical systems- 5.01kva through 15kva:", "1"),
  fill("attachment: document type", "Plans - Electrical"),
];

const seed = (discipline: string, steps: RecipeStep[]): string => {
  const stub = startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    portalPlatform: "accela", portalUrl: "https://aca-oregon.accela.com/oregon/", discipline,
  });
  db.run("UPDATE portal_recipes SET steps_json = ?, status = 'complete' WHERE id = ?", [JSON.stringify(steps), stub.id]);
  return stub.id;
};

const structuralId = seed("structural", STRUCTURAL);
const electricalId = seed("electrical", ELECTRICAL);
const KEY = getPortalRecipe(db, structuralId).profileKey;

run("the fixture reproduces the real collision: two complete recipes, one profile key", () => {
  const rows = db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portal_recipes WHERE profile_key = ? AND status = 'complete'", [KEY],
  );
  if (Number(rows[0]?.n) !== 2) throw new Error(`expected 2 recipes under "${KEY}", found ${rows[0]?.n}`);
  if (getPortalRecipe(db, electricalId).profileKey !== KEY) throw new Error("the two recipes do not share a key — the fixture proves nothing");
});

run("MUST PASS: passing the STRUCTURAL recipe yields the structural recipe's own questions", () => {
  const labels = extractPortalQuestions(db, getPortalRecipe(db, structuralId)).map((q) => q.portalLabel);
  for (const want of ["Residential - Structural", "Building Height - Feet:", "Number of Stories:"]) {
    if (!labels.includes(want)) throw new Error(`"${want}" missing from [${labels.join(" | ")}]`);
  }
  if (labels.includes("Residential - Electrical")) throw new Error("the ELECTRICAL record type leaked into the structural question set");
});

run("MUST PASS: passing the ELECTRICAL recipe yields the electrical recipe's own questions", () => {
  const labels = extractPortalQuestions(db, getPortalRecipe(db, electricalId)).map((q) => q.portalLabel);
  if (!labels.includes("Residential - Electrical")) throw new Error(`missing from [${labels.join(" | ")}]`);
  if (labels.includes("Building Height - Feet:")) throw new Error("structural geometry leaked into the electrical question set");
});

run("THE REGRESSION: an ambiguous profile key THROWS instead of quietly answering for one", () => {
  let threw = "";
  try { extractPortalQuestions(db, KEY); } catch (err) { threw = err instanceof Error ? err.message : String(err); }
  if (!threw) throw new Error("a bare profile key still resolved — the triage queue would show one discipline twice again");
  for (const want of ["structural", "electrical"]) {
    if (!threw.toLowerCase().includes(want)) throw new Error(`the error does not name "${want}": ${threw}`);
  }
});

run("MUST EXCLUDE: a key with ONE recipe still resolves by string (older callers keep working)", () => {
  const stub = startPortalRecording(db, {
    scopeType: "utility", state: "OR", utility: "Portland General Electric",
    portalPlatform: "powerclerk", portalUrl: "https://pgenm.powerclerk.com",
  });
  db.run("UPDATE portal_recipes SET steps_json = ?, status = 'complete' WHERE id = ?",
    [JSON.stringify([fill("Please make your selection regarding meter aggregation", "No aggregation")]), stub.id]);
  const labels = extractPortalQuestions(db, getPortalRecipe(db, stub.id).profileKey).map((q) => q.portalLabel);
  if (!labels.includes("Please make your selection regarding meter aggregation")) {
    throw new Error(`a single-recipe key must still answer; got [${labels.join(" | ")}]`);
  }
});

run("MUST EXCLUDE: an unknown key is an empty list — a different fact from an ambiguous one", () => {
  const out = extractPortalQuestions(db, "or|nowhere at all|unknown");
  if (out.length !== 0) throw new Error(`expected [], got ${out.length}`);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nquestionBankDiscipline: all checks passed."
  : `\nquestionBankDiscipline: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
