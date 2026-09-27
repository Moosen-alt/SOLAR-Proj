// R5 VOCABULARY BY MEANING — permitProcess.structureTypeMeaning.
//
// Live run 99baa5d0 (2026-09-27): the borrowed Coos Bay recipe wanted "1-1 or 2 Family Dwelling"
// for Category of Construction; Marion County's list offers "Single Family Dwelling" beside "Two
// Family Dwelling", "Manufactured Dwelling", "Townhouses", "Small Home", "Detached Accessory
// Structure", "Other". The select landed nothing and an LLM gap-fill (14 s) chose for it. The
// replay adapter now lands the UNIQUE option sharing the wanted value's meaning; this pins the
// predicate both ways.
//
// MUST-PASS: every one-or-two-family / single-family spelling means single_family.
// MUST-EXCLUDE: Manufactured Dwelling, Townhouses, Small Home, Detached Accessory Structure, Two
//   Family Dwelling (on its own), Other, --Select-- never read as single_family.
//
//   npx tsx backend/test/categoryVocabulary.test.ts
import { structureTypeMeaning } from "../src/permitProcess";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${name}`);
  else { failures++; console.error(`  FAIL - ${name}${detail ? `\n         ${detail}` : ""}`); }
};

const SINGLE = [
  "1-1 or 2 Family Dwelling", "Single Family Dwelling", "One and Two Family", "Residential - 1 & 2 Family", "1 & 2 Family Dwelling",
  "One- and Two-Family Dwelling", "Single-Family Residence", "SFD", "SFR", "Single Family", "1 or 2 Family Dwelling", "One Family Dwelling",
  "Residential 1 and 2 Family", "1-2 Family Dwelling",
];
for (const s of SINGLE) check(`MUST-PASS ${JSON.stringify(s)} → single_family`, structureTypeMeaning(s) === "single_family", String(structureTypeMeaning(s)));

const NOT_SINGLE: Array<[string, string | null]> = [
  ["Manufactured Dwelling", "manufactured"], ["Townhouses", "townhouse"], ["Small Home", "small_home"], ["Detached Accessory Structure", "accessory"],
  ["Two Family Dwelling", "two_family"], ["Duplex", "two_family"], ["Multi-Family", "multi_family"], ["Commercial", "commercial"],
  ["Other", null], ["--Select--", null], ["Please select...", null], ["", null], ["Manufactured Home - Single Wide", "manufactured"],
  ["Townhouse (Single Family Attached)", "townhouse"], ["Detached Garage", "accessory"],
];
for (const [s, want] of NOT_SINGLE) check(`MUST-EXCLUDE ${JSON.stringify(s)} → ${String(want)} (never single_family)`, structureTypeMeaning(s) === want, String(structureTypeMeaning(s)));

// The Marion list, as one: exactly one option means single_family.
const MARION = ["--Select--", "Detached Accessory Structure", "Manufactured Dwelling", "Single Family Dwelling", "Small Home", "Townhouses", "Two Family Dwelling", "Other"];
const single = MARION.filter((o) => structureTypeMeaning(o) === "single_family");
check("Marion's list holds exactly ONE single_family option: \"Single Family Dwelling\"", single.length === 1 && single[0] === "Single Family Dwelling", JSON.stringify(single));
// Coos Bay's own option is the same meaning, so the two lists meet.
check("Coos Bay's \"1-1 or 2 Family Dwelling\" and Marion's \"Single Family Dwelling\" share the meaning", structureTypeMeaning("1-1 or 2 Family Dwelling") === structureTypeMeaning("Single Family Dwelling"));

console.log(failures === 0 ? "\ncategoryVocabulary: all checks passed." : `\ncategoryVocabulary: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
