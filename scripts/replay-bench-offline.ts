// OFFLINE LEARN + REPLAY SCOREBOARD — the before/after measurement for the bot (plan item M1).
//
//   npm run bench:offline                         every cell (3 bases x 8 variants)
//   npm run bench:offline -- --only accela        cells whose name contains "accela"
//   npm run bench:offline -- --learn-variants     ALSO learn every variant first-time
//
// WHAT RUNS, AND WHAT IS STOOD IN FOR:
//   - Portals: synthetic replica wizards (portal-bot/src/replica/fixtures) on 127.0.0.1. Never a
//     real portal; no customer data anywhere.
//   - LEARN: the REAL learnPortal() -> AutoLearnAdapter, given the option set autoLearnPortal
//     builds (identities, equipment, bindable keys, upload mode, policy profile), on project A.
//     The LLM planner is REPLACED by a deterministic label->field stand-in (no model call is
//     possible: ANTHROPIC_API_KEY is blanked). Every run records that.
//   - SAVE: the real convertLiteralsToBoundFields + savePortalRecipeSteps into a SCRATCH DB.
//   - REPLAY: the real stageWithRecipe() -> RecipeAdapter for project B, with the real
//     resolveRecipeFieldValues. PORTAL_ALLOW_FINAL_SUBMIT is removed from the environment.
//
// CELL TOPOLOGY. The recipe for a base is learned ONCE on the unmutated base wizard, then
// replayed on each of the 8 variants of that base — a mutation models the portal drifting
// between the learn and the replay, which is the only way "one page fewer" can put a recipe on
// the review screen early (the hazard the plan's validity check is about). With
// --learn-variants each variant is also learned first-time, for a learn rate with a larger
// denominator.
//
// SCORING is strict and read from the replica server (benchScore.ts), never from the bot's own
// report: every expected field committed and matching, nothing blanked, no wrong box, no A
// value on B's filing, no submit/pay POST. A cell that errors, times out, or cannot run is
// SKIPPED with its reason and stays in the denominator.
import "../backend/test/_isolate"; // FIRST: temp cwd, so nothing lands in the repo's data folders
import { REPO } from "../backend/test/_isolate";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------------------------
// Environment — set before any backend or portal-bot module loads.
// ---------------------------------------------------------------------------------------------
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const SCRATCH = path.join(REPO, ".probe", "brar-scoreboard", `run-${STAMP}`);
fs.mkdirSync(SCRATCH, { recursive: true });
const ARTIFACTS = path.join(SCRATCH, "artifacts");
process.env.AUTOPILOT_DB_PATH = path.join(SCRATCH, "bench.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOLEARN_RUN_DIR = path.join(ARTIFACTS, "learn-runs");
process.env.REPLAY_RUN_DIR = path.join(ARTIFACTS, "replay-runs");
process.env.REPLAY_CAPTURE_DIR = path.join(ARTIFACTS, "replay-captures");
process.env.PORTAL_SCREENSHOT_DIR = path.join(ARTIFACTS, "screenshots");
process.env.POWERCLERK_DEBUG_DIR = path.join(ARTIFACTS, "portal-debug");
process.env.AUTOLEARN_DEBUG_SCREENSHOTS = "0";
process.env.PORTAL_VISION_PLAN = "0";
process.env.PORTAL_HEADLESS = "true";
process.env.PORTAL_HEADED_RETRY = "0";
const finalSubmitWasSet = process.env.PORTAL_ALLOW_FINAL_SUBMIT !== undefined;
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

const argv = process.argv.slice(2);
const argVal = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const ONLY = argVal("--only") ?? "";
const LEARN_VARIANTS = argv.includes("--learn-variants");
const RUN_TIMEOUT_MS = Number(argVal("--timeout") ?? 240) * 1000;
const OUT = argVal("--out") ?? path.join(REPO, ".probe", "bench", `${STAMP}.json`);
if (argv.includes("--debug")) process.env.AUTOLEARN_RUN_DEBUG = "1"; else process.env.AUTOLEARN_RUN_DEBUG = "0";
process.env.PORTAL_RUN_MAX_MS = String(RUN_TIMEOUT_MS + 30_000);

const { openDatabase } = await import("../backend/src/db");
const { createClient } = await import("../backend/src/clients");
const { createProject, getProjectDetail } = await import("../backend/src/repository");
const {
  startPortalRecording, savePortalRecipeSteps, getPortalRecipe, resolveRecipeFieldValues,
  convertLiteralsToBoundFields, deadFieldBindings, RECIPE_FIELD_DESCRIPTIONS,
} = await import("../backend/src/portalRecipes");
const { buildPortalPlanner } = await import("../backend/src/autoLearn");
const { mergeStepReport, scoreReplayOutcome } = await import("../backend/src/replayBenchmark");
const { learnPortal, stageWithRecipe } = await import("../portal-bot/src/index");
const { buildWizard, FLAVORS, MUTATIONS } = await import("../portal-bot/src/replica/fixtures/wizards");
const { PROJECT_A, PROJECT_B, secretsOf, aOnlyLiterals } = await import("../portal-bot/src/replica/fixtures/syntheticProjects");
type Flavor = import("../portal-bot/src/replica/fixtures/wizards").Flavor;
type Mutation = import("../portal-bot/src/replica/fixtures/wizards").Mutation;
type DocKey = import("../portal-bot/src/replica/fixtures/wizards").DocKey;
type SynthProject = import("../portal-bot/src/replica/fixtures/syntheticProjects").SynthProject;
const { startSyntheticReplica } = await import("../portal-bot/src/replica/syntheticServer");
const { scoreRun } = await import("../portal-bot/src/replica/benchScore");
const { standInPlanner, STAND_IN_PLANNER_ID } = await import("../portal-bot/src/replica/standInPlanner");
type ProjectRecord = import("../shared/src/types").ProjectRecord;
type LearnPlanRequest = import("../portal-bot/src/adapters/autoLearnAdapter").LearnPlanRequest;

const db = await openDatabase();

// ---------------------------------------------------------------------------------------------
// Synthetic projects through the real write path
// ---------------------------------------------------------------------------------------------
function makeDocs(tag: string): Record<DocKey, string> {
  const dir = path.join(SCRATCH, `docs-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  const pdf = (name: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
    return f;
  };
  return { plan_set: pdf(`${tag}-plan-set.pdf`), sld: pdf(`${tag}-one-line.pdf`), site_plan: pdf(`${tag}-site-plan.pdf`) };
}

function makeProject(p: SynthProject): ProjectRecord {
  const client = createClient(db, {
    companyName: p.installer.company, legalBusinessName: p.installer.company,
    contactName: `${p.installer.contactFirst} ${p.installer.contactLast}`,
    businessEmail: p.installer.email, businessPhone: p.installer.phone,
    businessAddress: p.installer.street, businessCity: p.installer.city, businessState: p.installer.state, businessZip: p.installer.zip,
    ccbLicenseNumber: p.installer.license.replace(/\D/g, ""),
  });
  const detail = createProject(db, {
    clientId: client.id, owner: `${p.ownerFirst} ${p.ownerLast}`, street: p.street, city: p.city, state: p.state, zip: p.zip,
    ahj: p.ahj, utility: p.utility, account: p.accountNumber, meter: p.meterNumber, dcKw: p.dcKw, acKw: p.acKw,
    homeownerEmail: p.ownerEmail, homeownerPhone: p.ownerPhone, county: p.county, numberOfStories: p.stories,
    moduleManufacturer: p.moduleMake, moduleModel: p.moduleModel, moduleQuantity: p.moduleQty,
    inverterManufacturer: p.inverterMake, inverterModel: p.inverterModel, inverterQuantity: p.inverterQty,
    hasBattery: "No", permitPathOverride: "prescriptive",
  } as never, undefined, { learningExcluded: true });
  return { ...getProjectDetail(db, detail.project.id).project, permitType: "electrical" } as ProjectRecord;
}

const projA = makeProject(PROJECT_A);
const projB = makeProject(PROJECT_B);
const docsA = makeDocs("A");
const docsB = makeDocs("B");
const docNames = (d: Record<DocKey, string>) => ({ plan_set: path.basename(d.plan_set), sld: path.basename(d.sld), site_plan: path.basename(d.site_plan) });
const A_ONLY = [...aOnlyLiterals(PROJECT_A, PROJECT_B), ...Object.values(docNames(docsA))];
const ALL_SECRETS = [...secretsOf(PROJECT_A), ...secretsOf(PROJECT_B)];

const scopeOf = (f: Flavor): "ahj" | "utility" => (f === "powerclerk" ? "utility" : "ahj");
const portalTypeOf = (f: Flavor) => (scopeOf(f) === "utility" ? "utility" : "AHJ");

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(`HARNESS TIMEOUT: ${what} exceeded ${Math.round(ms / 1000)}s`)), ms))]);

// ---------------------------------------------------------------------------------------------
// LEARN one wizard on project A
// ---------------------------------------------------------------------------------------------
interface LearnOutcome {
  cell: string;
  status: "ran" | "skipped";
  skipReason?: string;
  seconds: number;
  learnReachedReview: boolean;
  learnerSaidReview: boolean;
  pageCount: number;
  stepsRecorded: number;
  plannerCalls: number;
  secretsInPlannerRequests: number;
  deadBindings: string[];
  ambiguousLiterals: number;
  fieldsCorrect: number;
  fieldsExpected: number;
  submitPosts: number;
  payPosts: number;
  recipeId?: string;
  learnBase?: string;
  message: string;
  validationErrors: string[];
}

async function learnCell(flavor: Flavor, mutation: Mutation): Promise<LearnOutcome> {
  const started = Date.now();
  const wizard = buildWizard(flavor, mutation);
  const cell = `${flavor}/${mutation}`;
  const replica = await startSyntheticReplica({ wizard, credential: { username: PROJECT_A.portalUsername, password: PROJECT_A.portalPassword } });
  const scopeType = scopeOf(flavor);
  const portalType = portalTypeOf(flavor);
  const out: LearnOutcome = {
    cell, status: "ran", seconds: 0, learnReachedReview: false, learnerSaidReview: false, pageCount: 0, stepsRecorded: 0,
    plannerCalls: 0, secretsInPlannerRequests: 0, deadBindings: [], ambiguousLiterals: 0, fieldsCorrect: 0, fieldsExpected: 0,
    submitPosts: 0, payPosts: 0, message: "", validationErrors: [],
  };
  try {
    // The real secret strip — the stand-in sees exactly the map the LLM would.
    const { projectFields } = buildPortalPlanner(db, projA, { portalType, scopeType, permitType: "electrical" });
    const leakedIntoFields = ALL_SECRETS.filter((s) => JSON.stringify(projectFields).includes(s));
    const inner = standInPlanner(projectFields, { utility: scopeType === "utility" });
    const planner = async (req: LearnPlanRequest) => {
      out.plannerCalls++;
      const { screenshotBase64: _shot, ...rest } = req;
      const text = JSON.stringify(rest);
      if (ALL_SECRETS.some((s) => text.includes(s))) out.secretsInPlannerRequests++;
      return inner(req);
    };
    if (leakedIntoFields.length) out.secretsInPlannerRequests += 1;
    const recipe = startPortalRecording(db, {
      scopeType, state: projA.state, ahj: projA.ahj, utility: projA.utility,
      portalUrl: replica.entryUrl, portalPlatform: flavor, discipline: scopeType === "ahj" ? `electrical-${cell}` : cell,
    });
    const pf = projectFields;
    const learn = await withTimeout(learnPortal({
      portalName: `${cell} replica`,
      portalUrl: replica.entryUrl,
      project: projA,
      planner,
      credential: flavor === "powerclerk" ? { username: PROJECT_A.portalUsername, password: PROJECT_A.portalPassword } : undefined,
      headless: true,
      budgetMs: RUN_TIMEOUT_MS - 20_000,
      docsByType: docsA,
      uploadMode: scopeType === "ahj" ? "combined" : "split",
      policyProfile: scopeType === "utility" ? "residential_nem" : "none",
      bindableFields: Array.from(new Set([...Object.keys(resolveRecipeFieldValues(db, projA, portalType)), ...Object.keys(RECIPE_FIELD_DESCRIPTIONS)])),
      siteContactIdentity: { firstName: pf.homeownerFirstName || "", lastName: pf.homeownerLastName || "", email: pf.homeownerEmail || "", phone: pf.homeownerPhone || "", street: pf.street || "", city: pf.city || "", state: pf.state || "", zip: pf.zip || "" },
      contactIdentity: { firstName: pf.installerFirstName || "", lastName: pf.installerLastName || pf.installerCompanyName || "", email: pf.installerEmail || "", phone: pf.installerPhone || "", street: pf.installerStreet || "", city: pf.installerCity || "", state: pf.installerState || "", zip: pf.installerZip || "" },
      equipment: {
        inverterMake: pf.inverterMake || "", inverterModel: pf.inverterModel || "", moduleMake: pf.moduleMake || "", moduleModel: pf.moduleModel || "",
        inverterQty: pf.inverterQty || "", moduleQty: pf.moduleQty || "", tracking: "Fixed",
      },
      hasBattery: false,
      siteIdentity: { city: projA.city, zip: projA.zip, homeownerName: projA.homeownerName, isElectrical: true },
    }), RUN_TIMEOUT_MS, `learn ${cell}`);
    out.pageCount = learn.pageCount ?? 0;
    out.stepsRecorded = learn.steps?.length ?? 0;
    out.learnerSaidReview = learn.reachedReview === true;
    out.message = String(learn.message ?? "").slice(0, 300);
    const bound = convertLiteralsToBoundFields(learn.steps ?? [], projectFields);
    out.ambiguousLiterals = bound.ambiguous.length;
    out.deadBindings = deadFieldBindings(bound.steps, resolveRecipeFieldValues(db, projA, portalType));
    savePortalRecipeSteps(db, recipe.id, bound.steps, { status: learn.reachedReview ? "complete" : "recording", notes: `offline bench learn (${STAND_IN_PLANNER_ID})` });
    out.recipeId = recipe.id;
    out.learnBase = replica.base;
    const s = scoreRun(wizard, replica.state, PROJECT_A, docNames(docsA), []);
    out.learnReachedReview = s.reachedReview;
    out.fieldsCorrect = s.fieldsCorrect;
    out.fieldsExpected = s.fieldsExpected;
    out.submitPosts = s.submitPosts;
    out.payPosts = s.payPosts;
    out.validationErrors = replica.state.validationErrors.slice(0, 6);
  } catch (err) {
    out.status = "skipped";
    out.skipReason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    out.submitPosts = replica.state.submitPosts.length;
    out.payPosts = replica.state.payPosts.length;
  } finally {
    await replica.close();
    out.seconds = Math.round((Date.now() - started) / 100) / 10;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// REPLAY a learned recipe on one variant for project B
// ---------------------------------------------------------------------------------------------
interface ReplayOutcomeRow {
  cell: string;
  status: "ran" | "skipped";
  skipReason?: string;
  seconds: number;
  replayReachedReview: boolean;
  allFieldsCorrect: boolean;
  fieldsCorrect: number;
  fieldsExpected: number;
  blanked: number;
  wrongValue: number;
  wrongBoxWrites: number;
  leakedAValues: number;
  submitPosts: number;
  payPosts: number;
  rung: string;
  rungReason: string;
  adapterOk: boolean;
  executed: number;
  recorded: number;
  skippedSteps: number;
  message: string;
  /** The adapter's own report, kept for diagnosis — NOT part of the score. */
  adapterSkipped: string[];
  adapterDrift: string[];
  fieldVerdicts: Array<{ key: string; verdict: string; note?: string }>;
  validationErrors: string[];
}

async function replayCell(flavor: Flavor, mutation: Mutation, learned: LearnOutcome): Promise<ReplayOutcomeRow> {
  const started = Date.now();
  const cell = `${flavor}/${mutation}`;
  const row: ReplayOutcomeRow = {
    cell, status: "ran", seconds: 0, replayReachedReview: false, allFieldsCorrect: false, fieldsCorrect: 0, fieldsExpected: 0,
    blanked: 0, wrongValue: 0, wrongBoxWrites: 0, leakedAValues: 0, submitPosts: 0, payPosts: 0, rung: "", rungReason: "",
    adapterOk: false, executed: 0, recorded: 0, skippedSteps: 0, message: "", adapterSkipped: [], adapterDrift: [], fieldVerdicts: [], validationErrors: [],
  };
  const wizard = buildWizard(flavor, mutation);
  if (!learned.recipeId || learned.status !== "ran") {
    row.status = "skipped";
    row.skipReason = `no recipe: the base learn did not complete (${learned.skipReason ?? "learn produced no recipe"})`;
    row.fieldsExpected = scoreRun(wizard, { values: {}, posts: [], submitPosts: [], payPosts: [], reviewReached: false, pagesSeen: [], loggedIn: false, validationErrors: [] }, PROJECT_B, docNames(docsB), []).fieldsExpected;
    row.seconds = 0;
    return row;
  }
  const replica = await startSyntheticReplica({ wizard, credential: { username: PROJECT_B.portalUsername, password: PROJECT_B.portalPassword } });
  try {
    const stored = getPortalRecipe(db, learned.recipeId);
    // HARNESS AFFORDANCE: the recipe was recorded against the learn server's port; the
    // variant runs on its own port. Only the origin is rewritten — path and query are the
    // recipe's own, so a recipe that recorded the wrong page still goes to the wrong page.
    const swap = (u: string) => (learned.learnBase ? u.split(learned.learnBase).join(replica.base) : u);
    const recipe = {
      ...stored,
      portalUrl: swap(stored.portalUrl || ""),
      steps: stored.steps.map((s) => (s.action === "goto" && typeof s.value === "string" ? { ...s, value: swap(s.value) } : s)),
    };
    row.recorded = recipe.steps.length;
    const portalType = portalTypeOf(flavor);
    const fieldValues = resolveRecipeFieldValues(db, projB, portalType);
    const result = await withTimeout(stageWithRecipe(recipe, projB, fieldValues, docsB, [], {
      headless: true,
      credential: flavor === "powerclerk" ? { username: PROJECT_B.portalUsername, password: PROJECT_B.portalPassword } : undefined,
      loginUrl: replica.entryUrl,
      autoSubmit: false,
    }), RUN_TIMEOUT_MS, `replay ${cell}`);
    const merged = mergeStepReport(result) as Record<string, unknown>;
    row.adapterOk = result.ok === true;
    row.executed = Number(merged.executed ?? 0);
    row.skippedSteps = Array.isArray(merged.skipped) ? (merged.skipped as unknown[]).length : 0;
    row.message = String(merged.message ?? "").slice(0, 300);
    const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(typeof x === "string" ? x : JSON.stringify(x)).slice(0, 200)).slice(0, 12) : []);
    row.adapterSkipped = strs(merged.skipped);
    row.adapterDrift = strs(merged.driftWarnings);
    const rung = scoreReplayOutcome({ ...(merged as object), recorded: row.recorded } as never);
    row.rung = rung.rung;
    row.rungReason = rung.reason.slice(0, 160);
  } catch (err) {
    row.status = "skipped";
    row.skipReason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  } finally {
    const s = scoreRun(wizard, replica.state, PROJECT_B, docNames(docsB), A_ONLY);
    row.replayReachedReview = s.reachedReview;
    row.allFieldsCorrect = row.status === "ran" && s.allCorrect && row.skippedSteps === 0;
    row.fieldsCorrect = s.fieldsCorrect;
    row.fieldsExpected = s.fieldsExpected;
    row.blanked = s.blanked;
    row.wrongValue = s.wrongValue;
    row.wrongBoxWrites = s.wrongBoxWrites;
    row.leakedAValues = s.leakedAValues;
    // Safety counters are counted even on a skipped (timed-out) run: a filing is a filing.
    row.submitPosts = s.submitPosts;
    row.payPosts = s.payPosts;
    row.fieldVerdicts = s.fields.filter((f) => f.verdict !== "correct").map((f) => ({ key: f.key, verdict: f.verdict, note: f.note }));
    row.validationErrors = replica.state.validationErrors.slice(0, 6);
    await replica.close();
    row.seconds = Math.round((Date.now() - started) / 100) / 10;
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------
const t0 = Date.now();
const cells = FLAVORS.flatMap((f) => MUTATIONS.map((m) => ({ flavor: f, mutation: m, name: `${f}/${m}` })));
const selected = cells.filter((c) => !ONLY || c.name.includes(ONLY));
const flavorsNeeded = [...new Set(selected.map((c) => c.flavor))];

console.log(`OFFLINE BOT SCOREBOARD — ${selected.length} replay cell(s) over ${flavorsNeeded.length} base(s)`);
console.log(`  planner: ${STAND_IN_PLANNER_ID} (no LLM; ANTHROPIC_API_KEY blanked)`);
console.log(`  scratch: ${path.relative(REPO, SCRATCH)}  (DB + artifacts; nothing under data/)`);
console.log(`  PORTAL_ALLOW_FINAL_SUBMIT: removed from the environment${finalSubmitWasSet ? " (it WAS set in the parent shell)" : ""}`);

const learns: LearnOutcome[] = [];
const baseLearn = new Map<Flavor, LearnOutcome>();
for (const f of flavorsNeeded) {
  process.stdout.write(`\n[learn] ${f}/base on project A ... `);
  const l = await learnCell(f, "base");
  learns.push(l);
  baseLearn.set(f, l);
  console.log(`${l.status === "ran" ? (l.learnReachedReview ? "REACHED REVIEW" : "did not reach review") : `SKIPPED (${l.skipReason})`} — ${l.pageCount} page(s), ${l.stepsRecorded} step(s), fields ${l.fieldsCorrect}/${l.fieldsExpected}, ${l.seconds}s`);
  if (l.message) console.log(`        learner: ${l.message.slice(0, 200)}`);
  if (l.validationErrors.length) console.log(`        portal refused: ${l.validationErrors.join(" | ").slice(0, 200)}`);
}
if (LEARN_VARIANTS) {
  for (const c of selected.filter((x) => x.mutation !== "base")) {
    process.stdout.write(`[learn] ${c.name} on project A ... `);
    const l = await learnCell(c.flavor, c.mutation);
    learns.push(l);
    console.log(`${l.status === "ran" ? (l.learnReachedReview ? "REACHED REVIEW" : "did not reach review") : `SKIPPED (${l.skipReason})`} — fields ${l.fieldsCorrect}/${l.fieldsExpected}, ${l.seconds}s`);
  }
}

const replays: ReplayOutcomeRow[] = [];
for (const c of selected) {
  process.stdout.write(`[replay] ${c.name} for project B ... `);
  const r = await replayCell(c.flavor, c.mutation, baseLearn.get(c.flavor)!);
  replays.push(r);
  const tag = r.status === "skipped" ? `SKIPPED (${r.skipReason})` : r.allFieldsCorrect ? "ALL CORRECT" : r.replayReachedReview ? "reached review, fields wrong/missing" : "did not reach review";
  console.log(`${tag} — fields ${r.fieldsCorrect}/${r.fieldsExpected}, submit/pay ${r.submitPosts}/${r.payPosts}, ${r.seconds}s`);
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const frac = (k: number, n: number) => `${k}/${n}${n ? ` (${Math.round((100 * k) / n)}%)` : ""}`;
const sum = (rows: ReplayOutcomeRow[], f: (r: ReplayOutcomeRow) => number) => rows.reduce((a, r) => a + f(r), 0);
const count = (rows: ReplayOutcomeRow[], f: (r: ReplayOutcomeRow) => boolean) => rows.filter(f).length;

function groupLine(label: string, rows: ReplayOutcomeRow[]): string {
  const n = rows.length;
  return [
    label.padEnd(24),
    `all-correct ${frac(count(rows, (r) => r.allFieldsCorrect), n)}`.padEnd(22),
    `review ${frac(count(rows, (r) => r.replayReachedReview), n)}`.padEnd(18),
    `fields ${frac(sum(rows, (r) => r.fieldsCorrect), sum(rows, (r) => r.fieldsExpected))}`.padEnd(20),
    `blank ${sum(rows, (r) => r.blanked)}`.padEnd(9),
    `wrongbox ${sum(rows, (r) => r.wrongBoxWrites)}`.padEnd(12),
    `leakA ${sum(rows, (r) => r.leakedAValues)}`.padEnd(9),
    `submit/pay ${sum(rows, (r) => r.submitPosts)}/${sum(rows, (r) => r.payPosts)}`.padEnd(15),
    `skipped ${count(rows, (r) => r.status === "skipped")}`,
  ].join(" ");
}

console.log("\n=== REPLAY CELLS (recipe learned on the base, replayed on each variant, project B) ===");
for (const r of replays) {
  console.log(`${r.cell.padEnd(34)} ${r.status === "skipped" ? "SKIPPED" : r.allFieldsCorrect ? "PASS   " : "FAIL   "} review=${r.replayReachedReview ? "y" : "n"} fields=${r.fieldsCorrect}/${r.fieldsExpected} blank=${r.blanked} wrong=${r.wrongValue} wrongbox=${r.wrongBoxWrites} leakA=${r.leakedAValues} submit=${r.submitPosts} pay=${r.payPosts} rung=${r.rung || "-"} ${r.seconds}s`);
  const bad = r.fieldVerdicts.slice(0, 6).map((v) => `${v.key}:${v.verdict}`).join(", ");
  if (bad) console.log(`${"".padEnd(34)}   not correct: ${bad}${r.fieldVerdicts.length > 6 ? `, +${r.fieldVerdicts.length - 6}` : ""}`);
  if (r.skipReason) console.log(`${"".padEnd(34)}   reason: ${r.skipReason}`);
  if (!r.allFieldsCorrect && r.message) console.log(`${"".padEnd(34)}   adapter: ${r.message.slice(0, 160)}`);
  for (const d of r.allFieldsCorrect ? [] : r.adapterDrift.slice(0, 2)) console.log(`${"".padEnd(34)}   drift: ${d.slice(0, 160)}`);
}

console.log("\n=== BY BASE ===");
for (const f of flavorsNeeded) console.log(groupLine(f, replays.filter((r) => r.cell.startsWith(`${f}/`))));
console.log("\n=== BY MUTATION ===");
for (const m of MUTATIONS) {
  const rows = replays.filter((r) => r.cell.endsWith(`/${m}`));
  if (rows.length) console.log(groupLine(m, rows));
}
console.log("\n=== TOTAL ===");
console.log(groupLine("all replay cells", replays));

const learnRan = learns;
const learnReached = learnRan.filter((l) => l.status === "ran" && l.learnReachedReview).length;
const secrets = learnRan.reduce((a, l) => a + l.secretsInPlannerRequests, 0);
const plannerCalls = learnRan.reduce((a, l) => a + l.plannerCalls, 0);
const learnSubmit = learnRan.reduce((a, l) => a + l.submitPosts, 0);
const learnPay = learnRan.reduce((a, l) => a + l.payPosts, 0);
console.log(`\nLEARNS: reached review ${frac(learnReached, learnRan.length)}; fields ${frac(learnRan.reduce((a, l) => a + l.fieldsCorrect, 0), learnRan.reduce((a, l) => a + l.fieldsExpected, 0))}; submit/pay POSTs ${learnSubmit}/${learnPay}; skipped ${learnRan.filter((l) => l.status === "skipped").length}`);
console.log(`SECRETS IN PLANNER REQUESTS: ${secrets} of ${plannerCalls} request(s)`);

const replayAllCorrect = count(replays, (r) => r.allFieldsCorrect);
const tripwire = replays.find((r) => r.cell === "accela/one_page_fewer");
console.log("\n=== HEADLINES ===");
console.log(`replay_all_fields_correct_rate: ${frac(replayAllCorrect, replays.length)}   (target >= 90%)`);
console.log(`learn_reached_review_rate:      ${frac(learnReached, learnRan.length)}   (target >= 80%)`);
console.log(`submit_or_pay_posts:            ${sum(replays, (r) => r.submitPosts + r.payPosts) + learnSubmit + learnPay}   (must be 0)`);
if (tripwire) {
  console.log(`VALIDITY TRIPWIRE accela/one_page_fewer: submit_posts=${tripwire.submitPosts} — ${tripwire.submitPosts > 0
    ? "the harness SEES the drift-seek filing hazard (expected before R1 lands)"
    : tripwire.status === "skipped" ? "NOT MEASURED (cell skipped)" : "no filing POST (after R1 this is the pass condition; before R1, suspect the harness)"}`);
}
const seconds = Math.round((Date.now() - t0) / 1000);
console.log(`\nwall clock ${seconds}s`);

const report = {
  generatedAt: new Date().toISOString(),
  commit: (() => { try { return fs.readFileSync(path.join(REPO, ".git", "HEAD"), "utf8").trim(); } catch { return ""; } })(),
  planner: STAND_IN_PLANNER_ID,
  topology: LEARN_VARIANTS ? "learn base once per flavour + first-time learn of every variant; replay base recipe on every variant" : "learn base once per flavour; replay base recipe on every variant",
  finalSubmitEnvRemoved: true,
  finalSubmitWasSetInParent: finalSubmitWasSet,
  wallClockSeconds: seconds,
  headline: {
    replay_all_fields_correct_rate: { k: replayAllCorrect, n: replays.length },
    learn_reached_review_rate: { k: learnReached, n: learnRan.length },
    submit_or_pay_posts: sum(replays, (r) => r.submitPosts + r.payPosts) + learnSubmit + learnPay,
    secrets_in_planner_requests: { k: secrets, n: plannerCalls },
    tripwire_accela_one_page_fewer_submit_posts: tripwire?.submitPosts ?? null,
  },
  learns,
  replays,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`JSON: ${path.relative(REPO, OUT)}`);
process.exit(0);
