// Standalone review API end-to-end: boots the real server on a temp sqlite and
// exercises POST /api/review + submissions endpoints over HTTP (stub LLM mode).
// Run: tsx backend/test/reviewApi.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-api-test-"));
const PORT = 4970 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmpDir, "test.sqlite"),
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "", // stub LLM — deterministic, no network
  NO_PROXY: "*",
  no_proxy: "*",
};
delete (env as Record<string, string | undefined>).HTTPS_PROXY;
delete (env as Record<string, string | undefined>).https_proxy;
delete (env as Record<string, string | undefined>).HTTP_PROXY;
delete (env as Record<string, string | undefined>).http_proxy;

const server = spawn("npx", ["tsx", "backend/src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"], detached: false });
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server never came up. log tail:\n${serverLog.slice(-2000)}`);
}

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

// The Oregon golden fixture's subject, expressed as the standalone DTO.
const oregonSubject = {
  workType: "solar_pv_residential",
  state: "OR",
  ahj: "Portland",
  utility: "PGE",
  applicant: { name: "Golden Test", address: "123 Snowy Ridge Rd", city: "Portland", zip: "97201" },
  system: { sizeDcKw: 60, sizeAcKw: 48, interconnectionMethod: "Load-side breaker" },
  fields: {
    dcKw: "60", acKw: "48", exportKw: "30", snow: "85", deadLoad: "5", roofRafterSpacing: "32",
    wind: "D", busRating: "200", mainBreaker: "200", pvBreaker: "70",
    moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2+", moduleWattage: "430", moduleQty: "140",
    inverterModel: "IQ8M", homeownerEmail: "golden@test.example", homeownerPhone: "(503) 555-0100",
    permitPath: "prescriptive",
    splitPagesText: "one-line diagram rapid shutdown site plan roof plan",
    projectDescriptionText: "Roof-mounted PV, load side interconnection.",
  },
};

try {
  await waitForServer();

  let submissionId = "";
  await run("POST /api/review (OR solar) reviews with jurisdiction-adopted codes", async () => {
    const res = await fetch(`${BASE}/api/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(oregonSubject) });
    const text = await res.text();
    assert.equal(res.status, 201, text.slice(0, 400));
    const body = JSON.parse(text);
    submissionId = body.submissionId;
    assert.ok(submissionId, "submission id returned");
    const blockers = body.report.findings.filter((f: { severity: string }) => f.severity === "blocker");
    assert.ok(blockers.length >= 5, `deterministic blockers present (${blockers.length})`);
    const withOesc = body.report.findings.some((f: { codeReferences: Array<{ code: string }> }) =>
      f.codeReferences.some((c) => /2023/.test(c.code)));
    assert.ok(withOesc, "citations carry the adopted 2023 edition");
  });

  await run("Elmore County general review: verify-locally phrasing + honest AI-unavailable", async () => {
    const res = await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workType: "general", state: "ID", ahj: "Elmore County", applicant: { address: "1 Test Rd", city: "Mountain Home" }, fields: { projectDescriptionText: "detached garage" } }),
    });
    const text = await res.text();
    assert.equal(res.status, 201, text.slice(0, 400));
    const body = JSON.parse(text);
    assert.equal(body.report.findings.filter((f: { severity: string }) => f.severity === "blocker").length, 0, "AI-served type never blocks");
    assert.ok(body.report.findings.some((f: { id: string }) => f.id === "ai.review.unavailable"), "stub mode is honest about AI unavailability");
  });

  await run("submissions list + detail + printable HTML", async () => {
    const list = await (await fetch(`${BASE}/api/review/submissions`)).json();
    assert.ok(list.submissions.length >= 2);
    const detail = await (await fetch(`${BASE}/api/review/submissions/${submissionId}`)).json();
    assert.equal(detail.workType, "solar_pv_residential");
    assert.ok(detail.report.findings.length > 0);
    const htmlRes = await fetch(`${BASE}/api/review/submissions/${submissionId}?format=html`);
    const html = await htmlRes.text();
    assert.ok(htmlRes.headers.get("content-type")?.includes("text/html"));
    assert.ok(html.includes("Golden Test") || html.includes("123 Snowy Ridge Rd") || html.length > 500, "HTML report renders");
  });

  await run("validation: bad subject → 400, missing submission → 404", async () => {
    const bad = await fetch(`${BASE}/api/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workType: "general" }) });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${BASE}/api/review/submissions/nope`);
    assert.equal(missing.status, 404);
  });

  await run("work-types registry served", async () => {
    const body = await (await fetch(`${BASE}/api/review/work-types`)).json();
    assert.ok(body.workTypes.some((w: { workType: string; deterministic: boolean }) => w.workType === "solar_pv_residential" && w.deterministic));
    assert.ok(body.workTypes.some((w: { workType: string }) => w.workType === "general"));
  });
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} review-api test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll review-api tests passed.");
process.exit(0);
