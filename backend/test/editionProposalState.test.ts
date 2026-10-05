// WHERE A RECORDED EDITION FINDING STANDS (#182) — codeProfiles.editionProposalState.
//
// A due verify check that repeats a finding reports outcome "already_proposed" plus that finding's
// proposalState ("pending" / "dismissed"). The finding is matched by fingerprint. When it matches
// NONE of the row's recorded proposals the answer is "unknown" and no proposal is named — it used to
// fall back to the row's newest proposal, so a check could report ANOTHER finding as pending or
// dismissed (and by whom). Synthetic state-default row, no network.
//   npx tsx backend/test/editionProposalState.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodeEdition, JurisdictionCodeProfile } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edition-proposal-state-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const blank = (adoptedCodes: CodeEdition[]): JurisdictionCodeProfile => ({
  key: "", state: "ZY", ahj: "", confidence: "seeded", adoptedCodes, amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "",
});
const ROW: CodeEdition[] = [{ family: "fire", code: "IFC", edition: "2018" }, { family: "residential", code: "IRC", edition: "2021" }];
const FOUND_A: CodeEdition[] = [{ family: "fire", code: "IFC", edition: "2024", sourceUrl: "https://codes.example.gov/fire" }];
const FOUND_B: CodeEdition[] = [{ family: "residential", code: "IRC", edition: "2024", sourceUrl: "https://codes.example.gov/res" }];

const verified = CP.saveVerifiedCodeProfile(db, blank(ROW), "Original Verifier");

check("no editions proposal recorded for the row → null", () => {
  assert.equal(CP.editionProposalState(db, verified.key, ROW, FOUND_A), null);
});

const a = CP.proposeEditionUpdate(db, verified, blank(FOUND_A), "research");
assert.ok(a?.isNew, "fixture: finding A was not proposed");

check("the recorded finding itself → pending, named by its fingerprint", () => {
  assert.deepEqual(CP.editionProposalState(db, verified.key, ROW, FOUND_A), { state: "pending", fingerprint: a!.fingerprint });
});
check("a finding that matches no recorded proposal → unknown, naming none (never finding A's pending)", () => {
  const s = CP.editionProposalState(db, verified.key, ROW, FOUND_B);
  assert.deepEqual(s, { state: "unknown" }, JSON.stringify(s));
});

assert.equal(CP.dismissEditionProposal(db, a!.fingerprint, "Pat Synthetic").status, "dismissed");

check("finding A once dismissed → dismissed, by whom", () => {
  const s = CP.editionProposalState(db, verified.key, ROW, FOUND_A);
  assert.equal(s?.state, "dismissed");
  assert.equal(s?.fingerprint, a!.fingerprint);
  assert.equal(s?.dismissedBy, "Pat Synthetic");
});
check("another finding never borrows A's dismissal (or the dismisser's name)", () => {
  const s = CP.editionProposalState(db, verified.key, ROW, FOUND_B);
  assert.deepEqual(s, { state: "unknown" }, JSON.stringify(s));
});

db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures === 0 ? "\neditionProposalState: all checks passed." : `\neditionProposalState: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
