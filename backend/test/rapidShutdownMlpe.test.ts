// RAPID SHUTDOWN: OPTIMIZER EQUIPMENT IS MLPE (#213), AND 2023 IS NOT 2020 (#215).
//
// #213: isMlpeDesign knew microinverter wording and brands only, so a string inverter with an
// RSD-integrated optimizer on every module ("(22) … S440 POWER OPTIMIZERS") read as a plain string
// design and city.elec.rapid-shutdown-edition-evidence went to a BLOCKER once the edition was
// verified. Module-level electronics are now answered by ONE predicate
// (moduleLevelElectronics.ts), shared with the Iowa worksheet's DC-DC reading — from the EQUIPMENT
// (a model field or a quantity + optimizer-model schedule line), never a brand or the bare word.
// The same issue's comment: an Enphase model alone in the inverter field ("IQ8M") was missed.
//
// #215: the 2023 row was a copy of 2020. 2023 deleted 690.12(B)(2)'s "no exposed wiring" option and
// moved the RSD marking from 690.56(C) to 690.12(D); the finding names a 2023 difference only when
// the check tests one.
//
// Every fixture is SYNTHETIC. No database, no LLM, no network.
//
// Run: npx tsx backend/test/rapidShutdownMlpe.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings, isMlpeDesignForProject } from "../src/codeReviewRules";
import { dcDcConverterEvidence } from "../src/iowaPvWorksheet";
import { moduleLevelElectronicsEquipment } from "../src/moduleLevelElectronics";
import { NEC_EDITION_REQUIREMENTS } from "../src/necEditions";
import { isNearModelVariant, MICRO_SUPERSEDED_KEY, recordMicroSupersession } from "../src/normalize";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "ZZ";
const AHJ = "City of Testville";
const STRING_INVERTER = { invMake: "SolarEdge", invModel: "SE7600H-US", inverterModel: "SE7600H-US" };
const profile = (edition: string): JurisdictionCodeProfile => ({
  key: `${STATE.toLowerCase()}|${AHJ.toLowerCase()}|unknown`, state: STATE, ahj: AHJ, confidence: "verified",
  adoptedCodes: [{ code: "NEC", edition, title: "National Electrical Code" } as CodeEdition], amendments: [],
  designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "", researchedAt: "2026-09-01T00:00:00.000Z",
});
const project = (text: string, snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "rsd-mlpe", state: STATE, ahj: AHJ, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  parserSnapshot: { mounting: "Roof mount", planSetExtractedText: text, ...snapshot },
} as unknown as ProjectRecord);
const run = (edition: string, text: string, snapshot: Record<string, unknown> = STRING_INVERTER, docs: Array<{ label: string; text: string }> = [{ label: "Plan set", text }]): ReviewerFinding[] =>
  evaluateDesignCodeFindings(project(text, snapshot), null, buildCodeContext(STATE, AHJ, profile(edition)), [], docs);
const get = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const RSD_EDITION = "city.elec.rapid-shutdown-edition-evidence";
const RSD_MISSING = "city.elec.rapid-shutdown-missing";
const sections = (f: ReviewerFinding | undefined) => (f?.codeReferences ?? []).map((r) => `${r.code} ${r.section}`);

// The packet shape from #213: an optimizer schedule line, an RSD placard and switch, but none of
// the "listed"/PVHCS/UL 3741/690.12(B)(2) phrases.
const PLACARD = "E-2 SOLAR PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN. TURN RAPID SHUTDOWN SWITCH TO THE OFF POSITION. RAPID SHUTDOWN SWITCH AT SERVICE ENTRANCE. LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY.";
const OPTIMIZER_LINE = "T-1 EQUIPMENT: (22) SOLAREDGE S440 POWER OPTIMIZERS.";
const WITH_OPTIMIZERS = `${OPTIMIZER_LINE} E-1 STRING INVERTER WITH A POWER OPTIMIZER ATTACHED TO THE BACK OF EACH MODULE. ${PLACARD}`;

console.log("A. #213 — optimizer equipment is module-level electronics");

