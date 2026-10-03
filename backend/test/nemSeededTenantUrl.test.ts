// ISSUE #54 — the NEM card kept "PowerClerk — tenant URL unconfirmed" from an old research row in
// utility_filing_lookups while #36's SEEDED utility-wide KB row (NM / PNM) held the PowerClerk login,
// and never consulted it; "an answered row is never looked up again" made it permanent.
// Pins (hard rule 5 — the one predicate, hostFitsTrackAndEntity with `namedPlatform`; rule 3):
//   (a) lookup = PowerClerk / no URL + the seeded PNM row → the card shows the tenant login, seeded;
//   (b) …with a person-VERIFIED KB row → tagged verified;
//   (c) MUST-EXCLUDE: the KB URL is the utility's info page (off PowerClerk's domain) → still
//       "tenant URL unconfirmed", never the info page; a permit portal in the KB row → never (rule 5);
//   (d) precedence: verified KB beats a seeded lookup URL; a seeded lookup URL beats seeded KB; a
//       person's verified lookup URL is never displaced;
//   (e) retry rule: a named platform with no URL is INCOMPLETE (re-looked-up when stale), a verified
//       row never is, and a re-run that finds less keeps the cited answer it had;
//   (f) reads write nothing: the KB rows are untouched by the card.
// Synthetic utilities everywhere except the seeded PNM row (its login URL is public). No network.
//
// KILL TESTS (each run red by hand before the fix):
//   K1 utilityTrackPresentation reads only utility_filing_lookups      → (a), (b), (d) fail.
//   K2 the KB URL judged without namedPlatform                         → (c) fails.
//   K3 the retry rule counts only empty rows                           → (e) fails.
//
// Run: npx tsx backend/test/nemSeededTenantUrl.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("nem-seeded-tenant-url");
const { db } = fx;
const ufl = await import("../src/utilityFilingLookup");
const { knowledgeProfileKey } = await import("../src/knowledgeBase");

const STATE = "NM";
const PNM_LOGIN = "https://pnminterconnect.powerclerk.com/MvcAccount/Login";
const PNM_INFO = "https://www.pnm.com/customer-solar-program1";

/** A research row: the platform named, no URL (acceptFilingUrl dropped the info page). */
const saveLookup = (utility: string, filing: { name: string; url: string | null }, opts: { verifiedBy?: string; lookedUpAt?: string; program?: boolean } = {}) =>
  ufl.saveUtilityFilingLookup(db, {
    state: STATE, utility,
    filing: { value: filing, sourceUrl: `https://www.${utility.toLowerCase().replace(/\W+/g, "")}.test/solar`, quote: `Apply through our ${filing.name}.`, origin: "lookup" },
    program: opts.program
      ? { value: "net_metering", sourceUrl: "https://www.example.test/nem", quote: "Net metering is available.", origin: "lookup" }
      : { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "n/a" },
    ...(opts.program ? { programName: "Customer Solar Program" } : {}),
    lookedUpAt: opts.lookedUpAt ?? new Date().toISOString(),
    ...(opts.verifiedBy ? { confidence: "verified" as const } : {}),
  }, opts.verifiedBy ? { verifiedBy: opts.verifiedBy } : {});
let kbN = 0;
const kbRow = (utility: string, portalUrl: string, opts: { platform?: string; name?: string; verified?: boolean } = {}) => {
  const key = knowledgeProfileKey({ state: STATE, utility });
  db.run(`INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, portal_platform, confidence, notes, sources_json, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
          VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', '[]', datetime('now'), datetime('now'), datetime('now'), ?, ?)`,
  [`kb-54-${++kbN}`, key, STATE, utility, opts.name ?? "", portalUrl, opts.platform ?? "", opts.verified ? "verified" : "seeded",
    opts.verified ? new Date().toISOString() : null, opts.verified ? "operator@example.test" : ""]);
  return key;
};
const card = (utility: string) => ufl.utilityTrackPresentation(db, { state: STATE, utility });

