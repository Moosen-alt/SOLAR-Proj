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
// PICK A PORT THAT IS ACTUALLY FREE, rather than a random one and hope.
//
// This used to be `5040 + Math.floor(Math.random() * 20)`. On this machine a Windows svchost
// holds 5040, so roughly one chain run in twenty died here — and when it did, the failure read
// "server never came up" above a perfectly healthy startup banner, sending the reader to the
// server rather than the port. It cost two chain runs in one session before anybody looked at
// netstat.
//
// Probing beats retrying: bind a throwaway listener to each candidate and keep the first that
// accepts. A port held by another process fails here, silently and instantly, instead of
// 60 seconds later as a mystery.
function freePortInBand(start: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const candidate = start + i;
    try {
      // BIND THE WAY THE SERVER DOES — all IPv4 interfaces, EXPLICITLY. Two prior lies from
      // this probe, same shape: 127.0.0.1 succeeded while 0.0.0.0 was held, and then a
      // host-less listen() — which lands on IPv6 [::] on Windows — succeeded while svchost
      // (Connected Devices Platform) held IPv4 0.0.0.0:5040. Only "0.0.0.0" answers the
      // question the server will actually ask; proven live on this machine 2026-09-21.
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(${candidate},"0.0.0.0",function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return candidate;
    } catch { /* held — try the next */ }
  }
  // Every candidate held: fall back to the old behaviour rather than refusing to run, and let
  // waitForServer report it with the port named.
  return start + Math.floor(Math.random() * count);
}
// BAND MOVED OFF 5040. Probing cannot win this one: Windows' Connected Devices Platform
// service takes and releases ports around 5040 continuously, so a port that probes free is
// sometimes taken in the milliseconds between the probe closing its listener and the server
// binding — a race, not a bad probe, and it killed a chain run again on 2026-09-22 with the
// explicit-IPv4 probe already in place. The probe below still earns its keep against
// leftovers from a previous run; moving the band away from the known collider is what makes
// the race stop happening.
const PORT = freePortInBand(5140, 20);
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

