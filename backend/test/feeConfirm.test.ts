// ONE-CLICK CONFIRM — a person vouches for a researched fee (operator 2026-09-27: "there is no
// place to verify them").
//
// What this pins, on the REAL schedule module and the REAL route:
//   1. A Coos-shaped split fee (city structural + county electrical reached through the city's
//      "the county collects it" pointer) is `confirmable` while seeded; Confirm marks ALL THREE
//      rows verified with verified_by = the confirming person and verified_at set, and the line
//      then reads verified, names the person, and is no longer confirmable.
//   2. Only a named person confirms: "", "dashboard", "system", "human" are refused (400) and
//      write nothing. Only a researched published-schedule amount is confirmable: an estimate,
//      an actual and an already-verified line are refused (409).
//   3. Afterwards automation cannot move it: a research pass over the verified row is refused
//      (refusedVerified) and the row is byte-identical, verified_by unchanged.
//   4. THE ROUTE: POST /api/projects/:id/fee-sheet/confirm on a real server with sign-in ON takes
//      WHO from the session — a body-supplied name is ignored — returns 401 signed out, and 404
//      for a project that does not exist (never 403).
//   5. WHO VERIFIED IS THE CONFIRMING ORG'S FACT (skeptic MF3): the org is recorded with the
//      verification; another org's card and its persisted submission_payments.fee_basis say
//      "human-verified" + the date and never the name; another org's confirm outcome never names
//      the first org's person; a two-org total and a no-org (script) row name nobody.
// Kill: feeConfirm writes "human" instead of the person -> 1c and 4b FAIL.
// Kill (MF3): verifierNameFor returns the name without the org comparison -> 5b, 5c, 5f, 5g FAIL
// (measured: 4 failures).
import "./_isolate";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-confirm-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const R = await import("../src/repository");
const F = await import("../src/feeSchedules");
const { buildProjectFeeSheet, recordActualPermitFee, feeLineConfirmable } = await import("../src/submissionFees");
const { confirmPublishedFee, isConfirmingPerson } = await import("../src/feeConfirm");
type Finding = import("../src/feeSchedules").FeeScheduleFinding;
const db = await openDatabase();

const finding = (over: Partial<Finding>): Finding => ({
  found: true, reason: "", basis: "flat", brackets: [], notes: "", paymentMethod: "portal",
  sourceUrl: "https://example.gov/fees.pdf", sourceQuote: "A sentence a person could go back and read.", sourceKind: "official", ...over,
});
const COUNTY_PDF = "https://co.coos.example/community_development_fees.pdf";
const seedSplit = (city: string, county: string): void => {
  const countyKey = F.feeScheduleProfileKey({ state: "OR", ahj: county }, "permit");
  F.saveFeeSchedule(db, { state: "OR", ahj: city, track: "permit", discipline: "structural" }, finding({
    brackets: [{ feeUsd: 200, label: "Solar PV installation permit" }], sourceUrl: "https://city.example/fees.pdf", sourceQuote: "Solar PV installation permit | $200.00",
  }));
  F.saveFeeSchedule(db, { state: "OR", ahj: county, track: "permit", discipline: "electrical" }, finding({
    basis: "system_kw",
    brackets: [{ maxKw: 5, feeUsd: 135, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" }],
    sourceUrl: COUNTY_PDF, sourceQuote: "5.01 KVA to 15 KVA | $160.00",
  }));
  F.saveFeeSchedule(db, { state: "OR", ahj: city, track: "permit", discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: countyKey, sourceUrl: "https://city.example/fees.pdf",
    sourceQuote: "A separate electrical permit is required through the county.",
  }));
};
const mk = (ahj: string, acKw = "7.68") => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.36", acKw, street: "1 Test Way", city: "Testbay", zip: "97420", ahj, utility: "Test Power",
} as never).project;
const rows = (ahj: string) => db.query<Record<string, unknown>>("SELECT id, discipline, confidence, verified_by, verified_at, brackets_json, source_quote, collected_by_profile_key FROM fee_schedules WHERE ahj = ? ORDER BY discipline", [ahj]);
const permitLine = (projectId: string) => buildProjectFeeSheet(db, R.getProjectDetail(db, projectId).project).lines.find((l) => l.track === "permit")!;

