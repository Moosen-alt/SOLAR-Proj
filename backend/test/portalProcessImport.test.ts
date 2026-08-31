// Unit tests for the Permit-Processes workbook extractor. Browser-free, no DB writes
// (extractPortalRows is pure). Run: tsx backend/test/portalProcessImport.test.ts
import assert from "node:assert/strict";
import { extractPortalRows, stateFromSheetName, type ExtractedPortalRow } from "../src/portalProcessImport";
import type { SheetData } from "../src/xlsxRead";

let failures = 0;
const run = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}: ${(e as Error).message}`); }
};

// Build a sheet the way readXlsx yields it: rows are objects keyed by header/col index.
const sheet = (name: string, rows: string[][]): SheetData => ({
  name,
  headers: [],
  rows: rows.map((cells) => Object.fromEntries(cells.map((c, i) => [`col${i}`, c]))),
});

run("stateFromSheetName handles PROCESS suffixes and named sheets", () => {
  assert.equal(stateFromSheetName("MD PROCESS"), "MD");
  assert.equal(stateFromSheetName("VA-PROCESS"), "VA");
  assert.equal(stateFromSheetName("PA PROCESS NEW"), "PA");
  assert.equal(stateFromSheetName("New Hampshire stuff"), "NH");
});

run("credential row: URL + user + password + security answer all captured", () => {
  const rows = extractPortalRows(sheet("MD PROCESS", [[
    "PRINCE GEORGES COUNTY Momentum online processing REG# 429515 https://momentum.princegeorgescountymd.gov/home",
    "USR NM: permit@infinitysolarusa.com PSWRD: Walmart1! SEC QUESTION(1st CAR = FORD)",
    "ACTIVE",
  ]]));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.state, "MD");
  assert.equal(r.portalUrl, "https://momentum.princegeorgescountymd.gov/home");
  assert.equal(r.platform, "Momentum");
  assert.equal(r.username, "permit@infinitysolarusa.com");
  assert.equal(r.password, "Walmart1!");
  assert.match(r.securityAnswers, /FORD/i);
  assert.equal(r.usernameDefaulted, false);
});

run("SECRETS NEVER LEAK INTO NOTES (notes feed LLM-visible KB)", () => {
  const r = extractPortalRows(sheet("MD PROCESS", [[
    "HOWARD COUNTY https://dilp.howardcountymd.gov/CitizenAccess/Default.aspx",
    "USR NM: permit@infinitysolarusa.com Pswrd: Walmart5! Sec-Q answer: Pizza",
  ]]))[0];
  assert.ok(!/Walmart5!/.test(r.notes), `password leaked into notes: ${r.notes}`);
  assert.ok(!/Pizza/i.test(r.notes), `security answer leaked into notes: ${r.notes}`);
  assert.equal(r.platform, "Accela Citizen Access");
});

run("email-code portal is flagged as MFA (human-capture)", () => {
  const r = extractPortalRows(sheet("VA-PROCESS", [[
    "FREDRICKSBURG CSS SELF PORTAL https://selfservice.fredericksburgva.gov/energov_prod/selfservice#/home",
    "PERMIT@INFINITYSOLARUSA.COM - THEY SEND A CODE",
  ]]))[0];
  assert.equal(r.mfaEmailCode, true);
  assert.equal(r.platform, "Tyler EnerGov (CSS Self Service)");
});

run("jurisdiction derived from structured host uses the SHEET state, never the slug tail", () => {
  const rows = extractPortalRows(sheet("WA PROCESS", [
    ["https://centralia.portal.iworq.net/portalhome/centralia Walmart5!"],           // must NOT become "Central, IA"
    ["https://ci-edgewood-wa.smartgovcommunity.com/Public/Home Walmart5!"],          // -> Edgewood, WA (sheet-state suffix stripped)
  ]));
  const byUrl = (frag: string) => rows.find((r) => r.portalUrl.includes(frag)) as ExtractedPortalRow;
  assert.equal(byUrl("centralia").jurisdiction, "Centralia, WA");  // "ia" is NOT the sheet state → slug kept whole
  assert.equal(byUrl("edgewood").jurisdiction, "Edgewood, WA");
});

run("a slug ending in its OWN state suffix is cleaned only when that matches the sheet", () => {
  // Hialeah lives in the FL sheet → the trailing "fl" is the sheet state and is stripped.
  const r = extractPortalRows(sheet("FL PROCESS", [
    ["https://hialeahfl-energovpub.tylerhost.net/apps/selfservice Walmart5!"],
  ]))[0];
  assert.equal(r.jurisdiction, "Hialeah, FL");
});

run("Accela tenant code comes from the first path segment", () => {
  const r = extractPortalRows(sheet("CA PROCESS", [[
    "https://aca-prod.accela.com/CHINO/Login.aspx", "USRNM: permit@infinitysolarusa.com PSWRD: Walmart5!",
  ]]))[0];
  assert.equal(r.jurisdiction, "Chino, CA");
  assert.equal(r.platform, "Accela Citizen Access");
});

run("the AHJ's own contact address is NEVER stored as our login", () => {
  // A live sweep found credentials saved under building@gainesvillefl.gov and
  // bldg@sterlingheights.gov — the jurisdiction's inbox, which fails to log in and, retried,
  // locks a real account. The operator's own domain must win no matter the cell order.
  const r = extractPortalRows(sheet("FL PROCESS", [[
    "GAINESVILLE https://www4.citizenserve.com/Portal/Login",
    "Contact: building@gainesvillefl.gov",
    "USR NM: permit@infinitysolarusa.com PSWRD: Walmart5!",
  ]]))[0];
  assert.equal(r.username, "permit@infinitysolarusa.com");
});

run("a row whose ONLY email is the jurisdiction's leaves the username to the operator default", () => {
  const r = extractPortalRows(sheet("MI PROCESS", [[
    "STERLING HEIGHTS https://bsaonline.com/Account/LogOn?uid=272 bldg@sterlingheights.gov Walmart5!",
  ]]))[0];
  assert.notEqual(r.username, "bldg@sterlingheights.gov");
  assert.equal(r.username, "permit@infinitysolarusa.com");
  assert.equal(r.usernameDefaulted, true, "and it must be MARKED as a defaulted guess");
});

run("a non-gov operator alias (licensing@) is kept as-is", () => {
  const r = extractPortalRows(sheet("FL PROCESS", [[
    "HIALEAH https://hialeahfl-energovpub.tylerhost.net/apps/selfservice",
    "licensing@infinitysolarusa.com Walmart5!",
  ]]))[0];
  assert.equal(r.username, "licensing@infinitysolarusa.com");
  assert.equal(r.usernameDefaulted, false);
});

run("password with no explicit username defaults to the operator login, and is marked", () => {
  const r = extractPortalRows(sheet("OR PROCESS", [[
    "https://app.govoutreach.com/daytoncityor/public/home", "Walmart5!",
  ]]))[0];
  assert.equal(r.username, "permit@infinitysolarusa.com");
  assert.equal(r.usernameDefaulted, true);
});

run("pure-noise rows (no URL, no password) are dropped", () => {
  const rows = extractPortalRows(sheet("MD PROCESS", [
    ["ELEC CONTRACTOR LICENSE", "# 2705200985", "EXP 05/31/2028"],
    ["500 THAYER CENTER ST", "SUITE-C", "OAKLAND, MD 21550"],
  ]));
  assert.equal(rows.length, 0);
});

run("non-portal URLs (webmail, statute, property search) are not treated as portals", () => {
  const rows = extractPortalRows(sheet("PA PROCESS", [
    ["https://mail.google.com/mail/u/1?ui=2 something"],
    ["https://legislature.maine.gov/statutes/32/title32sec120"],
    ["https://www.miamidadepa.gov/pa/real-estate/property-search"],
  ]));
  assert.equal(rows.length, 0, `expected all filtered, got ${rows.map((r) => r.portalUrl).join(", ")}`);
});

if (failures) { console.error(`\n${failures} portalProcessImport test(s) FAILED.`); process.exit(1); }
console.log("\nAll portalProcessImport tests passed.");
process.exit(0);
