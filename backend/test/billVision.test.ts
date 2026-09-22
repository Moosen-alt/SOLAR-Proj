// READING THE BILL IS NOT GUESSING — BUT IT MUST STAY READING.
//
// The account number is the most common reason a project stops for a human (5 of 19 live
// projects, ~26 interruptions per 100). The fix reads it off the customer's own bill image
// with the extractor that already exists. QC's rule — "never guess it" — is what these tests
// protect: an operator's value is never overwritten, a low-confidence read is never written,
// a stub provider writes nothing, and only account/meter are touched.
// Run: tsx backend/test/billVision.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-vision-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { fillAccountFieldsFromDocuments } = await import("../src/billVision");

const db = await openDatabase();
let failures = 0;
const run = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}: ${(e as Error).message}`); }
};

const client = createClient(db, { companyName: "Bill Vision Solar", ccbLicenseNumber: "998877" });
let n = 0;
const mkProject = (snapshot: Record<string, unknown> = {}): string => {
  const p = createProject(db, {
    clientId: client.id, owner: `Owner ${++n}`, street: `${n} Bill St`, city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "7", acKw: "6",
  }).project;
  const row = db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [p.id]);
  const merged = { ...JSON.parse(row?.parser_json || "{}"), ...snapshot };
  db.run("UPDATE projects SET parser_json = ? WHERE id = ?", [JSON.stringify(merged), p.id]);
  return p.id;
};
const snapshotOf = (id: string): Record<string, unknown> =>
  JSON.parse(db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [id])?.parser_json || "{}");

// A 1x1 PNG is enough: the extractor is injected, so what is under test is the plumbing and
// the refusals, not the model's eyesight.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const attachBill = (projectId: string): unknown =>
  saveProjectDocument(db, projectId, { filename: "bill.png", docType: "utility_bill", contentType: "image/png", buffer: PNG_1PX, source: "upload" });

// Dependency injection, the way the rest of this suite does it (checkKnowledgeLinks(db, llm, …)):
// the function takes the provider, so there is no module patching and no network.
const stubLlm = (
  fields: Record<string, unknown>,
  lowConfidenceFields: string[] = [],
  provider: "claude" | "stub" = "claude",
): unknown => ({
  extractProjectFieldsFromImages: async () => ({ provider, fields, lowConfidenceFields, notes: "" }),
});

console.log("\n1. THE POINT: an account number on the bill is READ, not asked about");
await run("MUST PASS: an empty accountNumber is filled from the bill image", async () => {
  const id = mkProject({ accountNumber: "" });
  attachBill(id);
  const llm = stubLlm({ accountNumber: { value: "65564191-0014", confidence: "high" } });
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.deepEqual(written, ["accountNumber"], JSON.stringify(written));
  assert.equal(snapshotOf(id).accountNumber, "65564191-0014");
});

await run("the read is audited — what was read and from which document, never the value", async () => {
  const rows = db.query<{ details: string }>(
    "SELECT details FROM audit_logs WHERE action = 'project.fields_read_from_document' ORDER BY rowid DESC LIMIT 1");
  assert.ok(rows.length, "no audit row written");
  assert.match(rows[0].details, /accountNumber/);
  assert.ok(!/65564191/.test(rows[0].details), "the account number itself must never be logged");
});

console.log("\n2. WHAT IT MUST REFUSE — 'never guess it' survives intact");
await run("MUST EXCLUDE: an operator's existing value is never overwritten", async () => {
  const id = mkProject({ accountNumber: "OPERATOR-TYPED-1234" });
  attachBill(id);
  const llm = stubLlm({ accountNumber: { value: "9999999999", confidence: "high" } });
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.deepEqual(written, [], "it wrote over a value a person entered");
  assert.equal(snapshotOf(id).accountNumber, "OPERATOR-TYPED-1234");
});

await run("MUST EXCLUDE: a LOW-CONFIDENCE read is left for a human", async () => {
  const id = mkProject({ accountNumber: "" });
  attachBill(id);
  const llm = stubLlm({ accountNumber: { value: "maybe-1234", confidence: "low" } }, ["accountNumber"]);
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.deepEqual(written, [], "a doubtful read became a fact on a utility application");
  assert.equal(String(snapshotOf(id).accountNumber ?? ""), "");
});

await run("MUST EXCLUDE: the stub provider writes nothing — no LLM is not a blank answer", async () => {
  const id = mkProject({ accountNumber: "" });
  attachBill(id);
  const llm = stubLlm({ accountNumber: { value: "should-not-land", confidence: "high" } }, [], "stub");
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, llm as never, id), []);
});

await run("MUST EXCLUDE: no bill on file means no read and no error", async () => {
  const id = mkProject({ accountNumber: "" });
  const llm = stubLlm({ accountNumber: { value: "no-doc", confidence: "high" } });
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, llm as never, id), []);
});

await run("MUST EXCLUDE: only account/meter are written — not a back door for re-parsing", async () => {
  const id = mkProject({ accountNumber: "", homeownerName: "Real Person" });
  attachBill(id);
  const llm = stubLlm({
    accountNumber: { value: "12345678-002X", confidence: "high" },
    homeownerName: { value: "Someone Else", confidence: "high" },
    systemSizeDcKw: { value: "99", confidence: "high" },
  });
  await fillAccountFieldsFromDocuments(db, llm as never, id);
  const snap = snapshotOf(id);
  assert.equal(snap.accountNumber, "12345678-002X");
  assert.equal(snap.homeownerName, "Real Person", "a photo rewrote the homeowner's name");
  assert.notEqual(String(snap.systemSizeDcKw ?? ""), "99", "a photo rewrote the system size");
});

console.log(failures ? `\nbillVision: ${failures} check(s) FAILED` : "\nbillVision: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
