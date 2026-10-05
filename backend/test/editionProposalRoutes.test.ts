// EDITION PROPOSALS, DECIDED THROUGH THE REAL ROUTES (#172): POST /api/code-profiles/proposals/
// approve | dismiss, on a real server process over a temp database (stub LLM, no network).
//
// A due verify check on a HUMAN-VERIFIED code profile stores a proposal and never writes the row
// (hard rule 3). These routes are a person's two answers:
//   - Approve re-verifies the row through applyEditionProposal, stamping verified_by with the
//     DECIDER (the signed-in user when auth is on — a body-supplied name is ignored) and a new
//     verified_at; the proposal leaves GET /api/code-profiles.
//   - Dismiss leaves the row untouched, marks the proposal dismissed (it leaves the listing), and is
//     recorded under the decider's name.
//   - A stale click (already applied / dismissed / unknown) is a 409 that changes nothing; no
//     fingerprint is a 400; signed out is a 401.
//   - With auth OFF, a decision with no name is a 400 ("operator" is not a person) and the typed
//     name is the one stamped.
// Both routes sit under the existing /api/code-profiles prefix (rule 6: no new top-level path —
// routeScope.test.ts is unchanged).
//
// Fixtures are synthetic and written through the real write path before each server boots.
//
//   npx tsx backend/test/editionProposalRoutes.test.ts
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edition-proposal-routes-"));

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const blank = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "", ...over,
});
const OLD_VERIFIED_AT = "2025-01-01T00:00:00.000Z";

/** A human-verified row (verified long ago) with one pending edition proposal; returns its key and fingerprint. */
async function seedVerifiedWithProposal(dbPath: string, rows: Array<{ state: string; ahj: string }>): Promise<Array<{ key: string; fingerprint: string }>> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const CP = await import("../src/codeProfiles");
  const db = await openDatabase();
  const out: Array<{ key: string; fingerprint: string }> = [];
  for (const r of rows) {
    const verified = CP.saveVerifiedCodeProfile(db, blank(r.state, r.ahj, {
      adoptedCodes: [{ family: "fire", code: "IFC", edition: "2018" }, { family: "residential", code: "IRC", edition: "2021" }],
      designCriteria: { groundSnowLoadPsf: 25 },
    }), "Original Verifier");
    db.run("UPDATE jurisdiction_code_profiles SET verified_at = ? WHERE profile_key = ?", [OLD_VERIFIED_AT, verified.key]);
    const p = CP.proposeEditionUpdate(db, verified, blank(r.state, r.ahj, {
      adoptedCodes: [{ family: "fire", code: "IFC", edition: "2024", sourceUrl: "https://codes.example.gov/fire", quote: "The 2024 IFC is adopted." }],
    }), "research");
    assert.ok(p?.isNew, `fixture: no proposal for ${verified.key}`);
    out.push({ key: verified.key, fingerprint: p!.fingerprint });
  }
  db.close();
  return out;
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
    ADMIN_EMAIL: "admin@proposal.test",
    ADMIN_PASSWORD: "proposal-test-password-1",
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
  try { return db.prepare("SELECT confidence, verified_by, verified_at, payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?").get(key) as { confidence: string; verified_by: string; verified_at: string; payload_json: string }; }
  finally { db.close(); }
};
const auditCount = (dbPath: string, action: string, fingerprint: string): number => {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = ? AND details LIKE ?").get(action, `%${fingerprint}%`) as { n: number }).n; }
  finally { db.close(); }
};
const codesOf = (payloadJson: string): string[] => (JSON.parse(payloadJson).adoptedCodes as Array<{ code: string; edition: string }>).map((c) => `${c.code} ${c.edition}`);

