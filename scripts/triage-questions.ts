// SIXTEEN BUSINESS CALLS, ONE AT A TIME, IN THE OPERATOR'S OWN TERMINAL.
//
// The question bank classifies a portal's questions by keyword and leaves the ambiguous ones
// UNKNOWN on purpose — "Application Level = Level 1" is size-dependent on Ameren, and
// "Will the net metering facility interconnect to a switchgear?" is a site fact. Guessing
// either is exactly the silent-wrong-answer this machinery exists to stop, so they wait for a
// human.
//
// Waiting for a human should not mean typing sixteen long --classify commands with labels that
// contain quotes, em-dashes and newlines. This walks them one at a time: the portal's own
// wording, the answer the recipe froze, and two keys.
//
//   npx tsx scripts/triage-questions.ts              # every unclassified question, all portals
//   npx tsx scripts/triage-questions.ts --host pgenm # one portal
//   npx tsx scripts/triage-questions.ts --dry-run    # see the list without being asked anything
//
// PER-JOB means the answer changes from job to job — it must come from the project or be asked
// at intake. PORTAL-CONSTANT means this operator's answer is always the same, so the recorded
// answer is safe to keep replaying. SKIP leaves it unknown for next time; nothing is guessed
// either way, and every call is remembered in portal_question_overrides (shared, like recipes).
import "dotenv/config";
import readline from "node:readline";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
};
const hostFilter = arg("host").toLowerCase();
const dryRun = process.argv.includes("--dry-run");

const { openDatabase } = await import("../backend/src/db");
const { extractPortalQuestions, setPortalQuestionOverride } = await import("../backend/src/portalQuestionBank");
const { RECIPE_FIELD_DESCRIPTIONS, getPortalRecipe } = await import("../backend/src/portalRecipes");

const db = await openDatabase();
const line = (s = ""): void => console.log(s);

interface Row { id: string; profile_key: string; portal_url: string; status: string; discipline?: string }
const recipes = db.query<Row>("SELECT id, profile_key, portal_url, status, discipline FROM portal_recipes WHERE status = 'complete'")
  .filter((r) => !hostFilter || String(r.portal_url || "").toLowerCase().includes(hostFilter));

interface Pending { profileKey: string; discipline: string; host: string; label: string; answer: string; options: string[] }
const pending: Pending[] = [];
for (const r of recipes) {
  let host = r.portal_url;
  try { host = new URL(r.portal_url).hostname; } catch { /* keep raw */ }
  // BY RECIPE, NOT BY PROFILE KEY. Coos Bay holds TWO complete recipes under one key
  // (city/structural and county/electrical), so the key alone resolved to whichever sorted
  // first — this queue listed the electrical recipe's questions twice and never showed the
  // structural recipe's own. And the catch below used to swallow the answer into an empty
  // list, which is indistinguishable from "this portal asks nothing".
  let qs: Array<Record<string, unknown>> = [];
  try {
    qs = extractPortalQuestions(db, getPortalRecipe(db, r.id)) as never;
  } catch (err) {
    console.error(`  ! could not read ${r.profile_key}: ${err instanceof Error ? err.message : String(err)}`);
    qs = [];
  }
  for (const q of qs) {
    if (String(q.classification ?? "") !== "unknown") continue;
    pending.push({
      profileKey: r.profile_key,
      discipline: String((r as unknown as { discipline?: string }).discipline ?? ""),
      host,
      label: String(q.portalLabel ?? ""),
      answer: String(q.recordedAnswer ?? ""),
      options: Array.isArray(q.options) ? (q.options as string[]) : [],
    });
  }
}

if (pending.length === 0) {
  line("\nNothing to triage — every question the bank found is already classified.\n");
  process.exit(0);
}

line(`\n${pending.length} question(s) need one business call each.`);
line("PER-JOB = the answer changes per job (comes from the project, or is asked at intake).");
line("PORTAL-CONSTANT = your answer is always the same, so the recorded answer keeps replaying.\n");

if (dryRun) {
  let host = "";
  for (const p of pending) {
    // The heading is host + DISCIPLINE, because one host can carry two recipes: Coos Bay's
    // Accela serves the city/structural filing and the county/electrical one from the same
    // hostname, and a bare host printed two blocks a person could not tell apart.
    const heading = `${p.host}${p.discipline ? `  [${p.discipline}]` : ""}`;
    if (heading !== host) { host = heading; line(`\n── ${heading}`); }
    line(`   ? ${p.label}`);
    line(`     recipe currently files: ${JSON.stringify(p.answer)}`);
  }
  line(`\n--dry-run: nothing asked, nothing written. Drop the flag to triage.\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, (a) => res(a)));

let classified = 0;
let skipped = 0;
let host = "";
for (let i = 0; i < pending.length; i++) {
  const p = pending[i];
  const heading = `${p.host}${p.discipline ? `  [${p.discipline}]` : ""}`;
  if (heading !== host) { host = heading; line(`\n──────── ${heading} ────────`); }
  line(`\n[${i + 1}/${pending.length}] ${p.label}`);
  line(`   the recipe currently files: ${JSON.stringify(p.answer)}`);
  if (p.options.length) line(`   the portal offers: ${p.options.slice(0, 6).join(" | ")}${p.options.length > 6 ? " …" : ""}`);

  const a = (await ask("   [j]=per-job  [c]=portal-constant  [s]=skip  > ")).trim().toLowerCase();
  if (a === "c") {
    setPortalQuestionOverride(db, p.profileKey, p.label, "portal-constant");
    line("   → portal-constant. The recorded answer keeps replaying.");
    classified++;
  } else if (a === "j") {
    // A per-job answer needs somewhere to come from. Offer a binding, but never require one:
    // an unbound per-job question still surfaces at intake, which is the safe outcome.
    const bind = (await ask("   which project field answers it? (blank = ask at intake) > ")).trim();
    if (bind && !(bind in RECIPE_FIELD_DESCRIPTIONS)) {
      line(`   ! "${bind}" is not a field the resolver defines — recording as per-job with no binding, so it is asked at intake.`);
      setPortalQuestionOverride(db, p.profileKey, p.label, "per-job");
    } else {
      setPortalQuestionOverride(db, p.profileKey, p.label, "per-job", bind);
      line(bind ? `   → per-job, answered by ${bind}.` : "   → per-job. It will be asked at intake.");
    }
    classified++;
  } else {
    line("   → skipped; still unknown, nothing guessed.");
    skipped++;
  }
}
rl.close();

line(`\n──────────────────────────────────────────────`);
line(`  ${classified} classified, ${skipped} left for later.`);
if (classified) {
  line(`  Next: npx tsx scripts/apply-question-bindings.ts        (dry run)`);
  line(`        npx tsx scripts/apply-question-bindings.ts --apply`);
  line(`  — that writes the per-job bindings into the recipes so replay actually uses them.`);
}
line();
