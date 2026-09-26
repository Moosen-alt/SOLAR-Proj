// THE LEARN'S OWN DOOR, THE KB WRITE, THE VERIFIERS, TRIAGE AND THE OPERATOR ROUTES.
//
// bot-plan O1 + the entry/route half of B1 (2026-09-24):
//   (a) autoLearnPortal refuses — before ANY browser launches — a URL that is the other track's
//       kind of portal (rule 5, both ways) or another entity's portal. A stub launcher proves
//       nothing was opened. Every caller reaches a browser through this door.
//   (b) a TRUSTED learn's KB write is keyed on profile_key + state, never touches a verified row
//       (rule 3, read via isVerifiedKnowledge) nor a same-named row in another state (it used to
//       be `UPDATE … WHERE ahj = ?` across every state), and only writes a URL that fits.
//   (c) the vision verifier gets the same non-sensitive review fields the text verifier gets
//       (rule 2 — it used to receive account and meter numbers).
//   (d) a review screen is "readable" only with parsed fields or a vision read — never a bare
//       body-text snippet.
//   (e) triage never hands the LLM a review / after-fill screenshot, nor a secret field's values.
//   (f) the operator routes that take a portal URL (/auto-learn, /launch-record,
//       /portal-recipes/record, the verified KB profile routes) refuse with 409 before acting.
// Everything drives the real code: autoLearnPortal with the browser + LLM stubbed through
// setAutoLearnSeamsForTests, KB rows through the real KB writers, the routes on a real server.
//
// KILL TESTS (each turns this file red — verified by hand, see the commit):
//   K1 autoLearn: remove the host check at the learn's door        → (a1)(a2)(a3) reach the launcher.
//   K2 autoLearn.recordTrustedLearnPortalUrl: no verified skip     → (b) fails.
//   K3 autoLearn.recordTrustedLearnPortalUrl: write by AHJ name in
//      every state (the old UPDATE … WHERE ahj = ?)                 → (b) fails.
//   K4 autoLearn: vision verifier gets learn.reviewScreen.fields   → (c) fails.
//   K5 autoLearn: reviewReadable counts a body snippet again       → (d) fails.
//   K6 runTriage.isUnmaskedFilledShot: always false                → (e) fails.
//   K7 server: drop the /auto-learn route check                    → (f) fails.
//   K8 repository.researchWithFittedUrl: return research unchanged  → (g) fails.
//
// Run: npx tsx backend/test/learnTrackGuard.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("learn-track-guard");
const { db, repo, recipes } = fx;
const autoLearn = await import("../src/autoLearn");
const kb = await import("../src/knowledgeBase");
const llmMod = await import("../src/llm");
const triage = await import("../src/runTriage");

const PGE_NM = "https://pgenm.powerclerk.com/MvcAccount/Login";
const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const GRESHAM = "https://aca-gresham.accela.example/gresham/Default.aspx";
const GRESHAM_OTHER_PAGE = "https://aca-gresham.accela.example/gresham/Cap/CapHome.aspx";

// ── the stub launcher and the stub LLM ───────────────────────────────────────────────────────
let launches = 0;
let nextLearn: Record<string, unknown> = {};
const failedLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({
  learnPortal: (async () => { launches++; return { ...failedLearn, ...nextLearn }; }) as never,
});
const verified = { accurate: true, overallConfidence: "high" as const, matches: [{ label: "Owner", expected: "x", found: "x", ok: true }], issues: [], notes: "" };
const textCalls: Array<{ reviewFields: Array<{ label: string }> }> = [];
const visionCalls: Array<{ reviewFields: Array<{ label: string }> }> = [];
const base = llmMod.createLLMProvider(); // no API key → the stub provider
const fakeLlm = Object.assign(Object.create(base), {
  verifyPortalFill: async (input: { reviewFields: Array<{ label: string }> }) => { textCalls.push(input); return verified; },
  verifyPortalFillVision: async (input: { reviewFields: Array<{ label: string }> }) => { visionCalls.push(input); return verified; },
});
autoLearn.setAutoLearnSeamsForTests({ llm: () => fakeLlm });

const refusedBeforeLaunch = async (projectId: string, scope: "ahj" | "utility", portalUrl: string, code: string) => {
  const before = launches;
  await assert.rejects(
    autoLearn.autoLearnPortal(db, projectId, { scope, portalUrl, createdBy: "operator" }),
    (err: { status?: number; details?: { code?: string } }) => err.status === 409 && err.details?.code === code,
  );
  assert.equal(launches, before, "nothing may launch on a refused URL");
};

