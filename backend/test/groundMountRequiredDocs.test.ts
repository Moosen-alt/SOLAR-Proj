// A GROUND MOUNT DRIVES THE REQUIRED SET (#247).
//
// A ground array only ever switched the structural PATH (permitPath, with its own regex), while
// requiredDocuments demanded "Structural roof framing + attachment detail" of an array standing in a
// field, and nothing ever asked whether the AHJ wants a zoning / land-use approval for it. Pinned:
//
//   ONE PREDICATE     — permitPath and requiredDocuments read mountKind.ts, and only the MOUNTING
//                       FIELD (groundMountFromField): plan prose and parser flags never vote for a
//                       blocking row or the engineered path. "ground" counts as a mount noun or a whole
//                       field segment, never "ground lugs" / "ground floor" / "non-ground(-mount)" or
//                       ground-mounted EQUIPMENT; the advisory mountKind reads the field the same way.
//   MUST PASS         — a ground job on two permit platforms (Accela, Tyler EnerGov) gets footing/
//                       racking + trench rows, no roof-framing row, and a zoning row read from the
//                       per-job lookup: cited "required" names its source, cited "not_required" adds
//                       nothing, no answer says "not on file, verify". A seeded answer never blocks.
//   MUST EXCLUDE      — rooftop and unknown-mount jobs are unchanged, even where the lookup says a
//                       ground array needs zoning.
//   THE LOOKUP ASKS   — the process prompt asks the bounded question; only a cited quote that points
//                       the same way is kept.
//
//   npx tsx backend/test/groundMountRequiredDocs.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitedFact, ProjectRecord } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ground-mount-docs-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { requiredDocuments } = await import("../src/requiredDocuments");
const { resolvePermitPath } = await import("../src/permitPath");
const { mountKindForProject, isGroundMount, groundMountFromField } = await import("../src/mountKind");
const { mountKindForProject: reviewerMountKind } = await import("../src/codeReviewRules");
const { PROCESS_LOOKUP_SYSTEM, parseProcessPart, groundZoningPolarity } = await import("../src/permitProcessLookup");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Synthetic jurisdictions only — two different permit platforms.
const ACCELA = { state: "AZ", ahj: "Town of Sample Mesa", portal: "https://aca-prod.accela.com/SAMPLEMESA/Default.aspx", page: "https://www.samplemesa.example.gov/permits/solar" };
const ENERGOV = { state: "CO", ahj: "Example Valley County", portal: "https://examplevalleyco-energovweb.tylerhost.net/apps/selfservice", page: "https://www.examplevalley.example.gov/building/solar" };
const NO_LOOKUP = { state: "NV", ahj: "City of Nowhere Flats" };
const OREGON = { state: "OR", ahj: "City of Sample Harbor" };

const cited = <T,>(value: T, sourceUrl: string, quote: string): CitedFact<T> => ({ value, sourceUrl, quote, origin: "lookup" });
const nf = (why: string): CitedFact<never> => ({ value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: why });
const permit = (portalUrl: string, page: string) => ({
  discipline: "combo" as const, label: "Residential solar", issuingAgency: nf("same as the AHJ"),
  portalUrl: cited(portalUrl, page, `Apply online for residential solar permits at ${portalUrl}`), recordType: nf("none"), documents: nf("none"), fee: nf("none"),
});
const save = (j: { state: string; ahj: string; portal: string; page: string }, zoning: CitedFact<"required" | "not_required"> | undefined) => {
  const r = savePermitProcessLookup(db, {
    state: j.state, ahj: j.ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: cited(j.ahj, j.page, `${j.ahj} Building Division issues residential solar permits`),
    permitStructure: cited("combo", j.page, "one combination permit covers the structural and electrical work"),
    permits: [permit(j.portal, j.page)], notes: [],
    ...(zoning ? { groundMountZoning: zoning } : {}),
  });
  assert.ok(r.saved, `fixture lookup for ${j.ahj} not saved: ${r.reason}`);
};
save(ACCELA, cited("required", ACCELA.page, "Ground-mounted solar arrays require a zoning permit and must meet accessory structure setbacks."));
save(ENERGOV, cited("not_required", ENERGOV.page, "Ground-mounted solar arrays in residential districts do not require a separate zoning permit."));

