// EVERY LIVE-PORTAL LEARN WRITES THE DRAFT LEDGER — AND THE BENCHMARK WRITES IT ONLY ONCE.
//
// Until now only runLearnBenchmark recorded the drafts it left on real portals; the
// API-triggered learn, the self-heal re-learn queue (jobQueue "auto_learn") and the staging
// self-seed all opened the same portals with no record. buildLearnDraftTouch is the entry
// every autoLearnPortal run now records BEFORE the browser opens. This pins:
//   - a normal learn records purpose "auto-learn" with the portal host and the credential's
//     username REFERENCE (never a secret);
//   - PORTAL_REPLAY_SELFTEST says "+selftest (up to 2 drafts)" up front — the self-test
//     replays the live portal and can mint a second draft;
//   - createdBy "learn-benchmark" returns NULL: runLearnBenchmark.ts:226 already wrote its
//     own richer entry, and a second row would double-count every benchmark draft in the
//     ledger operators clean up from;
//   - the account resolution never guesses: host match wins, a single stored login is
//     unambiguous, anything else is honestly empty.
//
// Browser-free, DB-free (the helper is pure). Run: tsx backend/test/learnDraftLedger.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-draft-ledger-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { buildLearnDraftTouch } = await import("../src/autoLearn");

let passed = 0;
const ok = (n: string): void => { passed++; console.log(`ok   ${n}`); };

const CREDS = [
  { portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login", usernameReference: "permit@infinitysolarusa.com" },
  { portalUrl: "https://aca-prod.accela.com/oregon/", usernameReference: "aca-user@infinitysolarusa.com" },
];

// --- a normal learn records, before the browser opens -----------------------------------
{
  const touch = buildLearnDraftTouch({
    portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login?foo=1",
    projectId: "proj-1", createdBy: "operator", selfTestEnabled: false, credentials: CREDS,
  });
  assert.ok(touch, "a plain operator learn must produce a ledger entry");
  assert.equal(touch.purpose, "auto-learn");
  assert.equal(touch.host, "amerenillinoisinterconnect.powerclerk.com");
  assert.equal(touch.account, "permit@infinitysolarusa.com", "the account is the stored username REFERENCE for this host");
  assert.equal(touch.projectId, "proj-1");
  assert.match(touch.note ?? "", /never submitted/);
  ok("an operator learn records purpose auto-learn with host and username reference");
}

// --- the staging self-seed path records too ---------------------------------------------
{
  const touch = buildLearnDraftTouch({
    portalUrl: "https://aca-prod.accela.com/oregon/Default.aspx",
    projectId: "proj-2", createdBy: "auto-seed (staging)", selfTestEnabled: false, credentials: CREDS,
  });
  assert.ok(touch, "the staging self-seed opens a live portal and must record");
  assert.equal(touch.account, "aca-user@infinitysolarusa.com");
  ok("the staging self-seed path records under its own host's credential reference");
}

// --- selftest can mint a SECOND draft, and the purpose says so up front -----------------
{
  const touch = buildLearnDraftTouch({
    portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login",
    projectId: "proj-3", createdBy: "operator", selfTestEnabled: true, credentials: CREDS,
  });
  assert.equal(touch?.purpose, "auto-learn +selftest (up to 2 drafts)",
    "PORTAL_REPLAY_SELFTEST replays the live portal in a fresh session — the ledger must warn of the second draft");
  ok("selftest runs declare 'up to 2 drafts' in the purpose");
}

// --- MUST SKIP: the benchmark already wrote its own entry -------------------------------
{
  const touch = buildLearnDraftTouch({
    portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login",
    projectId: "proj-4", createdBy: "learn-benchmark", selfTestEnabled: false, credentials: CREDS,
  });
  assert.equal(touch, null,
    "runLearnBenchmark.ts:226 records BEFORE autoLearnPortal — a second row here would double-count every benchmark draft");
  ok("createdBy learn-benchmark is the one caller that does not record twice");
}

// --- account resolution: host match wins; one login is unambiguous; else empty ----------
{
  const single = buildLearnDraftTouch({
    portalUrl: "https://portal.nowhere-matched.example/login",
    projectId: "p", createdBy: "operator", selfTestEnabled: false,
    credentials: [CREDS[0]],
  });
  assert.equal(single?.account, "permit@infinitysolarusa.com",
    "a client with exactly ONE stored login makes the draft's account unambiguous even on a host miss");

  const ambiguous = buildLearnDraftTouch({
    portalUrl: "https://portal.nowhere-matched.example/login",
    projectId: "p", createdBy: "operator", selfTestEnabled: false, credentials: CREDS,
  });
  assert.equal(ambiguous?.account, "",
    "two stored logins and no host match must record an EMPTY account, not a guess");

  const none = buildLearnDraftTouch({
    portalUrl: "not a url at all",
    projectId: "p", createdBy: "operator", selfTestEnabled: false, credentials: [],
  });
  assert.ok(none, "an unparseable URL still records — the run still happened");
  assert.equal(none.host, "");
  ok("account: host match wins, a single login stands in, ambiguity records empty — never a guess");
}

// --- secrets-safe shape: nothing beyond the DraftTouch fields, reference only -----------
{
  const touch = buildLearnDraftTouch({
    portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login",
    projectId: "p", createdBy: "operator", selfTestEnabled: false, credentials: CREDS,
  })!;
  const allowed = new Set(["at", "host", "portalUrl", "account", "projectId", "purpose", "bundleDir", "portalReference", "note"]);
  for (const key of Object.keys(touch)) {
    assert.ok(allowed.has(key), `unexpected field "${key}" on a ledger entry — the ledger carries run metadata, never form data`);
  }
  ok("the entry carries only DraftTouch fields — no field values, no secrets by construction");
}

console.log(`\nAll ${passed} learn-draft-ledger checks passed.`);
