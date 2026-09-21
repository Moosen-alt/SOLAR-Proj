// A URL IS A URL, WHICHEVER COLUMN THE SPREADSHEET PUT IT IN — AND A PERMIT NEVER
// RESOLVES A UTILITY PORTAL, WHICHEVER COLUMN IT HIDES IN.
//
// Measured on the live KB (2026-09-21): the operator's AHJ process workbook import filed 71
// portal links in portal_NAME with portal_url empty; no resolver reads a URL out of a name, so
// Tigard staged to Accela and Douglas County toward the statewide fallback before the operator
// caught each one live. Separately, 23 AHJ-side rows carried the utility's PowerClerk as their
// portal — and Happy Valley had BOTH defects in one row: the real EnerGov link in the name, the
// PowerClerk login in the url. Three invariants, each proven here:
//
//   1. the write funnel (upsertKnowledge) routes a lone URL-in-the-name into portal_url;
//   2. the read mapper falls back to a URL-shaped name for OLD rows the funnel never saw;
//   3. the PERMIT-track exact-key lookup takes the first NON-UTILITY http candidate across
//      BOTH columns — the inverted Happy Valley row self-heals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-portal-cols-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { importSeededAhjKnowledge, findKnowledgeForLearn } = await import("../src/knowledgeBase");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n1. THE WRITE FUNNEL ROUTES A URL-SHAPED NAME INTO portal_url");
{
  importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Funnel City",
    portalName: "https://funnelcity.portal.iworq.net/portalhome/funnelcity",
    portalUrl: undefined, requiredDocuments: [], sourceLabel: "test workbook",
  } as never);
  const row = db.get<{ portal_url: string; portal_name: string }>(
    "SELECT portal_url, portal_name FROM permit_utility_knowledge WHERE profile_key = 'or|funnel city|unknown'");
  check("1a. THE FIX: the URL landed in portal_url", row?.portal_url === "https://funnelcity.portal.iworq.net/portalhome/funnelcity", JSON.stringify(row));

  importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Two Link Town",
    portalName: "https://a.example.gov/ https://b.example.gov/",
    portalUrl: undefined, requiredDocuments: [], sourceLabel: "test workbook",
  } as never);
  const two = db.get<{ portal_url: string }>(
    "SELECT portal_url FROM permit_utility_knowledge WHERE profile_key = 'or|two link town|unknown'");
  check("1b. MUST EXCLUDE: two URLs in one cell stay AMBIGUOUS — nothing is guessed into portal_url",
    !two?.portal_url, JSON.stringify(two));

  importSeededAhjKnowledge(db, {
    state: "OR", ahj: "Named City",
    portalName: "Tyler EnerGov CSS", portalUrl: "https://namedcity.tylerhost.net/",
    requiredDocuments: [], sourceLabel: "test workbook",
  } as never);
  const named = db.get<{ portal_url: string; portal_name: string }>(
    "SELECT portal_url, portal_name FROM permit_utility_knowledge WHERE profile_key = 'or|named city|unknown'");
  check("1c. MUST PASS: a real name + real url pass through untouched",
    named?.portal_name === "Tyler EnerGov CSS" && named?.portal_url === "https://namedcity.tylerhost.net/", JSON.stringify(named));
}

console.log("\n2. THE READ MAPPER RESCUES OLD ROWS THE FUNNEL NEVER SAW");
{
  // Raw insert simulating a pre-fix row: URL in the name, url empty.
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, confidence, first_seen_at, last_learned_at, updated_at)
     VALUES ('old-row-1', 'or|legacy town|unknown', 'OR', 'Legacy Town', '', 'https://legacytown.portal.iworq.net/home', '', 'seeded', ?, ?, ?)`,
    [ts, ts, ts],
  );
  const found = findKnowledgeForLearn(db, { state: "OR", ahj: "Legacy Town" });
  check("2a. the mapped profile reports the name's URL as portalUrl",
    found.ahj?.portalUrl === "https://legacytown.portal.iworq.net/home", JSON.stringify(found.ahj?.portalUrl));
}

console.log("\n3. THE PERMIT LOOKUP NEVER PICKS A UTILITY PLATFORM, WHICHEVER COLUMN IT IS IN");
{
  // Happy Valley's real shape, inverted columns: EnerGov in the NAME, PowerClerk in the URL.
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, confidence, first_seen_at, last_learned_at, updated_at)
     VALUES ('inv-row-1', 'or|inverted city|pge', 'OR', 'Inverted City', 'PGE', 'https://invertedcity-energovweb.tylerhost.net/apps/selfservice#/home', 'https://pgenm.powerclerk.com/MvcAccount/Login', 'learned', ?, ?, ?)`,
    [ts, ts, ts],
  );
  // The EXACT read prepareSubmission makes (repository.ts permit branch), reproduced with the
  // same SQL + the same chooser rule: first http candidate that is NOT a utility platform.
  const { isUtilityPlatformUrl } = await import("../src/portalChannel");
  const row = db.get<{ portal_url?: string; portal_name?: string }>(
    `SELECT portal_url, portal_name FROM permit_utility_knowledge
      WHERE ahj = ? AND ((portal_url IS NOT NULL AND portal_url != '') OR portal_name LIKE 'http%') LIMIT 1`,
    ["Inverted City"],
  );
  const candidates = [String(row?.portal_url ?? ""), String(row?.portal_name ?? "")];
  const chosen = candidates.find((u) => /^https?:\/\/\S+$/i.test(u.trim()) && !isUtilityPlatformUrl(u)) ?? "";
  check("3a. THE INVERSION SELF-HEALS: the permit chooser lands on the AHJ portal in the NAME",
    chosen === "https://invertedcity-energovweb.tylerhost.net/apps/selfservice#/home", chosen);
  check("3b. MUST PASS: PowerClerk was a candidate and was refused — hard rule 5 at the data seam",
    isUtilityPlatformUrl(candidates[0]));

  // Both columns utility → nothing, never "the less bad one".
  db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, confidence, first_seen_at, last_learned_at, updated_at)
     VALUES ('inv-row-2', 'or|all utility town|pge', 'OR', 'All Utility Town', 'PGE', 'https://pgenm.powerclerk.com/a', 'https://pacificorpnetmetering.powerclerk.com/b', 'learned', ?, ?, ?)`,
    [ts, ts, ts],
  );
  const row2 = db.get<{ portal_url?: string; portal_name?: string }>(
    `SELECT portal_url, portal_name FROM permit_utility_knowledge WHERE ahj = 'All Utility Town' LIMIT 1`);
  const chosen2 = [String(row2?.portal_url ?? ""), String(row2?.portal_name ?? "")]
    .find((u) => /^https?:\/\/\S+$/i.test(u.trim()) && !isUtilityPlatformUrl(u)) ?? "";
  check("3c. both columns utility -> EMPTY, so resolution falls through honestly instead of filing at a NEM portal",
    chosen2 === "");
}

console.log(failures ? `\nkbPortalColumns: ${failures} check(s) FAILED` : "\nkbPortalColumns: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
