// Regression: GET /api/projects/:id/filled-forms/:formId used to query a
// nonexistent ahj_forms table, so EVERY filled AHJ-form download 500'd with a
// JSON error instead of the PDF ("the downloaded file won't open"). Boots the
// real server on a temp sqlite (stub LLM), stores a blank AcroForm template via
// the upload endpoint, builds the filled forms, and downloads one over HTTP.
// Run: tsx backend/test/filledFormDownload.test.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filled-form-dl-test-"));
const PORT = 4930 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(tmpDir, "test.sqlite"),
  DATA_DIR: path.join(tmpDir, "data"),
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
      const res = await fetch(`${BASE}/api/projects`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start.\n${serverLog.slice(-2000)}`);
}

async function blankAcroFormPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Test Permit Application", { x: 60, y: 720, size: 18, font });
  const form = doc.getForm();
  const field = form.createTextField("OwnerName");
  field.addToPage(page, { x: 60, y: 650, width: 220, height: 22 });
  return Buffer.from(await doc.save());
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

async function main(): Promise<void> {
  await waitForServer();

  // Project whose AHJ matches the stored template below.
  const created = await (await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parserPayload: { owner: "DL Test Owner", ahj: "City of Testburg", state: "OR", utility: "PGE", dcKw: 8 } }),
  })).json();
  const pid: string = created?.project?.id || created?.id;
  check("project created", Boolean(pid), JSON.stringify(created).slice(0, 200));

  // Store a blank AcroForm template through the real upload endpoint (stub LLM
  // maps no fields — fine; the fill still produces a valid PDF).
  const blank = await blankAcroFormPdf();
  const upload = await (await fetch(`${BASE}/api/ahj-templates/upload?ahj=${encodeURIComponent("City of Testburg")}&state=OR&filename=Testburg%20Solar%20App.pdf`, {
    method: "POST", headers: { "Content-Type": "application/pdf" }, body: blank,
  })).json();
  check("template stored via upload endpoint", upload?.status === "acquired" || upload?.status === "needs_manual", JSON.stringify(upload).slice(0, 200));

  // The stub LLM maps no fields, and an unmapped template is (by design) not
  // filled. Give the stored template a real field map the way the operator's
  // re-map would, directly in the sqlite file (single cross-process UPDATE).
  {
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(env.AUTOPILOT_DB_PATH);
    const row = raw.prepare("SELECT id, field_map FROM ahj_form_templates WHERE ahj_name = ?").get("City of Testburg") as { id: string; field_map: string } | undefined;
    check("template row exists", Boolean(row));
    if (row) {
      const map = JSON.parse(row.field_map || "{}");
      map.fillMode = "acroform";
      map.textFields = { OwnerName: "project.homeownerName" };
      raw.prepare("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?").run(JSON.stringify(map), row.id);
    }
    raw.close();
  }

  // Build filled forms; the stored template must produce a downloadable form.
  const pkg = await (await fetch(`${BASE}/api/projects/${pid}/filled-forms`, { method: "POST" })).json();
  const form = (pkg?.forms || []).find((f: { formId?: string; status?: string }) => f.formId && f.status !== "skipped" && f.status !== "error");
  check("filled form built from stored template", Boolean(form), JSON.stringify(pkg).slice(0, 300));

  if (form) {
    const dl = await fetch(`${BASE}/api/projects/${pid}/filled-forms/${form.formId}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const cd = dl.headers.get("content-disposition") || "";
    const ct = dl.headers.get("content-type") || "";
    check("download returns 200 (was 500: no such table ahj_forms)", dl.ok, `status=${dl.status} body=${bytes.subarray(0, 120).toString()}`);
    check("download is a real PDF", bytes.subarray(0, 4).toString() === "%PDF", `magic=${bytes.subarray(0, 8).toString("hex")}`);
    check("content-type is pdf", /pdf/i.test(ct), ct);
    check("filename is friendly with .pdf", /filename=".+\.pdf"/.test(cd) && !/undefined/.test(cd), cd);
    const parsed = await PDFDocument.load(bytes).catch(() => null);
    check("downloaded PDF parses", Boolean(parsed && parsed.getPageCount() >= 1));
  }

  // Unknown form id → clean 404, never a 500.
  const missing = await fetch(`${BASE}/api/projects/${pid}/filled-forms/not-a-real-form`);
  check("unknown form id is a clean 404", missing.status === 404, `status=${missing.status}`);
}

main()
  .catch((err) => { failures++; console.error(err); console.error(serverLog.slice(-1500)); })
  .finally(() => {
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
    console.log("\nfilledFormDownload: all checks passed");
    process.exit(0);
  });