const job = (where: { state: string; ahj: string }, mounting: string, text = "", extra: Record<string, string> = {}): ProjectRecord => ({
  id: `gm-${where.state}-${mounting.replace(/\W+/g, "-") || "blank"}`, clientId: "c", homeownerName: "Test Owner", projectAddress: "1 Test Rd",
  city: "Testville", state: where.state, zip: "00000", ahj: where.ahj, utility: "Test Electric", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 8, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker", status: "pending",
  parserSnapshot: { state: where.state, ahj: where.ahj, mounting, planSetExtractedText: text, groundSnow: "20", windSpeed: "100", windExposure: "C", ...extra },
} as unknown as ProjectRecord);
const types = (p: ProjectRecord) => requiredDocuments(p).map((i) => i.docType);
const row = (p: ProjectRecord, t: string) => requiredDocuments(p).find((i) => i.docType === t);

console.log("\n1. ONE PREDICATE — the mounting FIELD drives permitPath and requiredDocuments, and agrees with the reviewer rules");
for (const mounting of ["Ground", "Pole mount", "ground-mounted array", "Pole", "Top of pole"]) {
  check(`field "${mounting}" is a ground mount everywhere`, () => {
    const p = job(ACCELA, mounting);
    assert.equal(mountKindForProject(p), "ground");
    assert.equal(reviewerMountKind(p), "ground");
    assert.ok(isGroundMount(p));
    assert.equal(resolvePermitPath(p).path, "engineered", "permitPath's ground default reads the same predicate");
    assert.ok(!types(p).includes("structural"), "no roof-framing row");
  });
}

console.log("\n2. MUST PASS — ground mount on two permit platforms");
check("Accela AHJ: footing/racking (blocking) + trench (advisory) replace roof framing, in place", () => {
  const p = job(ACCELA, "Ground mount");
  const t = types(p);
  assert.ok(!t.includes("structural"));
  assert.deepEqual(t.slice(0, 6), ["plan_set", "site_plan", "sld", "ground_footing", "trench_detail", "zoning_approval"]);
  assert.equal(row(p, "ground_footing")!.blocking, true);
  assert.deepEqual(row(p, "ground_footing")!.altDocTypes, ["structural"]);
  assert.equal(row(p, "trench_detail")!.blocking, false);
  assert.match(row(p, "trench_detail")!.why, /NEC 300\.5/);
});
check("Accela AHJ: cited 'required' zoning names its source; seeded, so advisory", () => {
  const z = row(job(ACCELA, "Ground mount"), "zoning_approval")!;
  assert.ok(z.why.includes(ACCELA.page) && /zoning permit/.test(z.why), z.why);
  assert.doesNotMatch(z.label, /not on file/);
  assert.equal(z.blocking, false, "a seeded lookup must not stop a filing on its own");
});
check("Tyler EnerGov AHJ: cited 'not_required' adds no zoning row; footing + trench still there", () => {
  const t = types(job(ENERGOV, "Ground mount"));
  assert.ok(t.includes("ground_footing") && t.includes("trench_detail"));
  assert.ok(!t.includes("zoning_approval"));
  assert.ok(!t.includes("structural"));
});
check("no lookup on file: zoning reads 'not on file, verify' — advisory, never assumed", () => {
  const z = row(job(NO_LOOKUP, "Ground mount"), "zoning_approval")!;
  assert.match(z.label, /not on file, verify/);
  assert.equal(z.blocking, false);
});
check("a person-verified 'required' answer blocks", () => {
  const VERIFIED = { ...ACCELA, ahj: "Village of Sample Ridge" };
  const r = savePermitProcessLookup(db, {
    state: VERIFIED.state, ahj: VERIFIED.ahj, lookedUpAt: new Date().toISOString(), confidence: "verified",
    issuingAgency: nf("n/a"), permitStructure: nf("n/a"), permits: [], notes: [],
    groundMountZoning: cited("required", VERIFIED.page, "A zoning permit is required for ground-mounted solar."),
  }, { verifiedBy: "test-operator" });
  assert.ok(r.saved);
  assert.equal(row(job(VERIFIED, "Ground mount"), "zoning_approval")!.blocking, true);
});
check("an uncited 'required' is not on file (verify), not a requirement", () => {
  const UNCITED = { ...ENERGOV, ahj: "Sample Butte County" };
  save(UNCITED, cited("required", "", "zoning permit required"));
  assert.match(row(job(UNCITED, "Ground mount"), "zoning_approval")!.label, /not on file, verify/);
});