check("MUST-PASS: verified 2023 + a quantity/optimizer schedule line + RSD placard → warning, with the equipment line cited", () => {
  const f = get(run("2023", WITH_OPTIMIZERS), RSD_EDITION);
  assert.ok(f, "edition-evidence finding expected (the listing basis is still not stated)");
  assert.equal(f.severity, "warning", f.message);
  const ev = (f.evidenceFound ?? []).map((e) => e.excerpt).join(" | ");
  assert.match(ev, /\(22\) SOLAREDGE S440 POWER OPTIMIZERS/, `equipment line not cited: ${ev}`);
  assert.match(f.designTeamAction, /690\.12\(B\)\(2\) basis and listing for the named MLPE/);
});
check("MUST-PASS: the same optimizers with no rapid-shutdown wording at all → presence finding is a warning", () => {
  const text = `${OPTIMIZER_LINE} LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY.`;
  assert.equal(get(run("2023", text), RSD_MISSING)?.severity, "warning");
});
check("MUST-PASS: the reviewer engine's predicate agrees (isMlpeDesignForProject)", () => {
  assert.equal(isMlpeDesignForProject(project(WITH_OPTIMIZERS, STRING_INVERTER)), true);
  assert.equal(isMlpeDesignForProject(project(PLACARD, STRING_INVERTER)), false);
});
check("ONE predicate: the Iowa worksheet's DC-DC reading and the reviewer read the same schedule line", () => {
  const fields = { invModel: "Test 7600 string inverter", planSetExtractedText: OPTIMIZER_LINE };
  assert.equal(dcDcConverterEvidence(fields, false).present, true);
  assert.equal(moduleLevelElectronicsEquipment(fields, [{ label: "Plan set", text: OPTIMIZER_LINE }]).present, true);
});
check("generic across RSD-integrated optimizer makers (Tigo TS4 schedule line, optimizer model field)", () => {
  assert.equal(get(run("2023", `(20) TIGO TS4-A-O OPTIMIZERS. ${PLACARD}`, { invModel: "Test 7600 string inverter" }), RSD_EDITION)?.severity, "warning");
  assert.equal(get(run("2023", PLACARD, { invModel: "Test 7600 string inverter", mciModel: "TS4-A-O" }), RSD_EDITION)?.severity, "warning");
});

check("MUST-EXCLUDE: string inverter, no MLPE, verified 2017+ → blocker", () => {
  for (const e of ["2017", "2020", "2023"]) assert.equal(get(run(e, PLACARD), RSD_EDITION)?.severity, "blocker", e);
});
check("MUST-EXCLUDE: a SolarEdge string inverter + Enphase IQ Battery, no optimizer line → blocker", () => {
  const text = `${PLACARD} ENPHASE IQ BATTERY 5P ENERGY STORAGE.`;
  assert.equal(get(run("2023", text, { ...STRING_INVERTER, batteryMake: "Enphase", batteryModel: "IQ Battery 5P" }), RSD_EDITION)?.severity, "blocker");
});
check("MUST-EXCLUDE: 'optimizer' only in a rail datasheet or a city handout → blocker", () => {
  const rail = "RAIL DATASHEET: SECURES AND BONDS MOST MICRO-INVERTERS AND OPTIMIZERS TO RAIL.";
  const handout = "CITY HANDOUT: OPTIMIZERS AND MICROINVERTERS PROVIDE MODULE-LEVEL SHUTDOWN.";
  const docs = [{ label: "Plan set", text: PLACARD }, { label: "Rail spec sheet", text: rail }, { label: "City handout", text: handout }];
  assert.equal(get(run("2023", `${PLACARD} ${rail} ${handout}`, STRING_INVERTER, docs), RSD_EDITION)?.severity, "blocker");
});

