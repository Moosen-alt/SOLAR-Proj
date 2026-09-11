// THE QUESTION BANK ON THE OPERATOR'S TERMINAL — "if PGE detected, ask PGE questions."
//
// The recipes already know what each portal asks: every unbound [select] literal in a
// complete recipe is a question, in the portal's own wording, with the learn project's
// answer frozen beside it. This prints them, classified the rigid way — portal-constant
// (fine frozen) / per-job (silent-wrong-answer hazard) / unknown (classify once, it is
// remembered).
//
//   npx tsx scripts/portal-questions.ts --host pacificorpnetmetering.powerclerk.com
//   npx tsx scripts/portal-questions.ts --project <projectId>
//   npx tsx scripts/portal-questions.ts --audit
//   npx tsx scripts/portal-questions.ts --host <h> --classify "<portal label>" --as per-job|portal-constant [--bind <fieldKey>]
//
// Read-only, except --classify, which persists ONE human classification to
// portal_question_overrides — shared portal knowledge, like the recipes themselves.
// Never prints secrets: questions and answers come from recipe steps, which never
// store sensitive values (they bind by name).
import "dotenv/config";

process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
const { openDatabase } = await import("../backend/src/db");
const {
  extractPortalQuestions, questionsForProject, auditFrozenAnswers, recipeHost,
  setPortalQuestionOverride,
} = await import("../backend/src/portalQuestionBank");
const { listPortalRecipes, RECIPE_FIELD_DESCRIPTIONS } = await import("../backend/src/portalRecipes");
import type { PortalQuestion } from "../backend/src/portalQuestionBank";
import type { PortalRecipe } from "../shared/src/types";

const argv = process.argv.slice(2);
const flag = (name: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] ?? "") : "";
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const usage = () => {
  console.error("usage: tsx scripts/portal-questions.ts --host <hostname> | --project <id> | --audit");
  console.error("       tsx scripts/portal-questions.ts --host <h> --classify \"<label>\" --as per-job|portal-constant [--bind <fieldKey>]");
  process.exit(2);
};

const db = await openDatabase();
const line = (s = "") => console.log(s);

// Where a per-job answer will come from at replay time. RECIPE_FIELD_DESCRIPTIONS is the
// project-field roster; a few keys are DERIVED inside resolveRecipeFieldValues instead
// (always defined at replay even though no column carries them).
const DERIVED_RESOLVER_KEYS = new Set(["exportLimiting", "energySource"]);
const answerSource = (q: PortalQuestion): string => {
  if (!q.suggestedBinding) return "intake — no binding known yet (set one: --classify \"<label>\" --as per-job --bind <fieldKey>)";
  if (DERIVED_RESOLVER_KEYS.has(q.suggestedBinding)) return `derived at replay from the parser snapshot (${q.suggestedBinding})`;
  return RECIPE_FIELD_DESCRIPTIONS[q.suggestedBinding]
    ? `project field ${q.suggestedBinding} (falls back to intake while the project record is empty)`
    : `intake -> snapshot key "${q.suggestedBinding}" (no first-class project column yet)`;
};

const printQuestion = (q: PortalQuestion, indent = "  ") => {
  line(`${indent}? ${q.portalLabel}`);
  line(`${indent}    recorded answer : ${q.recordedAnswer ? `"${q.recordedAnswer}"` : "(BLANK — the recipe files nothing here)"}`);
  if (q.options?.length) line(`${indent}    options         : ${q.options.join(" | ")}`);
  line(`${indent}    classification  : ${q.classification} — ${q.why}${q.classifiedBy ? ` [${q.classifiedBy}]` : ""}`);
  if (q.classification === "per-job") line(`${indent}    answer comes from: ${answerSource(q)}`);
  else if (q.suggestedBinding) line(`${indent}    binding         : ${q.suggestedBinding}`);
};

const printBank = (recipe: PortalRecipe) => {
  const questions = extractPortalQuestions(db, recipe);
  const host = recipeHost(recipe) || "(no portal url recorded)";
  line(`PORTAL QUESTION BANK — ${host}`);
  line(`recipe ${recipe.id} v${recipe.version} ${recipe.status} — ${recipe.profileKey} (${recipe.scopeType}${recipe.discipline ? `, ${recipe.discipline}` : ""})`);
  const groups: Array<[string, string, PortalQuestion[]]> = [
    ["PER-JOB", "answers vary by project — a frozen answer files silently wrong", questions.filter((q) => q.classification === "per-job")],
    ["PORTAL CONSTANTS", "the same answer on every filing this operator makes — fine frozen", questions.filter((q) => q.classification === "portal-constant")],
    ["UNKNOWN", "classify once with --classify; the call is remembered for this portal", questions.filter((q) => q.classification === "unknown")],
  ];
  for (const [title, blurb, list] of groups) {
    if (!list.length) continue;
    line();
    line(`${title} (${list.length}) — ${blurb}`);
    for (const q of list) printQuestion(q);
  }
  if (!questions.length) line("  (this recipe answers every control from the project record — no questions)");
};

