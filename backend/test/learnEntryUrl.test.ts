// THE URL A STAGE MAY LEARN ON (portalChannel.learnEntryUrl). Operator 2026-09-27: "if a supervised
// run is needed it should just start when I click Stage". City of Jefferson had no KB portal URL,
// no recipe and a refused borrow; the cited statewide portal (Oregon ePermitting) was not on the
// entry list, so Stage reported "no portal automation" instead of opening the learner.
import assert from "node:assert/strict";
import { learnEntryUrl } from "../src/portalChannel";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const OR = "https://aca-oregon.accela.com/oregon/";

check("MUST-PASS: a permit track with nothing but the cited statewide portal learns on it (Jefferson)", () => {
  assert.equal(learnEntryUrl({ track: "building", statewideUrl: OR }), OR);
  assert.equal(learnEntryUrl({ track: "electrical", ahjUrl: "", statewideUrl: OR }), OR);
});
check("MUST-EXCLUDE: a NEM track never learns on the statewide PERMIT portal", () => {
  assert.equal(learnEntryUrl({ track: "nem", statewideUrl: OR }), "");
  assert.equal(learnEntryUrl({ track: "nem", ahjUrl: "https://permits.example.gov/", statewideUrl: OR }), "");
});
check("the trust order holds: learned profile > recipe > draft > the track's own KB portal > statewide", () => {
  assert.equal(learnEntryUrl({ track: "building", learnedProfileUrl: "https://a/", recipeUrl: "https://b/", statewideUrl: OR }), "https://a/");
  assert.equal(learnEntryUrl({ track: "building", recipeUrl: "https://b/", draftUrl: "https://c/", statewideUrl: OR }), "https://b/");
  assert.equal(learnEntryUrl({ track: "building", draftUrl: "https://c/", ahjUrl: "https://d/", statewideUrl: OR }), "https://c/");
  assert.equal(learnEntryUrl({ track: "building", ahjUrl: "https://d/", statewideUrl: OR }), "https://d/");
  assert.equal(learnEntryUrl({ track: "nem", utilityUrl: "https://u.powerclerk.com/", ahjUrl: "https://d/" }), "https://u.powerclerk.com/");
});
check("nothing known -> no entry (Stage still says so, never an info page)", () => {
  assert.equal(learnEntryUrl({ track: "building" }), "");
  assert.equal(learnEntryUrl({ track: "building", statewideUrl: "  " }), "");
});
if (failures) { console.error(`learnEntryUrl: ${failures} check(s) FAILED`); process.exit(1); }
console.log("learnEntryUrl: all checks passed");