// Helm's review probes on #233: each matched the equipment shape and softened the blocker.
for (const [name, text, snap] of [
  ["a structural sheet reference: 'MICROINVERTERS OR OPTIMIZERS - SEE SHEET S101'", `${PLACARD} MICROINVERTERS OR OPTIMIZERS - SEE SHEET S101.`, STRING_INVERTER],
  ["'RSD BY OPTIMIZERS: SEE S101'", `${PLACARD} RSD BY OPTIMIZERS: SEE S101.`, STRING_INVERTER],
  ["a field holding 'No optimizers'", PLACARD, { ...STRING_INVERTER, mciModel: "No optimizers" }],
  ["'NO OPTIMIZERS - S440 NOT USED'", `${PLACARD} NO OPTIMIZERS - S440 NOT USED.`, STRING_INVERTER],
  ["a zero count: '(0) S440 OPTIMIZERS'", `${PLACARD} (0) S440 OPTIMIZERS.`, STRING_INVERTER],
  ["a negated schedule line: '(22) S440 OPTIMIZERS NOT USED'", `${PLACARD} (22) S440 OPTIMIZERS NOT USED.`, STRING_INVERTER],
  ["'OPTIMIZERS: N/A'", `${PLACARD} OPTIMIZERS: N/A.`, STRING_INVERTER],
] as const) {
  check(`MUST-EXCLUDE: ${name} is not optimizer equipment → blocker`, () => {
    assert.equal(get(run("2023", text, snap as Record<string, unknown>), RSD_EDITION)?.severity, "blocker");
  });
}
check("the finding quotes the matched equipment line only — never the title block around it", () => {
  const titleBlock = "PROJECT: SYNTH OWNER, 123 SAMPLE LANE, APN 000-000-000.";
  const text = `${titleBlock} (22) SOLAREDGE S440 POWER OPTIMIZERS ${titleBlock} ${PLACARD}`;
  const f = get(run("2023", text), RSD_EDITION);
  assert.ok(f);
  const said = [f.message, f.designTeamAction, ...(f.evidenceFound ?? []).map((e) => e.excerpt)].join(" | ");
  assert.doesNotMatch(said, /SYNTH OWNER|SAMPLE LANE|APN/, said);
  assert.equal(moduleLevelElectronicsEquipment({}, [{ label: "Plan set", text }]).basis, 'equipment line "(22) SOLAREDGE S440 POWER OPTIMIZERS"');
});

console.log("\nB. #213 comment — an Enphase model alone in the inverter field");

for (const model of ["IQ8M", "IQ8A-72-2-US", "IQ7PLUS"]) {
  check(`MUST-PASS: invModel "${model}" is a microinverter design → presence finding is a warning`, () => {
    assert.equal(get(run("2023", "LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY.", { invModel: model }), RSD_MISSING)?.severity, "warning");
  });
}
check("MUST-EXCLUDE: 'IQ Battery 5P' in the battery field of a string design → blocker", () => {
  const f = get(run("2023", "LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY.", { ...STRING_INVERTER, batteryModel: "IQ Battery 5P" }), RSD_MISSING);
  assert.equal(f?.severity, "blocker");
});

console.log("\nC. #215 — the 2023 row is its own edition");

