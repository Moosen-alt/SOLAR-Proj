// WHICH RULES APPLY TO AN ARRAY THAT IS NOT ON A ROOF?
//
// Fire access pathways, roof framing and racking flashing exist because a roof exists. A ground
// array has piers, a footing and a trench. Two separate layers of the gate answer this question
// — codeReviewRules (city.*) and reviewerEngine's plan-set pass (reviewer.plan.*) — and they
// are PAIRED by DEDUPE_ALIASES on topic:fire and topic:rapid-shutdown, with the code-rule side
// winning. That pairing hid the bug: while only codeReviewRules was mount-aware, a ground
// array's roof blockers came from there and the engine's mount-blind duplicates stayed masked.
// Making the first layer mount-aware removed the mask and the duplicates surfaced, demanding
// roof fire pathways and NEC 690.12 of an array standing in a field.
//
// So these tests pin the SCOPE, in both directions, at the level where it is decided:
//   - a non-roof array is exempt from roof rules,
//   - a roof job is not,
//   - and the exemption never becomes silence or widens to rules that do still apply.
// Run: tsx backend/test/groundMountScope.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";
import { mountKindForProject } from "../src/codeReviewRules";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (mounting: string, text?: string): ProjectRecord => ({
  id: `gm-${mounting.replace(/\W+/g, "-") || "blank"}`,
  clientId: "c", homeownerName: "Mount Scope", projectAddress: "1 Field Rd",
  city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay",
  utility: "Pacific Power", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    mounting, interco: "Load-side breaker",
    busRating: "225A", mainBreaker: "175A", pvBreaker: "40",
    planSetExtractedText: text ?? "",
  },
} as unknown as ProjectRecord);

const ids = (p: ProjectRecord): Map<string, string> => {
  const m = new Map<string, string>();
  for (const f of buildReviewerReport(p).findings) m.set(f.id, f.severity);
  return m;
};

// Both layers' names for the same roof questions. A fix that only silences one of these is
// not a fix — that is exactly the state this test was written to end.
const ROOF_ONLY_IDS = [
  "city.fire.pathways-missing",       // code-rule layer, topic:fire
  "reviewer.plan.fire-path",          // engine layer, topic:fire  <- the one that was blind
  "city.struct.framing-missing",
  "city.struct.attachment-detail-missing",
  "city.struct.span-table-incomplete",
];

console.log("\n1. A NON-ROOF ARRAY IS EXEMPT FROM ROOF RULES — IN BOTH LAYERS");
for (const mounting of ["Ground mount", "Pole mount", "ground-mounted array", "Carport"]) {
  check(`MUST PASS: "${mounting}" receives no roof-only finding`, () => {
    const got = ids(mk(mounting));
    const leaked = ROOF_ONLY_IDS.filter((id) => got.has(id));
    assert.deepEqual(leaked, [], `roof rules fired on a non-roof array: ${leaked.join(", ")}`);
  });
}

console.log("\n2. THE ROOF JOB IS STILL FULLY REVIEWED");
const roof = ids(mk("Roof mount"));
check("MUST EXCLUDE: a roof mount still raises roof findings", () => {
  const present = ROOF_ONLY_IDS.filter((id) => roof.has(id));
  assert.ok(present.length > 0, "the roof rules went quiet on an actual roof — over-exemption");
});
check("MUST EXCLUDE: the roof fire-pathway rule still fires on a roof", () => {
  const firePresent = roof.has("city.fire.pathways-missing") || roof.has("reviewer.plan.fire-path");
  assert.ok(firePresent, "no fire pathway review on a roof job at either layer");
});

console.log("\n3. THE EXEMPTION IS NOT SILENCE — a ground array gets its OWN prompt");
check("a non-roof array raises the ground-array site callout", () => {
  const got = ids(mk("Ground mount"));
  assert.equal(got.get("reviewer.plan.ground-array-site"), "callout",
    "roof rules were removed and nothing replaced them — the array is now unreviewed");
});
check("...and the callout names what a ground array actually needs", () => {
  const f = buildReviewerReport(mk("Ground mount")).findings
    .find((x) => x.id === "reviewer.plan.ground-array-site");
  assert.ok(f, "callout missing");
  const body = `${f!.message} ${f!.cityFeedback} ${f!.designTeamAction}`.toLowerCase();
  for (const term of ["setback", "pier", "trench"]) {
    assert.ok(body.includes(term), `the ground-array prompt never mentions ${term}`);
  }
});
check("MUST EXCLUDE: a roof job does NOT get the ground-array callout", () => {
  assert.equal(roof.has("reviewer.plan.ground-array-site"), false,
    "a roof job was told its roof rules do not apply");
});

