// AN UNREADABLE KNOWLEDGE BASE MUST NEVER RENDER AS "NOTHING IS MISSING".
//
// backend/data/reference-ahj-processes.json holds the 381 seeded AHJ process profiles.
// It is the ONLY place the system knows that City of Coos Bay files SEPARATE building +
// electrical permits, and everything the operator is shown about required documents is
// derived from it:
//
//   loadProfiles -> findAhjProcessProfile -> applicationDocContext -> requiredApplicationDocs
//     -> documentInventory -> pkg.missingDocuments / the submit gate / staging's 409
//
// The loader turned "we could not read it" into "this jurisdiction asks for nothing", twice over:
//
//   CWD-RELATIVE    path.resolve(process.cwd(), "backend/data/...") — any process whose working
//                   directory is not the repo root found nothing.
//   EMPTY SUCCESS   `if (!existsSync(f)) { cache = []; return cache; }` — a missing file cached
//                   as a successful read of zero profiles, with no log and no flag. A malformed
//                   file was worse: JSON.parse threw into callers that all `catch {}`, landing
//                   in the same state by a different road.
//
// Measured against a copy of the live database with the file made unreachable, Christopher Ivy
// (720b05f3, Coos Bay, stalled on Accela "Intake Requirements Needed") lost his ENTIRE blocking
// set — [building_application, electrical_application, solar_checklist] became [] — the packet
// card printed the pass-green "Every required document is attached", and the submit gate fell
// from blocker to warning. Those are the operator's own stated reasons the permit bounced.
//
// What is pinned here:
//
//   A. CWD-INDEPENDENT   — a process started OUTSIDE the repo still loads all 381 profiles and
//      RESOLUTION          still demands Coos Bay's two applications. This is the assertion that
//                          fails on the old CWD-relative loader.
//   B. FAILURE IS        — with the file unreadable, the knowledge status is "unavailable", the
//      REPRESENTABLE       inventory REFUSES (503) instead of returning an empty list, the packet
//                          reports missingDocumentsStatus "unavailable" with a reason (the exact
//                          value frontend/dashboard.js requires before it may render an
//                          all-clear), the packet profile carries an operator-visible warning,
//                          and staging does not pass.
//   C. UNKNOWN AHJ ≠     — with the file READABLE, an AHJ we have no row for demands nothing and
//      FAILED LOOKUP       resolves cleanly. Requirement 3: a legitimately empty demand must not
//                          be dressed up as a failure, or the warning that matters gets scrolled
//                          past. Also proves failure is not cached — the same process recovers.
//
//   npx tsx backend/test/ahjKnowledgeUnavailable.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_REFERENCE = path.join(REPO_ROOT, "backend", "data", "reference-ahj-processes.json");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahj-knowledge-"));
const MISSING_REFERENCE = path.join(tmpDir, "no-such-reference.json");

// SET BEFORE ../src/db IS IMPORTED (openDatabase reads the env, takes no path), and the
// bad reference path is set before the FIRST knowledge read so nothing caches a success.
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.ANTHROPIC_API_KEY = ""; // stub LLM — deterministic, no network research
process.env.AHJ_PROCESS_REFERENCE_PATH = MISSING_REFERENCE;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
// The REAL staging filter and the REAL gate report, imported rather than restated — a copy
// of a filter cannot notice the original drifting.
const {
  createProject,
  getApplicationDocumentPackage,
  getSubmitGateReport,
  prepareSubmission,
  stagingMissingDocuments,
} = await import("../src/repository");
const { applicationDocContext, documentInventory } = await import("../src/requiredDocuments");
const { ahjProcessKnowledgeStatus, findAhjProcessProfile, AHJ_PROCESS_REFERENCE_ENV } = await import("../src/processProfiles");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   - ${label}`); })
    .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const client = createClient(db, { companyName: "Knowledge Gate Solar", ccbLicenseNumber: "553311" });
let n = 0;
/** A real Coos Bay project through the real write path. permitPathOverride is the operator's
 *  own dropdown choice — the strongest permit-path signal — so the fixture does not depend on
 *  parsed structural data it has none of. */
const mkCoosBay = (permitPathOverride: string) => createProject(db, {
  clientId: client.id, owner: `Gate Owner ${++n}`, street: `${n} Bay St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  permitPathOverride,
}).project;
/** A jurisdiction the 381-profile reference has no row for — the LEGITIMATELY empty demand. */
const mkUnknownAhj = () => createProject(db, {
  clientId: client.id, owner: `Unknown Owner ${++n}`, street: `${n} Nowhere Rd`, city: "Pahranagat",
  state: "NV", ahj: "Township of Pahranagat Valley", utility: "NV Energy", dcKw: "6", acKw: "5",
  permitPathOverride: "prescriptive",
}).project;

