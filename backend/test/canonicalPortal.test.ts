// canonicalPortal — the platform stored in the SHARED knowledge base comes from the model's
// structured answer and the portal URL, never from a regex over its free-text notes.
// New-AHJ e2e test (2026-09-26): notes that DENIED ProjectDox stored ProjectDox for Iowa City,
// Waltham, Northern Cambria, Corry and Venus; any Accela host read as "Oregon ePermitting".
//
// KILL TESTS (verified red by hand): notes back into the matched text -> (c1) fails;
// any accela -> "Oregon ePermitting" -> (c2) fails.
//
// Run: npx tsx backend/test/canonicalPortal.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canon-portal-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
const { canonicalPortal } = await import("../src/ahjFormAuto");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const r = (o: Record<string, unknown>) => ({ provider: "claude", formName: "", candidateUrls: [], formType: "", confidence: "medium", notes: "", ...o }) as never;

await check("(c1) MUST-EXCLUDE: a note that mentions or denies a platform never becomes the stored platform", () => {
  const ia = canonicalPortal(r({ portalPlatform: "Tyler EnerGov", submissionMethod: "online portal", submittalPortalUrl: "https://egov.iowa-city.org/energovprod/selfservice#/home",
    notes: "ProjectDox is STALE - the city replaced it with EnerGov Citizen Self Service." }));
  assert.equal(ia.platform, "Tyler EnerGov");
  const waltham = canonicalPortal(r({ portalPlatform: "None", submissionMethod: "in-person drop-off", notes: "No Accela/ePermitting/ProjectDox portal applies here; email questions to the building department." }));
  assert.notEqual(waltham.platform, "ProjectDox");
  assert.notEqual(waltham.platform, "Oregon ePermitting");
  assert.notEqual(waltham.platform, "Email");
  const portalWithEmailNote = canonicalPortal(r({ portalPlatform: "Other", submissionMethod: "online portal", submittalPortalUrl: "https://permits.example-city.gov/apply", notes: "Questions: email permits@example-city.gov" }));
  assert.equal(portalWithEmailNote.method, "online portal");
});
await check("(c2) MUST-EXCLUDE: Accela outside Oregon's own instance is never 'Oregon ePermitting'", () => {
  assert.equal(canonicalPortal(r({ portalPlatform: "Accela", submittalPortalUrl: "https://aca-prod.accela.com/LEECO/Default.aspx" })).platform, "Accela Citizen Access");
  assert.equal(canonicalPortal(r({ portalPlatform: "Accela Citizen Access", submissionMethod: "online portal" })).platform, "Accela Citizen Access");
});
await check("(c3) MUST-PASS: real platforms still classify — ProjectDox by label or host, Oregon ePermitting, email-only", () => {
  assert.equal(canonicalPortal(r({ portalPlatform: "ProjectDox" })).platform, "ProjectDox");
  assert.equal(canonicalPortal(r({ submittalPortalUrl: "https://hillsboro-or-us-projectdoxwebui.avolvecloud.com/User/Index" })).platform, "ProjectDox");
  assert.equal(canonicalPortal(r({ submittalPortalUrl: "https://aca-oregon.accela.com/oregon/" })).platform, "Oregon ePermitting");
  assert.equal(canonicalPortal(r({ portalPlatform: "Oregon ePermitting" })).platform, "Oregon ePermitting");
  const email = canonicalPortal(r({ submissionMethod: "email" }));
  assert.deepEqual(email, { platform: "Email", method: "email" });
});

if (failures) { console.error(`\n${failures} canonicalPortal test(s) failed.`); process.exit(1); }
console.log("\nAll canonicalPortal tests passed.");
process.exit(0);
