// THE PER-JOB PROCESS LOOKUP RUNS FOR A STATE ISSUER, AND THE CARD SAYS WHOSE ANSWER IT IS (#59).
// A Valencia County project's building + electrical permits are issued by the state Construction
// Industries Division (permitProcess.trackIssuer → source "state_rule", issue #32/#45). The lookup
// was keyed and queued for the AHJ only, so CID's own submission method / portal was never asked,
// and the track card read "Channel: Unknown — verify on the AHJ site" for a permit the AHJ does not
// issue. Now:
//   - the trigger (ensurePermitProcessLookedUp) also queues a lookup keyed on the ISSUER, with the
//     same gates (an existing row, a person-verified row — rule 3 — and the 24 h dedupe);
//   - the card's channel line names the agency the answer was looked up for (the issuer), and its
//     unknown / next-action wording points at the issuer's site, never "the AHJ's";
//   - rule 5: an information page on the issuer's site is never a portal (the one predicate,
//     portalChannel.hostFitsTrackAndEntity, unchanged).
// Albuquerque (a full-service city) is unchanged. Synthetic projects; no network: the model key is a
// placeholder and every queued job is retired synchronously, before enqueueJob's deferred kick.
//   npx tsx backend/test/issuerProcessLookup.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issuer-lookup-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.DOCUMENT_FETCH = "off";
process.env.PORTAL_AUTOMATION = "off";
delete process.env.PERMIT_PROCESS_LOOKUP;
// A synthetic process reference naming neither jurisdiction: no seeded row speaks for either here.
const REFERENCE = path.join(tmp, "reference-ahj-processes.json");
fs.writeFileSync(REFERENCE, JSON.stringify({ profiles: [{
  state: "NM", ahj: "Example Unrelated Town", submissionMethod: "Email", timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false,
  requiresStructuralStamp: false, requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false, requiresJurisdictionCheck: false,
  otherRequirements: "", reviewerNotes: "", sourceSheet: "(test)",
}] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = REFERENCE;

const { openDatabase } = await import("../src/db");
const { getSubmittalTracks } = await import("../src/submittalTracks");
const { ensurePermitProcessLookedUp, acceptPortalForPermit } = await import("../src/permitProcessLookup");
const { savePermitProcessLookup, trackIssuer, getPermitProcessLookup, normalizeAhjName } = await import("../src/permitProcess");
const { hostFitsTrackAndEntity } = await import("../src/portalChannel");
const jobQueue = await import("../src/jobQueue");

const db = await openDatabase();
clearInterval(jobQueue.startJobWorker(db));

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

let seq = 0;
const project = (ahj: string, city: string, snapshot: Record<string, unknown> = {}) => ({
  id: `iss-${++seq}`, clientId: null, homeownerName: "Example Owner", projectAddress: "100 Example Rd", city, state: "NM", zip: "87000", ahj,
  utility: "Example Mesa Electric", systemSizeDcKw: 6, systemSizeAcKw: 5, status: "parsed",
  parserSnapshot: { projectDescriptionText: "Install roof-mounted PV system, 12 modules.", ...snapshot },
}) as never;
const cited = <T>(value: T, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const none = (why = "not found") => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
const permit = (discipline: string, label: string, portalUrl: ReturnType<typeof cited<string>> | ReturnType<typeof none>) => ({
  discipline, label, issuingAgency: none(), portalUrl, recordType: none(), documents: none(), fee: none(),
});
const CID = "New Mexico Construction Industries Division (CID)";
const CID_RE = /New Mexico Construction Industries Division \(CID\)/;
// Synthetic stand-ins: the state's Salesforce site (allowlisted tenant) and an information page.
const CID_PORTAL = "https://nmrld.my.site.com/s/";
const CID_INFO = "https://www.rld.nm.gov/construction-industries/resources/";
const CID_PDF = "https://www.rld.nm.gov/construction-industries/permit-application.pdf";

const card = (p: never, type: string) => getSubmittalTracks(db, p).find((t) => t.type === type)!;
const queuedFor = (ahj: string): number =>
  db.query<{ id: string }>("SELECT id FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ?", [`%"ahj":${JSON.stringify(ahj)}%`]).length;
// Runs the trigger, then — synchronously, before the enqueue kick's macrotask — retires the jobs.
const trigger = async (p: never): Promise<boolean> => {
  const queued = await ensurePermitProcessLookedUp(db, p);
  db.run("UPDATE job_queue SET status = 'failed' WHERE job_type = 'permit_process_lookup' AND status IN ('pending','running')");
  return queued;
};

const valencia = project("Valencia County", "Los Lunas");
const abq = project("Albuquerque", "Albuquerque");

console.log("\nthe card names the issuer");
await check("(c0) precondition: CID issues Valencia County's building + electrical permits (state rule)", () => {
  for (const t of ["building", "electrical"]) {
    const i = trackIssuer(valencia, t);
    assert.equal(i.source, "state_rule");
    assert.equal(i.name, CID);
  }
});
await check("(c1) MUST-PASS: with nothing looked up yet, the CID track's channel says verify on CID's site — never 'the AHJ site'", () => {
  for (const t of ["building", "electrical"]) {
    const c = card(valencia, t);
    assert.equal(c.channelBasis, "unknown", c.channel);
    assert.match(c.channel, CID_RE, `${t}: ${c.channel}`);
    assert.doesNotMatch(c.channel, /\bAHJ\b/, `${t}: ${c.channel}`);
    // The zoning prerequisite IS the AHJ's own step (Valencia County first); the filing after it is CID's.
    const filing = c.nextAction.split("THEN:").pop() ?? "";
    assert.doesNotMatch(filing, /\bAHJ\b/, `${t}: ${c.nextAction}`);
    assert.match(filing, CID_RE, `${t}: ${c.nextAction}`);
  }
});
await check("(c2) MUST-PASS: CID's own looked-up portal reaches the card, labelled as the lookup FOR CID", () => {
  const saved = savePermitProcessLookup(db, {
    state: "NM", ahj: CID, lookedUpAt: new Date().toISOString(), issuingAgency: cited(CID, "https://www.rld.nm.gov/construction-industries/", "Construction Industries Division"),
    permitStructure: none(),
    permits: [
      permit("structural", "Building permit", cited(CID_PORTAL, "https://www.rld.nm.gov/construction-industries/", "Apply for a permit online at nmrld.my.site.com")),
      permit("electrical", "Electrical permit", cited(CID_PORTAL, "https://www.rld.nm.gov/construction-industries/", "Apply for a permit online at nmrld.my.site.com")),
    ],
  } as never);
  assert.equal(saved.lookup?.confidence, "seeded", "a lookup lands seeded (rule 3)");
  for (const t of ["building", "electrical"]) {
    const c = card(valencia, t);
    assert.equal(c.channelBasis, "cited", c.channel);
    assert.ok(c.channel.includes(CID_PORTAL), c.channel);
    assert.match(c.channel, new RegExp(`per-job lookup for ${CID_RE.source}`), `${t}: ${c.channel}`);
    assert.equal(c.issuer?.source, "state_rule");
  }
});
await check("(c3) MUST-EXCLUDE (rule 5): an information page / document on CID's site is never the card's portal", () => {
  for (const u of [CID_INFO, CID_PDF]) {
    assert.equal(hostFitsTrackAndEntity("building", null, u, "research").fits, false, u);
    assert.equal(acceptPortalForPermit(cited(u, u, "Apply for a permit online"), "process part", { seenUrls: [u] }).code, "rule5", u);
    savePermitProcessLookup(db, {
      state: "NM", ahj: CID, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(),
      permits: [permit("structural", "Building permit", cited(u, u, "Apply for a permit online")), permit("electrical", "Electrical permit", cited(u, u, "Apply for a permit online"))],
    } as never);
    for (const t of ["building", "electrical"]) {
      const c = card(valencia, t);
      assert.ok(!c.channel.includes(u), `${t}: ${c.channel}`);
      assert.notEqual(c.recipePortalUrl, u);
      assert.match(c.channel, CID_RE, `${t}: ${c.channel}`);
    }
  }
});
await check("(c4) Albuquerque (the city issues): unchanged — no CID, the AHJ's own wording", () => {
  for (const t of ["building", "electrical", "combo", "permit"]) {
    const c = card(abq, t);
    if (!c) continue;
    assert.doesNotMatch(c.channel, /Construction Industries|CID/, c.channel);
    assert.equal(c.issuer?.source, "project");
    if (c.channelBasis === "unknown") assert.equal(c.channel, "Unknown — verify on the AHJ site");
  }
});

console.log("\nthe trigger asks about the issuer");
db.run("DELETE FROM permit_process_lookups");
getPermitProcessLookup(db, "NM", CID); // refresh the registry for the deleted key
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
try {
  await check("(t1) MUST-PASS: a Valencia County project queues the lookup for CID, the issuer, beside the AHJ's own", async () => {
    const q = await trigger(valencia);
    assert.equal(q, true);
    assert.equal(queuedFor(CID), 1, `CID rows: ${queuedFor(CID)}`);
    assert.equal(queuedFor("Valencia County"), 1);
    const payload = JSON.parse(db.get<{ payload: string }>("SELECT payload FROM job_queue WHERE payload LIKE ?", [`%"ahj":${JSON.stringify(CID)}%`])!.payload);
    assert.equal(payload.state, "NM");
    assert.equal(payload.lookupKey, `nm|${normalizeAhjName(CID)}`);
  });
  await check("(t2) MUST-EXCLUDE: one lookup per issuer — a second project served by CID within 24 h queues no second CID lookup", async () => {
    db.run("UPDATE job_queue SET status = 'done' WHERE job_type = 'permit_process_lookup'");
    await trigger(project("Village of Los Lunas", "Los Lunas"));
    assert.equal(queuedFor(CID), 1);
  });
  await check("(t3) MUST-EXCLUDE (rule 3): a person-verified CID row is never re-asked", async () => {
    db.run("DELETE FROM job_queue WHERE job_type = 'permit_process_lookup'");
    savePermitProcessLookup(db, { state: "NM", ahj: CID, permits: [], lookedUpAt: new Date().toISOString(), confidence: "verified" } as never, { verifiedBy: "reviewer@example.test" });
    await trigger(valencia);
    assert.equal(queuedFor(CID), 0);
    assert.equal(getPermitProcessLookup(db, "NM", CID)?.confidence, "verified");
  });
  await check("(t4) Albuquerque: only the city is looked up — never CID", async () => {
    db.run("DELETE FROM job_queue WHERE job_type = 'permit_process_lookup'");
    db.run("DELETE FROM permit_process_lookups");
    getPermitProcessLookup(db, "NM", CID);
    await trigger(abq);
    assert.equal(queuedFor(CID), 0);
    assert.equal(queuedFor("Albuquerque"), 1);
  });
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  db.run("UPDATE job_queue SET status = 'failed' WHERE status IN ('pending','running')");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