const CITES_B23 = `${PLACARD} INSIDE ARRAY BOUNDARY PER NEC 690.12(B)(2)(3).`;
check("a 690.12(B)(2)(3) citation answers the inside-boundary gap under 2020, not under 2023 (deleted option)", () => {
  const f2020 = get(run("2020", CITES_B23), RSD_EDITION);
  assert.equal(f2020, undefined, f2020?.message);
  const f2023 = get(run("2023", CITES_B23), RSD_EDITION);
  assert.ok(f2023, "2023 deleted the option: the inside-boundary gap is owed");
  assert.deepEqual(sections(f2023), ["2023 NEC 690.12(B)(2)"]);
  assert.match(f2023.title, /option the NEC 2023 removed/);
  // That deletion is a secondary-source cell: said so, and held to a warning until confirmed.
  assert.match(f2023.message, /not yet confirmed against the NFPA 70-2023 text/);
  assert.equal(f2023.severity, "warning");
  // …but not when another gap sits beside it: no initiation device shown keeps the blocker.
  const noSwitch = "E-2 SOLAR PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN. LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY. INSIDE ARRAY BOUNDARY PER NEC 690.12(B)(2)(3).";
  const both = get(run("2023", noSwitch), RSD_EDITION);
  assert.deepEqual(sections(both), ["2023 NEC 690.12(B)(2)", "2023 NEC 690.12(C)"]);
  assert.equal(both!.severity, "blocker");
});
// Helm's review probes: a GENERAL "no exposed wiring" note is not the option, under any edition.
for (const [edition, note] of [
  ["2020", "GENERAL NOTE: NO EXPOSED WIRING IN ATTIC OR LIVING SPACE."],
  ["2017", "ALL CONDUCTORS IN EMT, NO EXPOSED WIRING."],
  ["2020", "OPTION (3) NO EXPOSED WIRING METHODS - NOT USED."],
] as const) {
  check(`MUST-EXCLUDE: NEC ${edition} '${note}' does not answer 690.12(B)(2) → blocker`, () => {
    assert.equal(get(run(edition, `${PLACARD} ${note}`), RSD_EDITION)?.severity, "blocker");
  });
}
check("MUST-EXCLUDE: a city handout's 'no exposed wiring' under 2020 → blocker", () => {
  const handout = "CITY HANDOUT: NO EXPOSED WIRING ON ROOFTOPS.";
  const f = get(run("2020", PLACARD, STRING_INVERTER, [{ label: "Plan set", text: PLACARD }, { label: "City handout", text: handout }]), RSD_EDITION);
  assert.equal(f?.severity, "blocker");
});
check("2023: '690.12(B)(2)(3) - NOT USED' or a general note does not make the finding claim the deleted option", () => {
  for (const text of [`${PLACARD} 690.12(B)(2)(3) - NOT USED.`, `${PLACARD} GENERAL NOTE: NO EXPOSED WIRING IN ATTIC.`]) {
    const f = get(run("2023", text), RSD_EDITION);
    assert.ok(f, text);
    assert.equal(f.severity, "blocker", text);
    assert.doesNotMatch(f.title, /removed/, text);
  }
});
check("the finding names a 2023 difference only when the check tested one", () => {
  const f = get(run("2023", PLACARD), RSD_EDITION);
  assert.ok(f);
  // The adopted edition is named as the one applied — not as a claimed 2023 change.
  assert.equal(f.title, "Rapid shutdown basis not shown for the adopted NEC 2023");
  assert.doesNotMatch(f.title, /removed/);
  assert.doesNotMatch(f.message, /removed/);
});
check("the RSD label article: 690.56(C) under 2020, 690.12(D) under 2023 — and the 2023 cells off secondary sources are marked unconfirmed", () => {
  assert.equal(NEC_EDITION_REQUIREMENTS[2020].labels.rapidShutdown, "690.56(C)");
  assert.equal(NEC_EDITION_REQUIREMENTS[2023].labels.rapidShutdown, "690.12(D)");
  assert.equal(NEC_EDITION_REQUIREMENTS[2020].rapidShutdown.noExposedWiringOption, true);
  assert.equal(NEC_EDITION_REQUIREMENTS[2023].rapidShutdown.noExposedWiringOption, false);
  assert.doesNotMatch(NEC_EDITION_REQUIREMENTS[2023].rapidShutdown.limits, /,\s*or no exposed wiring$/);
  for (const cell of ["labels.rapidShutdown", "rapidShutdown.noExposedWiringOption"]) {
    assert.ok(NEC_EDITION_REQUIREMENTS[2023].unconfirmed?.includes(cell), `${cell} should be marked unconfirmed`);
  }
  const missing = get(run("2023", "LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY."), RSD_MISSING);
  assert.ok(sections(missing).includes("2023 NEC 690.12(D)"), sections(missing).join(", "));
});
check("2023: the label is asked at 690.12(D), a plan citing 690.12(D) answers it, and the unconfirmed article is said in the finding", () => {
  const labels = "LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY.";
  const missing = get(run("2023", labels), "city.elec.labels-edition-missing");
  assert.ok(missing?.codeReferences.some((r) => r.section === "690.12(D)"), missing?.message);
  assert.match(missing!.message, /690\.12\(D\) is \(per secondary sources; not yet confirmed against the NFPA 70-2023 text\)/);
  const cited = get(run("2023", `${labels} RSD MARKING PER NEC 690.12(D).`), "city.elec.labels-edition-missing");
  assert.ok(!cited?.codeReferences.some((r) => r.section === "690.12(D)"), cited?.message);
});

