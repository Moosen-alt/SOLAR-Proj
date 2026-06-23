// LIVE smoke test for the auto-learn flow driven by the REAL Claude planner.
//
// Spins up an in-process fixture portal that mirrors a real utility NEM application —
// login → dashboard (nav links only) → applicant-info form → DOCUMENT UPLOAD page →
// review/submit — and runs the full learnPortal() pipeline through it with the actual LLM
// (when ANTHROPIC_API_KEY is set; otherwise the deterministic stub planner). It asserts the
// learner: navigates the dashboard, fills the form, attaches the RIGHT split document to
// each upload control, reaches the review screen, records the final submit WITHOUT clicking
// it, and captures a review screenshot. Headless, no live-portal/network access required.
//
// Run:  npm run portal:test:live      (uses the real LLM if ANTHROPIC_API_KEY is set)
import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnPortal } from "../index";
import type { LearnPlanRequest, LearnPlanResponse } from "./autoLearnAdapter";
import { createLLMProvider } from "../../../backend/src/llm";

const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><style>body{font-family:sans-serif;margin:32px;max-width:720px}h1{color:#16407a}label{display:block;margin:10px 0 2px;font-weight:600}input{padding:6px;width:320px}.box{border:1px solid #ccc;border-radius:8px;padding:16px;margin:12px 0}.ok{color:#15803d}</style></head><body>${body}</body></html>`;

let failures = 0;
function check(name: string, pass: boolean) {
  console.log(`  ${pass ? "ok  " : "FAIL"} - ${name}`);
  if (!pass) failures++;
}

async function main() {
  // --- real split-doc files the learner attaches (named so we can verify the mapping) ---
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-docs-"));
  const mk = (n: string, c: string) => { const p = path.join(docDir, n); fs.writeFileSync(p, c); return p; };
  const docsByType: Record<string, string> = {
    sld: mk("sld.pdf", "%PDF sld"), site_plan: mk("site_plan.pdf", "%PDF site"),
    inverter_spec: mk("inverter_spec.pdf", "%PDF inv"), meter_photo: mk("meter_photo.png", "PNG"),
    plan_set: mk("plan_set.pdf", "%PDF planset"),
  };
  const EXPECTED: Record<string, string> = { file_sld: "sld.pdf", file_site: "site_plan.pdf", file_inv: "inverter_spec.pdf", file_meter: "meter_photo.png" };

  function parseMultipart(buf: Buffer, boundary: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of buf.toString("latin1").split(`--${boundary}`)) {
      const m = part.match(/name="([^"]+)"[^]*?filename="([^"]*)"/);
      if (m && m[2]) out[m[1]] = m[2];
    }
    return out;
  }

  let received: Record<string, string> = {};
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const q = new URLSearchParams((req.url || "").split("?")[1] || "");
    res.setHeader("content-type", "text/html");
    if (url === "/login") {
      res.end(html("Sign In", `<h1>Cascade Power — Customer Generation</h1><form action="/dashboard" method="get">
        <label for="username">Username</label><input id="username" name="username" type="text">
        <label for="password">Password</label><input id="password" name="password" type="password">
        <button type="submit">Log In</button></form>`));
    } else if (url === "/dashboard") {
      res.end(html("Program Home", `<h1>Program Home</h1><p>Welcome back.</p>
        <a href="/messages">Messages</a> <a href="/step1">New Customer Generation Application</a> <a href="/account">My Account</a>`));
    } else if (url === "/step1") {
      res.end(html("Step 1", `<h1>Step 1 — Applicant Information</h1><form action="/step2" method="get">
        <label for="owner">Property Owner Name</label><input id="owner" name="owner" type="text">
        <label for="addr">Project Address</label><input id="addr" name="addr" type="text">
        <button type="submit">Next</button></form>`));
    } else if (url === "/step2") {
      res.end(html("Step 2", `<h1>Step 2 — Upload Documents</h1><form action="/review" method="post" enctype="multipart/form-data">
        <input type="hidden" name="owner" value="${q.get("owner") || ""}"><input type="hidden" name="addr" value="${q.get("addr") || ""}">
        <label for="file_sld">Upload SLD / One-Line Diagram</label><input id="file_sld" name="file_sld" type="file">
        <label for="file_site">Site Plan</label><input id="file_site" name="file_site" type="file">
        <label for="file_inv">Inverter Specification Sheet</label><input id="file_inv" name="file_inv" type="file">
        <label for="file_meter">Meter Photo</label><input id="file_meter" name="file_meter" type="file">
        <button type="submit">Next</button></form>`));
    } else if (url === "/review" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "")?.[1] || "";
        received = parseMultipart(Buffer.concat(chunks), boundary);
        const rows = Object.entries(received).map(([f, n]) => `<li class="ok">✓ ${f} &larr; <b>${n}</b></li>`).join("");
        res.end(html("Step 3: Review", `<h1>Step 3: Review</h1><p>Please review all information before submitting.</p>
          <div class="box"><b>Attached documents (received by portal):</b><ul>${rows}</ul></div><button type="submit">Submit Application</button>`));
      });
    } else {
      res.end(html("Page", `<h1>${url}</h1>`));
    }
  });

  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = createLLMProvider();
  console.log(`Auto-learn LIVE smoke — planner: ${provider.constructor.name}\n`);

  const projects = [
    { label: "P1", fields: { homeownerName: "Jane Q Homeowner", projectAddress: "123 Solar Way" } },
    { label: "P2", fields: { homeownerName: "Carlos & Mei Rivera", projectAddress: "88 Sunbeam Ct" } },
  ];

  for (const p of projects) {
    received = {};
    const planner = async (reqp: LearnPlanRequest): Promise<LearnPlanResponse> => {
      const indexed = reqp.fields.map((f, i) => ({ index: i, label: f.label, fieldType: f.fieldType, options: f.options }));
      const plan = await provider.planPortalFields({
        url: reqp.url, pageTitle: reqp.pageTitle, fields: indexed, bodyText: reqp.bodyText,
        projectFields: p.fields, alreadyFilledLabels: reqp.alreadyFilledLabels, isDashboard: reqp.isDashboard,
      });
      return { fills: plan.fills.map((f) => ({ selectorIndex: f.index, value: f.value, field: f.field })),
        advanceSelectorIndex: plan.advanceIndex, navigateSelectorIndex: plan.navigateIndex,
        finalSubmitSelectorIndex: plan.finalSubmitIndex, atReview: plan.atReview, notes: plan.notes };
    };
    const result = await learnPortal({
      portalName: `Cascade Power (${p.label})`, portalUrl: `${base}/login`,
      project: { id: p.label, state: "OR" } as never, planner,
      credential: { username: "testuser", password: "testpass" }, docsByType, headless: true,
    });
    const uploads = result.steps.filter((s) => s.action === "upload");
    const docTypes = uploads.map((s) => s.docType).sort();
    console.log(`${p.label}: ${p.fields.homeownerName} — pages=${result.pageCount}`);
    check("reached review (ok)", result.ok === true);
    check("recorded 4 upload steps", uploads.length === 4);
    check("attached correct docTypes", JSON.stringify(docTypes) === JSON.stringify(["inverter_spec", "meter_photo", "site_plan", "sld"]));
    check("portal received right file per control", Object.entries(EXPECTED).every(([f, n]) => received[f] === n));
    check("final submit recorded, never clicked", result.steps.some((s) => s.isFinalSubmit === true));
    if (result.reviewScreenshotBase64 && p.label === "P1") {
      const shot = path.join(process.cwd(), "autolearn-live-final-page.png");
      fs.writeFileSync(shot, Buffer.from(result.reviewScreenshotBase64, "base64"));
      console.log(`  review screenshot: ${shot}`);
    }
  }

  await new Promise<void>((r) => server.close(() => r()));
  console.log(`\n${failures === 0 ? "All auto-learn LIVE smoke checks passed." : failures + " CHECK(S) FAILED."}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(2); });