// ── (a) the owner's run: PNM ──────────────────────────────────────────────────────────────
await check("(a) MUST-PASS: PNM lookup = PowerClerk / no URL + the seeded PNM row → the tenant login, tagged seeded", () => {
  saveLookup("PNM", { name: "PNM Interconnect PowerClerk online application portal", url: null });
  const c = card("PNM");
  assert.equal(c.portalUrl, PNM_LOGIN, c.channel);
  assert.ok(c.channel.includes(PNM_LOGIN), c.channel);
  assert.match(c.channel, /seeded knowledge base — verify/, c.channel);
  assert.match(c.channel, /pnm\.com\/customer-solar-program1/, "the card names its source");
  assert.doesNotMatch(c.channel, /tenant URL unconfirmed/);
  assert.equal(c.basis, "profile");
});

// ── (b) a person's verified KB row ────────────────────────────────────────────────────────
const MESQ_LOGIN = "https://mesquiteinterconnect.powerclerk.com/MvcAccount/Login"; // synthetic tenant
await check("(b) MUST-PASS: lookup = PowerClerk / no URL + a VERIFIED KB row → the login, tagged verified", () => {
  saveLookup("Mesquite Electric", { name: "PowerClerk", url: null });
  kbRow("Mesquite Electric", MESQ_LOGIN, { platform: "PowerClerk", verified: true });
  const c = card("Mesquite Electric");
  assert.equal(c.portalUrl, MESQ_LOGIN);
  assert.match(c.channel, /\(verified by a person\)/, c.channel);
  assert.equal(c.basis, "verified");
});

// ── (c) rule 5: the one predicate judges the KB URL ───────────────────────────────────────
await check("(c1) MUST-EXCLUDE: the KB URL is the utility's info page → still \"tenant URL unconfirmed\", never the info page", () => {
  saveLookup("Cholla Electric", { name: "PowerClerk", url: null });
  kbRow("Cholla Electric", "https://www.cholla-electric.test/customer-solar-program1");
  const c = card("Cholla Electric");
  assert.equal(c.portalUrl, "");
  assert.match(c.channel, /^PowerClerk — tenant URL unconfirmed, verify/, c.channel);
  assert.doesNotMatch(c.channel, /cholla-electric\.test\/customer-solar/);
});
await check("(c2) MUST-EXCLUDE: the PNM info page itself, as a seeded KB URL, is never the PowerClerk channel", () => {
  saveLookup("Pinon Power", { name: "Pinon Interconnect PowerClerk portal", url: null });
  kbRow("Pinon Power", PNM_INFO.replace("pnm.com", "pinon-power.test"), { platform: "PowerClerk" });
  assert.equal(card("Pinon Power").portalUrl, "");
});
await check("(c3) MUST-EXCLUDE: a permit portal in the utility's seeded KB row never reaches the NEM card (rule 5)", () => {
  saveLookup("Yucca Electric", { name: "PowerClerk", url: null });
  kbRow("Yucca Electric", "https://aca-prod.accela.com/YUCCA/Default.aspx");
  const c = card("Yucca Electric");
  assert.equal(c.portalUrl, "");
  assert.doesNotMatch(c.channel, /accela/i);
});

