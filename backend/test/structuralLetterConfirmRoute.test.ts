// THE STRUCTURAL-LETTER CONFIRM / WITHDRAW ROUTE: A SIGNED-IN PERSON, THIS ORG'S PROJECT ONLY (#198).
//
// Owner ruling 2026-10-08 (on #218): only a named, signed-in person's confirmation credits the
// engineer's structural letter, and the door sits under /api/projects/:id so it inherits the tenant
// scope guard (hard rule 6). Pinned, with sign-in ON against a real server process:
//   1. signed out → 401 and nothing written;
//   2. signed in → 200, WHO is the session's person (a body-supplied name is ignored), the row is
//      bound to the document's id + sha256, and the audit trail has the confirm;
//   3. MUST-EXCLUDE: another org's project → 404 (never 403), for confirm AND withdraw, nothing
//      written there; a document of another project → 404; a project that does not exist → 404;
//   4. withdraw → 200 and audited; withdrawing again → 409;
//   5. an org API key alone (no session) → 401 and nothing written: a key names an org, never a person;
//   6. a signed-in account with a person's display name is recorded by that name (and its user id);
//   7. ?inline=1 sends nosniff, and opens inline only a file whose bytes are a PDF.
// The gate behaviour (held without a confirmation, released with one, voided on re-upload) is pinned
// in structuralCertificationCredit.test.ts.
//
// Synthetic data only. Run: npx tsx backend/test/structuralLetterConfirmRoute.test.ts
import "./_isolate";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "structural-letter-route-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { createApiKey } = await import("../src/auth");
const { DEFAULT_ORG_ID } = await import("../src/db");
const db = await openDatabase();
const apiKey = createApiKey(db, DEFAULT_ORG_ID, "letter-route key").key;

const OTHER_ORG = "org-letter-beta";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [OTHER_ORG, "Beta Solar", new Date().toISOString()]);
const client = createClient(db, {
  companyName: "Letter Route Solar LLC", legalBusinessName: "Letter Route Solar LLC", ccbLicenseNumber: "240136",
  electricalLicenseNumber: "C1235", businessEmail: "ops@letter-route.test", businessPhone: "(503) 555-0143",
});
async function letterPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  ["EXAMPLE STRUCTURAL ENGINEERS, PLLC", "STRUCTURAL CERTIFICATION", "The existing truss framing is adequate per ASCE 7-16.", "Jane Example, P.E."]
    .forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 24, size: 11, font }));
  return Buffer.from(await pdf.save());
}
const mk = async (owner: string) => {
  const d = createProject(db, { clientId: client.id, owner, street: "1 Example St", city: "Testville", state: "UT", zip: "84000", ahj: "City of Testville", utility: "Rocky Mountain Power" });
  const doc = saveProjectDocument(db, d.project.id, { docType: "structural", filename: "structural.pdf", contentType: "application/pdf", buffer: await letterPdf(), source: "split" });
  return { projectId: d.project.id, docId: doc.id };
};
const mine = await mk("Jane Example");
const theirs = await mk("John Example");
db.run("UPDATE projects SET org_id = ? WHERE id = ?", [OTHER_ORG, theirs.projectId]);
// A document whose content type says PDF but whose bytes are HTML: ?inline=1 must not open it.
const fakePdfPath = path.join(tmpDir, "not-a-pdf.pdf");
fs.writeFileSync(fakePdfPath, "<html><script>alert(1)</script></html>");
const fakePdfId = "doc-not-a-pdf";
db.run(
  "INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, content_type, size_bytes, source, uploaded_at) VALUES (?, ?, 'site_photo', 'not-a-pdf.pdf', ?, 'application/pdf', 40, 'upload', ?)",
  [fakePdfId, mine.projectId, fakePdfPath, new Date().toISOString()],
);
// Text extraction runs in the background after each save; let it land before the handle closes.
for (let i = 0; i < 200; i++) {
  if (!db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE COALESCE(extracted_text, '') = ''")?.n) break;
  await new Promise((r) => setTimeout(r, 25));
}
db.close();

const PORT = 5190 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, "backups"), AUTOPILOT_AUTO_START: "0", PORT: String(PORT),
  SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@letter.test", ADMIN_PASSWORD: "letter-test-password-1", NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
