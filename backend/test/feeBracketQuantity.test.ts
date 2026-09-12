// THE FROZEN FEE-BRACKET QUANTITY.
//
// Measured in the live database. The City of Coos Bay ELECTRICAL recipe
// (portal_recipes, profile_key "or|city of coos bay|pacific power", discipline
// "electrical", status complete, 53 steps) carries exactly one step like this:
//
//   action "fill"
//   label  "Renewable energy for electrical systems- 5.01kva through 15kva:"
//   field  (unbound)
//   value  "1"
//   id     ctl00_PlaceHolderMain_AppSpecB42EAF26Edit_COOS_CO_txt_0_28
//
// Accela renders ONE TEXT BOX PER BRACKET ROW of Coos County's fee table and the
// quantity ticks the row that applies to this job. "1" is the answer for the
// project that was LEARNED. Replay it onto a 20 kVA job and the county bills the
// 5.01–15 tier for a 15.01–25 system — wrong, and invisible, because the field
// looks answered and every click succeeds. This is the bug migration v19 named.
//
//   MUST PASS    — a 4.55 kW-AC job gets "0" in the 5.01–15 box (it belongs in
//                  "5 KVA or less"); a 9 kW-AC job gets "1" in it; the numeric
//                  match works across the two spellings ("5.01kva through 15kva"
//                  vs "5.01 KVA to 15 KVA"); the answer agrees with the ONE fee
//                  evaluator at every size; "0" survives replay's own known/bound
//                  check instead of reading as blank.
//   MUST EXCLUDE — a project whose bracket has NO recorded step is FLAGGED, not
//                  silently zeroed (that is a silently UNDER-billed permit, the
//                  same invisible failure wearing different clothes); and with no
//                  schedule on file the step is left EXACTLY as it is today, not
//                  emitted as a wrong "0" — an unbound literal is the status quo
//                  and is visible, a computed 0 is not.
//
// Kill tests for this file (each must go RED on its own):
//   1. feeBracketFields.feeBracketQuantityFields — return "0" for the matched
//      bracket instead of "1". The 9 kW MUST PASS checks go red.
//   2. feeBracketQuantity.feeBracketCoverage — return `uncovered: false`. The
//      coverage MUST EXCLUDE checks go red.
//   3. portalRecipes.convertLiteralsToBoundFields — make feeBracketFieldForLabel
//      return "". The binding checks go red.
//
//   npx tsx backend/test/feeBracketQuantity.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The VERBATIM Accela label off the live recipe — a re-typed approximation would
// prove nothing about the spelling this exists to bridge.
const COOS_LABEL_5_15 = "Renewable energy for electrical systems- 5.01kva through 15kva:";
const COOS_LABEL_15_25 = "Renewable energy for electrical systems- 15.01kva through 25kva:";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-bracket-qty-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const { saveFeeSchedule, feeScheduleProfileKey, feeForProject } = await import("../src/feeSchedules");
  const { feeBracketQuantityFields, feeBracketFieldForLabel } = await import("../src/feeBracketFields");
  const {
    FEE_BRACKET_FIELD_PREFIX, feeBracketFieldKey, feeBracketCoverage, feeBracketCoverageMessage,
  } = await import("../../portal-bot/src/feeBracketQuantity");
  const { convertLiteralsToBoundFields, deadFieldBindings } = await import("../src/portalRecipes");
  const { planFeeBracketBindings, applyFeeBracketBindings } = await import("../src/bindFeeBrackets");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type RecipeStep = import("../../shared/src/types").RecipeStep;
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const finding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "flat", brackets: [], notes: "",
    sourceUrl: "https://example.gov/fees", sourceQuote: "A sentence a person could go back and read.",
    sourceKind: "official", ...over,
  });

  // ---------------------------------------------------------------------
  // The real Coos rows, in the shape the live database holds them: the CITY
  // delegates its electrical fee to the COUNTY, and the county's table is the
  // one with the brackets. A fixture that stored the brackets on the city would
  // never exercise the hop this fee actually lives behind.
  // ---------------------------------------------------------------------
  const CITY = { state: "OR", ahj: "City of Coos Bay", track: "permit" as const };
  const COUNTY = { state: "OR", ahj: "Coos County", track: "permit" as const };
  const countyKey = feeScheduleProfileKey(COUNTY, "permit");

  saveFeeSchedule(db, { ...COUNTY, discipline: "electrical" }, finding({
    basis: "system_kw",
    brackets: [
      { maxKw: 5, feeUsd: 135, label: "5 KVA or less" },
      { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" },
      { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA" },
    ],
    sourceUrl: "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf",
    sourceQuote: "5.01 KVA to 15 KVA | $160.00",
    paymentMethod: "portal",
  }));
  saveFeeSchedule(db, { ...CITY, discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: countyKey,
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: "Solar Structural Installation Permits – separate Electrical Permit application may also be required through the county",
  }));

  const coosProject = (acKw: number): never => ({
    id: "p-coos", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    systemSizeAcKw: acKw, systemSizeDcKw: acKw * 1.35, parserSnapshot: null,
  } as never);

  const KEY_5 = `${FEE_BRACKET_FIELD_PREFIX}-5`;
  const KEY_5_15 = `${FEE_BRACKET_FIELD_PREFIX}5.01-15`;
  const KEY_15_25 = `${FEE_BRACKET_FIELD_PREFIX}15.01-25`;

  // ---------------------------------------------------------------------
  // 1. NUMERIC MATCHING ACROSS THE TWO SPELLINGS.
  // ---------------------------------------------------------------------
  check("the ACCELA label resolves to the 5.01–15 bracket key",
    feeBracketFieldForLabel(COOS_LABEL_5_15) === KEY_5_15,
    `${JSON.stringify(COOS_LABEL_5_15)} -> ${JSON.stringify(feeBracketFieldForLabel(COOS_LABEL_5_15))}`);
  check("the COUNTY SCHEDULE's own wording resolves to the SAME key — different strings, identical bounds",
    feeBracketFieldForLabel("5.01 KVA to 15 KVA") === feeBracketFieldForLabel(COOS_LABEL_5_15),
    `${feeBracketFieldForLabel("5.01 KVA to 15 KVA")} vs ${feeBracketFieldForLabel(COOS_LABEL_5_15)}`);
  check("  and the stored bracket's own bounds produce it too, so resolver and binder agree by construction",
    feeBracketFieldKey(5.01, 15) === KEY_5_15, feeBracketFieldKey(5.01, 15));
  check("a label that asks nothing about size binds to nothing",
    feeBracketFieldForLabel("Property Owner Name") === "" && feeBracketFieldForLabel("") === "");

  // ---------------------------------------------------------------------
  // 2. MUST PASS — the box is computed from THIS project's size.
  // ---------------------------------------------------------------------
  const small = feeBracketQuantityFields(db, coosProject(4.55));
  check("MUST PASS: a 4.55 kW-AC job gets \"0\" in the 5.01–15 box",
    small[KEY_5_15] === "0", JSON.stringify(small));
  check("  ...because it belongs in \"5 KVA or less\", which gets the \"1\"",
    small[KEY_5] === "1" && small[KEY_15_25] === "0", JSON.stringify(small));

  const mid = feeBracketQuantityFields(db, coosProject(9));
  check("MUST PASS: a 9 kW-AC job gets \"1\" in the 5.01–15 box",
    mid[KEY_5_15] === "1", JSON.stringify(mid));
  check("  ...and \"0\" in every other bracket — exactly one box is ticked",
    Object.values(mid).filter((v) => v === "1").length === 1 && mid[KEY_5] === "0" && mid[KEY_15_25] === "0",
    JSON.stringify(mid));

  const big = feeBracketQuantityFields(db, coosProject(20));
  check("a 20 kVA job — the case the frozen \"1\" bills in the wrong tier — ticks 15.01–25 and zeroes 5.01–15",
    big[KEY_15_25] === "1" && big[KEY_5_15] === "0", JSON.stringify(big));

  // The local containment test is a copy of the private matchBracket; it is only
  // safe because the ONE evaluator holds a veto. Pin that they agree.
  for (const [kw, expectedFee] of [[4.55, 135], [9, 160], [20, 265]] as Array<[number, number]>) {
    const line = feeForProject(db, coosProject(kw), "electrical")?.lines[0];
    const ticked = Object.entries(feeBracketQuantityFields(db, coosProject(kw))).find(([, v]) => v === "1")?.[0] ?? "";
    const expectedKey = expectedFee === 135 ? KEY_5 : expectedFee === 160 ? KEY_5_15 : KEY_15_25;
    check(`  the ticked box agrees with the one fee evaluator at ${kw} kW ($${expectedFee})`,
      line?.feeUsd === expectedFee && ticked === expectedKey,
      `evaluator=$${line?.feeUsd} "${line?.bracketLabel}" ticked=${ticked}`);
  }

  // ---------------------------------------------------------------------
  // 3. MUST PASS — replay's own known/bound check keeps a "0".
  //
  // resolveValue() returns fieldValues[field] when the key is KNOWN, and the
  // fill case rejects only a value that is falsy AS A STRING. "0" is a non-empty
  // string, so it survives both; a numeric 0 or an empty string would not. This
  // is the whole reason the answer can be a per-bracket 1/0 with NO change to
  // replay, so it is pinned here rather than assumed.
  // ---------------------------------------------------------------------
  check("MUST PASS: \"0\" is not blank to replay's fill guard (the claim that replay needs no change)",
    Boolean(String(small[KEY_5_15])) === true && String(small[KEY_5_15]) === "0");

  // ---------------------------------------------------------------------
  // 4. BINDING THE RECORDED STEP — by label, with the literal KEPT.
  // ---------------------------------------------------------------------
  const recordedStep: RecipeStep = {
    action: "fill",
    selector: { label: COOS_LABEL_5_15, css: "#ctl00_PlaceHolderMain_AppSpecB42EAF26Edit_COOS_CO_txt_0_28" },
    value: "1",
    note: COOS_LABEL_5_15,
  } as RecipeStep;
  const projectFields = { ...feeBracketQuantityFields(db, coosProject(9)), homeownerName: "Alice Anderson" };
  const converted = convertLiteralsToBoundFields([recordedStep], projectFields);
  check("the recorded literal is rebound to its own bracket key",
    converted.steps[0].field === KEY_5_15, String(converted.steps[0].field));
  check("  and the literal is KEPT — it is the fallback for a jurisdiction with no schedule on file",
    converted.steps[0].value === "1", JSON.stringify(converted.steps[0]));
  check("  a bracket binding is never a DEAD binding, so it cannot block recipe promotion",
    deadFieldBindings(converted.steps, {}).length === 0, JSON.stringify(deadFieldBindings(converted.steps, {})));

  // The operator pass that repairs an ALREADY-STORED recipe without re-learning.
  const plan = planFeeBracketBindings([recordedStep]);
  check("the stored-recipe pass plans the same binding (no re-record needed)",
    plan.length === 1 && plan[0].field === KEY_5_15, JSON.stringify(plan));
  const reapplied = applyFeeBracketBindings([recordedStep], plan);
  check("  and running it twice is a no-op — an already-bound step is skipped",
    planFeeBracketBindings(reapplied).length === 0, JSON.stringify(planFeeBracketBindings(reapplied)));

  const boundSteps = converted.steps;

  // ---------------------------------------------------------------------
  // 5. MUST EXCLUDE — an uncovered bracket is FLAGGED, never silently zeroed.
  // ---------------------------------------------------------------------
  const coveredValues = feeBracketQuantityFields(db, coosProject(9));
  const covered = feeBracketCoverage(boundSteps, coveredValues);
  check("the 9 kW job's bracket IS the recorded box, so nothing is flagged",
    covered !== null && covered.uncovered === false, JSON.stringify(covered));

  const uncoveredValues = feeBracketQuantityFields(db, coosProject(20));
  const uncovered = feeBracketCoverage(boundSteps, uncoveredValues);
  check("MUST EXCLUDE: a 20 kVA job's bracket has NO recorded step, and that is FLAGGED",
    uncovered !== null && uncovered.uncovered === true
      && uncovered.needed === KEY_15_25 && uncovered.recorded.join(",") === KEY_5_15,
    JSON.stringify(uncovered));
  check("  the flag names the bracket a person has to tick, and says what happens if they do not",
    uncovered !== null && /15\.01/.test(feeBracketCoverageMessage(uncovered))
      && /BY HAND/.test(feeBracketCoverageMessage(uncovered)),
    uncovered ? feeBracketCoverageMessage(uncovered) : "(no coverage)");
  check("  and it is NOT silently zeroed: the recipe's one box really did resolve to \"0\"",
    uncoveredValues[KEY_5_15] === "0", JSON.stringify(uncoveredValues));

  // Two boxes recorded, and the job is in the second one: covered, no flag. This
  // is what a fully-captured recipe looks like, and it must not warn.
  const bothBoxes = convertLiteralsToBoundFields(
    [recordedStep, { ...recordedStep, selector: { label: COOS_LABEL_15_25 }, note: COOS_LABEL_15_25 } as RecipeStep],
    projectFields,
  ).steps;
  check("a recipe that DID capture both boxes raises nothing for a 20 kVA job",
    feeBracketCoverage(bothBoxes, uncoveredValues)?.uncovered === false,
    JSON.stringify(feeBracketCoverage(bothBoxes, uncoveredValues)));

  // A recipe with no bracket step at all is not a coverage gap — this portal
  // does not ask the question (or the binder has not been run on it yet).
  check("a recipe with no bracket box at all says nothing",
    feeBracketCoverage([recordedStep], uncoveredValues) === null);

  // ---------------------------------------------------------------------
  // 6. MUST EXCLUDE — no schedule on file leaves the step EXACTLY as it is.
  // ---------------------------------------------------------------------
  const elsewhere = {
    id: "p-elsewhere", state: "WA", ahj: "City of Nowhere", utility: "Puget Sound Energy",
    systemSizeAcKw: 9, systemSizeDcKw: 12, parserSnapshot: null,
  } as never;
  const none = feeBracketQuantityFields(db, elsewhere);
  check("MUST EXCLUDE: no schedule on file emits NO keys — not a wrong \"0\"",
    Object.keys(none).length === 0, JSON.stringify(none));
  check("  so the unbound literal is left exactly as it is today, which is visible in the recipe",
    convertLiteralsToBoundFields([recordedStep], { homeownerName: "Alice Anderson" }).steps[0].value === "1");
  check("  and nothing is flagged for a project that has no brackets to be missing",
    feeBracketCoverage(boundSteps, none) === null);

  // A project with no system size cannot be bracketed, and a guess would be the
  // same silent wrongness.
  const sizeless = { ...(coosProject(9) as unknown as Record<string, unknown>), systemSizeAcKw: null, systemSizeDcKw: null } as never;
  check("a project with no system size emits no keys either",
    Object.keys(feeBracketQuantityFields(db, sizeless)).length === 0);

  // A size outside every published bracket must NOT come back as all-zeros: that
  // is the same under-bill through a different door.
  const huge = feeBracketQuantityFields(db, coosProject(400));
  check("MUST EXCLUDE: a size outside every published bracket emits no keys, never all-zeros",
    Object.keys(huge).length === 0, JSON.stringify(huge));

  // A flat schedule has no bracket question to answer.
  saveFeeSchedule(db, { state: "OR", ahj: "Flatville", track: "permit", discipline: "electrical" }, finding({
    basis: "flat", brackets: [{ feeUsd: 100, label: "Flat solar electrical permit" }],
  }));
  const flat = feeBracketQuantityFields(db, {
    id: "p-flat", state: "OR", ahj: "Flatville", utility: "Pacific Power",
    systemSizeAcKw: 9, systemSizeDcKw: 12, parserSnapshot: null,
  } as never);
  check("a FLAT schedule asks no bracket question, so it emits no bracket keys",
    Object.keys(flat).length === 0, JSON.stringify(flat));

  // Close before deleting the scratch DB — Windows holds the open handle as a
  // file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0
    ? "\nfeeBracketQuantity: all checks passed."
    : `\nfeeBracketQuantity: ${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
