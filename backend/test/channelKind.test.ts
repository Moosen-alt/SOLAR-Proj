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
  // An in-person clause beats a platform word later in the same seeded method (Bernalillo County, NM).
  ["BPA: In person EPA: Bernalillo County accela (seeded AHJ profile — verify)", "", "in_person"],
  // …and outside Oregon an Accela instance is named neutrally, still a portal.
  ["Accela Citizen Access (online portal) (seeded AHJ profile — verify)", "", "portal"],
  // A negated in-person clause is not an in-person channel.
  ["Accela portal only — no in-person submittals", "", "portal"],
  // THE IN-PERSON CLAUSE IS READ ON ITS OWN (forms skeptic note 1, fixer-10 K2): a clause that refuses
  // in-person — "not accepted", "no longer", "closed" — is no in-person channel, and one that allows it
  // ALSO ("also accepted") never outranks the online filing it sits beside.
  ["In-person submittals are not accepted; apply online", "", "portal"],
  ["Paper applications are no longer accepted — apply online", "", "portal"],
  ["The permit counter is closed to walk-in submittals; submit online through the portal", "", "portal"],
  ["Apply online; in-person drop off also accepted", "", "portal"],
  // MUST-EXCLUDE: an in-person clause that neither refuses nor merely allows stays in person; with
  // no portal named, an "also accepted" in-person clause is still the channel.
  ["In-person only", "", "in_person"],
  ["Drop off at the permit counter; applications are not accepted by email", "", "in_person"],
  ["Walk-in submittals also accepted at the counter", "", "in_person"],
];
let failures = 0;
for (const [channel, portalUrl, want] of cases) {
  const got = channelKindOf({ channel, portalUrl });
  if (got === want) console.log(`  ok   - ${want}: ${channel.slice(0, 70)}`);
  else { failures++; console.error(`  FAIL - want ${want}, got ${got}: ${channel.slice(0, 120)}`); }
}
assert.equal(failures, 0, `${failures} channel-kind case(s) failed`);
console.log(`channelKind: all ${cases.length} cases passed — Waltham in person, portals named or linked, guesses stay unknown`);