// node + the tsx CLI directly: "npx" is not spawnable on Windows (ENOENT), and a
// shell wrapper would make kill() stop the shell while orphaning the server.
const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // NAME THE PORT, AND THE LIKELIEST CAUSE. This test picks a random port in a 20-wide band, and
  // "server never came up" sends you reading the server log — which prints a perfectly healthy
  // startup banner, because the process starts either way. The real cause is usually that
  // something else already holds the port: on Windows a svchost service can sit on one of these,
  // and then this test fails about one run in twenty with a message about the wrong thing.
  const portTaken = /EADDRINUSE|address already in use/i.test(serverLog);
  throw new Error(
    `server never answered ${BASE}/health within 60s`
    + (portTaken ? ` — PORT ${PORT} IS ALREADY IN USE (that is the failure, not the server).` : "")
    + `\nIf the log below looks like a healthy startup banner, check the port first:`
    + `\n  netstat -ano | findstr :${PORT}`
    + `\nlog tail:\n${serverLog.slice(-2000)}`,
  );
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

  let projA = "", projB = "", clientA = "", clientB = "";
  await run("each tenant creates its own project and client", async () => {
    // CLIENTS FIRST: POST /api/projects now requires a clientId that exists IN THE
    // CALLER'S OWN ORG (every filing carries that client's CCB licence), so a tenant
    // cannot create a project before it has a client.
    const rc = await jsonOk(await a("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Acme Installers" }) }));
    clientA = String(rc.id);
    const rcb = await jsonOk(await b("/api/clients", { method: "POST", body: JSON.stringify({ companyName: "Beta Installers" }) }));
    clientB = String(rcb.id);
    const ra = await jsonOk(await a("/api/projects", { method: "POST", body: JSON.stringify({ ...projectPayload("Alice A", "1 Acme Way"), clientId: clientA }) }));
    projA = ((ra.project as { id: string }).id);
    const rb = await jsonOk(await b("/api/projects", { method: "POST", body: JSON.stringify({ ...projectPayload("Bob B", "2 Beta Blvd"), clientId: clientB }) }));
    projB = ((rb.project as { id: string }).id);
    assert.ok(projA && projB && clientA && clientB, `projA=${projA} projB=${projB} clientA=${clientA} clientB=${clientB}`);
  });

  await run("a tenant cannot create a project against ANOTHER tenant's client", async () => {
    // Out of scope must read as "there is no such client here", never as a 403 that
    // confirms one exists (hard rule 6). 400 is the create route's own vocabulary.
    const res = await b("/api/projects", { method: "POST", body: JSON.stringify({ ...projectPayload("Bob Borrow", "3 Borrow Rd"), clientId: clientA }) });
    const body = await res.text();
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body.slice(0, 300)}`);
    assert.ok(/No client/i.test(body), `expected a "no such client" message, got: ${body.slice(0, 300)}`);
  });

  await run("a project cannot be created with NO client at all", async () => {
    const res = await a("/api/projects", { method: "POST", body: JSON.stringify(projectPayload("Nobody N", "4 Nowhere Ln")) });
    const body = await res.text();
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${body.slice(0, 300)}`);
    assert.ok(/Pick the client/i.test(body), `expected a message naming what to do, got: ${body.slice(0, 300)}`);
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

  // LLM-6 model spend, asserted as a PAIR for the reason given below: the owner's 200 proves the
  // route exists and is licensed, the other tenant's 404 proves it sits behind the scope guard.
  await run("per-project model spend (llm-usage) is registered and tenancy-scoped", async () => {
    const own = await a(`/api/projects/${projA}/llm-usage`);
    assert.equal(own.status, 200, `own llm-usage returned ${own.status}`);
    const body = await own.json() as { projectId?: string; calls?: number; byLabel?: unknown[] };
    assert.equal(body.projectId, projA);
    assert.equal(typeof body.calls, "number");
    assert.ok(Array.isArray(body.byLabel));
    assert.equal((await b(`/api/projects/${projA}/llm-usage`)).status, 404, "another tenant read A's model spend");
  });

  // THE OPERATOR STATUS OVERRIDE, over real HTTP.
  //
  // POST /api/projects/:id/status is the audited way to move a project the pipeline got wrong
  // (updateProject deliberately excludes status, so before it a drifted row was fixable only
  // with hand-written SQL against production). It is also the only writer for `blocked`.
  //
  // ASSERTED AS A PAIR, deliberately. A foreign-tenant 404 on its own proves NOTHING here: a
  // route that was never registered 404s exactly the same way, so the half of this check that
  // carries the weight is the SAME request succeeding on the caller's own project. If the route
  // is deleted, the 200 fails; if the guard is lost, the 404 fails. One of them alone is
  // indistinguishable from a typo in the path.
  await run("the operator status override is registered, tenancy-scoped, and refuses what it must", async () => {
    // Your own project: the route exists, is licensed, and answers.
    const own = await a(`/api/projects/${projA}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "blocked", reason: "Homeowner paused the job pending an HOA decision." }),
    });
    const ownText = await own.text();
    assert.equal(own.status, 200, `override on your OWN project returned ${own.status}: ${ownText.slice(0, 300)}`);
    assert.equal(JSON.parse(ownText).project.status, "blocked", "the response carries a stale status");
    // …and it actually landed, read back through a separate request.
    const reread = await (await a(`/api/projects/${projA}`)).json();
    assert.equal(reread.project.status, "blocked", `the override did not persist: ${reread.project.status}`);
    assert.equal(reread.project.stageDetail, "operator_override",
      `stage_detail after an override is "${reread.project.stageDetail}" — a stale sub-stage under a new status lies`);

    // The other tenant's project: 404, never 403 — an id you don't own must be
    // indistinguishable from one that doesn't exist.
    const foreign = await b(`/api/projects/${projA}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "issued", reason: "not mine to move" }),
    });
    assert.equal(foreign.status, 404, `a foreign project's override returned ${foreign.status}`);
    const afterForeign = await (await a(`/api/projects/${projA}`)).json();
    assert.equal(afterForeign.project.status, "blocked", "the foreign override CHANGED another tenant's project");

    // A reason is mandatory — it is the audit row's whole explanation for overruling the pipeline.
    const noReason = await a(`/api/projects/${projA}/status`, {
      method: "POST", body: JSON.stringify({ status: "issued", reason: "   " }),
    });
    assert.equal(noReason.status, 400, `a reasonless override returned ${noReason.status}`);

    // handoff_ready is computed from permit-issued AND nem-approved. Forcing it would publish an
    // installer handoff checklist and drop the job off the board for a permit that may not exist.
    const forced = await a(`/api/projects/${projA}/status`, {
      method: "POST", body: JSON.stringify({ status: "handoff_ready", reason: "customer says it is done" }),
    });
    assert.equal(forced.status, 409, `handoff_ready was accepted over HTTP (${forced.status})`);

    const settled = await (await a(`/api/projects/${projA}`)).json();
    assert.equal(settled.project.status, "blocked", `a refused override still moved the project to ${settled.project.status}`);

    // Out of blocked again, through the same door — blocked has no other writer anywhere.
    const unblock = await a(`/api/projects/${projA}/status`, {
      method: "POST", body: JSON.stringify({ status: "qc_passed", reason: "HOA approved; resuming." }),
    });
    assert.equal(unblock.status, 200, `un-blocking returned ${unblock.status}: ${(await unblock.text()).slice(0, 200)}`);
  });

  await run("the client list is scoped — no route to another tenant's portal credentials", async () => {
    // B now has a client of its OWN (POST /api/projects requires one), so the claim is
    // no longer "B sees nothing" — it is "B sees exactly its own and never A's", which is
    // the stronger statement anyway: an empty list also passes a query that is simply broken.
    const listB = await (await b("/api/clients")).json();
    const idsB = (listB.clients || []).map((c: { id: string }) => c.id);
    assert.deepEqual(idsB, [clientB], `B saw ${JSON.stringify(idsB)}, expected only its own ${clientB}`);
    assert.ok(!idsB.includes(clientA), `B saw A's client ${clientA}`);
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

  // FOLDER SCANS (#276). A folder_scan job's payload carries a server folderPath (and its result
  // names every scanned PDF's path), so the batch-import job list must be scoped like /api/jobs.
  // It used to call listJobs with no orgId, which falls back to the DEFAULT org: every tenant
  // saw the operator's scans and never its own. Synthetic empty folders under this test's tmp dir.
  const scanJobIds: Record<"a" | "b" | "owner", string> = { a: "", b: "", owner: "" };
  const listScanIds = async (c: ReturnType<typeof as>): Promise<string[]> => {
    const res = await c("/api/batch-import/jobs");
    const text = await res.text();
    assert.equal(res.status, 200, `GET /api/batch-import/jobs -> ${res.status}: ${text.slice(0, 300)}`);
    return (JSON.parse(text) as { id: string }[]).map((j) => j.id);
  };
  await run("batch-import folder scans list only the caller's own org's jobs", async () => {
    for (const [who, c] of [["a", a], ["b", b], ["owner", owner]] as const) {
      const folder = path.join(tmpDir, `scan-${who}`);
      fs.mkdirSync(folder, { recursive: true });
      const made = await jsonOk(await c("/api/batch-import/scan", { method: "POST", body: JSON.stringify({ folderPath: folder }) }));
      scanJobIds[who] = String(made.id);
    }
    const seenA = await listScanIds(a);
    const seenB = await listScanIds(b);
    const seenOwner = await listScanIds(owner);
    assert.deepEqual(seenA, [scanJobIds.a], `A saw ${JSON.stringify(seenA)}`);
    assert.deepEqual(seenB, [scanJobIds.b], `B saw ${JSON.stringify(seenB)}`);
    // The default org is a tenant too: it sees its own scan and neither tenant's.
    assert.deepEqual(seenOwner, [scanJobIds.owner], `default org saw ${JSON.stringify(seenOwner)}`);
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

  await run("the superadmin's batch-import job list spans every org", async () => {
    // Runs after the promotion above: reqOrgFilter is null for a superadmin, which reads across orgs.
    const seen = await listScanIds(owner);
    for (const who of ["a", "b", "owner"] as const) {
      assert.ok(seen.includes(scanJobIds[who]), `superadmin missed ${who}'s scan (saw ${JSON.stringify(seen)})`);
    }
  });

} finally {
  server.kill("SIGTERM");
  // Wait for the ACTUAL process exit - on Windows kill() returns while the server still
  // holds the sqlite handle, and an immediate rm EBUSYs. Bounded so a hung child can't
  // wedge the test; the rm is best-effort (temp dir, OS cleans it eventually).
  await new Promise((r) => { server.once("exit", r); setTimeout(r, 5000); });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* still locked - leave to OS */ }
}

if (failures > 0) {
  console.error(`\n${failures} tenancy test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll tenancy tests passed.");
process.exit(0);
