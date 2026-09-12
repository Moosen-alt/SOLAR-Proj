// THE BANK KNOWS THE BINDING; THE RECIPE STILL HAS TO USE IT.
//
// The question bank classifies a portal's questions and records which project field should
// answer each one. That knowledge changed nothing on its own: replay reads the RECIPE, and a
// recipe step with no `field` either replays a frozen literal or files a blank, whatever the
// bank believes.
//
// Measured on Ameren after the bindings landed. Two steps, both UNBOUND:
//   step 25  select  County                     = "Sangamon"   <- project A's county, on every filing
//   step 26  select  Community Solar / BTM      = ""           <- required, blank, portal may reject
// The resolver could answer both (county, systemConfiguration) and the cross-project run still
// reported six blanks, because nothing connected the two.
//
// This is that connection: for every per-job question the bank has a binding for, find the
// matching step in the recipe and bind it — dropping the frozen literal, which was somebody
// else's answer.
//
//   npx tsx scripts/apply-question-bindings.ts                     # every complete recipe, DRY RUN
//   npx tsx scripts/apply-question-bindings.ts --host <h>          # one portal
//   npx tsx scripts/apply-question-bindings.ts --apply             # write
//
// SAFETY. It edits SHARED recipes, so:
//   - dry run is the default and prints every change it would make;
//   - it only ever touches a step that is UNBOUND. A step someone already bound is left alone,
//     because a human's binding outranks a keyword table's;
//   - it never binds a step whose label is ambiguous within its recipe;
//   - it refuses a binding the resolver does not define, so a typo cannot silently blank a
//     field that used to carry at least a plausible literal;
//   - it records what it did in the recipe's notes, including the literal it dropped, so the
//     change is auditable and the old answer is not simply lost.
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const apply = process.argv.includes("--apply");
const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
};
const hostFilter = arg("host").toLowerCase();

const { openDatabase } = await import("../backend/src/db");
const { RECIPE_FIELD_DESCRIPTIONS, appendRecipeNoteSegment } = await import("../backend/src/portalRecipes");
const { extractPortalQuestions } = await import("../backend/src/portalQuestionBank");

const db = await openDatabase();
const line = (s = ""): void => console.log(s);

interface RecipeRow { id: string; profile_key: string; portal_url: string; steps_json: string; notes: string; status: string }

const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const labelOf = (step: Record<string, unknown>): string => {
  const sel = (step.selector ?? {}) as Record<string, unknown>;
  return String(sel.label ?? step.note ?? "");
};

const rows = db.query<RecipeRow>("SELECT id, profile_key, portal_url, steps_json, notes, status FROM portal_recipes WHERE status = 'complete'");
const targets = rows.filter((r) => !hostFilter || String(r.portal_url || "").toLowerCase().includes(hostFilter));

line(`\nAPPLY QUESTION BINDINGS — ${apply ? "WRITING" : "dry run (pass --apply to write)"}`);
line(`${targets.length} complete recipe(s)\n`);

let totalBound = 0;
let totalSkipped = 0;

for (const row of targets) {
  let steps: Array<Record<string, unknown>>;
  try { steps = JSON.parse(row.steps_json || "[]"); } catch { continue; }

  // What the bank believes about this portal's questions, and which binding answers each.
  let questions: Array<{ portalLabel?: string; suggestedBinding?: string; classification?: string }> = [];
  // extractPortalQuestions takes a PROFILE KEY or a recipe object - passing the recipe id
  // returns an empty list silently, which is how the first run of this script reported 0.
  try { questions = extractPortalQuestions(db, row.profile_key) as never; } catch { questions = []; }
  const wanted = new Map<string, string>();
  for (const q of questions) {
    const binding = String(q.suggestedBinding ?? "").trim();
    if (!binding || q.classification !== "per-job") continue;
    // A binding the resolver cannot answer would REPLACE a literal with a permanent blank.
    if (!(binding in RECIPE_FIELD_DESCRIPTIONS)) continue;
    wanted.set(norm(q.portalLabel), binding);
  }
  if (wanted.size === 0) continue;

  // Ambiguity check within this recipe: two steps sharing a label cannot be told apart.
  const labelCounts = new Map<string, number>();
  for (const s of steps) labelCounts.set(norm(labelOf(s)), (labelCounts.get(norm(labelOf(s))) ?? 0) + 1);

  const changes: Array<{ index: number; label: string; binding: string; wasLiteral: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = String(step.action ?? "");
    if (action !== "fill" && action !== "select" && action !== "check") continue;
    if (String(step.field ?? "").trim()) continue;              // already bound — a human outranks us
    if (step.sensitive || step.isFinalSubmit) continue;
    const key = norm(labelOf(step));
    const binding = wanted.get(key);
    if (!binding) continue;
    if ((labelCounts.get(key) ?? 0) !== 1) { totalSkipped++; continue; }   // ambiguous within the recipe
    changes.push({ index: i, label: labelOf(step), binding, wasLiteral: String(step.value ?? "") });
  }

  if (changes.length === 0) continue;

  line(`${row.profile_key}`);
  for (const c of changes) {
    line(`   step ${String(c.index).padStart(3)}  ${c.label.slice(0, 46).padEnd(46)} -> ${c.binding}`);
    if (c.wasLiteral) line(`              dropping frozen literal ${JSON.stringify(c.wasLiteral.slice(0, 40))} (another project's answer)`);
    if (apply) {
      steps[c.index].field = c.binding;
      delete steps[c.index].value;
    }
  }
  totalBound += changes.length;

  if (apply) {
    const note = `[question-bank bindings applied ${new Date().toISOString()}: ${changes
      .map((c) => `${c.label.slice(0, 30)} -> ${c.binding}${c.wasLiteral ? ` (was ${JSON.stringify(c.wasLiteral.slice(0, 24))})` : ""}`)
      .join("; ")}]`;
    db.run("UPDATE portal_recipes SET steps_json = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(steps), new Date().toISOString(), row.id]);
    try { appendRecipeNoteSegment(db, row.id, note); } catch { /* notes are best-effort */ }
  }
  line();
}

line("──────────────────────────────────────────────────────────────");
line(`  ${totalBound} step(s) ${apply ? "bound" : "would be bound"}${totalSkipped ? `, ${totalSkipped} skipped as ambiguous within their recipe` : ""}.`);
if (!apply && totalBound > 0) line("  Re-run with --apply to write. Replay will then resolve these from the project,");
if (!apply && totalBound > 0) line("  and anything the project cannot answer surfaces as an intake question.");
line();
