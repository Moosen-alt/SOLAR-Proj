// THE KNOWLEDGE-ROW DELETE SCRIPT: a dry run writes nothing, --apply removes the row and its
// children and nothing else, a human-verified row is refused (and --force overrides).
//
// scripts/delete-knowledge-rows.ts (operator ruling 2026-09-26: six junk / false ProjectDox rows
// are deleted). The script is exercised as the OPERATOR runs it — the CLI in its own process, on
// a scratch database opened by the real openDatabase (real schema, foreign_keys ON, the seeded
// reference rows as the "nothing else"). Rows go in through the real writers
// (importSeededAhjKnowledge / saveVerifiedAhjProfile); the child rows the FK tables hold are
// inserted as data against those rows' profile keys.
//
// KILL TESTS (each makes one check red):
//   K1 applyKnowledgeDeletions: delete the parent before the children → (b) throws under FK.
//   K2 planKnowledgeDeletions: drop the verified_at refusal → (c) red.
//   K3 CLI: open the dry run read-write and run apply → (a) sha1 changes.
//   K4 planKnowledgeDeletions: drop the project_count > 0 refusal → (f) red (the skeptic's K6,
//      which survived before (f) existed: the used row is made by the REAL write path —
//      createProject → learnFromProject → knowledge_events.project_id → project_count).
// Run: npx tsx backend/test/deleteKnowledgeRows.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delete-kb-rows-"));
const DB_PATH = path.join(tmp, "t.sqlite");
process.env.AUTOPILOT_DB_PATH = DB_PATH;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const KB = await import("../src/knowledgeBase");
const { createProject } = await import("../src/repository");
const { id: newId } = await import("../src/ids");
const { nowIso } = await import("../src/time");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// Seed: two junk rows (one with every kind of child), one verified row, one bystander.
// ---------------------------------------------------------------------------------------------
const db = await openDatabase();
assert.equal(KB.importSeededAhjKnowledge(db, { state: "ID", ahj: "City of Hillsboro Electronic", sourceLabel: "test", notes: "junk" }), "imported");
assert.equal(KB.importSeededAhjKnowledge(db, { state: "OR", ahj: "1 5 days", sourceLabel: "test", notes: "junk" }), "imported");
assert.equal(KB.importSeededAhjKnowledge(db, { state: "MA", ahj: "City of Waltham", sourceLabel: "test", notes: "bystander" }), "imported");
KB.saveVerifiedAhjProfile(db, { state: "TX", ahj: "City of Verified", notes: "a coordinator checked this", verifiedBy: "test-user" });
// A USED row, through the real write path: a project for that AHJ (no utility, so the key is the
// AHJ-only one) → learnFromProject → a knowledge_events row with project_id → project_count 1.
createProject(db, { owner: "Used Owner", street: "1 Served Way", city: "Boise", state: "ID", zip: "83702", ahj: "City of Used", utility: "", dcKw: "7.0" } as never);

const keyOf = (state: string, ahj: string): string => KB.knowledgeProfileKey({ state, ahj, utility: "" });
const rowByKey = (key: string): { id: string; verified_at: string | null; project_count: number } =>
  db.get<{ id: string; verified_at: string | null; project_count: number }>("SELECT id, verified_at, project_count FROM permit_utility_knowledge WHERE profile_key = ?", [key])!;
const JUNK_A = rowByKey(keyOf("ID", "City of Hillsboro Electronic"));
const JUNK_B = rowByKey(keyOf("OR", "1 5 days"));
const BYSTANDER = rowByKey(keyOf("MA", "City of Waltham"));
const VERIFIED = rowByKey(keyOf("TX", "City of Verified"));
const USED = rowByKey(keyOf("ID", "City of Used"));
assert.ok(JUNK_A?.id && JUNK_B?.id && BYSTANDER?.id && VERIFIED?.id && USED?.id, "seed rows exist");
assert.ok(VERIFIED.verified_at, "the verified row carries verified_at");
assert.ok(Number(USED.project_count) >= 1 && !USED.verified_at, `the used row: project_count ${USED.project_count}, verified_at ${USED.verified_at}`);

// Child rows for JUNK_A in every referencing table (what 46b361e8 carries on production).
const keyA = keyOf("ID", "City of Hillsboro Electronic");
const ts = nowIso();
for (let i = 0; i < 3; i++) {
  db.run("INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at) VALUES (?, ?, NULL, 'test.event', '{}', ?)", [newId(), keyA, ts]);
  db.run(
    `INSERT INTO mbox_learning_records (id, source_signature, source_label, bucket, workflow, profile_key, state, created_at)
     VALUES (?, ?, 'test', 'permit_correction', 'permit', ?, 'ID', ?)`,
    [newId(), `sig-${i}-${newId()}`, keyA, ts],
  );
}
db.run(
  `INSERT INTO historical_failure_examples (id, source_signature, profile_key, project_id, state, sample, created_at)
   VALUES (?, ?, ?, NULL, 'ID', 'Hi [name], please revise', ?)`,
  [newId(), `hfe-${newId()}`, keyA, ts],
);
// A bystander child on the row that must survive.
db.run("INSERT INTO knowledge_events (id, profile_key, project_id, event_type, details, created_at) VALUES (?, ?, NULL, 'test.event', '{}', ?)", [newId(), keyOf("MA", "City of Waltham"), ts]);
db.close();