// Projects are created while the reference is unreadable ON PURPOSE: intake must not itself
// fall over when the knowledge base is missing — only the document VERDICT may refuse.
const coosBay = mkCoosBay("prescriptive");
const unknownAhj = mkUnknownAhj();

// ---------------------------------------------------------------------------
// A. CWD-INDEPENDENT RESOLUTION — in a child process started outside the repo.
//
// This is the actual mechanism of the bug, and it cannot be reproduced in-process: this
// test file runs from the repo root, where the old CWD-relative path happened to work.
// The child gets a working directory in the OS temp dir and NO env override, so the only
// way it can see a profile is module-relative resolution. It asserts the whole demand
// chain, not just the count, because a loader that resolves the file but hands back
// nothing usable is the same failure wearing a number.
// ---------------------------------------------------------------------------
const childScript = path.join(tmpDir, "cwd-child.mts");
fs.writeFileSync(childScript, `
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const REPO = process.argv[2];
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const { ahjProcessKnowledgeStatus, findAhjProcessProfile } = await imp("backend/src/processProfiles.ts") as any;
const { applicationDocContext, requiredApplicationDocs } = await imp("backend/src/requiredDocuments.ts") as any;

const status = ahjProcessKnowledgeStatus();
console.log("EVIDENCE cwd=" + process.cwd());
console.log("EVIDENCE status=" + status.status + " profileCount=" + status.profileCount);
console.log("EVIDENCE loadedFrom=" + status.path);
assert.equal(status.status, "resolved", "a process outside the repo could not read the AHJ reference");
assert.ok(status.profileCount > 300, "expected the full ~381-profile reference, got " + status.profileCount);

// DB-free on purpose: applicationDocContext + requiredApplicationDocs are exactly the pair
// documentInventory threads together, so this is the production demand path, not a copy.
const project = {
  id: "cwd-child", ahj: "City of Coos Bay", city: "Coos Bay", state: "OR",
  utility: "Pacific Power", systemSizeDcKw: 8, systemSizeAcKw: 6.4,
  permitPathOverride: "prescriptive", parserSnapshot: {},
};
assert.ok(findAhjProcessProfile(project), "Coos Bay did not match a profile from a foreign cwd");
const ctx = applicationDocContext(project);
console.log("EVIDENCE knowledgeStatus=" + ctx.knowledgeStatus + " structure=" + ctx.permitStructure);
assert.equal(ctx.knowledgeStatus, "resolved");
assert.equal(ctx.permitStructure, "separate", "Coos Bay's separate-permit structure did not resolve");
const demanded = requiredApplicationDocs(project, ctx).map((d: any) => d.docType).sort();
console.log("EVIDENCE demanded=" + JSON.stringify(demanded));
assert.ok(demanded.includes("building_application"), "no building-side application demanded");
assert.ok(demanded.includes("electrical_application"), "no electrical application demanded");
console.log("EVIDENCE childOk=true");
`, "utf8");

await check("A. a process whose cwd is NOT the repo still loads all 381 profiles and still demands Coos Bay's two applications", () => {
  const childEnv = { ...process.env };
  delete childEnv[AHJ_PROCESS_REFERENCE_ENV]; // no override: module-relative resolution is the only road
  const run = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), childScript, REPO_ROOT],
    { cwd: tmpDir, env: childEnv, encoding: "utf8" },
  );
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  assert.equal(run.status, 0, `child failed (cwd=${tmpDir}):\n${out}`);
  assert.match(out, /EVIDENCE childOk=true/, `child did not complete:\n${out}`);
  assert.match(out, /EVIDENCE demanded=.*building_application/, out);
  assert.match(out, /EVIDENCE demanded=.*electrical_application/, out);
  // The cwd really was foreign — otherwise this check proves nothing about resolution.
  assert.doesNotMatch(out, new RegExp(`EVIDENCE cwd=${REPO_ROOT.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\r?\\n`), out);
});