console.log("\n4. THE EXEMPTION MUST NOT WIDEN TO THE SITE PLAN");
// A ground array needs a site plan MORE than a roof job: setbacks, pier layout, trench route.
// The code-rule layer already exempts site plans for ground mounts, so reviewer.plan.site is a
// ground array's ONLY site-plan coverage. Exempting it too would trade a false blocker for a
// real silence — the failure mode this whole line of work exists to prevent.
check("a ground array is STILL required to produce a site plan", () => {
  const got = ids(mk("Ground mount"));
  assert.ok(got.has("reviewer.plan.site") || got.has("city.plan.site-roof-missing"),
    "no layer asks a ground array for a site plan — setbacks and trench route go unreviewed");
});

console.log("\n5. RAPID SHUTDOWN FOLLOWS THE BUILDING, NOT THE ROOF");
// NEC 690.12 governs PV "on buildings". A ground/pole array is not on one. A CARPORT is a
// structure and AHJs differ, so the conservative call is that a carport KEEPS its rapid-shutdown
// requirement. Decided deliberately 2026-09-22 — overturn it here, on purpose, not by accident.
check("ground mount is exempt from rapid shutdown at BOTH layers", () => {
  const got = ids(mk("Ground mount"));
  assert.equal(got.has("city.elec.rapid-shutdown-missing"), false, "code-rule layer");
  assert.equal(got.has("reviewer.plan.rapid-shutdown"), false, "engine layer still demanded 690.12");
});
check("MUST EXCLUDE: a CARPORT still answers for rapid shutdown", () => {
  const got = ids(mk("Carport"));
  assert.ok(got.has("city.elec.rapid-shutdown-missing") || got.has("reviewer.plan.rapid-shutdown"),
    "a carport was exempted from 690.12 — it is a structure, and the AHJ may well require it");
});
check("MUST EXCLUDE: a roof mount still answers for rapid shutdown", () => {
  assert.ok(roof.has("city.elec.rapid-shutdown-missing") || roof.has("reviewer.plan.rapid-shutdown"),
    "rapid shutdown stopped being reviewed on a roof");
});

console.log("\n6. THE PREDICATE ITSELF — one vocabulary, conservative on silence");
check("mountKindForProject classifies each mounting string", () => {
  assert.equal(mountKindForProject(mk("Roof mount")), "roof");
  assert.equal(mountKindForProject(mk("Ground mount")), "ground");
  assert.equal(mountKindForProject(mk("Pole Mount")), "ground");
  assert.equal(mountKindForProject(mk("Carport")), "carport");
  assert.equal(mountKindForProject(mk("Canopy")), "carport");
});
check("silence about mounting reads as UNKNOWN and keeps the roof rules", () => {
  assert.equal(mountKindForProject(mk("")), "unknown");
  const got = ids(mk(""));
  const present = ROOF_ONLY_IDS.filter((id) => got.has(id));
  assert.ok(present.length > 0,
    "an unknown mount bought a roof-rule exemption — an unknown must not read as reassurance");
});
check("MUST EXCLUDE: 'Flush mount' is a ROOF mount, not a ground array", () => {
  assert.equal(mountKindForProject(mk("Flush mount, composition shingle")), "roof",
    "the bare word 'mount' was enough to classify a roof job as a ground array");
});
check("the plan-set TEXT is a fallback when the mounting field is empty", () => {
  assert.equal(mountKindForProject(mk("", "GROUND MOUNT ARRAY ON DRIVEN PIER FOUNDATION")), "ground",
    "a parse that captured the mount only in sheet text was ignored");
});

console.log(failures === 0
  ? "\nAll ground-mount scope checks passed."
  : `\n${failures} ground-mount scope check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