const findRecipesForHost = (host: string): PortalRecipe[] => {
  const wanted = host.toLowerCase().trim();
  return listPortalRecipes(db)
    .filter((r) => {
      const h = recipeHost(r);
      return h && (h === wanted || h.includes(wanted));
    })
    .sort((a, b) => (a.status === "complete" ? 0 : 1) - (b.status === "complete" ? 0 : 1));
};

if (has("classify")) {
  // ── persist ONE human classification ────────────────────────────────────────────────
  const host = flag("host");
  const label = flag("classify");
  const as = flag("as");
  const bind = flag("bind");
  if (!host || !label || !["per-job", "portal-constant", "unknown"].includes(as)) usage();
  const recipe = findRecipesForHost(host)[0];
  if (!recipe) {
    console.error(`no recipe found for host "${host}" — the override is keyed by the recipe's profile key, so a recipe must exist first.`);
    process.exit(2);
  }
  setPortalQuestionOverride(db, recipe.profileKey, label, as as "per-job" | "portal-constant" | "unknown", bind);
  line(`remembered for ${recipe.profileKey}: "${label}" -> ${as}${bind ? ` (binding ${bind})` : ""}`);
  line(`every tenant filing through this portal now sees that classification.`);
} else if (has("audit")) {
  // ── the fleet-wide silent-wrong-answer list, worst first ────────────────────────────
  const findings = auditFrozenAnswers(db);
  const bySeverity = [0, 1, 2].map((s) => findings.filter((f) => f.severity === s));
  line(`FROZEN-ANSWER AUDIT — every complete recipe, per-job + unknown questions only`);
  line(`${findings.length} finding(s): ${bySeverity[0].length} frozen per-job (files silently WRONG), ${bySeverity[1].length} per-job blank (files empty), ${bySeverity[2].length} unclassified`);
  const titles = [
    "FROZEN PER-JOB ANSWERS — replay files the learn project's answer on every job",
    "PER-JOB BLANKS — replay files nothing; the portal may reject or mis-route",
    "UNCLASSIFIED — a human should classify each once (--classify); the call is remembered",
  ];
  bySeverity.forEach((list, s) => {
    if (!list.length) return;
    line();
    line(`■ ${titles[s]} (${list.length})`);
    let lastRecipe = "";
    for (const f of list) {
      if (f.recipeId !== lastRecipe) {
        lastRecipe = f.recipeId;
        line(`  ${f.portalHost || f.profileKey} — recipe ${f.recipeId.slice(0, 8)} (${f.scopeType}${f.discipline ? ` ${f.discipline}` : ""}, ${f.profileKey})`);
      }
      const answer = f.question.recordedAnswer ? `= "${f.question.recordedAnswer}"` : "= (blank)";
      line(`    ? ${f.question.portalLabel.slice(0, 90)} ${answer}`);
      if (s === 0) line(`      -> should come from: ${answerSource(f.question)}`);
    }
  });
  if (!findings.length) line("clean — every question in every complete recipe is a portal constant or project-bound.");
} else if (flag("project")) {
  // ── "the PGE questions" for one project ─────────────────────────────────────────────
  const { getProjectDetail } = await import("../backend/src/repository");
  const project = getProjectDetail(db, flag("project")).project;
  line(`PORTAL QUESTIONS FOR PROJECT ${project.id} — ${project.homeownerName}, ${project.city} ${project.state} (${project.utility})`);
  const tracks = questionsForProject(db, project);
  if (!tracks.length) {
    line(`no complete recipe resolves for this project (state=${project.state} utility="${project.utility}" ahj="${project.ahj}") — nothing to ask yet.`);
  }
  for (const t of tracks) {
    line();
    line(`── ${t.track.toUpperCase()} track — ${t.portalHost || t.profileKey} (recipe ${t.recipeId.slice(0, 8)})`);
    if (t.answered.length) {
      line(`  answered by the project record (${t.answered.length}):`);
      for (const a of t.answered) line(`    ✓ ${a.question.portalLabel.slice(0, 80)} -> "${a.value}" (from ${a.from})`);
    }
    if (t.unanswered.length) {
      line(`  UNANSWERED — ask the installer these (${t.unanswered.length}):`);
      for (const q of t.unanswered) printQuestion(q, "    ");
    } else {
      line(`  no unanswered per-job questions — this project can answer everything its portal asks.`);
    }
  }
} else if (flag("host")) {
  const host = flag("host");
  const recipes = findRecipesForHost(host);
  if (!recipes.length) {
    console.error(`no recipe found whose portal URL / goto step matches "${host}".`);
    process.exit(2);
  }
  printBank(recipes[0]);
  if (recipes.length > 1) {
    line();
    line(`(${recipes.length - 1} other recipe(s) match this host: ${recipes.slice(1).map((r) => `${r.id.slice(0, 8)} ${r.status} ${r.profileKey}`).join("; ")})`);
  }
} else {
  usage();
}

db.close();