console.log("\n2b. A ROOF + GROUND COMBINATION keeps roof framing and adds the ground rows");
for (const mounting of ["Roof and Ground", "Roof + ground mount"]) {
  check(`field "${mounting}": structural kept, ground rows right after it, engineered`, () => {
    const p = job(ACCELA, mounting);
    assert.equal(groundMountFromField(p), "combination");
    assert.ok(!isGroundMount(p), "a combination is not a pure ground mount");
    const t = types(p);
    assert.deepEqual(t.slice(3, 7), ["structural", "ground_footing", "trench_detail", "zoning_approval"]);
    assert.equal(resolvePermitPath(p).path, "engineered");
  });
}

console.log("\n3. MUST EXCLUDE — rooftop and unknown mount unchanged");
const ROOF_BASELINE = ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels"];
for (const [label, mounting] of [["rooftop", "Roof mount"], ["unknown mount", ""], ["carport", "Carport"]] as const) {
  for (const where of [ACCELA, ENERGOV, NO_LOOKUP]) {
    check(`${label} at ${where.ahj}: the roof set, untouched — no ground rows even where the lookup wants zoning`, () => {
      const items = requiredDocuments(job(where, mounting));
      assert.deepEqual(items.map((i) => i.docType).slice(0, 7), ROOF_BASELINE);
      assert.deepEqual(items.find((i) => i.docType === "structural"), { docType: "structural", label: "Structural roof framing + attachment detail", why: "Required for the structural permit (framing, spacing, attachment).", lane: "permit", blocking: true });
      for (const t of ["ground_footing", "trench_detail", "zoning_approval"]) assert.ok(!items.some((i) => i.docType === t), t);
    });
  }
}
// Plan prose and parser flags name ground-mounted EQUIPMENT on rooftop jobs; they never vote (#247
// review, each reproduced against the first version of this PR). In and outside Oregon.
const ROOFTOP_PROSE: Array<[string, string, Record<string, string>]> = [
  ["", "(E) UTILITY POLE MOUNTED TRANSFORMER. FLUSH ROOF MOUNT COMP SHINGLE.", {}],
  ["", "(N) GROUND-MOUNTED AC DISCONNECT", {}],
  ["", "GROUND MOUNTED METER PEDESTAL", {}],
  ["", "(N) GROUND MOUNTED BATTERY ON CONCRETE PAD", {}],
  ["", "UNDERGROUND ARRAY FEEDER", {}],
  ["", "ROOF MOUNT - NOT A GROUND MOUNT", {}],
  ["", "", { reviewFlags: "confirm roof mount vs ground mount" }],
  ["Pole barn roof", "", {}],
  // Field values whose "ground" is not a mount (#247 re-review).
  ["Roof mount w/ ground lugs", "", {}],
  ["Flush roof; ground-level inverter", "", {}],
  ["Roof mount, ground floor garage", "", {}],
  ["Roof mount; not ground", "", {}],
  ["Roof Mount (non-ground)", "", {}],
  ["Roof mount, ground fault protection", "", {}],
  ["Roof mount - not a ground mount", "", {}],
  // #269: 'non' negates a mount phrase; ground- or pole-mounted EQUIPMENT in the field is not an array.
  ["Roof mount (non-ground-mount)", "", {}],
  ["Roof mount, non-ground-mounted", "", {}],
  ["Roof mount with ground-mounted inverter", "", {}],
  ["Roof mount; ground-mounted AC disconnect", "", {}],
  ["Flush roof + ground mounted meter pedestal", "", {}],
  ["Roof mount, ground-mounted battery", "", {}],
  ["Roof mount w/ ground mount ESS", "", {}],
  ["Roof; pole-mounted transformer", "", {}],
];
for (const where of [OREGON, NO_LOOKUP]) {
  for (const [mounting, text, extra] of ROOFTOP_PROSE) {
    check(`${where.state}: ${mounting ? `field "${mounting}"` : text ? `text "${text}"` : `flag "${extra.reviewFlags}"`} keeps the roof set and the roof path`, () => {
      const p = job(where, mounting, text, extra);
      const bare = job(where, /ground/i.test(mounting) ? "Roof mount" : mounting);
      assert.deepEqual(requiredDocuments(p), requiredDocuments(bare));
      assert.equal(groundMountFromField(p), null);
      assert.deepEqual(types(p), types(bare));
      assert.ok(types(p).includes("structural") && !types(p).includes("ground_footing"));
      assert.ok(!resolvePermitPath(p).basis.some((b) => /Ground\/pole mount/.test(b)), resolvePermitPath(p).basis.join(" | "));
      assert.equal(resolvePermitPath(p).path, resolvePermitPath(bare).path);
    });
  }
}
// A carport the field calls ground- or pole-MOUNTED keeps main's engineered path and PE-stamp row
// (#247 re-review), while its document set stays the carport (roof) set.
for (const mounting of ["Ground-mounted carport", "Carport (ground mount)", "Pole-mounted canopy", "Pole mount awning"]) {
  check(`OR field "${mounting}": engineered with the stamp row, as on main; no ground rows`, () => {
    const p = job(OREGON, mounting);
    assert.equal(resolvePermitPath(p).path, "engineered");
    assert.ok(types(p).includes("structural") && !types(p).includes("ground_footing"));
    assert.equal(row(p, "structural_letter")?.blocking, true, "the blocking PE-stamp row");
  });
}
check("rooftop permit path is not touched by the shared predicate", () => {
  assert.ok(!resolvePermitPath(job(ACCELA, "Roof mount")).basis.some((b) => /Ground\/pole mount/.test(b)));
});