const TABLES = ["permit_utility_knowledge", "knowledge_events", "historical_project_fingerprints", "historical_failure_examples", "mbox_learning_records"];
const counts = (): Record<string, number> => {
  const ro = new Database(DB_PATH, { readonly: true });
  try {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number((ro.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    for (const t of TABLES.slice(1)) out[`${t}:A`] = Number((ro.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE profile_key = ?`).get(keyA) as { n: number }).n);
    out.rowA = Number((ro.prepare("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE id = ?").get(JUNK_A.id) as { n: number }).n);
    out.rowB = Number((ro.prepare("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE id = ?").get(JUNK_B.id) as { n: number }).n);
    out.bystander = Number((ro.prepare("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE id = ?").get(BYSTANDER.id) as { n: number }).n);
    out.verified = Number((ro.prepare("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE id = ?").get(VERIFIED.id) as { n: number }).n);
    out.used = Number((ro.prepare("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE id = ?").get(USED.id) as { n: number }).n);
    return out;
  } finally { ro.close(); }
};
const sha1 = (): string => crypto.createHash("sha1").update(fs.readFileSync(DB_PATH)).digest("hex");
const backups = (): string[] => fs.readdirSync(tmp).filter((f) => f.endsWith(".backup"));

const SCRIPT = path.join(REPO, "scripts", "delete-knowledge-rows.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, "--db", DB_PATH, ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, AUTOPILOT_DB_PATH: "" } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

const before = counts();
assert.equal(before["knowledge_events:A"], 4, "A's own import event + the 3 inserted");
assert.equal(before["mbox_learning_records:A"], 3);
assert.equal(before["historical_failure_examples:A"], 1);

await check("(a) DRY RUN writes nothing: file sha1 unchanged, no .backup, verdict printed with 8-char ids only", () => {
  const h0 = sha1();
  const r = run("--id", JUNK_A.id, "--id", JUNK_B.id);
  assert.equal(r.code, 0, r.out);
  assert.equal(sha1(), h0, "the dry run changed the database file");
  assert.deepEqual(backups(), [], "the dry run took a backup");
  assert.deepEqual(counts(), before);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, new RegExp(`delete\\s+${JUNK_A.id.slice(0, 8)}\\s`));
  assert.match(r.out, /knowledge_events 4/);
  assert.match(r.out, /2 row\(s\) would be deleted, 0 refused/);
  assert.doesNotMatch(r.out, new RegExp(JUNK_A.id), "the full id was printed");
  assert.doesNotMatch(r.out, /hillsboro/i, "a profile key / name reached the output");
});

await check("(c) a human-verified row is REFUSED, and with it nothing at all is written (atomic)", () => {
  const h0 = sha1();
  const r = run("--id", VERIFIED.id, "--id", JUNK_B.id, "--apply");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /REFUSE\s+\S+.*human-verified/);
  assert.match(r.out, /nothing written/i);
  assert.equal(sha1(), h0, "a refused apply still wrote");
  assert.deepEqual(backups(), [], "a refused apply took a backup");
  assert.deepEqual(counts(), before);
});

await check("(d) an unknown id is refused even under --force", () => {
  const r = run("--id", "00000000-0000-0000-0000-000000000000", "--apply", "--force");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no such knowledge row/);
  assert.deepEqual(counts(), before);
});

await check("(b) --apply removes the two rows + every child of A, takes a .backup first, touches nothing else", () => {
  const r = run("--id", JUNK_A.id, "--id", JUNK_B.id, "--apply");
  assert.equal(r.code, 0, r.out);
  assert.equal(backups().length, 1, "no .backup beside the database");
  const after = counts();
  assert.equal(after.rowA, 0); assert.equal(after.rowB, 0);
  for (const t of TABLES.slice(1)) assert.equal(after[`${t}:A`], 0, `${t} still holds A's children`);
  assert.equal(after.bystander, 1); assert.equal(after.verified, 1);
  assert.equal(after.permit_utility_knowledge, before.permit_utility_knowledge - 2);
  assert.equal(after.knowledge_events, before.knowledge_events - 4 - 1, "A's 4 events + B's own import event");
  assert.equal(after.mbox_learning_records, before.mbox_learning_records - 3);
  assert.equal(after.historical_failure_examples, before.historical_failure_examples - 1);
  assert.equal(after.historical_project_fingerprints, before.historical_project_fingerprints);
  assert.match(r.out, /Written: 2 knowledge row\(s\) deleted/);
  // The backup holds the pre-delete state.
  const bk = new Database(path.join(tmp, backups()[0]), { readonly: true });
  assert.equal(Number((bk.prepare("SELECT COUNT(*) AS n FROM permit_utility_knowledge WHERE id = ?").get(JUNK_A.id) as { n: number }).n), 1, "the backup does not hold the deleted row");
  bk.close();
  // FK integrity after the delete.
  const ro = new Database(DB_PATH, { readonly: true });
  assert.deepEqual(ro.pragma("foreign_key_check"), [], "orphans left behind");
  ro.close();
});

await check("(e) --force deletes the verified row (the operator's explicit override)", () => {
  const r = run("--id", VERIFIED.id, "--apply", "--force");
  assert.equal(r.code, 0, r.out);
  assert.equal(counts().verified, 0);
});

await check("(f) a row that has SERVED a project is refused without --force (exit 2, nothing written) and deleted with it", () => {
  const before = counts();
  const h0 = sha1();
  const refused = run("--id", USED.id, "--apply");
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /REFUSE\s+\S+.*has served 1 project\(s\)/, refused.out);
  assert.match(refused.out, /nothing written/i);
  assert.equal(sha1(), h0, "a refused apply of a used row still wrote");
  assert.deepEqual(counts(), before);
  assert.equal(counts().used, 1);
  const forced = run("--id", USED.id, "--apply", "--force");
  assert.equal(forced.code, 0, forced.out);
  assert.equal(counts().used, 0, "--force did not delete the used row");
});

if (failures) { console.error(`\n${failures} delete-knowledge-rows test(s) failed.`); process.exit(1); }
console.log("\nAll delete-knowledge-rows tests passed.");