console.log("\nD. #242 — '690.12(B)(2)(3) … NOT USED' rejects the option; it is not listed equipment");

// Two synthetic jurisdictions, so no single fixture carries the behaviour.
const JURISDICTIONS = [["ZZ", "City of Testville"], ["YY", "Town of Example Mesa"]] as const;
const runIn = (state: string, ahj: string, edition: string, text: string): ReviewerFinding[] => {
  const p = { ...profile(edition), key: `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj };
  const proj = { ...project(text, STRING_INVERTER), state, ahj } as ProjectRecord;
  return evaluateDesignCodeFindings(proj, null, buildCodeContext(state, ahj, p), [], [{ label: "Plan set", text }]);
};
for (const [state, ahj] of JURISDICTIONS) {
  for (const edition of ["2017", "2020"]) {
    for (const note of [
      "690.12(B)(2)(3) NO EXPOSED WIRING METHODS - NOT USED.",
      "NEC 690.12(B)(2)(3): N/A.",
      "690.12(B)(2)(3) NO EXPOSED WIRING METHODS OR CONDUCTIVE PARTS - NOT APPLICABLE.",
    ]) {
      check(`MUST-EXCLUDE: NEC ${edition}, ${state}: '${note}' does not clear 690.12(B)(2) → blocker`, () => {
        const f = get(runIn(state, ahj, edition, `${PLACARD} ${note}`), RSD_EDITION);
        assert.ok(f, "the inside-boundary gap is owed");
        assert.deepEqual(sections(f), [`${edition} NEC 690.12(B)(2)`]);
        assert.equal(f.severity, "blocker", f.message);
      });
    }
    for (const note of [
      "INSIDE ARRAY BOUNDARY PER NEC 690.12(B)(2)(3).",
      "INSIDE ARRAY BOUNDARY: 690.12(B)(2)(3) NO EXPOSED WIRING METHODS.",
      "INSIDE ARRAY BOUNDARY PER LISTED PVHCS, 690.12(B)(2)(1).",
    ]) {
      check(`MUST-PASS: NEC ${edition}, ${state}: '${note}' answers 690.12(B)(2)`, () => {
        const f = get(runIn(state, ahj, edition, `${PLACARD} ${note}`), RSD_EDITION);
        assert.equal(f, undefined, f?.message);
      });
    }
  }
  // Helm re-review: a parenthesised or "IS NOT USED" rejection is a rejection under every edition —
  // never the gap answered (2017/2020), never "relies on the removed option" (2023).
  for (const note of ["690.12(B)(2)(3) NO EXPOSED WIRING METHODS (NOT USED).", "690.12(B)(2)(3) IS NOT USED."]) {
    for (const edition of ["2017", "2020", "2023"]) {
      check(`MUST-EXCLUDE: NEC ${edition}, ${state}: '${note}' is a rejection → blocker, not the option`, () => {
        const f = get(runIn(state, ahj, edition, `${PLACARD} ${note}`), RSD_EDITION);
        assert.ok(f, "the inside-boundary gap is owed");
        assert.deepEqual(sections(f), [`${edition} NEC 690.12(B)(2)`]);
        assert.equal(f.severity, "blocker", f.message);
        assert.doesNotMatch(f.title, /removed/);
      });
    }
  }
  check(`2023, ${state}: '690.12(B)(2)(3) NO EXPOSED WIRING METHODS' is a citation of the deleted option, not a denial`, () => {
    const f = get(runIn(state, ahj, "2023", `${PLACARD} INSIDE ARRAY BOUNDARY: 690.12(B)(2)(3) NO EXPOSED WIRING METHODS.`), RSD_EDITION);
    assert.ok(f);
    assert.match(f.title, /option the NEC 2023 removed/);
  });
}

console.log("\nE. #270 — only a RECORDED human statement supersedes pvMicro* evidence; string inequality never does");

// Micros the brand list does not name, so only pvMicroQty's "microinverter" makes them MLPE: an
// older Enphase M-series and an APsystems DS3D. Snapshots are in their stored (canonicalized) shape.
const SUNNY = "Sunny Boy SB7.7-1SP-US-41";
const unnamedMicro = (model: string, extra: Record<string, unknown> = {}) => ({
  pvMicroMake: "Testmicro", pvMicroModel: model, pvMicroQty: "10",
  inverterManufacturer: "Testmicro", inverterModel: model, inverterQuantity: "10", ...extra,
});
// What recordMicroSupersession writes after a person's verify/edit (normalize.ts).
const personSaid = (model: string) => ({ invModel: model, inverterModel: model, [MICRO_SUPERSEDED_KEY]: { model, door: "review_queue", at: "2026-10-09T00:00:00.000Z" } });
const LABELS_ONLY = "LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY.";
const labelSections = (snapshot: Record<string, unknown>) =>
  (get(run("2023", LABELS_ONLY, snapshot), "city.elec.labels-edition-missing")?.evidenceNeeded ?? []).join(" | ");

for (const model of ["M215-60-2LL-S22", "DS3D"]) {
  check(`MUST-EXCLUDE (Helm probe D1): ${model} micro + a parser invQty/invMake (quantity/make diverged) stays MLPE`, () => {
    const snap = unnamedMicro(model, { invQty: "12", inverterQuantity: "12", invMake: "Other", inverterManufacturer: "Other" });
    assert.equal(isMlpeDesignForProject(project(PLACARD, snap)), true);
  });
  check(`MUST-EXCLUDE: ${model} micro after a quantity fix-it (inverterQuantity/invQty "18") stays MLPE`, () => {
    assert.equal(isMlpeDesignForProject(project(PLACARD, unnamedMicro(model, { invQty: "18", inverterQuantity: "18" }))), true);
  });
}
check("MUST-EXCLUDE (Helm re-review blocker): the parser's micro + Powerwall 3 shape (PW3_MICRO_AMPS) stays MLPE", () => {
  // parser.html moves the ESS inverter into inv* and keeps the micro in pvMicro*: inverterModel ≠ pvMicroModel, no person involved.
  const snap = unnamedMicro("DS3D", { batteryMake: "Tesla", batteryModel: "Powerwall 3", batteryQty: "1", invMake: "Tesla", invModel: "Powerwall 3", invQty: "1", invOutputW: "1.21", inverterModel: "Powerwall 3", inverterManufacturer: "Tesla", inverterQuantity: "1" });
  assert.equal(isMlpeDesignForProject(project(PLACARD, snap)), true);
});
check("MUST-EXCLUDE: a string inverterModel that differs from pvMicroModel WITHOUT the recorded statement stays MLPE", () => {
  assert.equal(isMlpeDesignForProject(project(PLACARD, unnamedMicro("DS3D", { invModel: SUNNY, inverterModel: SUNNY }))), true);
});
check("MUST-PASS: a person's recorded verify to a string inverter turns MLPE off", () => {
  assert.equal(isMlpeDesignForProject(project(PLACARD, unnamedMicro("DS3D", personSaid(SUNNY)))), false);
});
check("a statement about a model no longer on file is inert (a later parse put the micro back)", () => {
  const snap = { ...unnamedMicro("DS3D", personSaid(SUNNY)), invModel: "DS3D", inverterModel: "DS3D" };
  assert.equal(isMlpeDesignForProject(project(PLACARD, snap)), true);
});
check("the label reader agrees (isMicroinverterDesign): the verified row gets the string design's DC labels back", () => {
  const micro = labelSections(unnamedMicro("DS3D"));
  const verified = labelSections(unnamedMicro("DS3D", personSaid(SUNNY)));
  const string = labelSections({ invModel: SUNNY, inverterModel: SUNNY });
  assert.notEqual(micro, string, "fixture must distinguish micro from string labels");
  assert.equal(verified, string, `verified: ${verified}\nstring:   ${string}`);
  assert.equal(labelSections(unnamedMicro("DS3D", { invModel: SUNNY, inverterModel: SUNNY })), micro, "inequality alone must not drop the micro reading");
});

console.log("\nF. #270 — what counts as a person's statement (recordMicroSupersession)");
const afterVerify = (micro: string, model: string, extra: Record<string, unknown> = {}) => {
  const snap: Record<string, unknown> = { pvMicroModel: micro, pvMicroQty: "10", inverterModel: model, ...extra };
  recordMicroSupersession(snap as never, "review_queue");
  return snap;
};
for (const [micro, fixed] of [["HMS-2OOO-4T", "HMS-2000-4T"], ["M215-60-2LL-S2", "M215-60-2LL-S22"], ["DS3-D", "DS3D"]]) {
  check(`MUST-EXCLUDE: a verify that corrects the micro's string ('${micro}' → '${fixed}') records nothing and stays MLPE`, () => {
    const snap = afterVerify(micro, fixed);
    assert.equal(snap[MICRO_SUPERSEDED_KEY], undefined);
    assert.equal(isMlpeDesignForProject(project(PLACARD, { ...snap, invModel: fixed })), true);
  });
}
check("MUST-EXCLUDE: a verify naming the ESS inverter or the battery records nothing", () => {
  assert.equal(afterVerify("DS3D", "Powerwall 3", { batteryModel: "Powerwall 3" })[MICRO_SUPERSEDED_KEY], undefined);
  assert.equal(afterVerify("DS3D", "SE-10K-RWS", { essInverterModel: "SE10K-RWS" })[MICRO_SUPERSEDED_KEY], undefined);
});
check("MUST-EXCLUDE (Helm re-review blocker 1): the ESS is matched by FAMILY, not exact string", () => {
  const PW3X = "POWERWALL 3 (13.5 KWH) + EXPANSION (13.5 KWH)";
  assert.equal(afterVerify("DS3D", PW3X, { batteryModel: PW3X })[MICRO_SUPERSEDED_KEY], undefined, "approve of the parser's own model");
  assert.equal(afterVerify("DS3D", "Tesla Powerwall 3", { batteryModel: "Powerwall 3" })[MICRO_SUPERSEDED_KEY], undefined, "typed with the make in front");
  assert.equal(afterVerify("DS3D", "Powerwall 3", { batteryModel: PW3X })[MICRO_SUPERSEDED_KEY], undefined, "contained in the expansion string");
  assert.equal(afterVerify("DS3D", "PW3-1707000-21-K", { batteryMake: "Tesla", batteryQty: "1", invMake: "TESLA" })[MICRO_SUPERSEDED_KEY], undefined, "invMake = batteryMake on a battery design");
});
check("…while a real string inverter next to an unrelated battery still records", () => {
  assert.ok(afterVerify("DS3D", SUNNY, { batteryMake: "Enphase", batteryModel: "IQ Battery 5P", batteryQty: "1", invMake: "SMA" })[MICRO_SUPERSEDED_KEY]);
});
check("MUST-PASS: a verify to a different inverter records the model it was about", () => {
  assert.deepEqual((afterVerify("DS3D", SUNNY)[MICRO_SUPERSEDED_KEY] as { model: string }).model, SUNNY);
});
check("near-variant: shared 5+ prefix or ≤2 edits after normalising; unrelated models are not", () => {
  assert.equal(isNearModelVariant("IQ8PLUS-72-2-US", "IQ8PLUS-72-2-US (operator)"), true);
  assert.equal(isNearModelVariant("DS3D", "DS3"), true);
  assert.equal(isNearModelVariant("DS3D", SUNNY), false);
  assert.equal(isNearModelVariant("IQ8PLUS-72-2-US", "Powerwall 3"), false);
});


if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall rapid-shutdown MLPE / edition checks passed");
