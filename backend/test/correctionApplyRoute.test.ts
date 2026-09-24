// THE APPROVAL, THROUGH THE REAL ROUTE: POST /api/corrections/:id/apply.
//
// Two traps the direct-function tests could not prove were closed at the edge the dashboard
// actually calls (a real server process on a temp database, logged in, stub LLM, no network):
//   1. A fields-only (project) approval must not STRAND the jurisdiction proposals: the review
//      item stays pending with them still "proposed", and the next {} click applies them and
//      closes it — without re-running the project half (the designer wait) a second time.
//   2. A jurisdiction-only approval must CLOSE the review item (not leave it pending with nothing
//      to click) and mark the correction human-reviewed — while the correction itself stays open.
//
// Fixtures are synthetic and written through the real write path (addManualCorrection) before
// the server boots on the same file.
//
//   npx tsx backend/test/correctionApplyRoute.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-apply-route-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

// ── fixtures, through the real write path ──────────────────────────────────────────────────
const TEXT_A = "Provide updated design criteria for the letter from the engineer and the plan set. -Ground snow load 36 psf. "
  + "Provide updated mounting spacing. -The mounting spacing should be 2' oc per R324.4.1 exception 5 exception 1.4. "
  + "Provide UL listing for the panels, mounting and racking hardware.";
const ids = await (async () => {
  const { openDatabase } = await import("../src/db");
  const R = await import("../src/repository");
  const CP = await import("../src/codeProfiles");
  const db = await openDatabase();
  const seeded = (ahj: string) => CP.saveResearchedCodeProfile(db, {
    key: "", state: "OR", ahj, confidence: "seeded", adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [],
    designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  });
  const mk = (ahj: string) => R.createProject(db, {
    owner: "Synthetic Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testbay", zip: "97420", ahj, utility: "Test Power",
  } as never).project.id;
  seeded("City of Routeselect");
  seeded("City of Routeonly");
  const pSelect = mk("City of Routeselect");
  const cSelect = R.addManualCorrection(db, pSelect, TEXT_A).corrections[0].id;
  const pOnly = mk("City of Routeonly");
  const cOnly = R.addManualCorrection(db, pOnly, "Ground snow load 36 psf.").corrections[0].id;
  db.close();
  return { pSelect, cSelect, pOnly, cOnly };
})();

// ── the real server on the same file ───────────────────────────────────────────────────────
const PORT = 5110 + Math.floor(Math.random() * 40); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath,
  BACKUP_DIR: path.join(tmpDir, "backups"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true",
  ADMIN_EMAIL: "admin@route.test",
  ADMIN_PASSWORD: "route-test-password-1",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: false,
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const read = <T>(sql: string, args: unknown[] = []): T => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(sql).get(...args) as T; } finally { db.close(); }
};
const item = (projectId: string, correctionId: string): { status: string; payload: Record<string, unknown> } => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT status, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'").all(projectId) as Array<{ status: string; notes: string }>;
    const hit = rows.find((r) => r.notes.includes(`"correctionId":"${correctionId}"`))!;
    return { status: hit.status, payload: JSON.parse(hit.notes.slice("agent-triage:".length)) };
  } finally { db.close(); }
};
const profileSnow = (ahj: string): unknown => {
  const row = read<{ payload_json: string } | undefined>("SELECT payload_json FROM jurisdiction_code_profiles WHERE ahj = ?", [ahj]);
  return row ? (JSON.parse(row.payload_json).designCriteria ?? {}).groundSnowLoadPsf : undefined;
};
const audits = (projectId: string, action: string): number =>
  read<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = ?", [projectId, action]).n;

let cookie = "";
const apply = (correctionId: string, body: Record<string, unknown>) => fetch(`${BASE}/api/corrections/${correctionId}/apply`, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
});

try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up. log tail:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@route.test", password: "route-test-password-1" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

  await run("fields-only (project) apply via the route: the item stays PENDING with its jurisdiction proposals still 'proposed'", async () => {
    const res = await apply(ids.cSelect, { fields: ["meterNumber"] });
    assert.equal(res.status, 200, (await res.text()).slice(0, 300));
    assert.equal(profileSnow("City of Routeselect"), undefined, "an unselected jurisdiction value was written");
    const it = item(ids.pSelect, ids.cSelect);
    assert.equal(it.status, "pending", "the item closed and stranded its jurisdiction proposals");
    const j = it.payload.jurisdictionProposals as Array<{ status: string }>;
    assert.ok(j.length === 3 && j.every((p) => p.status === "proposed"), JSON.stringify(j.map((p) => p.status)));
    assert.equal(audits(ids.pSelect, "correction.waiting_on_designer"), 1);
  });

  await run("the next {} click via the route applies them, closes the item, and does NOT re-run the designer wait", async () => {
    const res = await apply(ids.cSelect, {});
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(JSON.parse(text).jurisdictionCriteria?.applied?.length, 3);
    assert.equal(profileSnow("City of Routeselect"), 36);
    assert.equal(item(ids.pSelect, ids.cSelect).status, "approved");
    assert.equal(audits(ids.pSelect, "correction.waiting_on_designer"), 1, "the project half ran a second time");
  });

  await run("jurisdiction-only approval via the route: item CLOSED, correction human-reviewed, correction still open", async () => {
    const res = await apply(ids.cOnly, {});
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(JSON.parse(text).jurisdictionCriteria?.applied?.length, 1);
    assert.equal(profileSnow("City of Routeonly"), 36);
    assert.equal(item(ids.pOnly, ids.cOnly).status, "approved", "left pending with nothing to click");
    const c = read<{ human_approved: number; closed_at: string | null }>("SELECT human_approved, closed_at FROM corrections WHERE id = ?", [ids.cOnly]);
    assert.equal(c.human_approved, 1, "the correction does not read as human-reviewed");
    assert.equal(c.closed_at, null, "an approval must not close the correction (that is the resubmit event)");
  });

  await run("a second click on a closed item is refused (409), not a silent re-apply", async () => {
    const res = await apply(ids.cOnly, {});
    assert.equal(res.status, 409, (await res.text()).slice(0, 300));
  });
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\ncorrectionApplyRoute: all checks passed" : `\ncorrectionApplyRoute: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