// Evidence: PGE's NEM portal belongs to PGE (a utility recipe through the real writers).
{
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: PGE_NM, createdBy: "test" });
  recipes.savePortalRecipeSteps(db, r.id, [{ action: "fill", selector: { name: "a" }, field: "homeownerName" }, { action: "stopForReview", selector: {} }] as RecipeStep[], { status: "complete" });
}

await check("(a1) an AHJ learn on a PowerClerk URL is refused before any browser launches", async () => {
  await refusedBeforeLaunch(fx.newProject(), "ahj", PGE_NM, "track_conflict");
});
await check("(a2) a utility learn on an Accela permit URL is refused before any browser launches", async () => {
  await refusedBeforeLaunch(fx.newProject(), "utility", ACA_OREGON, "track_conflict");
});
await check("(a3) a Pacific Power project cannot learn PGE's portal", async () => {
  await refusedBeforeLaunch(fx.newProject({ utility: "Pacific Power" }), "utility", PGE_NM, "foreign_entity");
});
await check("(a4) MUST-PASS: the project's own kind of portal reaches the launcher", async () => {
  const before = launches;
  nextLearn = {};
  await autoLearn.autoLearnPortal(db, fx.newProject(), { scope: "ahj", portalUrl: "https://devhub.portlandoregon.gov/", createdBy: "operator" });
  assert.equal(launches, before + 1);
});

// ── a TRUSTED learn, end to end through autoLearnPortal ──────────────────────────────────────
function trustedLearnFor(projectId: string, portalUrl: string, reviewFields: Array<{ label: string; value: string }>) {
  const project = repo.getProjectDetail(db, projectId).project;
  const replay = recipes.resolveRecipeFieldValues(db, project, "AHJ");
  const keys = Object.keys(replay).filter((k) => String(replay[k] ?? "").trim() && !/acc(oun)?t|meter|ssn|passw/i.test(k)).slice(0, 6);
  assert.ok(keys.length >= 5, `fixture: need 5 bindable fields, got ${keys.join(",")}`);
  return {
    ok: true, portalName: "Gresham Permits", pageCount: 3, pauseReason: null, finalSubmitRecorded: false,
    reachedReview: true, filledSomething: true, message: "reached review",
    steps: [
      { action: "goto", value: portalUrl, note: "entry url" },
      ...keys.map((k, i) => ({ action: "fill", selector: { name: `f${i}` }, field: k, note: k })),
      { action: "stopForReview", selector: {} },
    ],
    reviewScreen: { fields: reviewFields, bodyTextSnippet: "Review your application before submitting." },
    reviewScreenshotBase64: "iVBORw0KGgo=",
  };
}

await check("(b) a trusted learn writes its URL to THIS entity's rows in THIS state — never a verified row, never another state", async () => {
  // The world, through the real KB writers:
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Gresham", portalUrl: GRESHAM, portalPlatform: "accela", verifiedBy: "test" });
  const research = (state: string, portalUrl: string, utility?: string) => kb.saveResearchedAhjProfile(db, { state, ahj: "City of Gresham", utility }, {
    provider: "claude", portalName: "", portalPlatform: "", portalUrl, submissionMethod: "online", requiredDocuments: ["Plan set"],
    commonCorrections: [], tips: [], submissionSteps: [], confidence: "medium", needsHumanVerification: true, notes: "", webGrounded: true,
  });
  const waRow = research("WA", "https://permits.greshamwa.example/");
  const orUtilityRow = research("OR", "", "PGE");
  const projectId = fx.newProject({ ahj: "City of Gresham", city: "Gresham", zip: "97030" });
  nextLearn = trustedLearnFor(projectId, GRESHAM_OTHER_PAGE, [{ label: "Owner", value: "x" }]);
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl: GRESHAM_OTHER_PAGE, createdBy: "operator" });
  assert.equal(result.status, "trusted", `setup: the learn must be trusted to reach the KB write (${result.message})`);
  const row = (key: string) => db.get<{ portal_url: string }>("SELECT portal_url FROM permit_utility_knowledge WHERE profile_key = ?", [key])!;
  assert.equal(row(kb.knowledgeProfileKey({ state: "OR", ahj: "City of Gresham" })).portal_url, GRESHAM, "the verified row is untouched (rule 3)");
  assert.equal(row(waRow.profileKey).portal_url, "https://permits.greshamwa.example/", "the WA Gresham is another city");
  assert.equal(row(orUtilityRow.profileKey).portal_url, GRESHAM_OTHER_PAGE, "MUST-PASS: this entity's unverified row in this state is written");
  // …and a URL that does not fit is never written at all.
  const refused = autoLearn.recordTrustedLearnPortalUrl(db, { scope: "ahj", state: "OR", ahj: "City of Gresham", utility: "PGE", portalUrl: PGE_NM });
  assert.ok(refused.refused && !refused.written.length, JSON.stringify(refused));
});

