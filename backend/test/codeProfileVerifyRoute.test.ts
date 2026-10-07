// VERIFYING A SEEDED CODE PROFILE NAMES A PERSON (#209): PUT /api/code-profiles/verify, on a real
// server process over a temp database (stub LLM, no network).
//
// The KB tab's "Review / verify" and /review's Mark verified both PUT this route. Verification is a
// named person's attestation that locks the row against automatic overwrite (hard rule 3), so it is
// stamped exactly like an edition-proposal decision (editionProposalDecider):
//   - auth ON: verified_by is the SIGNED-IN user — a body-supplied `verifiedBy` is ignored (it would
//     let a caller put someone else's name on a verification); signed out, or an org API key with no
//     session, is a 401 that writes nothing.
//   - auth OFF: verified_by is the typed `verifiedBy`; blank or missing is a 400 that writes nothing
//     (the row stays seeded). It used to stamp "operator", which is not a person.
// No route is added (rule 6): the existing PUT under /api/code-profiles carries it.
//
// Fixtures are synthetic and written through the real write path before each server boots.
//
//   npx tsx backend/test/codeProfileVerifyRoute.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { JurisdictionCodeProfile } from "../../shared/src/types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-profile-verify-route-"));

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const seeded = (state: string, ahj: string): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021" }],
  amendments: [], designCriteria: { groundSnowLoadPsf: 30 }, prescriptive: {}, fireSetbacks: [],
  citations: [{ label: "Synthetic adoption page", sourceUrl: "https://codes.example.gov/adoption" }], updatedAt: "",
});

/** Seeded (never verified) rows, written through the real research save path; returns their keys. */
async function seedRows(dbPath: string, rows: Array<{ state: string; ahj: string }>): Promise<string[]> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const CP = await import("../src/codeProfiles");
  const db = await openDatabase();
  try { return rows.map((r) => CP.saveResearchedCodeProfile(db, seeded(r.state, r.ahj)).key); }
  finally { db.close(); }
}

/** An org API key (programmatic, no session) for the default org. */
async function apiKeyFor(dbPath: string): Promise<string> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const { createApiKey } = await import("../src/auth");
  const db = await openDatabase();
  try {
    const org = db.get<{ id: string }>("SELECT id FROM orgs ORDER BY created_at LIMIT 1");
    assert.ok(org, "fixture: no org");
    return createApiKey(db, org!.id, "verify-test key").key;
  } finally { db.close(); }
}

function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}

async function boot(dbPath: string, port: number, auth: boolean): Promise<{ server: ChildProcess; log: () => string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: dbPath,
    BACKUP_DIR: path.join(tmpDir, `backups-${port}`),
    AUTOPILOT_AUTO_START: "0",
    PORT: String(port),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "warn",
    ANTHROPIC_API_KEY: "",
    CODE_RESEARCH: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: auth ? "true" : "false",
    ADMIN_EMAIL: "admin@verify.test",
    ADMIN_PASSWORD: "verify-test-password-1",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
    // Its own process group: tsx runs the server in a CHILD process, so killing only the launcher
    // would leave the server listening (and a later run on the same port would talk to it).
    env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { server, log: () => log }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(server);
  throw new Error(`server never came up. log tail:\n${log.slice(-2000)}`);
}

const readRow = (dbPath: string, key: string) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare("SELECT confidence, verified_by, verified_at FROM jurisdiction_code_profiles WHERE profile_key = ?").get(key) as { confidence: string; verified_by: string | null; verified_at: string | null }; }
  finally { db.close(); }
};
// What the KB card / review page sends: the row's values (code-profile-verify.js editablePayload).
const body = (state: string, ahj: string, extra: Record<string, unknown> = {}) => {
  const p = seeded(state, ahj);
  return { state, ahj, adoptedCodes: p.adoptedCodes, amendments: p.amendments, designCriteria: p.designCriteria, prescriptive: p.prescriptive, fireSetbacks: p.fireSetbacks, citations: p.citations, ...extra };
};

