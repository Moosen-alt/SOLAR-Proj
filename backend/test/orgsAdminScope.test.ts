// ORG ADMINISTRATION IS SCOPED (issue #275, hard rule 6). Boots the real server on a
// scratch sqlite with AUTH_ENABLED=true and proves:
//
//   MUST-EXCLUDE: a plain admin of one autopilot tenant cannot mint an API key, create a
//   user, change products or list orgs in ANOTHER org (nor create a new org). Each is a
//   404 (never a 403 that confirms the org exists), and nothing is written.
//   MUST-PASS: the superadmin still administers every org; a plain admin still
//   administers its own.
//
// Before the fix, requireAdmin asked only "is this an admin of an autopilot org?", never
// "of WHICH org?", so a tenant admin could mint a key that alone reads another tenant's
// review submissions, or create a login inside it.
//
// All orgs, users and keys are synthetic. No key value is ever printed: failures name the
// status and the row counts, never a response body that could carry a key.
//
// Run: tsx backend/test/orgsAdminScope.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orgs-admin-scope-test-"));

// Own port band (5400-5419): no other server-booting suite uses it. Probe for a free
// port the way the server binds (all IPv4 interfaces) rather than hoping.
async function freePortInBand(start: number, count: number): Promise<number> {
  for (let i = 0; i < count; i++) {
    const candidate = start + i;
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(candidate, "0.0.0.0", () => probe.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  return start + Math.floor(Math.random() * count);
}
const PORT = await freePortInBand(5400, 20);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "test.sqlite");

const env = {
  ...process.env,
  AUTOPILOT_DB_PATH: DB_PATH,
  PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
  BACKUP_DIR: path.join(tmpDir, "backups"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true",
  ADMIN_EMAIL: "owner@operator.test",
  ADMIN_PASSWORD: "owner-test-password-1",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
  delete (env as Record<string, string | undefined>)[k];
}

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never answered ${BASE}/health within 60s (port ${PORT})\nlog tail:\n${serverLog.slice(-2000)}`);
}

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const as = (cookie: string) => (p: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers });
};
const loginAs = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login ${email}: status ${res.status}`);
  return String(res.headers.get("set-cookie") || "").split(";")[0];
};