await check("(c) the vision verifier never receives an account or meter number field", async () => {
  const projectId = fx.newProject({ ahj: "City of Gresham", city: "Gresham", zip: "97030" });
  visionCalls.length = 0;
  textCalls.length = 0;
  nextLearn = trustedLearnFor(projectId, GRESHAM, [
    { label: "Owner", value: "x" },
    { label: "Account Number", value: "1234567890" },
    { label: "Meter #", value: "987654321" },
  ]);
  await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl: GRESHAM, createdBy: "operator" });
  assert.equal(visionCalls.length, 1, "setup: the vision verifier ran");
  for (const call of [...visionCalls, ...textCalls]) {
    const labels = call.reviewFields.map((f) => f.label);
    assert.ok(!labels.some((l) => autoLearn.SENSITIVE_REVIEW_LABEL.test(l)), `a verifier received ${labels.join(", ")}`);
    assert.ok(labels.includes("Owner"), "MUST-PASS: ordinary fields still go");
  }
});

await check("(d) a review screen with no parsed fields and no vision read is not readable, so not trusted", async () => {
  const projectId = fx.newProject({ ahj: "City of Gresham", city: "Gresham", zip: "97030" });
  const learn = trustedLearnFor(projectId, GRESHAM, []);
  delete (learn as Record<string, unknown>).reviewScreenshotBase64; // no vision read either
  learn.reviewScreen.bodyTextSnippet = "Home | Help | Log out | Your application | Step 4 of 4 | Review | ".repeat(6);
  nextLearn = learn;
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl: GRESHAM, createdBy: "operator" });
  assert.notEqual(result.status, "trusted", "a body snippet alone must not make an unread page verifiable");
  assert.ok(result.verification.issues.some((i) => /could not be read/.test(i)), JSON.stringify(result.verification.issues));
});

await check("(e) triage withholds review and after-fill screenshots and secret values (MUST-PASS + MUST-EXCLUDE)", () => {
  for (const f of ["review.png", "p003-after-page.png", "p012-after-fill.png", "REVIEW.PNG"]) assert.equal(triage.isUnmaskedFilledShot(f), true, f);
  for (const f of ["p001-before-page.png", "login-ok.png", "p004-reviewer-notes.png"]) assert.equal(triage.isUnmaskedFilledShot(f), false, f);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-digest-"));
  fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify({ deterministicSignal: { allMismatches: [
    { field: "accountNumber", expected: "1234567890", found: "0000000000" },
    { field: "homeownerName", expected: "Jane Doe", found: "Jane Roe" },
  ] } }));
  const { summary } = triage.digestBundle(dir);
  assert.ok(!summary.includes("1234567890") && !summary.includes("0000000000"), summary);
  assert.ok(summary.includes("Jane Roe"), "MUST-PASS: an ordinary mismatch still shows its values");
});

await check("(g) research that lands on the wrong portal is not saved as the entity's own URL (the next stage would launch it)", () => {
  // Tigard's verified EnerGov row (through the real writer) — research that says Accela disagrees.
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Tigard", portalUrl: "https://tigardor-energovweb.tylerhost.net/apps/SelfService#/home", portalPlatform: "EnerGov", verifiedBy: "test" });
  const research = { portalUrl: ACA_OREGON, notes: "" };
  const saved = repo.researchWithFittedUrl(db, "permit", { state: "OR", name: "City of Tigard" }, research);
  assert.equal(saved.portalUrl, "", "the conflicting URL is left out of what is saved");
  assert.equal(research.portalUrl, ACA_OREGON, "the caller still sees what research found");
  assert.equal(repo.researchWithFittedUrl(db, "nem", { state: "OR", name: "PGE" }, { portalUrl: ACA_OREGON, notes: "" }).portalUrl, "", "a permit portal is never a utility's");
  // MUST-PASS: research for a new AHJ with no evidence keeps its URL.
  assert.equal(repo.researchWithFittedUrl(db, "permit", { state: "TX", name: "City of Hereford" }, { portalUrl: "https://www.mygovernmentonline.org/", notes: "" }).portalUrl, "https://www.mygovernmentonline.org/");
});

