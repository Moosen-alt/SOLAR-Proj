// LEAK-FIX (forms, documents, KB) — the DB-free half. Each section pins one confirmed sweep finding
// (.probe/leak-sweep/RESULT.json) with a MUST-PASS and a MUST-EXCLUDE, so a fix that over-corrects
// fails as loudly as one that regresses. Synthetic values only: no real licence number, supervisor
// name, login handle or password appears here.
//
//   npx tsx backend/test/leakFixForms.test.ts
import "./_isolate"; // FIRST: temp cwd, reference data reachable
import assert from "node:assert/strict";

delete process.env.ANTHROPIC_API_KEY;

const { matchingForms } = await import("../src/ahjForms");

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// F1 — the built-in City of Portland (OR) electrical application belongs to Portland, OREGON.
// ---------------------------------------------------------------------------------------------
const PORTLAND_FORM = "portland-electrical-renewable-energy";
const ids = (p: { ahj: string; state: string }) => matchingForms(p).map((d) => d.id);

await check("F1 MUST-PASS: Portland, OR still gets its own electrical application (OR, Oregon, bare 'Portland')", () => {
  assert.deepEqual(ids({ ahj: "City of Portland", state: "OR" }), [PORTLAND_FORM]);
  assert.deepEqual(ids({ ahj: "City of Portland", state: "Oregon" }), [PORTLAND_FORM]);
  assert.deepEqual(ids({ ahj: "Portland", state: "or" }), [PORTLAND_FORM]);
});

await check("F1 MUST-EXCLUDE: South Portland ME, Portland ME / TX / CT never get Portland, Oregon's form", () => {
  for (const p of [
    { ahj: "City of South Portland", state: "ME" },
    { ahj: "City of Portland", state: "ME" },
    { ahj: "Portland", state: "TX" },
    { ahj: "Town of Portland", state: "CT" },
    { ahj: "City of Portland", state: "Maine" },
  ]) assert.deepEqual(ids(p), [], `${p.ahj}, ${p.state} matched ${ids(p).join(",")}`);
});

await check("F1 MUST-EXCLUDE: a blank or unrecognised state is UNKNOWN, never Oregon", () => {
  assert.deepEqual(ids({ ahj: "City of Portland", state: "" }), []);
  assert.deepEqual(ids({ ahj: "City of Portland", state: "OR 97201" }), []);
});

await check("F1 MUST-EXCLUDE: a county or a name that only CONTAINS the word is not the city (whole words, same kind)", () => {
  assert.deepEqual(ids({ ahj: "Portlandia County", state: "OR" }), []);
  assert.deepEqual(ids({ ahj: "Multnomah County", state: "OR" }), []);
});

// ---------------------------------------------------------------------------------------------
// F8 — shared KB notes never hand one company's logins / licence numbers to another's planner.
// (The write guard's own MUST-REFUSE / MUST-KEEP lists live in kbCredentialNote.test.ts.)
// ---------------------------------------------------------------------------------------------
const { learnSafeNotes, isCompanyLoginSegment, looksLikeCredentialNote } = await import("../src/knowledgeBase");
const { extractPortalRows } = await import("../src/portalProcessImport");

await check("F8 MUST-EXCLUDE: credential, login and 'credential stored' segments never reach a planner; licence numbers are replaced", () => {
  const notes = [
    "Portal is Accela; pick Residential - Electrical",
    "Operator credential stored for this portal.",
    "Username: someone@acme-solar.test PW: «pw»",
    "User name someone@acme-solar.test",
    "Acmehandle & Xy9!abcdefgh",
    "Acmehandle & someone@acme-solar.test",
    "Structural to the city; metro license # 98765 on the application",
    "CCB# 555444 required on the cover",
  ].join(" | ");
  const safe = learnSafeNotes(notes);
  for (const leak of ["credential stored", "someone@acme-solar.test", "«pw»", "Xy9!abcdefgh", "98765", "555444"]) {
    assert.ok(!safe.includes(leak), `"${leak}" reached the planner: ${safe}`);
  }
});

