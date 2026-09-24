// OFFLINE LEARN + REPLAY SCOREBOARD — the before/after measurement for the bot (plan item M1).
//
//   npm run bench:offline                         every cell (3 bases x 8 variants)
//   npm run bench:offline -- --only accela        cells whose name contains "accela"
//   npm run bench:offline -- --learn-variants     ALSO learn every variant first-time
//   npm run bench:offline -- --reuse-learns .probe/bench/<earlier>.json
//                                                 replay the recipes an earlier run learned
//                                                 (replay-only iteration; learns not re-measured)
//   --timeout S (learn, default 240)  --replay-timeout S (default 180)  --out <file>  --debug
//   --all-probes (also the slow upload-page hazard probe)
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
const REPLAY_TIMEOUT_MS = Number(argVal("--replay-timeout") ?? 180) * 1000;
/** A previous report whose learned recipes are replayed instead of learning again. */
const REUSE_LEARNS = argVal("--reuse-learns");
const ALL_PROBES = argv.includes("--all-probes");
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
type Wizard = import("../portal-bot/src/replica/fixtures/wizards").Wizard;
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
  /** The bound steps as saved — kept so a later run can --reuse-learns them. Synthetic data only. */
  recipeSteps?: import("../shared/src/types").RecipeStep[];
  /** Set when this learn was not run but taken from an earlier report. */
  reusedFrom?: string;
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
    out.recipeSteps = bound.steps;
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
  /** rendered = the review page was served/painted; routed = SPA accepted the last step first. */
  reviewVia?: string;
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

/** A recipe transform for an ISOLATED probe: returns the steps to replay (origin already
 *  swapped) or a reason it cannot be built. */
type RecipeCut = (steps: import("../shared/src/types").RecipeStep[], base: string) => { steps: import("../shared/src/types").RecipeStep[] } | { reason: string };