// ── 1. CONFIRM A SPLIT FEE ─────────────────────────────────────────────────────────────────
seedSplit("City of Confirmbay", "Confirm County");
const ann = mk("City of Confirmbay");
const before = permitLine(ann.id);
check("1a. the researched split fee is seeded, from the schedule, $360, and confirmable",
  before.source === "published_schedule" && before.confidence === "seeded" && before.feeUsd === 360 && before.confirmable === true,
  JSON.stringify({ s: before.source, c: before.confidence, f: before.feeUsd, k: before.confirmable }));

// 2 (first half): the refusals write nothing.
for (const who of ["", "  ", "dashboard", "System", "human", "operator"]) {
  let status = 0;
  try { confirmPublishedFee(db, ann, "permit", who, DEFAULT_ORG_ID); } catch (err) { status = (err as { status?: number }).status ?? -1; }
  check(`2a. "${who}" is not a person — refused 400`, status === 400, String(status));
}
check("2b. …and nothing was verified by a refused confirm", [...rows("City of Confirmbay"), ...rows("Confirm County")].every((r) => r.confidence === "seeded"));

const outcome = confirmPublishedFee(db, ann, "permit", "Jane Operator", DEFAULT_ORG_ID);
const city = rows("City of Confirmbay");
const county = rows("Confirm County");
check("1b. Confirm verified all three rows: city structural, the city's pointer, the county's electrical",
  outcome.verified.length === 3 && [...city, ...county].every((r) => r.confidence === "verified"),
  JSON.stringify(outcome.verified));
check("1c. verified_by is the confirming PERSON and verified_at is set",
  [...city, ...county].every((r) => r.verified_by === "Jane Operator" && String(r.verified_at).length >= 10),
  JSON.stringify([...city, ...county].map((r) => [r.verified_by, r.verified_at])));
const after = permitLine(ann.id);
check("1d. the line now reads verified, names the person, and is no longer confirmable",
  after.confidence === "verified" && after.verifiedBy === "Jane Operator" && after.confirmable === false && /human-verified by Jane Operator/.test(after.basis),
  JSON.stringify({ c: after.confidence, v: after.verifiedBy, k: after.confirmable, b: after.basis.slice(0, 160) }));

// 2 (second half): nothing-to-confirm refusals.
const refused409 = (fn: () => unknown): number => { try { fn(); return 200; } catch (err) { return (err as { status?: number }).status ?? -1; } };
check("2c. an already-verified line is refused 409", refused409(() => confirmPublishedFee(db, ann, "permit", "Jane Operator", DEFAULT_ORG_ID)) === 409);
const trued = mk("City of Confirmbay");
recordActualPermitFee(db, trued, "permit", 412.5, "operator");
check("2d. an operator-entered actual has nothing on the schedule to confirm — 409", refused409(() => confirmPublishedFee(db, trued, "permit", "Jane Operator", DEFAULT_ORG_ID)) === 409);
check("2e. …and its line is not confirmable", permitLine(trued.id).confirmable === false);
// The one predicate both doors ask (the sheet's control and confirmPublishedFee's refusal):
// only a seeded published-schedule amount. An estimate walked on a guessed valuation is not.
const grid: Array<[string, string, boolean]> = [
  ["published_schedule", "seeded", true], ["published_schedule", "estimated", false], ["published_schedule", "verified", false],
  ["actual", "actual", false], ["learned_history", "verified", false], ["valuation_estimate", "estimated", false], ["unknown", "unknown", false],
];
check("2f. feeLineConfirmable: only a seeded published-schedule amount",
  grid.every(([s, c, want]) => feeLineConfirmable(s as never, c as never) === want));

// ── 3. AUTOMATION CANNOT MOVE IT ───────────────────────────────────────────────────────────
const frozen = rows("Confirm County").find((r) => r.discipline === "electrical")!;
const research = F.saveFeeSchedule(db, { state: "OR", ahj: "Confirm County", track: "permit", discipline: "electrical" }, finding({
  basis: "system_kw", brackets: [{ maxKw: 5, feeUsd: 150, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 190, label: "5.01 KVA to 15 KVA" }],
  sourceUrl: COUNTY_PDF, sourceQuote: "5.01 KVA to 15 KVA | $190.00",
}));
const thawed = rows("Confirm County").find((r) => r.discipline === "electrical")!;
check("3a. a later research pass over the confirmed row is refused", research.refusedVerified === true && research.saved === false, research.reason);
check("3b. …the row's table and quote are byte-identical, and still verified by the person",
  thawed.brackets_json === frozen.brackets_json && thawed.source_quote === frozen.source_quote && thawed.confidence === "verified" && thawed.verified_by === "Jane Operator");
