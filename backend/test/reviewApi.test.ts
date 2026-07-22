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
  // Startup key gate refuses to boot unset/placeholder; keep hermetic on fresh clones.
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true",
  ADMIN_EMAIL: "admin@review.test",
  ADMIN_PASSWORD: "review-test-password-1",
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

// Session-cookie helper: log in once, carry the cookie on every operator call.
let cookie = "";
async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie && !headers.has("x-api-key")) headers.set("cookie", cookie);
  return fetch(`${BASE}${pathname}`, { ...init, headers });
}

try {
  await waitForServer();

  await run("login (auth enabled) — the operator session all calls ride on", async () => {
    const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@review.test", password: "review-test-password-1" }) });
    assert.equal(res.status, 200, await res.text());
    cookie = String(res.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie.includes("sa_session"));
  });

  let submissionId = "";
  await run("POST /api/review (OR solar) reviews with jurisdiction-adopted codes", async () => {
    const res = await api("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(oregonSubject) });
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
    const res = await api("/api/review", {
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
    const list = await (await api("/api/review/submissions")).json();
    assert.ok(list.submissions.length >= 2);
    const detail = await (await api(`/api/review/submissions/${submissionId}`)).json();
    assert.equal(detail.workType, "solar_pv_residential");
    assert.ok(detail.report.findings.length > 0);
    const htmlRes = await api(`/api/review/submissions/${submissionId}?format=html`);
    const html = await htmlRes.text();
    assert.ok(htmlRes.headers.get("content-type")?.includes("text/html"));
    assert.ok(html.includes("Golden Test") || html.includes("123 Snowy Ridge Rd") || html.length > 500, "HTML report renders");
  });

  await run("validation: bad subject → 400, missing submission → 404", async () => {
    const bad = await api("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workType: "general" }) });
    assert.equal(bad.status, 400);
    const missing = await api("/api/review/submissions/nope");
    assert.equal(missing.status, 404);
  });

  await run("work-types registry served", async () => {
    const body = await (await api("/api/review/work-types")).json();
    assert.ok(body.workTypes.some((w: { workType: string; deterministic: boolean }) => w.workType === "solar_pv_residential" && w.deterministic));
    assert.ok(body.workTypes.some((w: { workType: string }) => w.workType === "general"));
  });
  await run("tenancy: review_gate org via API key — review works, full product 403s, rows isolated", async () => {
    const orgRes = await api("/api/orgs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Elmore County Building Dept", edition: "review_gate" }) });
    const orgText = await orgRes.text();
    assert.equal(orgRes.status, 201, orgText.slice(0, 300));
    const org = JSON.parse(orgText).org;

    const keyRes = await api(`/api/orgs/${org.id}/api-keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "intake" }) });
    const key = (await keyRes.json()).key as string;
    assert.ok(key.startsWith("rg_"), "plaintext key returned once");

    // API key reaches the review surface (no session cookie)…
    const rev = await fetch(`${BASE}/api/review`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ workType: "reroof", state: "ID", ahj: "Elmore County", fields: {} }) });
    assert.equal(rev.status, 201, (await rev.text()).slice(0, 200));

    // …but never the full product. An API key isn't even authenticated there (401);
    // a review_gate SESSION USER gets the licensing 403.
    const projectsViaKey = await fetch(`${BASE}/api/projects`, { headers: { "x-api-key": key } });
    assert.equal(projectsViaKey.status, 401, "api keys never authenticate full-product APIs");
    const userRes = await api(`/api/orgs/${org.id}/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "County Reviewer", email: "reviewer@elmore.test", password: "reviewer-pass-1" }) });
    assert.equal(userRes.status, 201, (await userRes.text()).slice(0, 200));
    const tenantLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "reviewer@elmore.test", password: "reviewer-pass-1" }) });
    const tenantCookie = String(tenantLogin.headers.get("set-cookie") || "").split(";")[0];
    const projectsAsTenant = await fetch(`${BASE}/api/projects`, { headers: { cookie: tenantCookie } });
    assert.equal(projectsAsTenant.status, 403, "review_gate session user is licensing-denied the all-in-one APIs");
    const reviewAsTenant = await fetch(`${BASE}/api/review/work-types`, { headers: { cookie: tenantCookie } });
    assert.equal(reviewAsTenant.status, 200, "review surface open to the tenant user");

    // Row isolation: the tenant sees ONLY its own submissions; the default org
    // cannot read the tenant's submission by id.
    const tenantList = await (await fetch(`${BASE}/api/review/submissions`, { headers: { "x-api-key": key } })).json();
    assert.equal(tenantList.submissions.length, 1, "tenant sees only its rows");
    const tenantSubId = tenantList.submissions[0].id;
    const crossOrg = await api(`/api/review/submissions/${tenantSubId}`);
    assert.equal(crossOrg.status, 404, "cross-org read is a 404");

    // Bad API key → 401.
    const badKey = await fetch(`${BASE}/api/review/submissions`, { headers: { "x-api-key": "rg_wrong" } });
    assert.equal(badKey.status, 401);
  });

  await run("shared report link works publicly; default-org flow unaffected", async () => {
    const share = await (await api(`/api/review/submissions/${submissionId}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.ok(String(share.url).includes("/api/public/review/"));
    const token = String(share.url).split("/").pop();
    const pub = await fetch(`${BASE}/api/public/review/${token}`); // NO cookie, NO key
    assert.equal(pub.status, 200);
    assert.ok((await pub.text()).length > 300, "public HTML report renders");
    // Default org (full edition) still reaches the all-in-one product.
    const projects = await api("/api/projects");
    assert.equal(projects.status, 200, "full edition unaffected");
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