// ---------------------------------------------------------------------------
// B. AN UNREADABLE REFERENCE IS AN ERROR STATE, NOT AN EMPTY ONE.
// ---------------------------------------------------------------------------
await check("B1. PREMISE: the reference really is unreadable in this process, and the status says so", () => {
  assert.equal(fs.existsSync(MISSING_REFERENCE), false, "the fixture path must not exist");
  const status = ahjProcessKnowledgeStatus();
  assert.equal(status.status, "unavailable");
  assert.equal(status.profileCount, 0);
  assert.equal(status.path, null);
  assert.match(String(status.error), /could not be read/i);
});

await check("B2. applicationDocContext reports LOOKUP-FAILED, not a jurisdiction that happens to ask for nothing", () => {
  const ctx = applicationDocContext(coosBay as never);
  assert.equal(ctx.knowledgeStatus, "unavailable", "the context could not tell a failed lookup from an unknown AHJ");
  assert.match(String(ctx.knowledgeError), /could not be read/i);
  // Coos Bay's flags are genuinely gone — which is exactly why the empty demand below
  // would have been indistinguishable from a clean project.
  assert.equal(ctx.processFlags, undefined);
  assert.equal(findAhjProcessProfile(coosBay as never), null);
});

await check("B3. documentInventory REFUSES rather than returning an empty missingBlocking list", () => {
  assert.throws(
    () => documentInventory(db, coosBay as never),
    (err: unknown) => {
      const e = err as { status?: number; message?: string; details?: Record<string, unknown> };
      assert.equal(e.status, 503, `expected a 503, got ${e.status}`);
      assert.equal(e.details?.ahjKnowledgeUnavailable, true);
      assert.match(String(e.message), /knowledge base is unreadable/i);
      assert.match(String(e.message), new RegExp(AHJ_PROCESS_REFERENCE_ENV));
      return true;
    },
  );
});

await check("B4. the packet says WE DO NOT KNOW — never the pass-green 'every required document is attached'", () => {
  const pkg = getApplicationDocumentPackage(db, coosBay.id);
  // frontend/dashboard.js gates its all-clear on `missingDocumentsStatus === "resolved"`
  // and nothing else; this is that exact predicate, asserted from the backend side.
  assert.notEqual(pkg.missingDocumentsStatus, "resolved", "the packet claimed an authoritative document verdict it does not have");
  assert.equal(pkg.missingDocumentsStatus, "unavailable");
  // ABSENT, not empty: `pkg.missingDocuments || []` downstream must not be handed a list
  // that means "nothing is missing".
  assert.equal(pkg.missingDocuments, undefined, "an empty list here is the lie this exists to stop");
  assert.match(String(pkg.missingDocumentsError), /knowledge base is unreadable/i);
});

await check("B5. the operator sees it on the packet itself — the jurisdiction notes carry the warning", () => {
  const pkg = getApplicationDocumentPackage(db, coosBay.id);
  const notes = pkg.profile.notes || [];
  assert.ok(notes.length, "the packet profile carries no notes at all");
  assert.match(String(notes[0]), /could not be read/i, `no warning note on the packet profile: ${JSON.stringify(notes.slice(0, 2))}`);
  // profile.notes is rendered as "Jurisdiction notes" on the AHJ packet card and reproduced
  // in the generated packet HTML — so this reaches the same screen the wrong list would.
  assert.match(pkg.html, /could not be read/i, "the generated packet HTML does not carry the warning");
});

await check("B6. the authoritative submit-gate report REFUSES instead of reporting the document check as 'pass'", () => {
  // Hunt finding #3: an operator who distrusts the packet card and opens the submit gate
  // for a second opinion used to get the truncated inventory confirmed — the same silence
  // wearing the word "authoritative". It consumes documentInventory directly, so it now
  // refuses with the same cause rather than grading a set it never computed.
  assert.throws(
    () => getSubmitGateReport(db, coosBay.id),
    (err: unknown) => {
      const e = err as { status?: number; message?: string; details?: Record<string, unknown> };
      assert.equal(e.details?.ahjKnowledgeUnavailable, true, `the submit gate failed for a different reason: ${e.message}`);
      assert.equal(e.status, 503);
      return true;
    },
  );
});

