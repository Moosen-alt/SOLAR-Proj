// READING THE BILL IS NOT GUESSING — BUT IT MUST STAY READING, AND IT MUST ACTUALLY LAND.
//
// The account number is the most common reason a project stops for a human (5 of 19 live
// projects, ~26 interruptions per 100). The read_bill chain step reads it off the customer's
// own bill image with the extractor that already exists.
//
// The first version of these tests passed while the feature could never write a value: they
// seeded parser_json with the literal key "accountNumber" by raw SQL and stubbed the model to
// answer "accountNumber" — the one key neither the real snapshot nor the real prompt uses. The
// snapshot stores the account as "account" (normalize.ts fieldAliases), the vision prompt
// returns "account"/"meter", and the column QC and the portals read is account_number. So in
// production every chain run paid for an Opus vision call and threw the answer away.
//
// These tests therefore use ONLY the real paths: projects via createProject, a stub that
// answers with the real prompt's keys, and assertions on the account_number column and the
// critical.account QC row. Each part of the fix was removed in turn to confirm a test fails.
// Run: npx tsx backend/test/billVision.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bill-vision-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
// Documents go to the temp dir, never the repo's real backend/data/project-documents.
process.env.PROJECT_DOCS_DIR = path.join(dir, "docs");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, updateProject } = await import("../src/repository");
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
/** A project made the way the app makes one — no raw-SQL snapshot patching. */
const mkProject = (extra: Record<string, unknown> = {}): string =>
  createProject(db, {
    clientId: client.id, owner: `Owner ${++n}`, street: `${n} Bill St`, city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "7", acKw: "6",
    ...extra,
  }).project.id;

const columns = (id: string): { account_number: string; meter_number: string; homeowner_name: string } =>
  db.get<{ account_number: string; meter_number: string; homeowner_name: string }>(
    "SELECT account_number, meter_number, homeowner_name FROM projects WHERE id = ?", [id],
  ) ?? { account_number: "", meter_number: "", homeowner_name: "" };
const qcAccount = (id: string): string =>
  db.get<{ qc_status: string }>("SELECT qc_status FROM qc_results WHERE project_id = ? AND rule_id = 'critical.account'", [id])?.qc_status ?? "(none)";

// A 1x1 PNG is enough: the extractor is injected, so what is under test is the plumbing and
// the refusals, not the model's eyesight.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const attachBill = (projectId: string): unknown =>
  saveProjectDocument(db, projectId, { filename: "bill.png", docType: "utility_bill", contentType: "image/png", buffer: PNG_1PX, source: "upload" });

// Dependency injection (the function takes the provider): no module patching, no network.
// The stub COUNTS calls — "did we pay for a vision call" is itself under test.
const stubLlm = (
  fields: Record<string, unknown>,
  lowConfidenceFields: string[] = [],
  provider: "claude" | "stub" = "claude",
): { calls: number; extractProjectFieldsFromImages: () => Promise<unknown> } => {
  const s = {
    calls: 0,
    extractProjectFieldsFromImages: async () => { s.calls++; return { provider, fields, lowConfidenceFields, notes: "" }; },
  };
  return s;
};
// The REAL vision prompt's keys (llm.ts extractProjectFieldsFromImages): "account", "meter",
// plus fields this module must never write ("owner").
const realAnswer = (account: string, meter = "78118886") => ({
  account: { value: account, confidence: 0.95 },
  meter: { value: meter, confidence: 0.95 },
  owner: { value: "Someone Else", confidence: 0.95 },
  street: { value: "999 Elsewhere Rd", confidence: 0.95 },
});

console.log("\n1. THE POINT: an account number on the bill is READ, lands on the column, and QC sees it");
let filledId = "";
await run("MUST PASS: a missing account is filled from the bill via the real key, the column, and QC", async () => {
  const id = (filledId = mkProject());
  assert.equal(columns(id).account_number, "", "precondition: no account on the project");
  assert.equal(qcAccount(id), "fail", "precondition: QC blocks on the missing account");
  attachBill(id);
  const llm = stubLlm(realAnswer("65564191-0014"));
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.equal(llm.calls, 1);
  assert.deepEqual(written, ["accountNumber", "meterNumber"], JSON.stringify(written));
  assert.equal(columns(id).account_number, "65564191-0014", "the account_number column was not written");
  assert.equal(columns(id).meter_number, "78118886", "the meter_number column was not written");
  assert.equal(qcAccount(id), "pass", "QC still blocks on the account after it was read");
});

await run("MUST EXCLUDE: an account the operator saves WHILE the model is reading is not overwritten", async () => {
  // The person types the number off the same bill the chain is reading. Their save lands
  // through the real write path mid-call; the read must yield to it.
  const id = mkProject({ meter: "11112222" });
  attachBill(id);
  let calls = 0;
  const llm = {
    extractProjectFieldsFromImages: async () => {
      calls++;
      updateProject(db, id, { account: "OPERATOR-TYPED-9999" });
      return { provider: "claude", fields: realAnswer("65564191-0014"), lowConfidenceFields: [], notes: "" };
    },
  };
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.equal(calls, 1);
  assert.equal(columns(id).account_number, "OPERATOR-TYPED-9999", `operator's account overwritten (written=${JSON.stringify(written)})`);
  assert.deepEqual(written, [], JSON.stringify(written));
});

