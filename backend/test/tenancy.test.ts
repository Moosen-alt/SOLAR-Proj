// TENANT ISOLATION over real HTTP. Boots the actual server on a temp sqlite with
// AUTH_ENABLED=true (the same shape as reviewApi.test.ts) and proves that two
// autopilot-licensed orgs on one instance cannot see or touch each other's data.
//
// Before this work there was no row-level tenancy on projects/clients/customers at
// all: 184 of 193 routes had nothing beyond "are you logged in", so anyone with a
// login saw every company's projects — and, via an unfiltered client list, the route
// to every company's portal credentials.
//
// Run: tsx backend/test/tenancy.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenancy-test-"));
// Distinct port band per server-booting suite: filledFormDownload owns 4930-4949
// and reviewApi owns 4970-4989. These run sequentially in the chain, but a socket
// lingering in TIME_WAIT from the previous suite made a shared band flaky.
const PORT = 5040 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmpDir, "test.sqlite"),
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

const server = spawn("npx", ["tsx", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never came up. log tail:\n${serverLog.slice(-2000)}`);
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
  assert.equal(res.status, 200, `login ${email}: ${await res.text()}`);
  return String(res.headers.get("set-cookie") || "").split(";")[0];
};

const projectPayload = (owner: string, street: string) => ({
  owner, street, city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Salem", utility: "PGE", dcKw: "7.5",
});

try {
  await waitForServer();

  const ownerCookie = await loginAs("owner@operator.test", "owner-test-password-1");
  const owner = as(ownerCookie);

  // Two autopilot-licensed tenants, each with its own user.
  let orgA = "", orgB = "", aCookie = "", bCookie = "";
  await run("two full-product orgs can be created with their own users", async () => {
    const mk = async (name: string, email: string) => {
      const created = await owner("/api/orgs", { method: "POST", body: JSON.stringify({ name, edition: "full", products: ["autopilot"] }) });
      const orgText = await created.text();
      assert.equal(created.status, 201, orgText.slice(0, 300));
      const org = JSON.parse(orgText).org as { id: string };
      const userRes = await owner(`/api/orgs/${org.id}/users`, { method: "POST", body: JSON.stringify({ name, email, password: "tenant-pass-12345" }) });
      const userText = await userRes.text();
      assert.equal(userRes.status, 201, userText.slice(0, 300));
      return org.id;
    };
    orgA = await mk("Acme Solar", "staff@acme.test");
    orgB = await mk("Beta Solar", "staff@beta.test");
    aCookie = await loginAs("staff@acme.test", "tenant-pass-12345");
    bCookie = await loginAs("staff@beta.test", "tenant-pass-12345");
    assert.ok(orgA && orgB && orgA !== orgB);
  });
  const a = as(aCookie);
  const b = as(bCookie);

  // Read the body ONCE. `assert.equal(res.status, 201, await res.text())` looks
  // harmless but evaluates the message eagerly and consumes the stream, so the
  // following .json() throws "Body has already been read".
  const jsonOk = async (res: Response, expected = 201): Promise<Record<string, unknown>> => {
    const text = await res.text();
    assert.equal(res.status, expected, `${res.url} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  let projA = "", projB = "", clientA = "";
  await run("each tenant creates its own project and client", async () => {
    const ra = await jsonOk(await a("/api/projects", { method: "POST", body: JSON.stringify(projectPayload("Alice A", "1 Acme Way")) }));
    projA = ((ra.project as { id: string }).id);
    const rb = await jsonOk(await b("/api/projects", { method: "POST", body: JSON.stringify(projectPayload("Bob B", "2 Beta Blvd")) }));
    projB = ((rb.project as { id: string }).id);
    const rc = await jsonOk(await a("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Acme Installers" }) }));
    clientA = String(rc.id);
    assert.ok(projA && projB && clientA, `projA=${projA} projB=${projB} clientA=${clientA}`);
  });

  await run("the project LIST shows only your own rows", async () => {
    const listA = await (await a("/api/projects")).json();
    const listB = await (await b("/api/projects")).json();
    assert.equal(listA.projects.length, 1, `A saw ${listA.projects.length}`);
    assert.equal(listB.projects.length, 1, `B saw ${listB.projects.length}`);
    assert.equal(listA.projects[0].id, projA);
    assert.equal(listB.projects[0].id, projB);
    assert.equal(listA.total, 1);
  });

  await run("reading another tenant's project by id is a 404, not a 403", async () => {
    assert.equal((await b(`/api/projects/${projA}`)).status, 404);
    assert.equal((await a(`/api/projects/${projB}`)).status, 404);
  });

  await run("every SUBROUTE under a foreign project id is blocked too", async () => {
    // The guard is registered on the path, so it covers routes this test never names.
    for (const sub of ["documents", "corrections", "notes", "ops-plan", "historical-failures", "filled-forms"]) {
      const res = await b(`/api/projects/${projA}/${sub}`);
      assert.equal(res.status, 404, `GET /${sub} returned ${res.status}`);
    }
    const write = await b(`/api/projects/${projA}/assign`, { method: "POST", body: JSON.stringify({ userId: null }) });
    assert.equal(write.status, 404, `assign returned ${write.status}`);
  });

  await run("the client list is scoped — no route to another tenant's portal credentials", async () => {
    const listB = await (await b("/api/clients")).json();
    assert.equal(listB.clients.length, 0, `B saw ${listB.clients.length} clients`);
    assert.equal((await b(`/api/clients/${clientA}`)).status, 404);
    assert.equal((await b(`/api/clients/${clientA}/portal-credentials`)).status, 404);
  });

  await run("the user list is scoped", async () => {
    const usersA = await (await a("/api/users")).json();
    const emails = (Array.isArray(usersA) ? usersA : usersA.users || []).map((u: { email: string }) => u.email);
    assert.ok(!emails.includes("staff@beta.test"), `A saw ${emails.join(",")}`);
    assert.ok(!emails.includes("owner@operator.test"), `A saw the operator: ${emails.join(",")}`);
  });

  await run("a tenant cannot promote itself to admin", async () => {
    const usersA = await (await a("/api/users")).json();
    const me = (Array.isArray(usersA) ? usersA : usersA.users || []).find((u: { email: string }) => u.email === "staff@acme.test");
    assert.ok(me, "own user row is visible");
    const res = await a(`/api/users/${me.id}`, { method: "PUT", body: JSON.stringify({ role: "admin" }) });
    assert.equal(res.status, 403, `self-promotion returned ${res.status}: ${await res.text()}`);
    // …and it did not take effect.
    const after = await (await a("/api/users")).json();
    const stillOperator = (Array.isArray(after) ? after : after.users || []).find((u: { email: string }) => u.email === "staff@acme.test");
    assert.equal(stillOperator.role, "operator");
  });

  await run("a tenant cannot administer orgs or licences", async () => {
    assert.equal((await b("/api/orgs")).status, 403);
    assert.equal((await b("/api/orgs", { method: "POST", body: JSON.stringify({ name: "sneaky" }) })).status, 403);
    assert.equal((await b(`/api/orgs/${orgA}/products`, { method: "PUT", body: JSON.stringify({ products: ["autopilot"] }) })).status, 403);
  });

  await run("entitlements gate by product: a form-filler org gets the tool, not the autopilot", async () => {
    const org = (await (await owner("/api/orgs", { method: "POST", body: JSON.stringify({ name: "Filler Only", edition: "full", products: ["form_filler"] }) })).json()).org;
    await owner(`/api/orgs/${org.id}/users`, { method: "POST", body: JSON.stringify({ name: "F", email: "f@filler.test", password: "tenant-pass-12345" }) });
    const f = as(await loginAs("f@filler.test", "tenant-pass-12345"));
    assert.equal((await f("/api/projects")).status, 403, "autopilot is not licensed");
    assert.equal((await f("/api/review/work-types")).status, 403, "reviewer is not licensed either");
    // Its own product answers (400 = reached the handler, which wants a PDF body).
    const tool = await f("/api/tools/form-fill/inspect", { method: "POST", headers: { "content-type": "application/pdf" }, body: "not-a-pdf" });
    assert.ok(tool.status !== 403, `form filler should be licensed, got ${tool.status}`);
  });

  await run("revoking a product closes the door immediately", async () => {
    await owner(`/api/orgs/${orgB}/products`, { method: "PUT", body: JSON.stringify({ products: [] }) });
    assert.equal((await b("/api/projects")).status, 403);
    await owner(`/api/orgs/${orgB}/products`, { method: "PUT", body: JSON.stringify({ products: ["autopilot"] }) });
    assert.equal((await b("/api/projects")).status, 200);
  });

  await run("signatures are per-tenant", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const mk = (c: ReturnType<typeof as>) => c("/api/signatures?role=applicant&name=sig", { method: "POST", headers: { "content-type": "image/png" }, body: png });
    assert.equal((await mk(a)).status, 201);
    const listB = await (await b("/api/signatures")).json();
    assert.equal(listB.signatures.length, 0, `B saw ${listB.signatures.length} of A's signatures`);
    const listA = await (await a("/api/signatures")).json();
    assert.equal(listA.signatures.length, 1);
    // B cannot download A's signature image or re-point its default.
    const sigA = listA.signatures[0].id;
    assert.equal((await b(`/api/signatures/${sigA}/image`)).status, 404);
    assert.equal((await b(`/api/signatures/${sigA}/default`, { method: "PATCH" })).status, 404);
  });

  await run("background job queue rows are tenant-scoped", async () => {
    const made = await jsonOk(await a("/api/jobs", { method: "POST", body: JSON.stringify({ jobType: "permit_checks", payload: {} }) }));
    const jobId = String(made.id);
    assert.equal((await b(`/api/jobs/${jobId}`)).status, 404, "B read A's job");
    const listB = await (await b("/api/jobs")).json();
    assert.ok(!listB.some((j: { id: string }) => j.id === jobId), "A's job appeared in B's queue");
    // A job naming another tenant's project is refused before it is ever queued.
    const cross = await b("/api/jobs", { method: "POST", body: JSON.stringify({ jobType: "autopilot", payload: {}, projectId: projA }) });
    assert.equal(cross.status, 404, `cross-tenant job enqueue returned ${cross.status}`);
  });

  await run("the aggregate ops views are scoped", async () => {
    const actionsB = await (await b("/api/ops-actions")).json();
    const names = JSON.stringify(actionsB);
    assert.ok(!names.includes("Alice A"), "B's action queue named A's homeowner");
    const reportB = await (await b("/api/ops-report")).json();
    assert.ok(!JSON.stringify(reportB).includes("Alice A"), "B's daily report named A's homeowner");
  });

  await run("the operator (superadmin) sees across every tenant", async () => {
    const usersA = await (await owner("/api/users")).json();
    const ownerRow = (Array.isArray(usersA) ? usersA : usersA.users || []).find((u: { email: string }) => u.email === "owner@operator.test");
    assert.ok(ownerRow, "owner row found");
    const promote = await owner(`/api/users/${ownerRow.id}`, { method: "PUT", body: JSON.stringify({ role: "superadmin" }) });
    // Nobody edits their own role — not even the owner. Grant via a second admin instead.
    assert.equal(promote.status, 403, "self role-edit is refused even for admin");

    // Seed the superadmin directly against the SERVER's database file. (openDatabase()
    // reads AUTOPILOT_DB_PATH from the environment, which is set for the child process
    // and not for this one, so it would silently open a different db.)
    const Database = (await import("better-sqlite3")).default;
    const sdb = new Database(env.AUTOPILOT_DB_PATH);
    sdb.prepare("UPDATE users SET role = 'superadmin' WHERE email = ?").run("owner@operator.test");
    sdb.close();
    // The role is read from the users row on every request, so the existing session
    // cookie picks it up without a re-login.
    const all = await (await owner("/api/projects")).json();
    assert.ok(all.projects.length >= 2, `superadmin saw ${all.projects.length} projects, expected both tenants'`);
    assert.equal((await owner(`/api/projects/${projA}`)).status, 200);
    assert.equal((await owner(`/api/projects/${projB}`)).status, 200);
  });

} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} tenancy test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll tenancy tests passed.");
process.exit(0);