// Read/write the SERVER's db file directly (openDatabase() reads AUTOPILOT_DB_PATH, which
// is set for the child process, not this one). Used for role setup and for proving that a
// refused request wrote nothing.
const withDb = <T>(fn: (db: Database.Database) => T): T => {
  const db = new Database(DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
const setRole = (email: string, role: string) => withDb((db) => db.prepare("UPDATE users SET role = ? WHERE email = ?").run(role, email));
const count = (sql: string, ...params: unknown[]): number => withDb((db) => Number((db.prepare(sql).get(...params) as { n: number }).n));
const keysIn = (orgId: string) => count("SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ?", orgId);
const usersIn = (orgId: string) => count("SELECT COUNT(*) AS n FROM users WHERE org_id = ?", orgId);
const productsOf = (orgId: string): string[] => withDb((db) =>
  (db.prepare("SELECT * FROM org_entitlements WHERE org_id = ?").all(orgId) as Array<Record<string, unknown>>)
    .map((r) => String(r.product)).sort());
const orgCount = () => count("SELECT COUNT(*) AS n FROM orgs");

try {
  await waitForServer();

  const ownerCookie = await loginAs("owner@operator.test", "owner-test-password-1");
  const owner = as(ownerCookie);
  // The operator is the one superadmin (VERIFICATION_PLAN 1.3); the seeded login is a plain
  // admin, so promote it the way the operator does. The role is re-read on every request.
  setRole("owner@operator.test", "superadmin");

  // Two autopilot tenants, each with a login; A's login is then made a plain ADMIN of A,
  // the way scripts/onboard-company.ts tells operators to.
  let orgA = "", orgB = "";
  await run("MUST-PASS: the superadmin creates two tenant orgs and a login in each", async () => {
    const mk = async (name: string, email: string) => {
      const created = await owner("/api/orgs", { method: "POST", body: JSON.stringify({ name, edition: "full", products: ["autopilot"] }) });
      assert.equal(created.status, 201, `create org ${name}: ${created.status}`);
      const id = String((await created.json()).org.id);
      const user = await owner(`/api/orgs/${id}/users`, { method: "POST", body: JSON.stringify({ name, email, password: "tenant-pass-12345" }) });
      assert.equal(user.status, 201, `create user in ${name}: ${user.status}`);
      return id;
    };
    orgA = await mk("Acme Solar", "admin@acme.test");
    orgB = await mk("Beta Solar", "staff@beta.test");
    assert.ok(orgA && orgB && orgA !== orgB);
  });
  setRole("admin@acme.test", "admin");
  const adminA = as(await loginAs("admin@acme.test", "tenant-pass-12345"));
  const staffB = as(await loginAs("staff@beta.test", "tenant-pass-12345"));

  // A plain admin of the DEFAULT org (the operator's own org) is not cross-org either:
  // being in the operator's org is not the superadmin role.
  await run("setup: a plain admin in the default org", async () => {
    const res = await owner("/api/orgs/org-default/users", { method: "POST", body: JSON.stringify({ name: "Staff", email: "staff@operator.test", password: "default-pass-12345" }) });
    assert.equal(res.status, 201, `create default-org user: ${res.status}`);
  });
  setRole("staff@operator.test", "admin");
  const adminDefault = as(await loginAs("staff@operator.test", "default-pass-12345"));

  // ---------------------------------------------------------------- MUST-EXCLUDE
  for (const [who, actor] of [["A's admin", adminA], ["the default org's plain admin", adminDefault]] as const) {
    await run(`MUST-EXCLUDE: ${who} cannot mint an API key in org B (404, no key written)`, async () => {
      const before = keysIn(orgB);
      const res = await actor(`/api/orgs/${orgB}/api-keys`, { method: "POST", body: JSON.stringify({ name: "sneaky" }) });
      assert.equal(res.status, 404, `status ${res.status}`);
      const body = await res.text();
      assert.ok(!/rg_[A-Za-z0-9_-]{10,}/.test(body), "a key-shaped value came back in the refusal");
      assert.equal(keysIn(orgB), before, "an api_keys row was written for org B");
    });

    await run(`MUST-EXCLUDE: ${who} cannot create a user in org B (404, no user written)`, async () => {
      const before = usersIn(orgB);
      const email = `sneaky-${Math.random().toString(36).slice(2, 8)}@beta.test`;
      const res = await actor(`/api/orgs/${orgB}/users`, { method: "POST", body: JSON.stringify({ name: "Sneaky", email, password: "sneaky-pass-12345" }) });
      assert.equal(res.status, 404, `status ${res.status}`);
      assert.equal(usersIn(orgB), before, "a users row was written into org B");
      assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE email = ?", email), 0, "the user exists somewhere");
    });

    await run(`MUST-EXCLUDE: ${who} cannot change org B's products (404, entitlements unchanged)`, async () => {
      const before = productsOf(orgB);
      const res = await actor(`/api/orgs/${orgB}/products`, { method: "PUT", body: JSON.stringify({ products: [] }) });
      assert.equal(res.status, 404, `status ${res.status}`);
      assert.deepEqual(productsOf(orgB), before, "org B's entitlements changed");
    });

    await run(`MUST-EXCLUDE: ${who} cannot list every org (404)`, async () => {
      const res = await actor("/api/orgs");
      assert.equal(res.status, 404, `status ${res.status}`);
      assert.ok(!(await res.text()).includes("Beta Solar"), "the refusal named another tenant");
    });

    await run(`MUST-EXCLUDE: ${who} cannot create a new org (404, no org written)`, async () => {
      const before = orgCount();
      const res = await actor("/api/orgs", { method: "POST", body: JSON.stringify({ name: "Sneaky Org", edition: "full", products: ["autopilot"] }) });
      assert.equal(res.status, 404, `status ${res.status}`);
      assert.equal(orgCount(), before, "an orgs row was written");
    });
  }

  await run("MUST-EXCLUDE: a foreign org and a nonexistent org read the same (no org-id probing)", async () => {
    const foreign = await adminA(`/api/orgs/${orgB}/api-keys`, { method: "POST", body: JSON.stringify({ name: "x" }) });
    const missing = await adminA("/api/orgs/org-doesnotexist/api-keys", { method: "POST", body: JSON.stringify({ name: "x" }) });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await foreign.text(), await missing.text());
  });

  await run("MUST-EXCLUDE: the guard covers ANY /api/orgs/:id/* path, not just today's routes", async () => {
    // A path with no route still hits the guard first: 404 from the guard for a foreign id.
    const res = await adminA(`/api/orgs/${encodeURIComponent(orgB)}/anything-new`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404, `status ${res.status}`);
    assert.equal(keysIn(orgB), 0, "org B gained a key");
  });

  await run("non-admins keep their 403, even on their own org", async () => {
    assert.equal((await staffB(`/api/orgs/${orgB}/api-keys`, { method: "POST", body: JSON.stringify({ name: "x" }) })).status, 403);
    assert.equal((await staffB("/api/orgs")).status, 403);
    assert.equal(keysIn(orgB), 0);
  });

  // ---------------------------------------------------------------- MUST-PASS
  await run("MUST-PASS: A's admin mints an API key in its OWN org", async () => {
    const before = keysIn(orgA);
    const res = await adminA(`/api/orgs/${orgA}/api-keys`, { method: "POST", body: JSON.stringify({ name: "own" }) });
    assert.equal(res.status, 201, `status ${res.status}`);
    const body = await res.json() as { key?: unknown };
    assert.equal(typeof body.key, "string", "no key returned"); // never printed
    assert.equal(keysIn(orgA), before + 1);
  });

  await run("MUST-PASS: A's admin creates a user in its OWN org", async () => {
    const before = usersIn(orgA);
    const res = await adminA(`/api/orgs/${orgA}/users`, { method: "POST", body: JSON.stringify({ name: "New Staff", email: "new@acme.test", password: "tenant-pass-12345" }) });
    assert.equal(res.status, 201, `status ${res.status}`);
    assert.equal(usersIn(orgA), before + 1);
  });

  await run("MUST-PASS: A's admin sets its OWN org's products", async () => {
    const res = await adminA(`/api/orgs/${orgA}/products`, { method: "PUT", body: JSON.stringify({ products: ["autopilot"] }) });
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.deepEqual(productsOf(orgA), ["autopilot"]);
  });

  await run("MUST-PASS: the superadmin lists every org", async () => {
    const res = await owner("/api/orgs");
    assert.equal(res.status, 200, `status ${res.status}`);
    const ids = ((await res.json()).orgs as Array<{ id: string }>).map((o) => o.id);
    assert.ok(ids.includes(orgA) && ids.includes(orgB) && ids.includes("org-default"), `listed ${ids.length} orgs`);
  });

  await run("MUST-PASS: the superadmin mints a key, creates a user and changes products in ANOTHER org", async () => {
    const keysBefore = keysIn(orgB), usersBefore = usersIn(orgB);
    const key = await owner(`/api/orgs/${orgB}/api-keys`, { method: "POST", body: JSON.stringify({ name: "intake" }) });
    assert.equal(key.status, 201, `key status ${key.status}`);
    await key.arrayBuffer(); // drain without printing
    const user = await owner(`/api/orgs/${orgB}/users`, { method: "POST", body: JSON.stringify({ name: "B2", email: "second@beta.test", password: "tenant-pass-12345" }) });
    assert.equal(user.status, 201, `user status ${user.status}`);
    const products = await owner(`/api/orgs/${orgB}/products`, { method: "PUT", body: JSON.stringify({ products: ["autopilot", "form_filler"] }) });
    assert.equal(products.status, 200, `products status ${products.status}`);
    assert.equal(keysIn(orgB), keysBefore + 1);
    assert.equal(usersIn(orgB), usersBefore + 1);
    assert.deepEqual(productsOf(orgB), ["autopilot", "form_filler"]);
  });

  // ------------------------------------------------- the role that IS the cross-org key
  // Since #275 holding superadmin is what lets an admin act across orgs, so updateUser's
  // "only a superadmin can grant superadmin" check (users.ts) is the boundary. Without it a
  // tenant admin goes cross-org in three requests: promote a colleague, have them promote
  // it back, done. Pinned here so deleting that check turns this suite red.
  const userId = (email: string) => withDb((db) => String((db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id));
  const roleOf = (email: string) => withDb((db) => String((db.prepare("SELECT role FROM users WHERE email = ?").get(email) as { role: string }).role));

  await run("MUST-EXCLUDE: A's admin cannot grant superadmin to an operator in its own org (403, role unchanged)", async () => {
    assert.equal(roleOf("new@acme.test"), "operator", "setup: new@acme.test should be an operator");
    const res = await adminA(`/api/users/${userId("new@acme.test")}`, { method: "PUT", body: JSON.stringify({ role: "superadmin" }) });
    assert.equal(res.status, 403, `status ${res.status}`);
    assert.equal(roleOf("new@acme.test"), "operator");
    assert.equal(roleOf("admin@acme.test"), "admin");
  });

  await run("MUST-EXCLUDE: A's admin cannot grant superadmin to itself (403, role unchanged)", async () => {
    const res = await adminA(`/api/users/${userId("admin@acme.test")}`, { method: "PUT", body: JSON.stringify({ role: "superadmin" }) });
    assert.equal(res.status, 403, `status ${res.status}`);
    assert.equal(roleOf("admin@acme.test"), "admin");
    assert.equal(roleOf("new@acme.test"), "operator");
  });
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => { server.once("exit", r); setTimeout(r, 5000); });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* still locked - leave to OS */ }
}

if (failures > 0) {
  console.error(`\n${failures} org-admin scope test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll org-admin scope tests passed.");
process.exit(0);