// #269: the advisory reviewer predicate reads the field the way the blocking consumers do — a field
// the required set calls roof is "roof" to the reviewer rules too, and the ground vocabulary is unchanged.
check("advisory mountKind agrees with groundMountFromField on every rooftop field value", () => {
  for (const [mounting] of ROOFTOP_PROSE.filter(([m]) => m)) {
    const p = job(OREGON, mounting);
    assert.equal(mountKindForProject(p), "roof", mounting);
    assert.equal(reviewerMountKind(p), "roof", mounting);
  }
});
for (const [mounting, field] of [["Ground", "ground"], ["Roof and Ground", "combination"], ["Roof + Ground", "combination"], ["Ground mount", "ground"], ["Top of pole", "ground"], ["Ground-mounted array with ground-mounted inverter", "ground"]] as const) {
  check(`MUST PASS: field "${mounting}" is unchanged — ${field} by the field, ground to the reviewer rules, engineered`, () => {
    for (const where of [OREGON, NO_LOOKUP]) {
      const p = job(where, mounting);
      assert.equal(groundMountFromField(p), field);
      assert.equal(mountKindForProject(p), "ground");
      assert.equal(resolvePermitPath(p).path, "engineered");
      assert.ok(types(p).includes("ground_footing"));
    }
  });
}