// ── the operator routes, on a real server over the same DB ───────────────────────────────────
const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const projectForRoutes = fx.newProject();
const PORT = 5160 + Math.floor(Math.random() * 40); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@learnguard.test", ADMIN_PASSWORD: "learn-guard-password-1", NO_PROXY: "*", no_proxy: "*",
  AUTOPILOT_TEST_SEAMS: "",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
// (h) A LOGIN MET MID-RUN on another host. Live (City of Jefferson, 2026-09-25): the run started
// on a state help page, met Accela's sign-in later, and had no way to ask for Accela's login. The
// learner is handed a resolver; it must return the saved login for THAT host + jurisdiction only.
// KILL: drop credentialForUrl from runLearn's options → "the learner is given no resolver" fails.
await check("(h) a login met mid-run on another host gets that host's own saved login, and only that one", async () => {
  process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
  const creds = await import("../src/portalCredentials");
  creds.createPortalCredential(db, fx.client.id, { portalType: "ahj", portalUrl: "https://aca-oregon.accela.com/oregon/", username: "tml-test-user", password: "not-a-real-password" });
  let seen: ((u: string) => unknown) | undefined;
  autoLearn.setAutoLearnSeamsForTests({
    learnPortal: (async (input: { credentialForUrl?: (u: string) => unknown }) => { launches++; seen = input.credentialForUrl; return { ...failedLearn }; }) as never,
  });
  try {
    await autoLearn.autoLearnPortal(db, fx.newProject(), { scope: "ahj", portalUrl: "https://devhub.portlandoregon.gov/", createdBy: "operator" });
  } finally {
    autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => { launches++; return { ...failedLearn, ...nextLearn }; }) as never });
  }
  assert.equal(typeof seen, "function", "the learner is given no resolver: a mid-run login on another host can never sign in");
  const hit = (await Promise.resolve(seen!("https://aca-oregon.accela.com/oregon/Login.aspx?ReturnUrl=x"))) as { username?: string } | null;
  assert.equal(hit?.username, "tml-test-user", "MUST-PASS: Accela's sign-in page gets the saved Accela login");
  assert.equal(await Promise.resolve(seen!("https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login")), null, "MUST-EXCLUDE: another portal's host gets nothing");
  assert.equal(await Promise.resolve(seen!("https://aca-oregon.accela.com/otherjurisdiction/Login.aspx")), null, "MUST-EXCLUDE: another jurisdiction on the same Accela host gets nothing");
  assert.equal(await Promise.resolve(seen!("https://aca-prod.accela.com/sandiego/Login.aspx")), null, "MUST-EXCLUDE: another Accela host gets nothing");
});

