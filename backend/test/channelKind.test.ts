// HOW A TRACK IS FILED, AS A KIND (operator 2026-09-28: "City of Waltham only does in-person permit
// submission ... ensure they're bold enough to know, same with email submissions as it will require us
// to go outside of the submission tool"). submittalTracks.channelKindOf over the REAL channel sentences
// the live projects carry (copied from getSubmittalTracks on a copy of the production DB).
//
//   npx tsx backend/test/channelKind.test.ts
import assert from "node:assert/strict";
import { channelKindOf } from "../src/submittalTracks";

const cases: Array<[string, string, string]> = [
  // [channel sentence, portalUrl, expected kind]
  ["combination — in-person drop-off is the default for building permits; roofing/insulation/replacement-window permits may go by U.S. Mail or email to bldpermits@city.waltham.ma.us; permit fees payable online (researched — verify on the AHJ site)", "", "in_person"],
  ["Submit the completed application by email to permits@example-city.gov (researched — verify on the AHJ site)", "", "email"],
  ["Applications must be mailed to the Building Division, 100 Main St (researched — verify)", "", "mail"],
  ["Oregon ePermitting (Accela)", "", "portal"],
  ["PowerClerk (cited: https://portlandgeneral.com/renewable-installers/interconnection-qualifications)", "", "portal"],
  ["https://tigardor-energovweb.tylerhost.net/apps/SelfService#/home (seeded AHJ profile — verify)", "", "portal"],
  ["Portland DevHub portal", "", "portal"],
  ["Online portal", "", "portal"],
  ["anything at all", "https://aca-oregon.accela.com/oregon/", "portal"],
  // A guess stays a guess; an unidentified portal is unknown.
  ["unknown — likely in-person/combination at Building & Zoning, Room 304, Municipal Center West", "", "unknown"],
  ["Utility interconnection portal — not yet identified (verify on the utility's interconnection page)", "", "unknown"],
  ["Unknown — verify on the AHJ site", "", "unknown"],
  // Paying online is not filing online; "no online portal" is a negation.
  ["No online application portal found — applications must be dropped off in person (per-job lookup; verify on the AHJ site)", "", "in_person"],
];
let failures = 0;
for (const [channel, portalUrl, want] of cases) {
  const got = channelKindOf({ channel, portalUrl });
  if (got === want) console.log(`  ok   - ${want}: ${channel.slice(0, 70)}`);
  else { failures++; console.error(`  FAIL - want ${want}, got ${got}: ${channel.slice(0, 120)}`); }
}
assert.equal(failures, 0, `${failures} channel-kind case(s) failed`);
console.log(`channelKind: all ${cases.length} cases passed — Waltham in person, portals named or linked, guesses stay unknown`);