await check("F8 MUST-PASS: the knowledge around them survives — portal hints, agency contacts, what licence the AHJ asks for", () => {
  const notes = [
    "Portal is Accela; pick Residential - Electrical",
    "Corrections come from plans@city.test",
    "Only the entry URL and the login differ per AHJ",
    "Entry: https://city.example.test/Login/Index/",
    "Structural to the city; metro license # 98765 on the application",
  ].join(" | ");
  const safe = learnSafeNotes(notes);
  assert.match(safe, /Portal is Accela/);
  assert.match(safe, /plans@city\.test/);
  assert.match(safe, /login differ per AHJ/);
  assert.match(safe, /Login\/Index/);
  assert.match(safe, /metro license # \[the job's company's own number\] on the application/);
  assert.ok(!isCompanyLoginSegment("Corrections come from plans@city.test"));
  assert.ok(!looksLikeCredentialNote("Solar & Battery-Storage"));
});

await check("F8 importer: a '<handle> & <password>' cell never lands in a shared note, whatever the password looks like", () => {
  const sheet = { name: "OH PROCESS", headers: [], rows: [[
    "CITY OF TESTVILLE https://aca-prod.accela.com/TESTVILLE/Default.aspx",
    "Acmehandle & Qz7#abcdefg",
    "Building + electrical on one Accela record",
    "LICENSE # 24680 on file with the city",
  ]].map((cells) => Object.fromEntries(cells.map((c, i) => [`col${i}`, c]))) };
  const rows = extractPortalRows(sheet as never);
  assert.equal(rows.length, 1);
  const notes = rows[0].notes;
  assert.ok(!/Qz7#abcdefg|Acmehandle/.test(notes), `the credential cell reached the shared note: ${notes}`);
  assert.ok(!/24680/.test(notes), `a company licence number reached the shared note: ${notes}`);
  assert.match(notes, /one Accela record/, "the useful cell must survive");
});

// ---------------------------------------------------------------------------------------------
// F4 — "is this Oregon" is usStateCode(project.state) === "OR", nothing else. A town named Oregon is
// not Oregon, a blank state is unknown, and Accela outside Oregon is not "Oregon ePermitting".
// ---------------------------------------------------------------------------------------------
const { findApplicationProfile, describePermitType } = await import("../src/applicationDocs");
const job = (state: string, ahj: string, city = "") =>
  ({ id: "p", state, ahj, city, zip: "", utility: "", parserSnapshot: {}, systemSizeDcKw: 7 }) as never;

await check("F4 MUST-EXCLUDE: a town named Oregon (WI / IL / OH / MO) never gets Oregon's portal-only profile", () => {
  for (const [st, ahj] of [["WI", "Village of Oregon"], ["IL", "City of Oregon"], ["OH", "City of Oregon"], ["MO", "City of Oregon"]]) {
    const p = findApplicationProfile(job(st, ahj, "Oregon"));
    assert.notEqual(p.id, "oregon-generic-epermitting", `${ahj}, ${st} got Oregon's generic ePermitting profile`);
    assert.equal(p.requiresPortalEntryOnly, false, `${ahj}, ${st}: portal-only would skip form acquisition`);
    assert.ok(!/oregon/i.test(`${p.portalName} ${p.submissionMethod ?? ""}`), `${ahj}, ${st}: ${p.portalName}`);
  }
});

await check("F4 MUST-EXCLUDE: a BLANK state is unknown — Salem / Washington County / Portland pick up no Oregon profile", () => {
  for (const ahj of ["City of Salem", "Washington County", "City of Portland"]) {
    const p = findApplicationProfile(job("", ahj));
    assert.ok(!["salem-pac-solar-array", "washington-county-bdas", "portland-devhub-solar", "oregon-generic-epermitting"].includes(p.id), `${ahj} with no state got ${p.id}`);
    assert.equal(p.requiresPortalEntryOnly, false);
  }
});

await check("F4 MUST-PASS: Oregon projects keep their Oregon profiles (OR and 'Oregon' spellings)", () => {
  assert.equal(findApplicationProfile(job("OR", "City of Salem")).id, "salem-pac-solar-array");
  assert.equal(findApplicationProfile(job("Oregon", "City of Salem")).id, "salem-pac-solar-array");
  assert.equal(findApplicationProfile(job("OR", "City of Nowheresville Test")).id, "oregon-generic-epermitting");
  assert.equal(findApplicationProfile(job("OR", "Junction City")).portalName, "Oregon ePermitting (Accela)");
});

await check("F4 MUST-EXCLUDE: Accela outside Oregon is named neutrally (seeded Tampa / Sacramento / Hollywood)", () => {
  for (const [st, ahj] of [["FL", "City of Tampa"], ["CA", "City of Sacramento"], ["FL", "City of Hollywood"]]) {
    const p = findApplicationProfile(job(st, ahj));
    const label = describePermitType(p).submissionMethod;
    assert.ok(!/oregon/i.test(`${p.portalName} ${label}`), `${ahj}, ${st}: ${p.portalName} / ${label}`);
    // portal-truth D4: a seeded method carrying the AHJ's own ACA tenant URL (Sacramento's
    // aca-prod.accela.com/SACRAMENTO, Hollywood's …/hollywood) is labelled by that host as the AHJ's
    // own portal; words alone (Tampa) stay neutral. Never Oregon's label either way.
    assert.ok(["Accela Citizen Access (online portal)", `Accela Citizen Access (${ahj}'s own portal)`].includes(label), `${ahj}, ${st}: ${label}`);
  }
});

await check("F4: an in-person clause in the seeded method is the channel (Bernalillo County, NM), not 'Oregon ePermitting'", () => {
  const p = findApplicationProfile(job("NM", "Bernalillo County"));
  assert.match(p.portalName, /In person/i);
  assert.ok(!/oregon/i.test(p.portalName));
});

await check("F4: a learned 'Accela' platform outside Oregon is not Oregon ePermitting (describePermitType)", () => {
  const unknown = findApplicationProfile(job("GA", "City of Marietta Test"));
  assert.equal(describePermitType(unknown, { portalPlatform: "Accela" }).submissionMethod, "Accela Citizen Access (online portal)");
});

const { inferMboxState, inferMboxPortal } = await import("../src/knowledgeBase");
await check("F4 mbox learner MUST-EXCLUDE: a place name is not a state; e-permitting outside Oregon is not Oregon's", () => {
  assert.equal(inferMboxState("Village of Oregon building department: permit issued", "Village of Oregon", ""), "");
  assert.equal(inferMboxState("South Portland Maine permit office", "City of South Portland", ""), "");
  assert.equal(inferMboxState("Salem building permit ready", "City of Salem", ""), "");
  assert.equal(inferMboxPortal("submit through the e-permitting portal", "WA"), "Online e-permitting portal");
  assert.equal(inferMboxPortal("see you after the vacation", ""), "", "a bare 'aca' inside a word is not Accela");
});
await check("F4 mbox learner MUST-PASS: the state named in a state position, and Oregon's ePermitting in Oregon", () => {
  assert.equal(inferMboxState("Permit office, Salem, Oregon 97301", "City of Salem", ""), "OR");
  assert.equal(inferMboxState("City of Tigard, OR permit issued", "City of Tigard", ""), "OR");
  assert.equal(inferMboxPortal("upload on ePermitting", "OR"), "Oregon ePermitting");
  assert.equal(inferMboxPortal("Accela Citizen Access record", "FL"), "Accela");
});

// ---------------------------------------------------------------------------------------------
// F7 — the packet never renders the pass-green all-clear over an application set nobody knows.
// The REAL documentVerdictHtml, lifted from dashboard.js with the esc/plural it closes over.
// ---------------------------------------------------------------------------------------------
const fs = await import("node:fs");
const path = await import("node:path");
const { REPO } = await import("./_isolate");
const verdict = ((): (pkg: unknown) => string => {
  const src = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
  const cut = (name: string) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} is gone from dashboard.js`);
    let depth = 0;
    const i = src.indexOf("{", at);
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error(`unbalanced braces reading ${name}`);
  };
  return new Function(`${[cut("esc"), cut("plural"), cut("documentVerdictHtml")].join("\n\n")}\nreturn documentVerdictHtml;`)() as (pkg: unknown) => string;
})();
const ALL_CLEAR = "Every required document is on file";
const UNKNOWN = "Which permit application(s) City of Nowhere Test requires is not known — nothing here has checked.";

await check("F7 MUST-EXCLUDE: nothing known about the AHJ's applications -> no all-clear, an 'is not known' row, no pass-green doc row", () => {
  const html = verdict({ missingFields: [], missingDocumentsStatus: "resolved", missingDocuments: [], applicationSetUnknown: UNKNOWN });
  assert.ok(!html.includes(ALL_CLEAR), "the all-clear printed over an unanswered question");
  assert.match(html, /is not known/);
  assert.match(html, /kx-docstate is-unknown/);
  assert.ok(html.includes("City of Nowhere Test"), "the row names the AHJ (the inventory's own sentence)");
});

await check("F7: with documents missing too, the unknown row is shown beside them", () => {
  const html = verdict({ missingFields: [], missingDocumentsStatus: "resolved", missingDocuments: [{ docType: "sld", label: "SLD", why: "x" }], applicationSetUnknown: UNKNOWN });
  assert.match(html, /NOT in the packet/);
  assert.match(html, /is not known/);
});

await check("F7 MUST-PASS: a known, complete AHJ still gets the all-clear", () => {
  const html = verdict({ missingFields: [], missingDocumentsStatus: "resolved", missingDocuments: [] });
  assert.ok(html.includes(ALL_CLEAR));
  assert.doesNotMatch(html, /is not known/);
});

// ---------------------------------------------------------------------------------------------
// F3 — a form's prescriptive boxes answer against THE JURISDICTION's limits; outside Oregon a row
// with no published limit is blank ([verify]), never Oregon's 70 psf / 1 roof layer.
// ---------------------------------------------------------------------------------------------
const { resolveSource } = await import("../src/ahjForms");
const { prescriptiveCriterionCatalog } = await import("../src/permitPath");
const presc = (state: string, snap: Record<string, unknown>, limits: Record<string, unknown> = {}) => {
  const ctx = { project: { state, parserSnapshot: snap }, client: {}, snapshot: snap, prescriptiveLimits: limits, prescriptiveJurisdictionOnly: state !== "OR" } as never;
  return (name: string) => resolveSource(`computed.${name}`, ctx);
};
const SNAP = { mounting: "Roof Mount", lightFrame: "yes", riskCategory: "II", snow: 65, wind: "C", windSpeed: 110, roofRafterSpacing: 24, deadLoad: 3, moduleHeightAboveRoof: 6, roofLayers: 2 };

await check("F3 MUST-EXCLUDE: a Utah form never attests compliance against Oregon's limits (no limits on file -> every box blank)", () => {
  const r = presc("UT", SNAP);
  for (const n of ["prescSnowLoadYes", "prescSnowLoadNo", "prescRoofLayersNo", "prescModuleHeightYes", "prescAllYes", "prescAllNo", "prescAllAnswer"]) {
    assert.equal(r(n), "", `${n} answered "${r(n)}" against Oregon's limits`);
  }
  assert.equal(r("prescRoofMountYes"), "X", "a criterion that needs no limit (roof-mounted) still answers");
});

await check("F3 MUST-PASS: Oregon keeps its limits; a non-OR jurisdiction's OWN published limit is used", () => {
  const or = presc("OR", SNAP);
  assert.equal(or("prescSnowLoadYes"), "X");
  assert.equal(or("prescRoofLayersNo"), "X");
  assert.equal(or("prescAllNo"), "X");
  const ut = presc("UT", SNAP, { maxGroundSnowPsf: 60 });
  assert.equal(ut("prescSnowLoadNo"), "X", "its own 60 psf limit answers No at 65 psf");
});

await check("F3: the mapper's prescriptive source labels carry no Oregon numbers", () => {
  const labels = prescriptiveCriterionCatalog().map((c) => c.label);
  assert.ok(labels.length >= 10);
  assert.deepEqual(labels.filter((l) => /\d/.test(l)), [], JSON.stringify(labels));
});

console.log(`\nleakFixForms: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
