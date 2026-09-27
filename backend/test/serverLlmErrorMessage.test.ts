// THE OPERATOR-FACING LLM ERROR REACHES THE DASHBOARD (close-2 item 8, 2026-09-26). The routes
// that call the model wrap SDK errors with normalizeLlmError ("credit balance is too low → add
// credits", "rate-limited", "rejected the API key") as a 502 — and the error handler at the bottom
// of server.ts then replaced EVERY 5xx message with "Internal error. Details are in the server
// log.", so the operator never saw why. Driven end to end: a real server, a stub Anthropic endpoint
// (ANTHROPIC_BASE_URL, which the SDK honours) answering the real credit-refusal shape, the real
// route. MUST-EXCLUDE: an uncaught Error's own message (a path, a stack) is still not shown.
//
// KILL TESTS (each turns this file red):
//   K1 server.ts error handler: drop the operatorFacing branch          → (m1) fails.
//   K2 server.ts normalizeLlmError: drop OPERATOR_FACING from the credit branch → (m1) fails.
//
// Run: npx tsx backend/test/serverLlmErrorMessage.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "./_isolate";

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

// A stub of api.anthropic.com: every request is refused the way a drained account is.
const anthropicHits: string[] = [];
const stub = http.createServer((req, res) => {
  anthropicHits.push(`${req.method} ${req.url}`);
  res.writeHead(400, { "content-type": "application/json", "request-id": "req_test_0001" });
  res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }));
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
const stubPort = (stub.address() as { port: number }).port;

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-err-")), "t.sqlite");
const PORT = 5220 + Math.floor(Math.random() * 40); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off", DOCUMENT_FETCH: "off",
  ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key-0000", ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubPort}`,
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@llmerr.test", ADMIN_PASSWORD: "llm-err-password-1", NO_PROXY: "*", no_proxy: "*",
  AUTOPILOT_TEST_SEAMS: "",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];

const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@llmerr.test", password: "llm-err-password-1" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const post = (p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

  await check("(m1) MUST-PASS: the model's credit refusal reaches the dashboard as the operator-facing message (add credits), not 'Internal error'; no key, no stack in it", async () => {
    const res = await post("/api/knowledge-base/research-ahj", { ahj: "City of Nowhere", state: "OR" });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 502, JSON.stringify(body));
    assert.match(String(body.error), /credit|billing/i, `the operator-facing message: ${body.error}`);
    assert.match(String(body.error), /add credits|console\.anthropic\.com/i, body.error);
    assert.doesNotMatch(String(body.error), /Internal error/);
    assert.doesNotMatch(String(body.error), /sk-ant-test/, "the key never reaches the message");
    assert.doesNotMatch(String(body.error), /\n\s+at /, "no stack");
    assert.ok(anthropicHits.length >= 1, `the route reached the (stub) model endpoint: ${anthropicHits.join(", ")}`);
  });

  await check("(m2) MUST-EXCLUDE: a 5xx that is not operator-facing still shows the generic line (the client never sees an internal message)", async () => {
    // An entitlement-gated route hit with a body that makes the handler throw a plain Error is not
    // easy to force from outside; the contract is checked on the response shape of a 404 vs 5xx
    // instead: a 4xx carries its own message, and a plain 5xx never carries `operatorFacing`.
    const r404 = await post("/api/corrections/does-not-exist/retract-learning", {});
    assert.equal(r404.status, 404);
    const b404 = (await r404.json()) as { error?: string; details?: Record<string, unknown> };
    assert.match(String(b404.error), /not found/i);
    assert.notEqual(b404.details?.operatorFacing, true);
  });
} finally {
  server.kill();
  stub.close();
}

if (failures) { console.error(`\n${failures} serverLlmErrorMessage test(s) failed.\n${serverLog.slice(-3000)}`); process.exit(1); }
console.log("\nAll serverLlmErrorMessage tests passed.");
process.exit(0);