check("3c. isConfirmingPerson: a name passes, placeholders do not",
  isConfirmingPerson("Jane Operator") && isConfirmingPerson("jo@solar.example") && !isConfirmingPerson("Admin") && !isConfirmingPerson("x"));

// ── 5. WHO VERIFIED IS THE CONFIRMING ORG'S FACT (skeptic MF3) ─────────────────────────────
// fee_schedules is shared ON PURPOSE: every tenant quoting Tenantbay gets the verified amount. A
// person's identity is not shared knowledge (rule 6): the verifier's NAME shows only on the
// confirming org's projects; every other org reads "human-verified" + the date, and nothing
// persisted into another org's rows carries the name. The audit row stays with the confirming
// org's own project.
const OTHER_ORG = "org-mf3-beta";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [OTHER_ORG, "Beta Solar", new Date().toISOString()]);
const mkIn = (ahj: string, orgId: string) => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.36", acKw: "7.68", street: "2 Test Way", city: "Testbay", zip: "97420", ahj, utility: "Test Power",
} as never, orgId).project;
const orgOf = (...ahjs: string[]) => db.query<{ verified_org_id: string }>(`SELECT verified_org_id FROM fee_schedules WHERE ahj IN (${ahjs.map(() => "?").join(",")})`, ahjs).map((r) => r.verified_org_id);
{
  seedSplit("City of Tenantbay", "Tenant County");
  const mine = mkIn("City of Tenantbay", DEFAULT_ORG_ID);
  confirmPublishedFee(db, mine, "permit", "Jane Operator", DEFAULT_ORG_ID);
  check("5a. the confirming org is recorded with the verification, on every row it verified",
    orgOf("City of Tenantbay", "Tenant County").length === 3 && orgOf("City of Tenantbay", "Tenant County").every((o) => o === DEFAULT_ORG_ID), JSON.stringify(orgOf("City of Tenantbay", "Tenant County")));
  const theirs = mkIn("City of Tenantbay", OTHER_ORG);
  const theirLine = permitLine(theirs.id);
  check("5b. MUST-EXCLUDE: another org's card reads verified, 'human-verified' + the date, and never the name",
    theirLine.confidence === "verified" && theirLine.verifiedBy === "" && /human-verified on \d{4}-\d{2}-\d{2}/.test(theirLine.basis) && !/Jane/.test(JSON.stringify(theirLine)),
    JSON.stringify({ c: theirLine.confidence, v: theirLine.verifiedBy, b: theirLine.basis.slice(0, 200) }));
  const theirStored = String(db.get<{ fee_basis: string }>("SELECT fee_basis FROM submission_payments WHERE project_id = ? AND track = 'permit'", [theirs.id])?.fee_basis ?? "");
  check("5c. MUST-EXCLUDE: …and the other org's persisted quote row (submission_payments.fee_basis) carries no name",
    /human-verified/.test(theirStored) && !/Jane/.test(theirStored), theirStored.slice(0, 200));
  const mineLine = permitLine(mine.id);
  check("5d. MUST-PASS: the confirming org's own card still names the person, and the date",
    mineLine.verifiedBy === "Jane Operator" && /human-verified by Jane Operator on \d{4}-\d{2}-\d{2}/.test(mineLine.basis), mineLine.basis.slice(0, 200));

  // A second org confirms a total one row of which the first org already verified: its outcome
  // (the response, and its own audit trail) names nobody from the first org, and a total vouched
  // for by two orgs' people names nobody on either card.
  seedSplit("City of Mixbay", "Mix County");
  const mixMine = mkIn("City of Mixbay", DEFAULT_ORG_ID);
  const cityRow = rows("City of Mixbay").find((r) => r.discipline === "structural")!;
  F.markFeeScheduleVerifiedById(db, String(cityRow.id), "Jane Operator", DEFAULT_ORG_ID);
  const mixTheirs = mkIn("City of Mixbay", OTHER_ORG);
  const mixOutcome = confirmPublishedFee(db, mixTheirs, "permit", "Bob Beta", OTHER_ORG);
  check("5e. MUST-EXCLUDE: another org's confirm outcome does not name the first org's verifier",
    mixOutcome.alreadyVerified.length === 1 && mixOutcome.alreadyVerified[0].verifiedBy === "" && !/Jane/.test(JSON.stringify(mixOutcome)), JSON.stringify(mixOutcome));
  const mixA = permitLine(mixMine.id);
  const mixB = permitLine(mixTheirs.id);
  check("5f. a total vouched for by two orgs' people is verified and names nobody on either org's card",
    mixA.confidence === "verified" && mixB.confidence === "verified" && mixA.verifiedBy === "" && mixB.verifiedBy === "" && !/Jane|Bob/.test(mixA.basis + mixB.basis),
    JSON.stringify([mixA.verifiedBy, mixB.verifiedBy, mixA.basis.slice(0, 120)]));

  // The script door (markFeeScheduleVerified) records no org — so it names nobody (fail closed).
  F.saveFeeSchedule(db, { state: "OR", ahj: "City of Legacybay", track: "permit" }, finding({ brackets: [{ feeUsd: 120, label: "Solar PV installation permit" }] }));
  F.markFeeScheduleVerified(db, F.feeScheduleProfileKey({ state: "OR", ahj: "City of Legacybay" }, "permit"), "permit", "Legacy Person");
  const legacy = permitLine(mkIn("City of Legacybay", DEFAULT_ORG_ID).id);
  check("5g. a row verified with no org on record is 'human-verified' and names nobody (fail closed)",
    legacy.confidence === "verified" && legacy.verifiedBy === "" && !/Legacy Person/.test(legacy.basis) && /human-verified/.test(legacy.basis), legacy.basis.slice(0, 160));
}