const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@learnguard.test", password: "learn-guard-password-1" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const post = (p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const jobsFor = (projectId: string) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'auto_learn'", [projectId])!.n;

  await check("(f) the routes that take a portal URL refuse the wrong one with 409 before acting (MUST-PASS: the right one is accepted)", async () => {
    let res = await post(`/api/projects/${projectForRoutes}/auto-learn`, { scope: "ahj", portalUrl: PGE_NM });
    assert.equal(res.status, 409, await res.text());
    assert.equal(jobsFor(projectForRoutes), 0, "no learn job was queued");
    res = await post(`/api/projects/${projectForRoutes}/auto-learn`, { scope: "utility", portalUrl: ACA_OREGON });
    assert.equal(res.status, 409, await res.text());
    res = await post(`/api/projects/${projectForRoutes}/launch-record`, { scope: "ahj", portalUrl: PGE_NM });
    assert.equal(res.status, 409, "the recorder must not open the NEM portal for a permit");
    res = await post("/api/portal-recipes/record", { scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", portalUrl: PGE_NM });
    assert.equal(res.status, 409, await res.text());
    res = await post("/api/knowledge-base/ahj-profile", { state: "OR", ahj: "City of Tigard", portalUrl: PGE_NM });
    assert.equal(res.status, 409, "a verified AHJ profile cannot pin the permit track to a utility portal");
    res = await post("/api/knowledge-base/utility-profile", { state: "OR", utility: "PGE", portalUrl: ACA_OREGON });
    assert.equal(res.status, 409);
    // MUST-PASS
    res = await post("/api/portal-recipes/record", { scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", portalUrl: "https://devhub.portlandoregon.gov/" });
    assert.equal(res.status, 201, await res.text());
  });

  // ── trust skeptic M1, the route half: the approval this request minted rides in ITS job ──
  await check("(m1-route) Approve & Submit enqueues the approval's id in its own job; the run claims it BEFORE the first gate, so a gate-refused run has used it up", async () => {
    // A project an early gate refuses before any browser: an operator hold (the first gate).
    const held = fx.newProject();
    repo.setProjectStatusByOperator(db, held, "blocked", "waiting on the homeowner", "operator");
    const res = await post(`/api/projects/${held}/prepare-submission`, { track: "building", autoSubmit: true });
    const body = await res.text();
    assert.equal(res.status, 202, body);
    const { jobId } = JSON.parse(body) as { jobId: string };
    const approvals = db.query<{ id: string; consumed_at: string | null }>("SELECT id, consumed_at FROM portal_run_approvals WHERE project_id = ?", [held]);
    assert.equal(approvals.length, 1, "the signed-in approver's request minted no approval");
    const job = db.get<{ payload: string; status: string; error: string | null }>("SELECT payload, status, error FROM job_queue WHERE id = ?", [jobId])!;
    const payload = JSON.parse(job.payload) as { autoSubmit?: boolean; approvalId?: string | null };
    assert.equal(payload.approvalId, approvals[0].id, "the job does not carry the approval it was minted with");
    assert.equal(payload.autoSubmit, true);
    for (let i = 0; i < 100 && db.get<{ status: string }>("SELECT status FROM job_queue WHERE id = ?", [jobId])?.status === "running"; i++) await new Promise((r) => setTimeout(r, 100));
    const finished = db.get<{ status: string; error: string | null }>("SELECT status, error FROM job_queue WHERE id = ?", [jobId])!;
    assert.equal(finished.status, "failed", `the held project's run was not refused: ${JSON.stringify(finished)}`);
    assert.match(String(finished.error), /blocked by an operator/);
    assert.equal(db.query("SELECT id FROM portal_runs WHERE project_id = ?", [held]).length, 0, "a refused run wrote a run row");
    const consumed = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [approvals[0].id]);
    assert.ok(consumed?.consumed_at, "the gate-refused run left its approval live for the next request to pick up");
  });

  // ── trust skeptic M4, the route half: the flag is returned with the recipe and a human clears it ──
  await check("(m4-route) GET /api/portal-recipes returns the flag; POST …/clear-flag clears it as the signed-in person", async () => {
    const recipe = fx.completeRecipe();
    // The flag's own writer: an unattributed replay failure (keep-and-flag).
    const verdict = recipes.demoteOnReplayFailure(db, recipe.id, "Portal run errored: Cannot read properties of undefined (reading 'x')", recipe.version, {});
    assert.equal(verdict.action, "flagged", "setup: the failure was not flagged");
    let res = await fetch(`${BASE}/api/portal-recipes`, { headers: { cookie } });
    const listed = ((await res.json()) as { recipes: Array<{ id: string; flagReason?: string; flaggedAt?: string | null }> }).recipes.find((r) => r.id === recipe.id);
    assert.ok(listed?.flagReason && listed.flaggedAt, `the route does not return the flag: ${JSON.stringify(listed)}`);
    res = await post(`/api/portal-recipes/${recipe.id}/clear-flag`, { note: "looked at the run" });
    const cleared = (await res.json()) as { flagReason?: string; flaggedAt?: string | null; status?: string };
    assert.equal(res.status, 200, JSON.stringify(cleared));
    assert.equal(cleared.flagReason, "");
    assert.equal(cleared.status, "complete");
    const audit = db.get<{ actor_name: string }>("SELECT actor_name FROM audit_logs WHERE action = 'portal_recipe.flag_cleared' AND details LIKE ? ORDER BY created_at DESC", [`%${recipe.id}%`]);
    assert.match(String(audit?.actor_name), /admin@learnguard.test|admin/i, "the clear is not attributed to the signed-in person");
    res = await post("/api/portal-recipes/does-not-exist/clear-flag", {});
    assert.equal(res.status, 404);
  });
} finally {
  server.kill("SIGTERM");
}

finish("learn-track-guard");