// ── 1. auth ON: the verifier is the signed-in user ─────────────────────────────────────────
{
  const dbPath = path.join(tmpDir, "auth-on.sqlite");
  const [cityKey, stateKey] = await seedRows(dbPath, [{ state: "ZE", ahj: "City of Verifyton" }, { state: "ZF", ahj: "" }]);
  const apiKey = await apiKeyFor(dbPath);
  const PORT = 5300 + Math.floor(Math.random() * 15); // never 4173 / 4270
  const BASE = `http://127.0.0.1:${PORT}`;
  const { server } = await boot(dbPath, PORT, true);
  let cookie = "";
  const put = (b: Record<string, unknown>, headers: Record<string, string>) => fetch(`${BASE}/api/code-profiles/verify`, {
    method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b),
  });
  try {
    const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@verify.test", password: "verify-test-password-1" }) });
    assert.equal(login.status, 200, await login.text());
    cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

    await run("precondition: both rows are seeded and unverified", async () => {
      for (const k of [cityKey, stateKey]) {
        assert.equal(readRow(dbPath, k).confidence, "seeded");
        assert.equal(readRow(dbPath, k).verified_at, null);
      }
    });

    await run("signed out: 401, the row stays seeded", async () => {
      const res = await put(body("ZE", "City of Verifyton", { verifiedBy: "Forged Name" }), {});
      assert.equal(res.status, 401, await res.text());
      assert.equal(readRow(dbPath, cityKey).confidence, "seeded");
    });

    await run("an org API key (no session, no person) is a 401, the row stays seeded", async () => {
      const res = await put(body("ZE", "City of Verifyton", { verifiedBy: "Forged Name" }), { "x-api-key": apiKey });
      assert.equal(res.status, 401, await res.text());
      assert.equal(readRow(dbPath, cityKey).confidence, "seeded");
      assert.equal(readRow(dbPath, cityKey).verified_by, null);
    });

    await run("signed in: verified_by is the SIGNED-IN user, a body verifiedBy is ignored", async () => {
      const res = await put(body("ZE", "City of Verifyton", { verifiedBy: "Forged Name" }), { cookie });
      const text = await res.text();
      assert.equal(res.status, 200, text.slice(0, 300));
      assert.equal(JSON.parse(text).profile.verifiedBy, "Admin");
      const row = readRow(dbPath, cityKey);
      assert.equal(row.confidence, "verified");
      assert.equal(row.verified_by, "Admin", "verified_by is not the signed-in person");
      assert.ok(row.verified_at, "verified_at not stamped");
    });

    await run("signed in with no name in the body: still stamped with the signed-in user (state row)", async () => {
      const res = await put(body("ZF", ""), { cookie });
      assert.equal(res.status, 200, await res.text());
      assert.equal(readRow(dbPath, stateKey).verified_by, "Admin");
    });
  } finally {
    stop(server);
  }
}

// ── 2. auth OFF: the verifier is the name the page sends — and there must be one ───────────
{
  const dbPath = path.join(tmpDir, "auth-off.sqlite");
  const [key] = await seedRows(dbPath, [{ state: "ZG", ahj: "City of Namedville" }]);
  const PORT = 5315 + Math.floor(Math.random() * 15);
  const BASE = `http://127.0.0.1:${PORT}`;
  const { server } = await boot(dbPath, PORT, false);
  const put = (b: Record<string, unknown>) => fetch(`${BASE}/api/code-profiles/verify`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  });
  try {
    await run("auth off: no name, or a blank one, is a 400 and the row stays seeded (never \"operator\")", async () => {
      const missing = await put(body("ZG", "City of Namedville"));
      assert.equal(missing.status, 400, await missing.text());
      const blankName = await put(body("ZG", "City of Namedville", { verifiedBy: "   " }));
      assert.equal(blankName.status, 400, await blankName.text());
      const row = readRow(dbPath, key);
      assert.equal(row.confidence, "seeded");
      assert.equal(row.verified_by, null);
      assert.equal(row.verified_at, null);
    });
    await run("auth off: a named person's verify stamps that name", async () => {
      const res = await put(body("ZG", "City of Namedville", { verifiedBy: "  Pat Synthetic  " }));
      assert.equal(res.status, 200, await res.text());
      const row = readRow(dbPath, key);
      assert.equal(row.confidence, "verified");
      assert.equal(row.verified_by, "Pat Synthetic");
      assert.ok(row.verified_at);
    });
  } finally {
    stop(server);
  }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures === 0 ? "\ncodeProfileVerifyRoute: all checks passed." : `\ncodeProfileVerifyRoute: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