// ── (d) precedence ────────────────────────────────────────────────────────────────────────
const JUN_LOOKUP = "https://juniperinterconnect.powerclerk.com/MvcAccount/Login";
const JUN_KB = "https://juniper-apply.powerclerk.com/MvcAccount/Login";
await check("(d1) a seeded lookup URL beats a seeded KB URL", () => {
  saveLookup("Juniper Coop", { name: "PowerClerk", url: JUN_LOOKUP });
  kbRow("Juniper Coop", JUN_KB, { platform: "PowerClerk" });
  const c = card("Juniper Coop");
  assert.equal(c.portalUrl, JUN_LOOKUP);
  assert.equal(c.basis, "cited");
});
await check("(d2) a VERIFIED KB URL beats a seeded lookup URL", () => {
  saveLookup("Sage Coop", { name: "PowerClerk", url: JUN_LOOKUP.replace("juniper", "sage") });
  kbRow("Sage Coop", JUN_KB.replace("juniper", "sage"), { platform: "PowerClerk", verified: true });
  const c = card("Sage Coop");
  assert.equal(c.portalUrl, JUN_KB.replace("juniper", "sage"));
  assert.equal(c.basis, "verified");
});
await check("(d3) a person's VERIFIED lookup is never displaced by a seeded KB row (rule 3)", () => {
  saveLookup("Mesa Coop", { name: "PowerClerk", url: JUN_LOOKUP.replace("juniper", "mesa") }, { verifiedBy: "operator@example.test" });
  kbRow("Mesa Coop", JUN_KB.replace("juniper", "mesa"), { platform: "PowerClerk" });
  assert.equal(card("Mesa Coop").portalUrl, JUN_LOOKUP.replace("juniper", "mesa"));
  saveLookup("Arroyo Coop", { name: "PowerClerk", url: null }, { verifiedBy: "operator@example.test" });
  kbRow("Arroyo Coop", JUN_KB.replace("juniper", "arroyo"), { platform: "PowerClerk" });
  assert.equal(card("Arroyo Coop").portalUrl, "", "a seeded KB URL does not fill a person's verified answer");
});

// ── (e) the retry rule ────────────────────────────────────────────────────────────────────
const STALE = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
await check("(e1) a named platform with no URL is INCOMPLETE; a URL or a non-platform method is complete", () => {
  assert.equal(ufl.isIncompleteFilingLookup(ufl.getUtilityFilingLookup(db, STATE, "Cholla Electric")), true);
  assert.equal(ufl.isIncompleteFilingLookup(ufl.getUtilityFilingLookup(db, STATE, "Juniper Coop")), false);
  saveLookup("Email Coop", { name: "email to interconnection@email-coop.test", url: null });
  assert.equal(ufl.isIncompleteFilingLookup(ufl.getUtilityFilingLookup(db, STATE, "Email Coop")), false);
});
await check("(e2) a STALE PowerClerk/no-URL row is looked up again (forced); a verified one never is; a re-run that finds less keeps the cited answer", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy";
  try {
    let calls = 0;
    const llm = { webLookup: async () => { calls++; return { text: JSON.stringify({ filing: { value: null, notFound: "nothing" }, program: { value: null } }), groundedSearches: 1, stopReason: null, resultUrls: [], pagesRead: 0, fetchedUrls: [] }; } };
    saveLookup("Stale Coop", { name: "PowerClerk", url: null }, { lookedUpAt: STALE, program: true });
    assert.equal(ufl.ensureUtilityFilingLookedUp(db, { state: STATE, utility: "Stale Coop", city: "" } as never, llm as never), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 1);
    const after = ufl.getUtilityFilingLookup(db, STATE, "Stale Coop")!;
    assert.equal(after.filing.value?.name, "PowerClerk", "the cited filing is kept");
    assert.equal(after.program.value, "net_metering", "the cited program is kept");
    assert.ok(Date.parse(after.lookedUpAt) > Date.parse(STALE), "the row is re-stamped, so it is not searched daily");
    saveLookup("Stale Verified Coop", { name: "PowerClerk", url: null }, { lookedUpAt: STALE, verifiedBy: "operator@example.test" });
    assert.equal(ufl.ensureUtilityFilingLookedUp(db, { state: STATE, utility: "Stale Verified Coop", city: "" } as never, llm as never), false);
    assert.equal(calls, 1);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

// ── (f) reads write nothing ───────────────────────────────────────────────────────────────
await check("(f) the card writes nothing: the seeded PNM row stays seeded, unverified", () => {
  const before = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE state = 'NM' AND ahj = '' AND utility = 'PNM'");
  card("PNM");
  const after = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE state = 'NM' AND ahj = '' AND utility = 'PNM'");
  assert.deepEqual(after, before);
  assert.equal(after?.confidence, "seeded");
  assert.equal(after?.verified_at ?? null, null);
});

finish("NEM card falls through to the utility's KB tenant URL (#54)");
