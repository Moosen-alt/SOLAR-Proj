// RULE 5 ON EVERY DOOR THAT WRITES A TRACKING TARGET — and a refusal the operator can SEE.
//
// The add-target form was guarded (03081c0), but the track card's "I submitted it → capture #"
// form reached the same writer by another door: POST .../submittal-tracks/:type/mark-submitted
// -> markTrackSubmitted -> ensureCheckTarget, which stored a human-typed PowerClerk URL as a
// PERMIT target's portal_url (reproduced by the skeptic on a scratch DB). The guard now sits in
// ensureCheckTarget (the one creator) and at the top of markTrackSubmitted, so a building /
// electrical / combo track refuses a utility interconnection URL before anything is written.
//
// And the refusal must be visible: dashboard.js addPermitTarget had no catch, so the 400 was an
// unhandled rejection and clicking Track did nothing on screen; the message named a "target
// type: NEM" control that does not exist. It now names the NEM track card's "Public status URL".
//
// Fixtures are synthetic. The route part boots a real server on a temp DB (never 4173/4270).
//   npx tsx backend/test/permitTargetDoors.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-target-doors-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/MvcProjects/ProjectDetails";
const ACCELA = "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const T = await import("../src/submittalTracks");
const db = await openDatabase();
let n = 0;
const mk = () => R.createProject(db, {
  owner: "Door Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: `${++n} Door Way`, city: "Testport", zip: "97000",
  ahj: "City of Testport", utility: "Pacific Power",
} as never).project;
const rows = (sql: string, id: string): number => Number(db.get<{ n: number }>(sql, [id])?.n ?? 0);
const targetsOf = (id: string) => rows("SELECT COUNT(*) AS n FROM permit_check_targets WHERE project_id = ?", id);
const submissionsOf = (id: string) => rows("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", id);
const refusal = (fn: () => void): { status?: number; message: string } | null => {
  try { fn(); return null; } catch (e) { return { status: (e as { status?: number }).status, message: (e as Error).message }; }
};

console.log("\n1. markTrackSubmitted — the door the skeptic reproduced");
await check("MUST PASS: a PowerClerk URL on a COMBO track is refused (400) and NOTHING is written — no target, no submission", () => {
  const p = mk();
  const combo = T.requiredTracks(p).find((t) => t !== "nem")!;
  const r = refusal(() => T.markTrackSubmitted(db, p, combo, { applicationNumber: "187-26-000123-STR", trackingUrl: POWERCLERK }));
  assert.ok(r, `the ${combo} track accepted a utility interconnection URL`);
  assert.equal(r!.status, 400);
  assert.match(r!.message, /Public status URL/);
  assert.match(r!.message, /Utility net metering \(NEM\) \/ interconnection/, "the message must name the NEM track card");
  assert.doesNotMatch(r!.message, /target type/i, "must not point at a control that does not exist");
  assert.equal(targetsOf(p.id), 0, "a permit target was written with a utility URL");
  assert.equal(submissionsOf(p.id), 0, "a submission was recorded for a refused mark-submitted");
});
await check("MUST PASS: ensureCheckTarget itself refuses it (any future door), on the create AND the reuse path", () => {
  const p = mk();
  assert.ok(refusal(() => T.ensureCheckTarget(db, p, { track: "building", applicationNumber: "B-1", portalUrl: POWERCLERK })), "create path");
  T.ensureCheckTarget(db, p, { track: "building", applicationNumber: "B-2", portalUrl: ACCELA });
  assert.ok(refusal(() => T.ensureCheckTarget(db, p, { track: "building", applicationNumber: "B-2", trackingUrl: POWERCLERK })), "reuse path via trackingUrl");
  const url = db.get<{ portal_url: string; tracking_url: string }>("SELECT portal_url, tracking_url FROM permit_check_targets WHERE project_id = ?", [p.id]);
  assert.equal(url?.portal_url, ACCELA);
  assert.ok(!String(url?.tracking_url).includes("powerclerk"));
});
await check("MUST EXCLUDE: the NEM track takes the PowerClerk URL; a permit track takes Accela, even with a utility in its query", () => {
  const p = mk();
  T.markTrackSubmitted(db, p, "nem", { applicationNumber: "APP-111700", trackingUrl: POWERCLERK });
  const combo = T.requiredTracks(p).find((t) => t !== "nem")!;
  T.markTrackSubmitted(db, p, combo, { applicationNumber: "187-26-000124-STR", trackingUrl: `${ACCELA}?ref=pacificpower.net` });
  assert.equal(targetsOf(p.id), 2);
  assert.equal(submissionsOf(p.id), 2);
});
await check("MUST EXCLUDE: captureConfirmation (no portal URL) is unaffected — the confirmation lands and its target is created", () => {
  const p = mk();
  const ts = new Date().toISOString();
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'prepare_submit', 'awaiting_human_submit', ?, 'combo')", [`run-${p.id}`, p.id, ts]);
  db.run("INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, 'permit', 'combo', 'awaiting_human_submit', ?)", [`sub-${p.id}`, p.id, ts]);
  R.captureConfirmation(db, `run-${p.id}`, { applicationNumber: "187-26-000125-STR" });
  assert.equal(targetsOf(p.id), 1);
});
await check("ONE MESSAGE: the add-target form refuses with the same text", () => {
  const p = mk();
  const r = refusal(() => R.createPermitCheckTarget(db, p.id, { targetType: "permit", permitType: "building", portalUrl: POWERCLERK, applicationNumber: "APP-1" }));
  assert.equal(r?.message, T.UTILITY_URL_ON_PERMIT_TARGET_MESSAGE);
});