const read = (sql: string, args: unknown[] = []): Array<Record<string, unknown>> => {
  const h = new Database(dbPath, { readonly: true });
  try { return h.prepare(sql).all(...args) as Array<Record<string, unknown>>; } finally { h.close(); }
};
const rowsFor = (pid: string) => read("SELECT document_id, content_sha256, confirmed_by, confirmed_by_user_id, withdrawn_at FROM structural_letter_confirmations WHERE project_id = ?", [pid]);
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const post = (projectId: string, action: string, body: unknown, cookie = "", extra: Record<string, string> = {}) => fetch(`${BASE}/api/projects/${projectId}/structural-letter/${action}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body),
  });

  const keyOnly = await post(mine.projectId, "confirm", { documentId: mine.docId, page: 1, confirmedBy: "Jane Example" }, "", { "x-api-key": apiKey });
  check("5. an org API key alone (no session): 401, and nothing written", keyOnly.status === 401 && rowsFor(mine.projectId).length === 0, String(keyOnly.status));

  const anon = await post(mine.projectId, "confirm", { documentId: mine.docId, page: 1, confirmedBy: "Mallory Forger" });
  check("1. signed out: 401, and nothing written", anon.status === 401 && rowsFor(mine.projectId).length === 0, String(anon.status));

  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@letter.test", password: "letter-test-password-1" }) });
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

  const res = await post(mine.projectId, "confirm", { documentId: mine.docId, page: 1, confirmedBy: "Mallory Forger" }, cookie);
  const body = await res.json().catch(() => ({})) as { confirmation?: { confirmedBy?: string; documentId?: string }; structuralLetter?: { confirmation?: { confirmedBy?: string } } };
  const rows = rowsFor(mine.projectId);
  check("2a. signed in: 200, WHO is the session's person, never the body's name",
    res.status === 200 && body.confirmation?.confirmedBy === "admin@letter.test" && rows.length === 1 && rows[0].confirmed_by === "admin@letter.test" && Boolean(rows[0].confirmed_by_user_id),
    `${res.status} ${JSON.stringify(body).slice(0, 240)} ${JSON.stringify(rows)}`);
  check("2b. the confirmation is bound to the document id and its sha256",
    rows[0]?.document_id === mine.docId && /^[0-9a-f]{64}$/.test(String(rows[0]?.content_sha256)), JSON.stringify(rows));
  check("2c. the response carries the standing confirmation", body.structuralLetter?.confirmation?.confirmedBy === "admin@letter.test", JSON.stringify(body.structuralLetter));
  const audit = read("SELECT actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'structural_letter.confirmed'", [mine.projectId]);
  check("2d. the confirm is in the audit trail under the person, with the document and page",
    audit.length === 1 && audit[0].actor_name === "admin@letter.test" && (JSON.parse(String(audit[0].details)) as { documentId?: string; page?: number }).documentId === mine.docId
    && (JSON.parse(String(audit[0].details)) as { page?: number }).page === 1, JSON.stringify(audit));

  const foreign = await post(theirs.projectId, "confirm", { documentId: theirs.docId, page: 1 }, cookie);
  check("3a. MUST-EXCLUDE: another org's project → 404 (never 403), nothing written there",
    foreign.status === 404 && rowsFor(theirs.projectId).length === 0, String(foreign.status));
  const foreignWithdraw = await post(theirs.projectId, "withdraw", {}, cookie);
  check("3b. MUST-EXCLUDE: …and its withdraw → 404", foreignWithdraw.status === 404, String(foreignWithdraw.status));
  const borrowed = await post(mine.projectId, "confirm", { documentId: theirs.docId, page: 1 }, cookie);
  check("3c. MUST-EXCLUDE: another project's document on my project → 404, and my standing confirmation is untouched",
    borrowed.status === 404 && rowsFor(mine.projectId).filter((r) => !r.withdrawn_at).length === 1 && rowsFor(mine.projectId).every((r) => r.document_id === mine.docId),
    String(borrowed.status));
  const missing = await post("no-such-project", "confirm", { documentId: mine.docId }, cookie);
  check("3d. a project that does not exist → 404", missing.status === 404, String(missing.status));

  const w = await post(mine.projectId, "withdraw", { withdrawnBy: "Mallory Forger" }, cookie);
  const wAudit = read("SELECT actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'structural_letter.withdrawn'", [mine.projectId]);
  check("4a. withdraw → 200, the row is withdrawn, and audited under the session's person",
    w.status === 200 && rowsFor(mine.projectId).every((r) => Boolean(r.withdrawn_at)) && wAudit.length === 1 && wAudit[0].actor_name === "admin@letter.test",
    `${w.status} ${JSON.stringify(wAudit)}`);
  const again = await post(mine.projectId, "withdraw", {}, cookie);
  check("4b. withdrawing with nothing standing → 409", again.status === 409, String(again.status));

  // 6. The account gets a person's display name: that name is recorded (and the user id), not the email.
  const rw = new Database(dbPath);
  try { rw.prepare("UPDATE users SET name = 'Jane Example' WHERE email = 'admin@letter.test'").run(); } finally { rw.close(); }
  const named = await post(mine.projectId, "confirm", { documentId: mine.docId, page: 1, confirmedBy: "Mallory Forger" }, cookie);
  const namedBody = await named.json().catch(() => ({})) as { confirmation?: { confirmedBy?: string } };
  const namedRow = rowsFor(mine.projectId).find((r) => !r.withdrawn_at);
  const adminId = String(read("SELECT id FROM users WHERE email = 'admin@letter.test'")[0]?.id ?? "");
  const namedAudit = read("SELECT actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'structural_letter.confirmed' ORDER BY created_at DESC LIMIT 1", [mine.projectId]);
  check("6. a signed-in account named like a person is recorded by its name and user id, never the body's name",
    named.status === 200 && namedBody.confirmation?.confirmedBy === "Jane Example" && namedRow?.confirmed_by === "Jane Example"
    && namedRow?.confirmed_by_user_id === adminId && namedAudit[0]?.actor_name === "Jane Example"
    && (JSON.parse(String(namedAudit[0]?.details ?? "{}")) as { userId?: string }).userId === adminId,
    `${named.status} ${JSON.stringify(namedBody).slice(0, 200)} ${JSON.stringify(namedRow)}`);

  // 7. ?inline=1: nosniff, and inline only for real PDF bytes.
  const pdfInline = await fetch(`${BASE}/api/projects/${mine.projectId}/documents/${mine.docId}?inline=1`, { headers: { cookie } });
  check("7a. ?inline=1 on a PDF: inline, with nosniff",
    pdfInline.status === 200 && /^inline;/.test(String(pdfInline.headers.get("content-disposition"))) && pdfInline.headers.get("x-content-type-options") === "nosniff",
    `${pdfInline.status} ${pdfInline.headers.get("content-disposition")} ${pdfInline.headers.get("x-content-type-options")}`);
  const fakeInline = await fetch(`${BASE}/api/projects/${mine.projectId}/documents/${fakePdfId}?inline=1`, { headers: { cookie } });
  check("7b. ?inline=1 on HTML bytes labelled application/pdf: still a download, with nosniff",
    fakeInline.status === 200 && /^attachment;/.test(String(fakeInline.headers.get("content-disposition"))) && fakeInline.headers.get("x-content-type-options") === "nosniff",
    `${fakeInline.status} ${fakeInline.headers.get("content-disposition")} ${fakeInline.headers.get("x-content-type-options")}`);
} finally {
  server.kill("SIGTERM");
}

await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* the OS temp dir is reaped */ }
if (failures) { console.error(`\nstructuralLetterConfirmRoute: ${failures} failure(s)`); process.exit(1); }
console.log("\nstructuralLetterConfirmRoute: all checks passed");
process.exit(0);