// ── 1. auth ON: the decider is the signed-in user ──────────────────────────────────────────
{
  const dbPath = path.join(tmpDir, "auth-on.sqlite");
  const [approveMe, dismissMe] = await seedVerifiedWithProposal(dbPath, [{ state: "ZA", ahj: "City of Approveton" }, { state: "ZB", ahj: "City of Dismissville" }]);
  const PORT = 5270 + Math.floor(Math.random() * 15); // never 4173 / 4270
  const BASE = `http://127.0.0.1:${PORT}`;
  const { server } = await boot(dbPath, PORT, true);
  let cookie = "";
  const post = (action: string, body: Record<string, unknown>, withCookie = true) => fetch(`${BASE}/api/code-profiles/proposals/${action}`, {
    method: "POST", headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const listed = async (key: string) => {
    const res = await fetch(`${BASE}/api/code-profiles`, { headers: { cookie } });
    assert.equal(res.status, 200);
    return ((await res.json()).profiles as JurisdictionCodeProfile[]).find((p) => p.key === key);
  };
  try {
    const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@proposal.test", password: "proposal-test-password-1" }) });
    assert.equal(login.status, 200, await login.text());
    cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

    await run("precondition: both proposals are listed on GET /api/code-profiles", async () => {
      assert.equal((await listed(approveMe.key))?.editionProposals?.[0]?.fingerprint, approveMe.fingerprint);
      assert.equal((await listed(dismissMe.key))?.editionProposals?.[0]?.fingerprint, dismissMe.fingerprint);
    });

    await run("signed out: 401, nothing written", async () => {
      const res = await post("approve", { fingerprint: approveMe.fingerprint, decidedBy: "Forged Name" }, false);
      assert.equal(res.status, 401, await res.text());
      assert.equal(readRow(dbPath, approveMe.key).verified_at, OLD_VERIFIED_AT);
    });

    await run("no fingerprint: 400", async () => {
      assert.equal((await post("approve", {})).status, 400);
      assert.equal((await post("dismiss", { fingerprint: "  " })).status, 400);
    });

    await run("Approve re-verifies the row under the SIGNED-IN user (a body name is ignored) and stamps a new verified_at", async () => {
      const res = await post("approve", { fingerprint: approveMe.fingerprint, decidedBy: "Forged Name" });
      const text = await res.text();
      assert.equal(res.status, 200, text.slice(0, 300));
      const body = JSON.parse(text);
      assert.equal(body.status, "applied");
      assert.equal(body.decidedBy, "Admin");
      const row = readRow(dbPath, approveMe.key);
      assert.equal(row.confidence, "verified", "approval must be a re-verification");
      assert.equal(row.verified_by, "Admin", "verified_by is not the signed-in decider");
      assert.ok(row.verified_at > OLD_VERIFIED_AT, `verified_at not re-stamped: ${row.verified_at}`);
      const codes = codesOf(row.payload_json);
      assert.ok(codes.includes("IFC 2024") && !codes.includes("IFC 2018"), `fire edition not replaced: ${codes}`);
      assert.ok(codes.includes("IRC 2021"), `approval replaced a family it did not change: ${codes}`);
      assert.equal(JSON.parse(row.payload_json).designCriteria?.groundSnowLoadPsf, 25, "approval dropped the row's design criteria");
      assert.equal((await listed(approveMe.key))?.editionProposals, undefined, "the applied proposal is still listed");
      assert.equal(auditCount(dbPath, "code_profile.edition_proposal_applied", approveMe.fingerprint), 1);
    });

    await run("a second Approve of the same proposal is a 409 that writes nothing", async () => {
      const before = readRow(dbPath, approveMe.key);
      const res = await post("approve", { fingerprint: approveMe.fingerprint });
      assert.equal(res.status, 409, await res.text());
      assert.deepEqual(readRow(dbPath, approveMe.key), before);
      assert.equal(auditCount(dbPath, "code_profile.edition_proposal_applied", approveMe.fingerprint), 1);
    });

    await run("Dismiss leaves the verified row untouched, drops the proposal from the listing, and records the decider", async () => {
      const before = readRow(dbPath, dismissMe.key);
      const res = await post("dismiss", { fingerprint: dismissMe.fingerprint, reason: "The city has not adopted it yet." });
      const text = await res.text();
      assert.equal(res.status, 200, text.slice(0, 300));
      assert.equal(JSON.parse(text).status, "dismissed");
      assert.deepEqual(readRow(dbPath, dismissMe.key), before, "a dismissal wrote the verified row");
      assert.equal((await listed(dismissMe.key))?.editionProposals, undefined, "the dismissed proposal is still listed");
      const db = new Database(dbPath, { readonly: true });
      try {
        const d = db.prepare("SELECT actor_name, details FROM audit_logs WHERE action = 'code_profile.edition_proposal_dismissed' AND details LIKE ?").get(`%${dismissMe.fingerprint}%`) as { actor_name: string; details: string };
        assert.equal(d.actor_name, "Admin");
        assert.match(d.details, /has not adopted it yet/);
      } finally { db.close(); }
    });

    await run("dismissing again, or approving a dismissed proposal, is a 409 that changes nothing", async () => {
      const before = readRow(dbPath, dismissMe.key);
      assert.equal((await post("dismiss", { fingerprint: dismissMe.fingerprint })).status, 409);
      assert.equal((await post("approve", { fingerprint: dismissMe.fingerprint })).status, 409);
      assert.deepEqual(readRow(dbPath, dismissMe.key), before);
      assert.equal(auditCount(dbPath, "code_profile.edition_proposal_dismissed", dismissMe.fingerprint), 1);
      assert.equal((await post("approve", { fingerprint: "ZZ|nowhere#deadbeef" })).status, 409);
    });
  } finally {
    stop(server);
  }
}

// ── 2. auth OFF: the decider is the name the dashboard sends — and there must be one ───────
{
  const dbPath = path.join(tmpDir, "auth-off.sqlite");
  const [p] = await seedVerifiedWithProposal(dbPath, [{ state: "ZC", ahj: "City of Namedburg" }]);
  const PORT = 5285 + Math.floor(Math.random() * 15);
  const BASE = `http://127.0.0.1:${PORT}`;
  const { server } = await boot(dbPath, PORT, false);
  const post = (action: string, body: Record<string, unknown>) => fetch(`${BASE}/api/code-profiles/proposals/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    await run("auth off: Approve / Dismiss with no name is a 400 and writes nothing", async () => {
      assert.equal((await post("approve", { fingerprint: p.fingerprint })).status, 400);
      assert.equal((await post("approve", { fingerprint: p.fingerprint, decidedBy: "   " })).status, 400);
      assert.equal((await post("dismiss", { fingerprint: p.fingerprint })).status, 400);
      assert.equal(readRow(dbPath, p.key).verified_at, OLD_VERIFIED_AT);
      assert.equal(readRow(dbPath, p.key).verified_by, "Original Verifier");
      assert.equal(auditCount(dbPath, "code_profile.edition_proposal_dismissed", p.fingerprint), 0);
    });
    await run("auth off: Approve by a named person stamps that name as verified_by", async () => {
      const res = await post("approve", { fingerprint: p.fingerprint, decidedBy: "Pat Synthetic" });
      assert.equal(res.status, 200, await res.text());
      const row = readRow(dbPath, p.key);
      assert.equal(row.verified_by, "Pat Synthetic");
      assert.ok(row.verified_at > OLD_VERIFIED_AT);
    });
  } finally {
    stop(server);
  }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures === 0 ? "\neditionProposalRoutes: all checks passed." : `\neditionProposalRoutes: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