// ── 4. THE ROUTE, sign-in ON ───────────────────────────────────────────────────────────────
seedSplit("City of Routebay", "Route County");
const routed = mk("City of Routebay");
db.close();

const PORT = 5160 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, "backups"), AUTOPILOT_AUTO_START: "0", PORT: String(PORT),
  SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@fee.test", ADMIN_PASSWORD: "fee-test-password-1", NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
const read = (sql: string, args: unknown[] = []): Array<Record<string, unknown>> => {
  const h = new Database(dbPath, { readonly: true });
  try { return h.prepare(sql).all(...args) as Array<Record<string, unknown>>; } finally { h.close(); }
};
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const post = (projectId: string, body: unknown, cookie = "") => fetch(`${BASE}/api/projects/${projectId}/fee-sheet/confirm`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const anon = await post(routed.id, { track: "permit", confirmedBy: "Mallory Forger" });
  check("4a. signed out: 401, and nothing verified", anon.status === 401 && read("SELECT 1 FROM fee_schedules WHERE ahj IN ('City of Routebay','Route County') AND confidence = 'verified'").length === 0, String(anon.status));
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@fee.test", password: "fee-test-password-1" }) });
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const res = await post(routed.id, { track: "permit", confirmedBy: "Mallory Forger" }, cookie);
  const body = await res.json().catch(() => ({})) as { outcome?: { confirmedBy?: string }; feeSheet?: { lines?: Array<{ track: string; confidence: string; verifiedBy: string }> } };
  const who = read("SELECT DISTINCT verified_by FROM fee_schedules WHERE ahj IN ('City of Routebay','Route County')").map((r) => r.verified_by);
  check("4b. signed in: WHO is the session's person, never the body's name",
    res.status === 200 && who.length === 1 && who[0] === "admin@fee.test" && body.outcome?.confirmedBy === "admin@fee.test",
    `${res.status} ${JSON.stringify(who)} ${JSON.stringify(body).slice(0, 200)}`);
  check("4c. the response carries the refreshed sheet: the permit line is verified by that person",
    body.feeSheet?.lines?.find((l) => l.track === "permit")?.confidence === "verified" && body.feeSheet?.lines?.find((l) => l.track === "permit")?.verifiedBy === "admin@fee.test");
  const audit = read("SELECT actor_name, action FROM audit_logs WHERE project_id = ? AND action = 'fee.schedule_confirmed'", [routed.id]);
  check("4d. the confirmation is in the audit trail under the person", audit.length === 1, JSON.stringify(audit));
  const missing = await post("no-such-project", { track: "permit" }, cookie);
  check("4e. a project that does not exist is 404, never 403", missing.status === 404, String(missing.status));
} finally {
  server.kill("SIGTERM");
}

await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows may hold the killed server's handle a moment longer; the OS temp dir is reaped */ }
if (failures) { console.error(`\nfeeConfirm: ${failures} failure(s)`); process.exit(1); }
console.log("\nfeeConfirm: all checks passed");
process.exit(0);
