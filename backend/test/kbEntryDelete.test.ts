// A KB ENTRY CAN BE DELETED FROM THE DASHBOARD (issue #26) — and only the way it should be.
//
// The owner tried to remove the poisoned `NM / City of Albuquerque / PNM` row (issue #8) and
// found no way short of a SQLite edit. DELETE /api/knowledge-base/:profileKey is that way. The
// table is shared across every tenant on purpose (CLAUDE.md), so the route is ADMIN-ONLY and
// AUDITED (knowledge.deleted, the key and who), and a HUMAN-VERIFIED row (rule 3, in spirit) is
// refused with 409 unless the request carries ?confirmVerified=1.
//
// Part 1 boots the real server on a temp sqlite with AUTH_ENABLED=true (tenancy.test.ts shape)
// over rows this test seeds first. Part 2 runs the SHIPPED dashboard functions
// (kbDeleteButtonHtml / deleteKnowledgeEntry, brace-balanced cut out of frontend/dashboard.js)
// against stubs: the key is esc()'d into the card, URL-encoded on the way out, a verified row
// asks twice, and the card leaves state without a reload.
//
// KILL: drop requireAdmin from the route → "a non-admin tenant gets 403" fails; drop the
// isVerifiedKnowledge check → "verified row is refused" fails; drop addAuditLog → "audited"
// fails; drop the child-table deletes → the delete 500s on the foreign key.
//
// Run: tsx backend/test/kbEntryDelete.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const REPO = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-delete-test-"));

function freePortInBand(start: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const candidate = start + i;
    try {
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(${candidate},"0.0.0.0",function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return candidate;
    } catch { /* held — try the next */ }
  }
  return start + Math.floor(Math.random() * count);
}
// Own band: 5280-5299 (the other server-booting suites sit at 4930-5259).
const PORT = freePortInBand(5280, 20);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(tmpDir, "test.sqlite");

let failures = 0;
const run = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Seed BEFORE the server boots: one learned row with child rows on every FK table, one
// human-verified row. Synthetic names only.
// ---------------------------------------------------------------------------
const PLAIN = "zz|synthetic city|synthetic power";
const VERIFIED = "zz|verified city|synthetic power";
process.env.AUTOPILOT_DB_PATH = DB_PATH;
{
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  const now = new Date().toISOString();
  const insert = (key: string, ahj: string, verifiedAt: string) => db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, confidence, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
     VALUES (?, ?, 'ZZ', ?, 'Synthetic Power', 'https://permits.synthetic.test', ?, ?, ?, ?, ?, ?)`,
    [`kb-${ahj}`, key, ahj, verifiedAt ? "mixed" : "learned", now, now, now, verifiedAt, verifiedAt ? "tester" : ""],
  );
  insert(PLAIN, "Synthetic City", "");
  insert(VERIFIED, "Verified City", now);
  db.run("INSERT INTO knowledge_events (id, profile_key, event_type, created_at) VALUES ('ev-1', ?, 'test.seed', ?)", [PLAIN, now]);
  db.run("INSERT INTO historical_failure_examples (id, source_signature, profile_key, created_at) VALUES ('hf-1', 'sig-1', ?, ?)", [PLAIN, now]);
  db.run("INSERT INTO mbox_learning_records (id, source_signature, bucket, profile_key, created_at) VALUES ('mb-1', 'sig-mb-1', 'permit', ?, ?)", [PLAIN, now]);
  db.close();
}

const env: Record<string, string | undefined> = {
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
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];

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
const loginAs = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `login ${email}: ${await res.text()}`);
  return String(res.headers.get("set-cookie") || "").split(";")[0];
};
const as = (cookie: string) => (p: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${BASE}${p}`, { ...init, headers });
};
const keyPath = (key: string) => `/api/knowledge-base/${encodeURIComponent(key)}`;
const readDb = async <T>(fn: (db: import("../src/db").AppDb) => T): Promise<T> => {
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  try { return fn(db); } finally { db.close(); }
};

