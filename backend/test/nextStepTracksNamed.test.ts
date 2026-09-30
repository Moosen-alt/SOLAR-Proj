// THE NEXT STEP NAMES WHAT IS NOT STAGED YET, AND EACH TRACK BY ITS OWN ISSUER (dry run 2026-09-28, B13).
//
// (1) After only the building permit was staged, the answer was "The building permit application is
//     staged … Approve & Submit" — the electrical permit and the interconnection appeared nowhere, not
//     even in `why`. Rule 10 (a staged draft) outranks rule 14 (ready to stage) on purpose, so it must
//     name what is left itself.
// (2) With three drafts the headline merged them: "the building permit, electrical permit and
//     interconnection (NEM) application is staged on the PacifiCorp and City of Coos Bay portal".
//     Every permit track was named as the AHJ's (a second answer to "who issues this track"); the one
//     predicate is applicationDocsAgency.formAuthorityFor.
//
// Pinned:
//   a THE POINT     — building staged, electrical + NEM not: both named, and the first why points at
//                     the track cards.
//   b PER TRACK     — each draft named with its own issuer; the verbs agree with the count; the note
//                     that Approve & Submit acts on the newest draft only.
//   c MUST-EXCLUDE  — nothing left to stage -> no "not staged" text; one draft keeps the one-draft
//                     wording (the utility named — nextStep.test's /PGE/).
//   d THE REAL FACTS — loadNextStepFacts names a county-issued electrical permit as the county's, from
//                     a per-job lookup saved through the real writer; a job with no lookup keeps the AHJ.
//
// KILLS (verified by hand): rule 10 without notStaged -> a FAILS; agencyOf ignoring TrackFacts.agency
// -> b, d' FAIL; loadNextStepFacts not setting agency -> d FAILS.
//
//   npx tsx backend/test/nextStepTracksNamed.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "next-step-tracks-named-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(dir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, getProjectDetail } = await import("../src/repository");
const { decideNextStep, loadNextStepFacts } = await import("../src/nextStep");
const pp = await import("../src/permitProcess");
type NextStepFacts = import("../src/nextStep").NextStepFacts;
type TrackFacts = import("../src/nextStep").TrackFacts;
type RunLite = import("../src/nextStep").RunLite;

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

let seq = 0;
const run = (startedAt = "2026-09-28T10:00:00.000Z"): RunLite => ({ id: `run-${seq++}`, status: "awaiting_human_submit", permitType: "x", startedAt, errorMessage: "", pauseReason: null });
const track = (t: TrackFacts["track"], over: Partial<TrackFacts> = {}): TrackFacts => ({
  track: t, filed: false, filedAt: null, done: false, latestRun: null, onPortal: false, stagedRun: null, gapFillMissing: [], feeDue: false, paymentDue: false, ...over,
});
const staged = (t: TrackFacts["track"], agency: string, startedAt?: string) => {
  const r = run(startedAt);
  return track(t, { stagedRun: r, latestRun: r, onPortal: true, agency });
};
const facts = (tracks: TrackFacts[], over: Partial<NextStepFacts> = {}): NextStepFacts => ({
  projectId: "p1", status: "awaiting_human_submit", stageDetail: "", archived: false, ahj: "City of Testport", utility: "Test Power",
  operatorHold: null, openCorrections: [], jobInFlight: null, tracks, reopenPause: null,
  qcRan: true, qcFails: [], qcReview: [], portalReadings: 0, approvedRunIds: [],
  gate: { decision: "ready_to_stage", blockers: [] }, reviewerBlockers: [], ...over,
});

console.log("\na. ONE DRAFT STAGED, TWO TRACKS NOT: BOTH ARE NAMED");
{
  const step = decideNextStep(facts([staged("building", "City of Testport"), track("electrical", { agency: "Test County" }), track("nem", { agency: "Test Power" })]));
  check("a1. still the staged draft's step (rule 10 outranks rule 14), with its Approve button",
    step.key === "staged_awaiting_submit" && step.button?.id === "approveSubmitBtn", `${step.key} ${step.button?.id}`);
  check("a2. THE POINT: the headline names the electrical permit and the interconnection as not staged yet",
    /electrical permit and interconnection \(NEM\) are not staged yet/.test(step.headline), step.headline);
  check("a3. and the FIRST why points at the track cards (make() keeps three)",
    step.why[0]?.fixTarget === "submittalTracks" && /Test County/.test(step.why[0]?.text ?? "") && /Test Power/.test(step.why[0]?.text ?? ""),
    JSON.stringify(step.why[0]));
}