console.log("\n4. THE LOOKUP ASKS — bounded, cited, pointing the same way");
check("the process prompt asks how the AHJ permits a ground mount, as one enum", () => {
  assert.match(PROCESS_LOOKUP_SYSTEM, /groundMountZoning/);
  assert.match(PROCESS_LOOKUP_SYSTEM, /"groundMountZoning": \{"value": "required"\|"not_required"\|null/);
});
const answer = (value: string, quote: string) => JSON.stringify({ issuingAgency: null, permitStructure: null, permits: [], prerequisites: [], groundMountZoning: { value, sourceUrl: ACCELA.page, quote } });
check("a cited 'required' is kept", () => {
  const r = parseProcessPart(answer("required", "Ground-mounted solar requires zoning approval before the building permit."), [ACCELA.page], "end_turn");
  assert.equal(r.groundMountZoning?.value, "required");
});
check("a cited 'not_required' is kept only when the quote says so", () => {
  assert.equal(parseProcessPart(answer("not_required", "Ground-mounted solar is exempt from zoning review."), [ACCELA.page], "end_turn").groundMountZoning?.value, "not_required");
  assert.equal(parseProcessPart(answer("not_required", "Ground-mounted solar requires zoning approval."), [ACCELA.page], "end_turn").groundMountZoning?.value, null);
});
check("a 'required' whose quote says no zoning is needed, or a quote not about zoning, is dropped", () => {
  assert.equal(parseProcessPart(answer("required", "No zoning permit is needed for ground-mounted solar."), [ACCELA.page], "end_turn").groundMountZoning?.value, null);
  assert.equal(parseProcessPart(answer("required", "Solar permits are reviewed within ten business days."), [ACCELA.page], "end_turn").groundMountZoning?.value, null);
});
check("polarity is the requirement phrase's: a height limit's 'not' never flips it", () => {
  assert.equal(groundZoningPolarity("A zoning permit is required for ground-mounted arrays; arrays shall not exceed 15 feet"), "required");
  assert.equal(groundZoningPolarity("Ground-mounted systems not exceeding 6 feet in height require zoning approval."), "required");
  assert.equal(groundZoningPolarity("Ground-mounted systems do not require a zoning permit."), "not_required");
  assert.equal(groundZoningPolarity("Ground-mounted solar is exempt from zoning review."), "not_required");
  assert.equal(parseProcessPart(answer("required", "A zoning permit is required for ground-mounted arrays; arrays shall not exceed 15 feet"), [ACCELA.page], "end_turn").groundMountZoning?.value, "required");
  assert.equal(parseProcessPart(answer("not_required", "Ground-mounted systems not exceeding 6 feet in height require zoning approval."), [ACCELA.page], "end_turn").groundMountZoning?.value, null);
});
check("'not exempt' is a requirement; 'need(s) no' is not", () => {
  assert.equal(groundZoningPolarity("Ground-mounted solar arrays are not exempt from zoning review."), "required");
  assert.equal(groundZoningPolarity("Ground-mounted arrays need no zoning permit."), "not_required");
});
check("#269: every 'not exempt' polarity variant is a requirement; a 'not' elsewhere leaves the exemption", () => {
  for (const q of [
    "Ground-mounted solar arrays aren't exempt from zoning review.",
    "Ground-mounted solar arrays aren’t exempt from zoning review.",
    "Ground-mounted solar arrays are not exempt from zoning review.",
    "A ground-mounted array isn't exempt from accessory structure setbacks.",
    "Ground-mounted arrays are not considered exempt from planning review.",
    "Ground-mounted arrays will not be exempt from zoning.",
  ]) {
    assert.equal(groundZoningPolarity(q), "required", q);
    assert.equal(parseProcessPart(answer("not_required", q), [ACCELA.page], "end_turn").groundMountZoning?.value, null, q);
    assert.equal(parseProcessPart(answer("required", q), [ACCELA.page], "end_turn").groundMountZoning?.value, "required", q);
  }
  assert.equal(groundZoningPolarity("Ground-mounted arrays not visible from the street are exempt from zoning review."), "not_required");
});
check("an unknown value or a quote from a page the search never returned is dropped", () => {
  assert.equal(parseProcessPart(answer("maybe", "Ground-mounted solar requires zoning approval."), [ACCELA.page], "end_turn").groundMountZoning?.value, null);
  assert.equal(parseProcessPart(answer("required", "Ground-mounted solar requires zoning approval."), ["https://other.example.gov/"], "end_turn").groundMountZoning?.value, null);
});

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall ground-mount required-doc checks passed");
process.exit(failures ? 1 : 0);