// Fixture for the route part, then release the file for the server process.
const routeProject = mk();
db.close();

console.log("\n2. Through the real route: POST /api/projects/:id/submittal-tracks/:type/mark-submitted");
const PORT = 5160 + Math.floor(Math.random() * 40); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, "backups"), AUTOPILOT_AUTO_START: "0", PORT: String(PORT),
  SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@doors.test", ADMIN_PASSWORD: "doors-test-password-1", NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: false,
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
const count = (sql: string): number => {
  const ro = new Database(dbPath, { readonly: true });
  try { return Number((ro.prepare(sql).get(routeProject.id) as { n: number }).n); } finally { ro.close(); }
};
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up. log tail:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@doors.test", password: "doors-test-password-1" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const mark = (type: string, body: Record<string, unknown>) => fetch(`${BASE}/api/projects/${routeProject.id}/submittal-tracks/${type}/mark-submitted`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  });
  const combo = T.requiredTracks(routeProject).find((t) => t !== "nem")!;

  await check(`MUST PASS (route): a PowerClerk status URL on the ${combo} track -> 400 naming the NEM card's field; nothing written`, async () => {
    const res = await mark(combo, { applicationNumber: "187-26-000200-STR", trackingUrl: POWERCLERK });
    const text = await res.text();
    assert.equal(res.status, 400, text.slice(0, 300));
    assert.match(String(JSON.parse(text).error), /Public status URL/);
    assert.equal(count("SELECT COUNT(*) AS n FROM permit_check_targets WHERE project_id = ?"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?"), 0);
  });
  await check("MUST EXCLUDE (route): the same URL on the NEM track is saved", async () => {
    const res = await mark("nem", { applicationNumber: "APP-111701", trackingUrl: POWERCLERK });
    assert.ok(res.status === 200 || res.status === 201, `${res.status} ${(await res.text()).slice(0, 300)}`);
    assert.equal(count("SELECT COUNT(*) AS n FROM permit_check_targets WHERE project_id = ? AND target_type = 'nem'"), 1);
  });
} catch (err) {
  failures++;
  console.error(`  FAIL - route harness: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  server.kill();
}

console.log("\n3. The dashboard shows the refusal (addPermitTarget lifted out of dashboard.js)");
const dashboardJs = fs.readFileSync(path.join(repoRoot, "frontend/dashboard.js"), "utf8");
const dashboardHtml = fs.readFileSync(path.join(repoRoot, "frontend/dashboard.html"), "utf8");
function liftFunction(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in dashboard.js`);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
await check("MUST PASS: a rejected POST shows the server's message as an error (not an unhandled rejection)", async () => {
  const shown: Array<[string, string]> = [];
  const inputs: Record<string, { value: string }> = new Proxy({}, { get: () => ({ value: "" }) });
  const factory = new Function("state", "$", "api", "showMessage", "loadOpsPlan", `${liftFunction(dashboardJs, "addPermitTarget")}; return addPermitTarget;`);
  const serverSays = T.UTILITY_URL_ON_PERMIT_TARGET_MESSAGE;
  const addPermitTarget = factory(
    { selectedProjectId: "p1", detail: null },
    (id: string) => inputs[id],
    async () => { throw new Error(serverSays); },
    (msg: string, kind: string) => { shown.push([msg, kind]); },
    async () => { throw new Error("must not reload after a refusal"); },
  ) as () => Promise<void>;
  await addPermitTarget(); // rejects here without the catch
  assert.deepEqual(shown, [[serverSays, "error"]]);
});
await check("MUST PASS: the add-target form no longer suggests PowerClerk as a permit portal", () => {
  const nameInput = /<input id="permitPortalName"[^>]*>/.exec(dashboardHtml)?.[0] ?? "";
  assert.ok(nameInput, "permitPortalName input not found");
  assert.doesNotMatch(nameInput, /powerclerk/i);
  const urlInput = /<input id="permitPortalUrl"[^>]*>/.exec(dashboardHtml)?.[0] ?? "";
  assert.match(urlInput, /NEM track card/);
});
await check("MUST EXCLUDE: the NEM track card really has the field the message names (captureFields)", () => {
  assert.match(fs.readFileSync(path.join(repoRoot, "backend/src/submittalTracks.ts"), "utf8"), /key: "trackingUrl", label: "Public status URL"/);
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* server may still hold the file on Windows */ }
if (failures) { console.error(`\n${failures} permit-target door check(s) FAILED`); process.exit(1); }
console.log("\nall permit-target door checks passed");
process.exit(0);