console.log("\nb. THREE DRAFTS: EACH WITH ITS OWN ISSUER");
{
  const step = decideNextStep(facts([
    staged("building", "City of Testport", "2026-09-28T10:00:00.000Z"),
    staged("electrical", "Test County", "2026-09-28T11:00:00.000Z"),
    staged("nem", "Test Power", "2026-09-28T12:00:00.000Z"),
  ]));
  check("b1. THE POINT: each track is named with its own issuer — the county's electrical permit is the county's",
    /the building permit \(City of Testport\), electrical permit \(Test County\) and interconnection \(NEM\) with Test Power/.test(step.headline), step.headline);
  check("b2. MUST-EXCLUDE: no merged 'application is staged on the A and B portal'",
    !/application is staged on the .+ and .+ portal/.test(step.headline) && /review each on its own portal/.test(step.headline), step.headline);
  check("b3. Approve & Submit is said to act on the newest draft only (the interconnection)",
    step.why.some((w) => /newest draft only — the interconnection/.test(w.text)), JSON.stringify(step.why.map((w) => w.text)));
  check("b4. MUST-EXCLUDE: nothing left to stage -> no 'not staged' text", !/not staged/i.test(step.headline + step.why.map((w) => w.text).join(" ")));
}

console.log("\nc. ONE DRAFT, NOTHING ELSE LEFT");
{
  const step = decideNextStep(facts([staged("nem", "PGE"), track("combo", { filed: true })], { utility: "PGE" }));
  check("c1. MUST-PASS: the one-draft wording names the utility and asks for its review",
    /^The interconnection \(NEM\) with PGE application is staged on its portal — review it, approve, then click its submit yourself\.$/.test(step.headline), step.headline);
  check("c2. no 'not staged' why and no newest-draft note with one draft",
    !step.why.some((w) => /Not staged yet|newest draft/.test(w.text)), JSON.stringify(step.why.map((w) => w.text)));
  const b = staged("building", "City of Testport");
  const filedLater = decideNextStep(facts([b, track("electrical", { agency: "Test County" })], { approvedRunIds: [b.stagedRun!.id] }));
  check("c3. approved-awaiting-filing names the issuer and still names what is not staged",
    filedLater.key === "approved_awaiting_filing" && /building permit \(City of Testport\) application is NOT filed yet/.test(filedLater.headline)
      && /electrical permit is not staged yet/.test(filedLater.headline), filedLater.headline);
}

console.log("\nd. THE REAL FACTS: A COUNTY-ISSUED ELECTRICAL PERMIT IS THE COUNTY'S");
{
  const cite = (value: string, quote: string) => ({ value, sourceUrl: "https://testport.example.gov/permits", quote, origin: "lookup" as const });
  const none = () => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" });
  const permit = (discipline: "structural" | "electrical", agency: string) => ({
    discipline, label: `${discipline} permit`, issuingAgency: cite(agency, `${agency} issues ${discipline} permits`),
    portalUrl: none(), recordType: none(), documents: none(), fee: none(),
  });
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Testport", lookedUpAt: new Date().toISOString(),
    issuingAgency: cite("City of Testport", "The City of Testport issues building permits"),
    permitStructure: { value: "separate", sourceUrl: "https://testport.example.gov/permits", quote: "a separate electrical permit", origin: "lookup" },
    permits: [permit("structural", "City of Testport"), permit("electrical", "Test County")],
  } as never) as { saved: boolean; reason?: string };
  check("setup: the per-job lookup saved through the real writer", saved.saved, String(saved.reason ?? ""));
  const client = createClient(db, { companyName: "Named Tracks Solar", ccbLicenseNumber: "112266" });
  const p = createProject(db, { clientId: client.id, owner: "Named Owner 1", street: "1 Named St", city: "Testport", state: "OR", ahj: "City of Testport", utility: "Test Power", dcKw: "8", acKw: "6.4" }).project;
  const f = loadNextStepFacts(db, [getProjectDetail(db, p.id).project]).get(p.id)!;
  const by = (t: string) => f.tracks.find((x) => x.track === t)?.agency;
  check("d1. THE POINT: the electrical track's issuer is the county the lookup cites",
    by("electrical") === "Test County", JSON.stringify(f.tracks.map((t) => [t.track, t.agency])));
  check("d2. the building track stays the city's; the NEM track is the utility's",
    by("building") === "City of Testport" && by("nem") === "Test Power", JSON.stringify(f.tracks.map((t) => [t.track, t.agency])));
  const q = createProject(db, { clientId: client.id, owner: "Named Owner 2", street: "2 Named St", city: "Otherton", state: "OR", ahj: "City of Otherton", utility: "Test Power", dcKw: "8", acKw: "6.4" }).project;
  const g = loadNextStepFacts(db, [getProjectDetail(db, q.id).project]).get(q.id)!;
  check("d3. MUST-EXCLUDE: a job with no lookup names its AHJ for every permit track (no invented county)",
    g.tracks.filter((t) => t.track !== "nem").every((t) => t.agency === "City of Otherton"), JSON.stringify(g.tracks.map((t) => [t.track, t.agency])));
}

console.log(failures ? `\nnextStepTracksNamed: ${failures} check(s) FAILED` : "\nnextStepTracksNamed: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