try {
  await waitForServer();
  const owner = as(await loginAs("owner@operator.test", "owner-test-password-1"));
  // Creating a tenant org is cross-org administration: superadmin-only since #275. The
  // seeded login is a plain admin, so promote it as an operator does (VERIFICATION_PLAN 1.3).
  await readDb((db) => db.run("UPDATE users SET role = 'superadmin' WHERE email = ?", ["owner@operator.test"]));

  // A tenant org that holds the autopilot, with an ordinary (non-admin) user.
  let tenant: ReturnType<typeof as> | null = null;
  await run("a tenant org with a non-admin user can be created", async () => {
    const created = await owner("/api/orgs", { method: "POST", body: JSON.stringify({ name: "Acme Solar", edition: "full", products: ["autopilot"] }) });
    const text = await created.text();
    assert.equal(created.status, 201, text.slice(0, 300));
    const orgId = (JSON.parse(text).org as { id: string }).id;
    const user = await owner(`/api/orgs/${orgId}/users`, { method: "POST", body: JSON.stringify({ name: "Staff", email: "staff@acme.test", password: "tenant-pass-12345" }) });
    assert.equal(user.status, 201, (await user.text()).slice(0, 300));
    tenant = as(await loginAs("staff@acme.test", "tenant-pass-12345"));
  });

  await run("a non-admin tenant gets 403 and the row stays", async () => {
    assert.ok(tenant, "tenant login missing");
    const res = await tenant(keyPath(PLAIN), { method: "DELETE" });
    assert.equal(res.status, 403, await res.text());
    assert.ok(await readDb((db) => db.get("SELECT 1 FROM permit_utility_knowledge WHERE profile_key = ?", [PLAIN])), "row was deleted by a non-admin");
  });

  await run("404 on a missing key", async () => {
    const res = await owner(keyPath("zz|no such city|nobody"), { method: "DELETE" });
    assert.equal(res.status, 404, await res.text());
  });

  await run("admin delete removes the row (and its FK evidence rows)", async () => {
    const res = await owner(keyPath(PLAIN), { method: "DELETE" });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const body = JSON.parse(text) as { deleted: boolean; removed: Record<string, number> };
    assert.equal(body.deleted, true);
    assert.equal(body.removed.knowledge_events, 1);
    assert.equal(body.removed.historical_failure_examples, 1);
    assert.equal(body.removed.mbox_learning_records, 1);
    const left = await readDb((db) => ({
      row: db.get("SELECT 1 FROM permit_utility_knowledge WHERE profile_key = ?", [PLAIN]),
      events: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_events WHERE profile_key = ?", [PLAIN])?.n,
    }));
    assert.ok(!left.row, "row still present");
    assert.equal(left.events, 0);
    const list = await (await owner("/api/knowledge-base")).json() as { profiles: Array<{ profileKey: string }> };
    assert.ok(!list.profiles.some((p) => p.profileKey === PLAIN), "GET /api/knowledge-base still lists it");
  });

  await run("the delete is audited as knowledge.deleted with the key and who", async () => {
    const audit = await readDb((db) => db.get<{ actor_name: string; details: string }>(
      "SELECT actor_name, details FROM audit_logs WHERE action = 'knowledge.deleted' ORDER BY created_at DESC LIMIT 1",
    ));
    assert.ok(audit, "no knowledge.deleted audit row");
    assert.equal(audit.actor_name, "owner@operator.test");
    const details = JSON.parse(audit.details) as { profileKey: string; wasVerified: boolean };
    assert.equal(details.profileKey, PLAIN);
    assert.equal(details.wasVerified, false);
  });

  await run("a human-verified row is refused with 409 without ?confirmVerified=1", async () => {
    const res = await owner(keyPath(VERIFIED), { method: "DELETE" });
    assert.equal(res.status, 409, await res.text());
    assert.ok(await readDb((db) => db.get("SELECT 1 FROM permit_utility_knowledge WHERE profile_key = ?", [VERIFIED])), "verified row was deleted without the flag");
  });

  await run("a human-verified row goes with ?confirmVerified=1, audited as verified", async () => {
    const res = await owner(`${keyPath(VERIFIED)}?confirmVerified=1`, { method: "DELETE" });
    assert.equal(res.status, 200, await res.text());
    const state = await readDb((db) => ({
      row: db.get("SELECT 1 FROM permit_utility_knowledge WHERE profile_key = ?", [VERIFIED]),
      audit: db.get<{ details: string }>("SELECT details FROM audit_logs WHERE action = 'knowledge.deleted' AND details LIKE ?", [`%${VERIFIED}%`]),
    }));
    assert.ok(!state.row, "verified row still present");
    assert.ok(state.audit, "no audit row for the verified delete");
    assert.equal((JSON.parse(state.audit.details) as { wasVerified: boolean }).wasVerified, true);
  });
} finally {
  server.kill();
}