await run("the read is audited — which fields and documents, never the value", async () => {
  const rows = db.query<{ details: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action = 'project.fields_read_from_document'", [filledId]);
  assert.equal(rows.length, 1, "expected exactly one bill-vision audit row");
  assert.match(rows[0].details, /accountNumber/);
  assert.match(rows[0].details, /documentIds/);
  assert.ok(!/65564191/.test(rows[0].details), "the account number itself must never be logged");
});

await run("MUST PASS: the canonical id is accepted as a fallback key", async () => {
  const id = mkProject();
  attachBill(id);
  const llm = stubLlm({ accountNumber: { value: "12345678-002X", confidence: 0.9 } });
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, llm as never, id), ["accountNumber"]);
  assert.equal(columns(id).account_number, "12345678-002X");
});

console.log("\n2. WHAT IT MUST REFUSE — 'never guess it' and 'never overwrite' survive intact");
await run("MUST EXCLUDE: an existing account AND meter means ZERO model calls", async () => {
  const id = mkProject({ account: "OPERATOR-TYPED-1234", meter: "11112222" });
  attachBill(id);
  const llm = stubLlm(realAnswer("9999999999", "99999999"));
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.equal(llm.calls, 0, "paid for a vision call on a project that already had both values");
  assert.deepEqual(written, []);
  assert.equal(columns(id).account_number, "OPERATOR-TYPED-1234");
  assert.equal(columns(id).meter_number, "11112222");
});

await run("MUST EXCLUDE: an existing account is never overwritten when only the meter is missing", async () => {
  const id = mkProject({ account: "OPERATOR-TYPED-5678" });
  attachBill(id);
  const llm = stubLlm(realAnswer("9999999999", "78118886"));
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.deepEqual(written, ["meterNumber"], JSON.stringify(written));
  assert.equal(columns(id).account_number, "OPERATOR-TYPED-5678", "a model read overwrote the operator's account number");
  assert.equal(columns(id).meter_number, "78118886");
});

await run("MUST EXCLUDE: an account under the bill-import alias (ubAccountNumber) counts as present", async () => {
  const id = mkProject({ ubAccountNumber: "UB-IMPORTED-42", meter: "11112222" });
  attachBill(id);
  const llm = stubLlm(realAnswer("9999999999"));
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, llm as never, id), []);
  assert.equal(llm.calls, 0);
  assert.equal(columns(id).account_number, "UB-IMPORTED-42");
});

await run("MUST EXCLUDE: a LOW-CONFIDENCE read is left for a human (QC still blocks)", async () => {
  const id = mkProject({ meter: "11112222" });
  attachBill(id);
  const llm = stubLlm(realAnswer("maybe-1234"), ["account"]);
  const written = await fillAccountFieldsFromDocuments(db, llm as never, id);
  assert.deepEqual(written, [], "a doubtful read became a fact on a utility application");
  assert.equal(columns(id).account_number, "");
  assert.equal(qcAccount(id), "fail");
});

await run("MUST EXCLUDE: the same bill is not read again on the next chain run; a new upload is", async () => {
  const id = mkProject({ meter: "11112222" });
  attachBill(id);
  const first = stubLlm(realAnswer("maybe-1234"), ["account"]);
  await fillAccountFieldsFromDocuments(db, first as never, id);
  assert.equal(first.calls, 1);
  const again = stubLlm(realAnswer("65564191-0014"));
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, again as never, id), []);
  assert.equal(again.calls, 0, "re-read the same bill image for the same answer");
  attachBill(id); // a new (clearer) bill arrives
  const fresh = stubLlm(realAnswer("65564191-0014"));
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, fresh as never, id), ["accountNumber"]);
  assert.equal(fresh.calls, 1);
  assert.equal(columns(id).account_number, "65564191-0014");
});

await run("MUST EXCLUDE: the stub provider writes nothing — no LLM is not a blank answer", async () => {
  const id = mkProject();
  attachBill(id);
  const llm = stubLlm(realAnswer("should-not-land"), [], "stub");
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, llm as never, id), []);
  assert.equal(columns(id).account_number, "");
});

await run("MUST EXCLUDE: no bill on file means no read, no call and no error", async () => {
  const id = mkProject();
  const llm = stubLlm(realAnswer("no-doc"));
  assert.deepEqual(await fillAccountFieldsFromDocuments(db, llm as never, id), []);
  assert.equal(llm.calls, 0);
});

await run("MUST EXCLUDE: only account/meter are written — not a back door for re-parsing", async () => {
  const id = mkProject();
  const before = columns(id).homeowner_name;
  attachBill(id);
  const llm = stubLlm({ ...realAnswer("12345678-002X"), dcKw: { value: "99", confidence: 0.99 } });
  await fillAccountFieldsFromDocuments(db, llm as never, id);
  const after = columns(id);
  assert.equal(after.account_number, "12345678-002X");
  assert.equal(after.homeowner_name, before, "a photo rewrote the homeowner's name");
  const dc = db.get<{ system_size_dc_kw: number }>("SELECT system_size_dc_kw FROM projects WHERE id = ?", [id]);
  assert.notEqual(Number(dc?.system_size_dc_kw), 99, "a photo rewrote the system size");
});

console.log(failures ? `\nbillVision: ${failures} check(s) FAILED` : "\nbillVision: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