async function replayCell(flavor: Flavor, mutation: Mutation, learned: LearnOutcome, cut?: { name: string; fn: RecipeCut; wizard?: Wizard }): Promise<ReplayOutcomeRow> {
  const started = Date.now();
  const cell = cut ? `${flavor}/${mutation} [${cut.name}]` : `${flavor}/${mutation}`;
  const row: ReplayOutcomeRow = {
    cell, status: "ran", seconds: 0, replayReachedReview: false, allFieldsCorrect: false, fieldsCorrect: 0, fieldsExpected: 0,
    blanked: 0, wrongValue: 0, wrongBoxWrites: 0, leakedAValues: 0, submitPosts: 0, payPosts: 0, rung: "", rungReason: "",
    adapterOk: false, executed: 0, recorded: 0, skippedSteps: 0, message: "", adapterSkipped: [], adapterDrift: [], fieldVerdicts: [], validationErrors: [],
  };
  const wizard = cut?.wizard ?? buildWizard(flavor, mutation);
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
    let recipe = {
      ...stored,
      portalUrl: swap(stored.portalUrl || ""),
      steps: stored.steps.map((s) => (s.action === "goto" && typeof s.value === "string" ? { ...s, value: swap(s.value) } : s)),
    };
    if (cut) {
      const c = cut.fn(recipe.steps, replica.base);
      if ("reason" in c) throw new Error(`probe not built: ${c.reason}`);
      recipe = { ...recipe, steps: c.steps, portalUrl: String(c.steps[0]?.value ?? recipe.portalUrl) };
    }
    row.recorded = recipe.steps.length;
    const portalType = portalTypeOf(flavor);
    const fieldValues = resolveRecipeFieldValues(db, projB, portalType);
    const result = await withTimeout(stageWithRecipe(recipe, projB, fieldValues, docsB, [], {
      headless: true,
      credential: flavor === "powerclerk" ? { username: PROJECT_B.portalUsername, password: PROJECT_B.portalPassword } : undefined,
      loginUrl: replica.entryUrl,
      autoSubmit: false,
    }), REPLAY_TIMEOUT_MS, `replay ${cell}`);
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
    row.reviewVia = replica.state.reviewVia;
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
if (!selected.length) {
  // An empty scoreboard must never read as a clean one.
  console.error(`No cell matches --only "${ONLY}". Cells: ${cells.map((c) => c.name).join(", ")}`);
  process.exit(2);
}

console.log(`OFFLINE BOT SCOREBOARD — ${selected.length} replay cell(s) over ${flavorsNeeded.length} base(s)`);
console.log(`  planner: ${STAND_IN_PLANNER_ID} (no LLM; ANTHROPIC_API_KEY blanked)`);
console.log(`  scratch: ${path.relative(REPO, SCRATCH)}  (DB + artifacts; nothing under data/)`);
console.log(`  PORTAL_ALLOW_FINAL_SUBMIT: removed from the environment${finalSubmitWasSet ? " (it WAS set in the parent shell)" : ""}`);

const learns: LearnOutcome[] = [];
const baseLearn = new Map<Flavor, LearnOutcome>();
const reused: LearnOutcome[] = REUSE_LEARNS
  ? (JSON.parse(fs.readFileSync(path.resolve(REPO, REUSE_LEARNS), "utf8")) as { learns: LearnOutcome[] }).learns
  : [];
for (const f of flavorsNeeded) {
  const prior = reused.find((l) => l.cell === `${f}/base` && l.recipeSteps?.length);
  if (REUSE_LEARNS && prior) {
    // NOT A MEASUREMENT OF THE LEARNER: the recipe is re-saved through the real writer into
    // this run's scratch DB, and the learn row is carried over marked reusedFrom (and left out
    // of the learn headline).
    const rec = startPortalRecording(db, { scopeType: scopeOf(f), state: projA.state, ahj: projA.ahj, utility: projA.utility, portalUrl: `${prior.learnBase}/`, portalPlatform: f, discipline: `reused-${f}` });
    savePortalRecipeSteps(db, rec.id, prior.recipeSteps!, { status: "complete", notes: `reused from ${REUSE_LEARNS}` });
    const l: LearnOutcome = { ...prior, recipeId: rec.id, reusedFrom: REUSE_LEARNS };
    learns.push(l);
    baseLearn.set(f, l);
    console.log(`\n[learn] ${f}/base REUSED from ${REUSE_LEARNS} (not re-measured)`);
    continue;
  }
  if (REUSE_LEARNS) console.log(`\n[learn] ${f}/base: nothing to reuse in ${REUSE_LEARNS} — learning fresh`);
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

// THE DRIFT-SEEK HAZARD, ISOLATED (plan item M1's validity check). The hazard lives AFTER the
// Accela address and record-type pages, so any earlier failure hides it from the
// accela/one_page_fewer cell. Two probes replay the base-learned recipe from the contacts page
// (the server holds no state a skipped earlier page would have set that these pages need):
//
//   upload page dropped — the variant as scored: the recipe carries an attachments page this
//                         portal does not have.
//   field page dropped  — the recipe is one FIELD page longer than the portal: the recipe runs
//                         contacts -> Additional Information -> review, the portal contacts ->
//                         review (neither has attachments). This is the shape where drift-seek
//                         clicks "Continue Application" on the read-only review, which FILES.
//
// Reported on their own lines, never in a headline rate.
type RecipeStepT = import("../shared/src/types").RecipeStep;
function recipePages(steps: RecipeStepT[]): RecipeStepT[][] {
  const pages: RecipeStepT[][] = [[]];
  for (const s of steps) {
    pages[pages.length - 1].push(s);
    if (s.action === "click" && /advance:|continue/i.test(String(s.note ?? "")) && !s.isFinalSubmit) pages.push([]);
  }
  return pages.filter((p) => p.length);
}
const probes: ReplayOutcomeRow[] = [];
if (selected.some((c) => c.name === "accela/one_page_fewer")) {
  // Both start ON the review page — exactly where the previous page's Continue lands when the
  // portal lacks the next recipe page — and then run the recipe's page for it. Replay prechecks
  // a new segment after a goto just as after an advance, so this is the same code path.
  const reviewSlug = buildWizard("accela", "one_page_fewer").pages.find((p) => p.kind === "review")!.slug;
  const landOnReview = (pick: (pages: RecipeStepT[][], upload: number) => RecipeStepT[][]): RecipeCut => (steps, base) => {
    const pages = recipePages(steps);
    const upload = pages.findIndex((pg) => pg.some((s) => s.action === "upload"));
    if (upload < 1) return { reason: "the learned recipe has no upload page" };
    return { steps: [{ action: "goto", phase: "open", value: `${base}/CitizenAccess/Cap/${reviewSlug}`, note: "harness: isolated probe lands on the review page" }, ...pick(pages, upload).flat()] };
  };
  const plans: Array<{ name: string; wizard?: Wizard; fn: RecipeCut }> = [
    // The page the portal lacks is a FIELD page (Additional Information) — the tripwire.
    { name: "isolated: lands on review, recipe expects a field page", fn: landOnReview((pages, u) => [pages[u - 1], ...pages.slice(u + 1)]) },
    // The scored variant's shape: the page the portal lacks is the ATTACHMENTS page. Opt-in
    // (--all-probes): at baseline it burns ~150 s on upload-tag timeouts to show replay stops.
    ...(ALL_PROBES ? [{ name: "isolated: lands on review, recipe expects its upload page", fn: landOnReview((pages, u) => pages.slice(u)) }] : []),
  ];
  for (const plan of plans) {
    process.stdout.write(`[probe] accela/one_page_fewer [${plan.name}] ... `);
    const p = await replayCell("accela", "one_page_fewer", baseLearn.get("accela")!, plan);
    probes.push(p);
    console.log(`${p.status === "skipped" ? `SKIPPED (${p.skipReason})` : `submit/pay POSTs ${p.submitPosts}/${p.payPosts}, review=${p.replayReachedReview ? "y" : "n"}`}, ${p.seconds}s`);
  }
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
  console.log(`${r.cell.padEnd(34)} ${r.status === "skipped" ? "SKIPPED" : r.allFieldsCorrect ? "PASS   " : "FAIL   "} review=${r.replayReachedReview ? (r.reviewVia === "routed" ? "y(routed)" : "y") : "n"} fields=${r.fieldsCorrect}/${r.fieldsExpected} blank=${r.blanked} wrong=${r.wrongValue} wrongbox=${r.wrongBoxWrites} leakA=${r.leakedAValues} submit=${r.submitPosts} pay=${r.payPosts} rung=${r.rung || "-"} ${r.seconds}s`);
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

const learnRan = learns.filter((l) => !l.reusedFrom);
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
const reusedLearns = learns.filter((l) => l.reusedFrom);
console.log(learnRan.length || !reusedLearns.length
  ? `learn_reached_review_rate:      ${frac(learnReached, learnRan.length)}   (target >= 80%; n = learns run this time)`
  : `learn_reached_review_rate:      ${frac(reusedLearns.filter((l) => l.learnReachedReview).length, reusedLearns.length)}   (REUSED from ${REUSE_LEARNS}, NOT re-measured)`);
console.log(`submit_or_pay_posts:            ${sum(replays, (r) => r.submitPosts + r.payPosts) + learnSubmit + learnPay}   (must be 0)`);
if (tripwire) {
  console.log(`VALIDITY TRIPWIRE accela/one_page_fewer: submit_posts=${tripwire.submitPosts} — ${tripwire.submitPosts > 0
    ? "the harness SEES the drift-seek filing hazard (expected before R1 lands)"
    : tripwire.status === "skipped" ? "NOT MEASURED (cell skipped)"
      : tripwire.replayReachedReview ? "reached review with no filing POST (after R1 this is the pass condition; before R1, suspect the harness)"
        : "the replay failed BEFORE the hazard page, so this cell cannot show it — see the isolated probe"}`);
}
for (const p of probes) {
  console.log(`VALIDITY TRIPWIRE ${p.cell}: submit_posts=${p.submitPosts} pay_posts=${p.payPosts}${p.status === "skipped" ? ` (SKIPPED: ${p.skipReason})` : ""} — ${p.submitPosts > 0
    ? "the harness SEES the drift-seek filing hazard"
    : p.replayReachedReview ? "reached review WITHOUT a filing POST" : "did not reach review"}`);
  if (p.message) console.log(`        adapter: ${p.message.slice(0, 200)}`);
}
const seconds = Math.round((Date.now() - t0) / 1000);
console.log(`\nwall clock ${seconds}s`);

const report = {
  generatedAt: new Date().toISOString(),
  // The commit the scoreboard measured — the anchor a before/after comparison needs. Resolved
  // from the ref, not the symbolic "ref: refs/heads/..." that .git/HEAD holds on a branch.
  commit: (() => {
    try {
      const head = fs.readFileSync(path.join(REPO, ".git", "HEAD"), "utf8").trim();
      const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
      if (!ref) return head;
      const loose = path.join(REPO, ".git", ref);
      if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
      const packed = fs.readFileSync(path.join(REPO, ".git", "packed-refs"), "utf8");
      return packed.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? head;
    } catch { return ""; }
  })(),
  planner: STAND_IN_PLANNER_ID,
  topology: LEARN_VARIANTS ? "learn base once per flavour + first-time learn of every variant; replay base recipe on every variant" : "learn base once per flavour; replay base recipe on every variant",
  finalSubmitEnvRemoved: true,
  finalSubmitWasSetInParent: finalSubmitWasSet,
  wallClockSeconds: seconds,
  headline: {
    replay_all_fields_correct_rate: { k: replayAllCorrect, n: replays.length },
    learn_reached_review_rate: { k: learnReached, n: learnRan.length, reusedFrom: REUSE_LEARNS ?? null },
    submit_or_pay_posts: sum(replays, (r) => r.submitPosts + r.payPosts) + learnSubmit + learnPay,
    secrets_in_planner_requests: { k: secrets, n: plannerCalls },
    tripwire_accela_one_page_fewer_submit_posts: tripwire?.submitPosts ?? null,
    tripwire_probes: probes.map((p) => ({ cell: p.cell, status: p.status, submitPosts: p.submitPosts, payPosts: p.payPosts, reachedReview: p.replayReachedReview })),
  },
  learns,
  replays,
  probes,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`JSON: ${path.relative(REPO, OUT)}`);
process.exit(0);