// ---------------------------------------------------------------------------
// Part 2: the shipped dashboard functions.
// ---------------------------------------------------------------------------
const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const bundle = ["esc", "kbDeleteButtonHtml", "deleteKnowledgeEntry"].map(cut).join("\n\n");

function harness(confirms: boolean[]) {
  const calls: Array<{ path: string; method: string }> = [];
  const sandbox: Record<string, unknown> = {
    state: { knowledgeProfiles: [{ profileKey: "zz|a|b" }, { profileKey: "zz|keep|b" }] },
    confirm: () => confirms.shift() ?? false,
    api: async (p: string, init: { method?: string } = {}) => { calls.push({ path: p, method: init.method || "GET" }); return { deleted: true }; },
    $: () => ({ textContent: "" }),
    renderKnowledgeBase: () => { (sandbox.renders as number)++; },
    showMessage: () => {},
    renders: 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);
  return { sandbox, calls };
}

await run("the Delete button escapes the key into its data attribute", () => {
  const { sandbox } = harness([]);
  const html = vm.runInContext(`kbDeleteButtonHtml({ profileKey: 'zz|"><img src=x>|b', verifiedAt: "2026-01-01" })`, sandbox) as string;
  assert.ok(!html.includes("<img"), `unescaped key in: ${html}`);
  assert.ok(html.includes('data-kb-verified="1"'), html);
  assert.ok(html.includes("Delete entry"));
});

await run("confirming deletes via the URL-encoded key and the card leaves state without a reload", async () => {
  const { sandbox, calls } = harness([true]);
  const ok = await vm.runInContext(`deleteKnowledgeEntry("zz|a|b", false)`, sandbox);
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ path: `/api/knowledge-base/${encodeURIComponent("zz|a|b")}`, method: "DELETE" }]);
  const left = (sandbox.state as { knowledgeProfiles: Array<{ profileKey: string }> }).knowledgeProfiles.map((p) => p.profileKey);
  assert.deepEqual(left, ["zz|keep|b"]);
  assert.equal(sandbox.renders, 1);
});

await run("cancelling the confirm sends nothing", async () => {
  const { sandbox, calls } = harness([false]);
  await vm.runInContext(`deleteKnowledgeEntry("zz|a|b", false)`, sandbox);
  assert.equal(calls.length, 0);
});

await run("a verified row asks twice and only then sends confirmVerified=1", async () => {
  const once = harness([true, false]);
  await vm.runInContext(`deleteKnowledgeEntry("zz|a|b", true)`, once.sandbox);
  assert.equal(once.calls.length, 0, "sent after only one confirm");
  const twice = harness([true, true]);
  await vm.runInContext(`deleteKnowledgeEntry("zz|a|b", true)`, twice.sandbox);
  assert.equal(twice.calls.length, 1);
  assert.ok(twice.calls[0].path.endsWith("?confirmVerified=1"), twice.calls[0].path);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nkbEntryDelete: all checks passed");
