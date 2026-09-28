// A PASSWORD TYPED INTO A SHARED TABLE REACHES EVERY TENANT, AND THEN THE MODEL.
//
// Found 2026-09-12 while auditing the onboarding guide's §6 ("Portal passwords are stored only in
// encrypted form and are never displayed, printed or passed to a language model"). The audit
// decrypted the credential store and hunted the plaintext across 36,000 files and 8 GB of
// artifacts. Four permit_utility_knowledge rows carried a real stored secret in their notes, and
// the guard below then found FOUR MORE the hunt structurally could not — credentials the encrypted
// store no longer holds, so there was no known string to search for:
//
//     "Sec- Q: <security answer>"                         md|aaco md
//     "permit@<company>.com Walmart<secret>"              wa|wa portal
//     "permit@<company>.com Pass: <secret> LUP-…@…"       or|multnomahcounty or
//     "Logon: <company> Pass: <secret>"                   wa|shoreline wa
//
// permit_utility_knowledge is one of the tables CLAUDE.md shares across tenants ON PURPOSE, so
// every one was readable by every customer. And the notes are not inert: knowledgeResearchHint
// puts up to 700 characters of them into the knownContext handed to llm.findAhjFormUrl
// (ahjFormAuto.ts), and autoLearn's KB block puts up to 900 into the learner prompt. So these went
// to a language model — against §6 and against CLAUDE.md's hard rule 2.
//
// All eight rows were redacted. This pins the guard that stops it recurring, at the ONE place
// every writer's notes pass through (noteSegments — imports, research, human patches and the
// learner all route through it), so no caller has to remember.
//
//   MUST REFUSE  — every shape the real rows took, plus the obvious siblings.
//   MUST KEEP    — real portal knowledge, including notes that legitimately contain an email
//                  address or a question-and-answer. A guard that eats knowledge is worse than
//                  the leak it prevents, because it is silent and nobody re-types a lost note.
//
//   npx tsx backend/test/kbCredentialNote.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-credential-note-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { looksLikeCredentialNote, importSeededAhjKnowledge, findKnowledgeForLearn } = await import("../src/knowledgeBase");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The real wordings, with same-shaped stand-ins for the secrets. Never a real password.
const MUST_REFUSE = [
  "Sec- Q: bluex",
  "permit@infinitysolarusa.com WalmartXy9quz",
  "permit@infinitysolarusa.com Pass: SillyGoat2 LUP-submittals@multco.us",
  "Logon: TML INTERNATIONAL LLC Pass: Abc123def",
  "Password: hunter2xyz",
  "password = Zx9quuxA",
  "login pass: abc12345",
  "PIN: 4471",
  "passcode: 99812",
  "mfa seed: JBSWY3DPEHPK3PXP",
  "Security Answer: Denver7",
  // Leak sweep company-leak-5 (2026-09-28): a shared row carried "<Handle> & <password>" with no
  // label and no email. Synthetic stand-ins of the same shape (never the real value).
  "Acmehandle & Xy9!abcdefgh",
  "SolarCoLogin & Qz7#mmmmmm",
  "Accela login: AcmeSolar & Rt5$uvwxyz",
  "AcmeSolar Ab12cdEfgh",
  "acme_user Zz9yyYYyyy",
];

// Real notes from the knowledge base's own vocabulary. Each of these is the kind of thing an
// operator writes and would never re-type if it vanished.
const MUST_KEEP = [
  "Portal requires the AC disconnect make and model on page 3.",
  "Fee: $160.00 for 5.01-15 kVA (county schedule eff. 1/1/26)",
  "Contact permits@cityofx.gov for corrections",
  "Corrections come from LUP-submittals@multco.us regarding incomplete submittals",
  "Security screening is not required for residential rooftop PV",
  "Q: which permit category does rooftop PV file under? A: Residential - Electrical",
  "Emailed code at login goes to permits@shared.test",
  "Solar Permit (when required) - Prescriptive Path System, fee includes plan review | $200.00",
  "Renewable energy for electrical systems- 5.01kva through 15kva",
  "Submit an Application/Request starts the filing; record type Residential - Electrical",
  // The two new whole-segment shapes must not eat the notes that look closest to them.
  "$283.00 (5-15kVA)",
  "999.99 (1-25kW)",
  "Structural & electrical in one submission",
  "BLD & ELE",
  "Plans & specs",
  "Solar & Battery-Storage",
  "R-3 & U-occupancy",
  "Model IQ8Plus-72",
  "Fee 5kVA-15kVA",
  "Section R324.6",
];

check("MUST REFUSE: every shape the leaked rows actually took", () => {
  const missed = MUST_REFUSE.filter((s) => !looksLikeCredentialNote(s));
  assert.deepEqual(missed, [], `these would still reach a shared table and a model: ${JSON.stringify(missed)}`);
});

check("MUST KEEP: real portal knowledge, including emails and Q&A phrasing", () => {
  const eaten = MUST_KEEP.filter((s) => looksLikeCredentialNote(s));
  assert.deepEqual(eaten, [], `the guard would silently eat real knowledge: ${JSON.stringify(eaten)}`);
});

check("the guard runs at the WRITE boundary, so a credential never lands at all", () => {
  // Through the real import path, not by calling the predicate — the whole point is that no
  // caller has to remember. A useful segment alongside the credential must survive.
  importSeededAhjKnowledge(db, {
    state: "WA", ahj: "Guard Test City",
    notes: "Portal is Cloudpermit and wants the SLD as a separate upload | permit@example.test SecretPw9 | Corrections arrive from plans@guardtest.gov",
  } as never);
  const stored = findKnowledgeForLearn(db, { state: "WA", ahj: "Guard Test City" }).ahj;
  assert.ok(stored, "the row itself must still be written — the guard drops a segment, not the knowledge");
  const notes = String(stored!.notes || "");
  assert.doesNotMatch(notes, /SecretPw9/, `the credential was stored anyway: ${notes}`);
  assert.match(notes, /Cloudpermit/, `the useful segment before it was lost: ${notes}`);
  assert.match(notes, /plans@guardtest\.gov/, `the useful segment after it was lost: ${notes}`);
});

check("MUST EXCLUDE: the dropped segment is never written to the log either", () => {
  // Moving a secret out of the database and into a log file is the same mistake one layer along,
  // so the warning records a length and nothing else. Asserted against the source, because a log
  // assertion would need the secret in hand to look for it.
  // Scoped to the logger CALL, not a fixed slice of following characters — a 200-char window
  // ran on into `kept.push(seg)` below it and failed on code that has nothing to do with logging.
  const src = fs.readFileSync(path.join(process.cwd(), "backend", "src", "knowledgeBase.ts"), "utf8");
  const call = src.split("\n").find((l) => l.includes("refused a knowledge note")) ?? "";
  assert.ok(call, "the refusal is not logged — a silently dropped note is indistinguishable from one nobody wrote");
  assert.doesNotMatch(call, /\bseg\b(?!\.length)/, `the refusal log carries the segment itself: ${call}`);
  assert.match(call, /chars:/, `the refusal should record a shape rather than nothing: ${call}`);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nkbCredentialNote: all checks passed."
  : `\nkbCredentialNote: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