await check("B7. staging does NOT pass — the filter prepareSubmission stages through throws, and staging itself refuses", async () => {
  // THE STAGING EXPRESSION ITSELF, NOT A COPY OF IT. This is verbatim what
  // prepareSubmission evaluates (repository.ts: `stagingMissingDocuments(documentInventory(
  // db, detail.project), track)`), and it is unguarded there on purpose — so a throw here
  // is a throw there. An empty result from this expression is what lets a stage proceed.
  assert.throws(
    () => stagingMissingDocuments(documentInventory(db, coosBay as never), "building" as never),
    (err: unknown) => {
      const e = err as { status?: number; details?: Record<string, unknown> };
      assert.equal(e.details?.ahjKnowledgeUnavailable, true);
      assert.equal(e.status, 503);
      return true;
    },
  );
  // And end to end: staging this project does not succeed. The refusal an operator actually
  // hits first is the QC/reviewer gate — this fixture has no documents at all, so it never
  // reaches the document gate. That ordering is the reason the check above pins the
  // expression rather than the route: staging must not pass, and the document gate must be
  // the thing that stops it once the earlier gates are clear.
  await assert.rejects(prepareSubmission(db, coosBay.id, "building" as never), /staging blocked/i);
});

// ---------------------------------------------------------------------------
// C. AN AHJ WE HAVE NO ROW FOR IS NOT A FAILURE — and failure is never cached.
//
// Point the loader back at the real file. This works IN THE SAME PROCESS only because the
// loader caches success and never failure, which is also what lets a restored file recover
// without a restart.
// ---------------------------------------------------------------------------
process.env.AHJ_PROCESS_REFERENCE_PATH = REAL_REFERENCE;

await check("C1. the reference becomes readable again in the same process — failure was never cached", () => {
  const status = ahjProcessKnowledgeStatus();
  assert.equal(status.status, "resolved", "a failed read was cached and the recovery never happened");
  assert.ok(status.profileCount > 300, `expected ~381 profiles, got ${status.profileCount}`);
  assert.equal(status.path, REAL_REFERENCE);
});

await check("C2. an AHJ the reference has no row for demands nothing and resolves CLEANLY — no crying wolf", () => {
  assert.equal(findAhjProcessProfile(unknownAhj as never), null, "fixture AHJ must be one we have no profile for");
  const ctx = applicationDocContext(unknownAhj as never);
  assert.equal(ctx.knowledgeStatus, "resolved", "an unknown AHJ was reported as a failed lookup");
  assert.equal(ctx.knowledgeError, undefined);
  assert.equal(ctx.processFlags, undefined);
  // NO SIGNAL, NO DEMAND — and no throw. This is the legitimately empty case.
  const inv = documentInventory(db, unknownAhj as never);
  assert.deepEqual(
    inv.required.filter((i) => /application|checklist/.test(i.docType)).map((i) => i.docType), [],
    "an AHJ we know nothing about was told to attach applications nobody can name",
  );
  const pkg = getApplicationDocumentPackage(db, unknownAhj.id);
  assert.equal(pkg.missingDocumentsStatus, "resolved", "a clean unknown AHJ must still get an authoritative verdict");
  assert.ok(Array.isArray(pkg.missingDocuments));
  assert.doesNotMatch(String((pkg.profile.notes || [])[0] || ""), /could not be read/i, "warned about a knowledge base that was readable");
});

await check("C3. …while Coos Bay, read from the SAME restored file, is back to demanding its two applications", () => {
  const ctx = applicationDocContext(coosBay as never);
  assert.equal(ctx.knowledgeStatus, "resolved");
  assert.equal(ctx.permitStructure, "separate");
  const blocking = documentInventory(db, coosBay as never).missingBlocking.map((d) => d.docType).sort();
  assert.ok(blocking.includes("building_application"), `no building application demanded: ${JSON.stringify(blocking)}`);
  assert.ok(blocking.includes("electrical_application"), `no electrical application demanded: ${JSON.stringify(blocking)}`);
  // The prescriptive checklist — one of the two documents the real Coos Bay permits bounced for.
  assert.ok(blocking.includes("solar_checklist"), `no prescriptive checklist demanded: ${JSON.stringify(blocking)}`);
});

try { db.close(); } catch { /* best effort */ }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nahjKnowledgeUnavailable: all checks passed."
  : `\nahjKnowledgeUnavailable: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
