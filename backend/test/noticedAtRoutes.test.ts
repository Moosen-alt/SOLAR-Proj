// A NOTICE DATE IS A DATE OR A 400 — ON BOTH ROUTES THAT TAKE ONE (#137).
//
// POST /api/projects/:id/permit-checks passed req.body.noticedAt straight through to
// recordPermitStatusCheck, and POST /api/projects/:id/corrections took any string. A garbage value
// silently became "no date" (the cure clock starts at ingestion, nobody told), and a US-format
// date — which V8 parses as LOCAL midnight — landed a day early on a server west of UTC. Both
// routes now run the value through kpi.requestNoticedAt: unparseable → 400 with nothing written,
// accepted → one ISO shape.
//
// Driven through the real server (temp database, logged in, no LLM key, no network) with
// TZ=America/Los_Angeles on the server process, so the local-midnight drift this file guards
// against is actually visible. Synthetic data only.
//
//   npx tsx backend/test/noticedAtRoutes.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "noticed-at-routes-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

// ── fixtures, through the real write path ──────────────────────────────────────────────────
const ids = await (async () => {
  const { openDatabase } = await import("../src/db");
  const R = await import("../src/repository");
  const db = await openDatabase();
  const projectId = R.createProject(db, {
    owner: "Synthetic Owner", state: "CA", dcKw: "5", acKw: "4", street: "1 Test Way", city: "Testville", zip: "90000", ahj: "Testville", utility: "Test Power",
  } as never).project.id;
  const targetId = R.createPermitCheckTarget(db, projectId, { jurisdiction: "Test Power", applicationNumber: "NEM-TEST-137", targetType: "nem" })
    .permitCheckTargets.find((t) => t.targetType === "nem")!.id;
  db.close();
  return { projectId, targetId };
})();

// ── the real server on the same file ───────────────────────────────────────────────────────
const PORT = 5150 + Math.floor(Math.random() * 40); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  TZ: "America/Los_Angeles",
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
  ADMIN_EMAIL: "admin@noticed.test",
  ADMIN_PASSWORD: "noticed-test-password-1",
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

type CorrectionRow = { id: string; source: string; noticed_at: string | null; correction_text: string };
const corrections = (): CorrectionRow[] => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare("SELECT id, source, noticed_at, correction_text FROM corrections WHERE project_id = ? ORDER BY created_at").all(ids.projectId) as CorrectionRow[]; }
  finally { db.close(); }
};
const checks = (): number => {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS n FROM permit_status_checks WHERE project_id = ?").get(ids.projectId) as { n: number }).n; }
  finally { db.close(); }
};

let cookie = "";
const post = (route: string, body: Record<string, unknown>) => fetch(`${BASE}/api/projects/${ids.projectId}/${route}`, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
});
// Each reading's text differs, so none is suppressed as "unchanged" and each raises its own correction.
let reading = 0;
const permitCheck = (noticedAt: unknown) => post("permit-checks", {
  targetId: ids.targetId, source: "manual", noticedAt,
  rawStatusText: `Application deficient: correction required. Revise and resubmit the single-line diagram (item ${++reading}).`,
});
const correction = (text: string, noticedAt: unknown) => post("corrections", { correctionText: text, noticedAt });

try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up. log tail:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@noticed.test", password: "noticed-test-password-1" }) });
  assert.equal(login.status, 200, await login.text());
  cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

  // ── permit-checks ──
  for (const bad of ["not a date", "2/30/2025", 20250928]) {
    await run(`permit-checks: noticedAt ${JSON.stringify(bad)} is a 400 and writes nothing`, async () => {
      const [before, beforeChecks] = [corrections().length, checks()];
      const res = await permitCheck(bad);
      const text = await res.text();
      assert.equal(res.status, 400, text.slice(0, 300));
      assert.match(text, /noticedAt/);
      assert.equal(corrections().length, before, "a correction was written for a refused request");
      assert.equal(checks(), beforeChecks, "a status check was written for a refused request");
    });
  }

  await run("permit-checks: a US-format date (9/28/2025) is stored as that calendar day in ISO, not local midnight", async () => {
    const res = await permitCheck("9/28/2025");
    assert.equal(res.status, 201, (await res.text()).slice(0, 300));
    const row = corrections().filter((c) => c.source === "portal").at(-1);
    assert.ok(row, "the deficiency reading raised no correction");
    assert.equal(row.noticed_at, "2025-09-28T00:00:00.000Z");
  });

  await run("permit-checks: an ISO date-time is kept as its instant", async () => {
    const res = await permitCheck("2025-09-27T15:30:00Z");
    assert.equal(res.status, 201, (await res.text()).slice(0, 300));
    assert.equal(corrections().filter((c) => c.source === "portal").at(-1)?.noticed_at, "2025-09-27T15:30:00.000Z");
  });

  await run("permit-checks: a blank noticedAt is no date (the clock starts at ingestion), not a 400", async () => {
    const res = await permitCheck("  ");
    assert.equal(res.status, 201, (await res.text()).slice(0, 300));
    assert.equal(corrections().filter((c) => c.source === "portal").at(-1)?.noticed_at, null);
  });

  // ── corrections ──
  for (const bad of ["garbage", "13/01/2025", { at: "2025-09-28" }]) {
    await run(`corrections: noticedAt ${JSON.stringify(bad)} is a 400 and writes nothing`, async () => {
      const before = corrections().length;
      const res = await correction("Add fire setback dimensions.", bad);
      const text = await res.text();
      assert.equal(res.status, 400, text.slice(0, 300));
      assert.match(text, /noticedAt/);
      assert.equal(corrections().length, before, "a correction was written for a refused request");
    });
  }

  await run("corrections: a US-format date (9/28/2025) is stored as that calendar day in ISO, not local midnight", async () => {
    const res = await correction("Show attachment spacing.", "9/28/2025");
    assert.equal(res.status, 201, (await res.text()).slice(0, 300));
    const row = corrections().find((c) => c.correction_text === "Show attachment spacing.");
    assert.equal(row?.noticed_at, "2025-09-28T00:00:00.000Z");
  });

  await run("corrections: YYYY-MM-DD is stored as that calendar day", async () => {
    const res = await correction("Provide the rafter span table.", "2025-09-26");
    assert.equal(res.status, 201, (await res.text()).slice(0, 300));
    assert.equal(corrections().find((c) => c.correction_text === "Provide the rafter span table.")?.noticed_at, "2025-09-26T00:00:00.000Z");
  });
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\nnoticedAtRoutes: all checks passed" : `\nnoticedAtRoutes: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
