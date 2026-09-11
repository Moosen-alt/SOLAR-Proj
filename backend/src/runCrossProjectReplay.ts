// THE LIVE CROSS-PROJECT ACCEPTANCE TEST: learn once on project A, replay for project B,
// and PROVE B's values landed while A's did not.
//
//   npx tsx backend/src/runCrossProjectReplay.ts --host <host> [--headless] [--dry-run]
//        [--keep-project] [--variant b|c] [--state XX] [--utility "Name"]
//        [--ahj "Name"] [--discipline electrical|structural]
//
// The learn benchmark's self-test replays with the SAME project it learned on, so a step
// that froze A's homeowner replays A's homeowner and still "passes" — it proves selector
// reproducibility, never field substitution. This harness is the missing half, run LIVE:
// stage a materially different project through the recipe PRODUCTION would pick, then sweep
// every reported fill against A's values (tripwires) and B's (expected). Run it twice
// (--variant b, then --variant c) for the full B/C read the operator asked for.
//
// DRIVES A REAL PORTAL. It logs in with a stored credential, fills a real application, and
// leaves a DRAFT under the operator's account — recorded in the draft ledger BEFORE the
// browser opens, because a run that dies mid-way has still created the draft. It NEVER
// clicks final submit (no autoSubmit is ever passed; stageWithRecipe stops at review),
// never pays a fee, and stops cleanly at MFA/CAPTCHA. --dry-run touches nothing.
//
// Exit codes: 0 = PASS, 1 = A's data LEAKED into B's filing, 2 = could not run
// (resolution/credential/setup), 3 = ran but the evidence is insufficient to call either way.
import "dotenv/config";
// Same discipline as the other benchmarks: a throwaway project must not enqueue code
// research for a city nobody is filing in, or auto-start anything.
process.env.SKIP_CODE_RESEARCH = "1";
process.env.AUTOPILOT_AUTO_START = "0";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { createProject, deleteProject } from "./repository";
import { findCompleteRecipeForProject, resolveRecipeFieldValues } from "./portalRecipes";
import { getDecryptedCredential, getDecryptedCredentialAny, getDecryptedCredentialByUrl, listPortalCredentials } from "./portalCredentials";
import { isUtilityPlatformUrl } from "./portalChannel";
import { recordDraftTouch } from "./draftLedger";
import { buildPortalPlanner } from "./autoLearn";
import { mergeStepReport, scoreReplayOutcome, MIN_CONFIRMED_FIELDS } from "./replayBenchmark";
import { writeBenchmarkPlaceholderDoc } from "./benchmarkPlaceholderDoc";
import {
  plannedFills, sweepTripwires, tripwireVerdict, distinctLandedKeys, valueTraces,
  type FilledField, type PlannedFill,
} from "./crossProjectReplay";
import type { ProjectRecord, RecipeStep } from "../../shared/src/types";

const OUT_DIR = path.resolve(process.cwd(), "data", "cross-project-replay");
const CLIENT = process.env.BENCHMARK_CLIENT_ID || "tml-international-llc";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// PROJECT A — what the recipe was learned on. Every distinctive value is a TRIPWIRE: if
// any of these shows up in B's filing, the recipe is replaying the learn project's data.
//
// COPIED from backend/src/runLearnBenchmark.ts (CITY_BY_STATE / ADDRESS_BY_HOST and the
// createProject payload there), not imported — importing that module executes its main()
// against live portals. If the learn fixture changes, change this table with it, or the
// tripwires describe a project that was never learned on.
// ---------------------------------------------------------------------------
const A_CITY_BY_STATE: Record<string, { city: string; zip: string; street: string; utility: string }> = {
  OR: { city: "Salem", zip: "97301", street: "555 Liberty St SE", utility: "Portland General Electric" },
  WA: { city: "Everett", zip: "98201", street: "2930 Wetmore Ave", utility: "Puget Sound Energy" },
  CA: { city: "Sacramento", zip: "95814", street: "915 I St", utility: "SMUD" },
  AZ: { city: "Phoenix", zip: "85003", street: "200 W Washington St", utility: "APS" },
  FL: { city: "Orlando", zip: "32801", street: "400 S Orange Ave", utility: "Duke Energy Florida" },
  MD: { city: "Largo", zip: "20774", street: "9400 Peppercorn Pl", utility: "Pepco" },
  MA: { city: "Everett", zip: "02149", street: "484 Broadway", utility: "Eversource" },
  OH: { city: "Columbus", zip: "43215", street: "90 W Broad St", utility: "AEP Ohio" },
  MI: { city: "Grand Rapids", zip: "49503", street: "300 Monroe Ave NW", utility: "Consumers Energy" },
  TX: { city: "Canton", zip: "75103", street: "119 N Buffalo St", utility: "Oncor" },
  IL: { city: "Springfield", zip: "62701", street: "800 E Monroe St", utility: "Ameren Illinois" },
  ID: { city: "Boise", zip: "83702", street: "150 N Capitol Blvd", utility: "Idaho Power" },
  NM: { city: "Las Cruces", zip: "88001", street: "700 N Main St", utility: "El Paso Electric" },
  NY: { city: "Buffalo", zip: "14202", street: "65 Niagara Sq", utility: "National Grid" },
  CT: { city: "Hartford", zip: "06103", street: "550 Main St", utility: "Eversource" },
  PA: { city: "Pittsburgh", zip: "15219", street: "414 Grant St", utility: "Duquesne Light" },
  ME: { city: "Portland", zip: "04101", street: "389 Congress St", utility: "Central Maine Power" },
};
const A_ADDRESS_BY_HOST: Record<string, { city: string; zip: string; street: string }> = {
  "apps.miami.gov": { city: "Miami", zip: "33133", street: "3500 Pan American Dr" },
};

/** A's distinctive values for the portal in `state`/`host`. The shared-by-design entries
 *  (utility, state, battery) are deliberately INCLUDED — they also sit in B's set, so the
 *  sweep classifies them "shared, not evidence" instead of pretending they are proof. */
function aTripwires(state: string, host: string): Record<string, string> {
  const stateLoc = A_CITY_BY_STATE[state];
  const hostLoc = A_ADDRESS_BY_HOST[host.toLowerCase()];
  const loc = hostLoc ? { ...stateLoc, ...hostLoc } : stateLoc;
  return {
    homeownerName: `Benchmark ${loc?.city ?? state}`,
    street: loc?.street ?? "",
    city: loc?.city ?? "",
    zip: loc?.zip ?? "",
    email: "permit@infinitysolarusa.com",
    phone: "(503) 555-0142",
    dcKw: "7.2", acKw: "5.22", moduleQty: "18", moduleWattage: "400",
    inverterModel: "IQ8PLUS-72-2-US",
    inverterModelCertified: "IQ8PLUS-72-2-US {240V}",
    inverterWattage: "290",
    moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
    // A carried NO account/meter (the learn payload has none) — nothing to trip on there.
    // Shared with B on purpose:
    utility: loc?.utility ?? "", state, hasBattery: "No",
  };
}

// ---------------------------------------------------------------------------
// PROJECTS B and C — materially different from A in every tripwire dimension: name,
// address, city/zip, system size, module count, inverter model, account, phone, email.
// The battery deliberately stays "No" (same as A): its guards are deterministic and
// varying it would declare storage the customer does not own.
//
// Every equipment string is VERIFIED against cec_equipment on the live DB (2026-09-10):
// IQ8M-72-2-US {240V} 325 W and IQ8A-72-2-US {240V} 349 W exist; the operator-requested
// "IQ8MPLUS" does NOT exist on the CEC list and would be a select that can never land.
// Names are deliberately ZZTest-prefixed so a human pruning portal drafts can tell a
// harness run from a real filing at a glance (same convention as the replay benchmark),
// and every digit string is audited not to collide with A's (no 7.2/72, no 18, no 400).
// ---------------------------------------------------------------------------
interface VariantFixture {
  label: string;
  homeownerName: string; email: string; phone: string;
  account: string; meter: string;
  dcKw: string; acKw: string; moduleQty: string; moduleWattage: string;
  inverterModel: string; inverterWattage: string; inverterQuantity: string;
  moduleModel: string; tilt: string; azimuth: string;
  addressByState: Record<string, { street: string; city: string; zip: string }>;
}
const VARIANTS: Record<"b" | "c", VariantFixture> = {
  b: {
    label: "B",
    homeownerName: "ZZTest CrossProject Bravo",
    email: "permit+xproj-b@infinitysolarusa.com",
    phone: "(217) 555-0179",
    // Deliberately obvious fakes with distinctive digits (never runs of zeroes — the
    // replay benchmark learned that a "0000" needle matches any digit run on the page).
    account: "30917 44286 1", meter: "ZZ73048291",
    // 14 x 405 W = 5.67 kW DC; 14 x IQ8M at 325 W = 4.55 kW AC (DC:AC 1.25, ordinary).
    dcKw: "5.67", acKw: "4.55", moduleQty: "14", moduleWattage: "405",
    inverterModel: "IQ8M-72-2-US", inverterWattage: "325", inverterQuantity: "14",
    moduleModel: "Q.PEAK DUO BLK ML-G10.a+ 405",
    tilt: "30", azimuth: "160",
    addressByState: {
      IL: { street: "914 W Eldorado St", city: "Decatur", zip: "62521" },
      OR: { street: "2419 SE Belmont St", city: "Portland", zip: "97214" },
    },
  },
  c: {
    label: "C",
    homeownerName: "ZZTest CrossProject Charlie",
    email: "permit+xproj-c@infinitysolarusa.com",
    phone: "(312) 555-0186",
    account: "58244 90317 6", meter: "ZZ64095127",
    // 22 x 405 W = 8.91 kW DC; 22 x IQ8A at 349 W = 7.68 kW AC.
    dcKw: "8.91", acKw: "7.68", moduleQty: "22", moduleWattage: "405",
    inverterModel: "IQ8A-72-2-US", inverterWattage: "349", inverterQuantity: "22",
    moduleModel: "Q.PEAK DUO BLK ML-G10.C+ 405",
    tilt: "25", azimuth: "150",
    addressByState: {
      IL: { street: "102 N Neil St", city: "Champaign", zip: "61820" },
      OR: { street: "700 NE Multnomah St", city: "Portland", zip: "97232" },
    },
  },
};

/** B's expected values — what the sweep must find on the portal for the run to PASS. */
function bExpected(v: VariantFixture, addr: { street: string; city: string; zip: string }, state: string, utility: string, fieldValues: Record<string, string>): Record<string, string> {
  return {
    homeownerName: v.homeownerName,
    street: addr.street, city: addr.city, zip: addr.zip,
    email: v.email, phone: v.phone,
    account: v.account, meter: v.meter,
    dcKw: v.dcKw, acKw: v.acKw, exportKw: v.acKw,
    moduleQty: v.moduleQty, moduleWattage: v.moduleWattage,
    inverterModel: v.inverterModel,
    // The certified rendering the replay actually types, when the resolver produced one.
    inverterModelCertified: String(fieldValues["inverterModelCertified"] ?? ""),
    moduleModelCertified: String(fieldValues["moduleModelCertified"] ?? ""),
    inverterQuantity: v.inverterQuantity, inverterWattage: v.inverterWattage,
    moduleModel: v.moduleModel,
    // Shared with A on purpose — must classify as "shared, not evidence":
    utility, state, hasBattery: "No",
  };
}

/** Names in the adapter's lists are sliced at 60 or 70 chars — compare on the overlap. */
function nameMatches(list: string[], name: string): boolean {
  const n = name.slice(0, 60);
  return list.some((entry) => String(entry).slice(0, 60) === n);
}

async function main(): Promise<void> {
  const db = await openDatabase();
  const hostArg = (arg("host") || "").trim().toLowerCase();
  const dryRun = flag("dry-run");
  const keepProject = flag("keep-project");
  const variantKey: "b" | "c" = (arg("variant") || "b").toLowerCase() === "c" ? "c" : "b";
  const variant = VARIANTS[variantKey];
  if (!hostArg) {
    console.error("usage: npx tsx backend/src/runCrossProjectReplay.ts --host <host> [--headless] [--dry-run] [--keep-project] [--variant b|c]");
    process.exit(2);
  }

  // The credential row for this host — the same store production stages with. Its
  // portal_type ("IL · Ameren Illinois (PowerClerk)") carries the state and, for a utility
  // portal, the utility's name; --state/--utility override when a label does not parse.
  const creds = listPortalCredentials(db, CLIENT);
  const cred = creds.find((c) => {
    try { return new URL(c.portalUrl).hostname.toLowerCase().includes(hostArg); } catch { return false; }
  });
  if (!cred) {
    console.error(`no stored credential for a host matching "${hostArg}" (client ${CLIENT}) — the harness only drives portals the operator has an account on.`);
    process.exit(2);
  }
  // NEVER replay through a login the portal has already refused — same rule as both
  // benchmarks: repeated failures against a real account lock the operator out.
  if (cred.stale) {
    console.error(`the stored credential for ${cred.portalUrl} was refused by the portal (${String(cred.lastLoginNote ?? "no note")}) — fix the login first; this harness will not bang on a locked door.`);
    process.exit(2);
  }
  let host = ""; try { host = new URL(cred.portalUrl).hostname.toLowerCase(); } catch { host = hostArg; }
  const portalType = String(cred.portalType || "");
  const state = (arg("state") || (portalType.includes("·") ? portalType.split("·")[0] : "")).trim().toUpperCase();
  const labelUtility = portalType.includes("·") ? portalType.split("·")[1].replace(/\(.*\)/, "").trim() : "";
  // SAFETY RULE 5's own predicate decides the track — the same one that keeps a permit
  // track off a utility portal in production, so this harness cannot drift from it.
  const scopeType: "ahj" | "utility" = isUtilityPlatformUrl(cred.portalUrl) ? "utility" : "ahj";
  const utility = (arg("utility") || labelUtility || A_CITY_BY_STATE[state]?.utility || "").trim();
  const ahjArg = (arg("ahj") || "").trim();
  const discipline = (arg("discipline") || "electrical").trim() as "electrical" | "structural";
  if (!state || (scopeType === "utility" && !utility)) {
    console.error(`could not derive ${!state ? "a state" : "a utility"} from the credential's portal_type "${portalType}" — pass --state / --utility explicitly.`);
    process.exit(2);
  }
  if (scopeType === "ahj" && !ahjArg) {
    console.error(`${host} is an AHJ portal: production resolves its recipe by the project's REAL jurisdiction. Pass --ahj "<jurisdiction>" (and --discipline) so resolution runs the way production runs it.`);
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // 1. Resolve the recipe EXACTLY as production would — findCompleteRecipeForProject with
  // the scope/state/utility (or ahj+discipline) the PROJECT carries, never by recipe id.
  // Mirrors repository.ts:5353-5358 byte for byte. A test that hand-picks the recipe
  // measures a recipe production cannot find — that is the exact defect the learn
  // benchmark had (commit 07c79eb: the verified Ameren recipe sat under a benchmark AHJ
  // key while every real NEM project resolved an unverified sibling).
  // -------------------------------------------------------------------------
  const recipe = scopeType === "utility"
    ? findCompleteRecipeForProject(db, { scopeType: "utility", state, utility })
    : findCompleteRecipeForProject(db, { scopeType: "ahj", state, ahj: ahjArg, utility, discipline });
  if (!recipe) {
    console.error(`PRODUCTION RESOLUTION FOUND NO COMPLETE RECIPE for scope=${scopeType} state=${state} ${scopeType === "utility" ? `utility="${utility}"` : `ahj="${ahjArg}" discipline=${discipline}`}.`);
    console.error(`Stopping here: a test that hand-picks the recipe measures a recipe production cannot find.`);
    console.error(`(If a verified recipe exists under a benchmark/AHJ key, it needs re-keying before this test is meaningful.)`);
    process.exit(2);
  }
  // The recipe production resolved must drive the portal the operator named. If it does
  // not, that IS the finding — report it rather than silently opening a different site.
  let recipeHost = "";
  try { recipeHost = new URL(recipe.portalUrl || String((recipe.steps.find((s) => s.action === "goto") as RecipeStep | undefined)?.value || "")).hostname.toLowerCase(); } catch { /* none recorded */ }
  if (recipeHost && recipeHost !== host) {
    console.error(`production resolution for state=${state} ${scopeType === "utility" ? `utility="${utility}"` : `ahj="${ahjArg}"`} picked the recipe for ${recipeHost} (${recipe.profileKey} v${recipe.version}), not ${host}.`);
    console.error(`That mismatch is the finding — this harness will not open a portal other than the one production would.`);
    process.exit(2);
  }
  const fills = recipe.steps.filter((s) => ["fill", "select", "check"].includes(String(s.action))).length;
  const notVerified = /NOT verified/i.test(recipe.notes || "");
  console.log(`resolved as production would: ${recipe.profileKey} [${recipe.discipline || "no discipline"}]`);
  console.log(`   recipe ${recipe.id} v${recipe.version} status=${recipe.status} — ${recipe.steps.length} step(s), ${fills} fill/select/check`);
  console.log(`   notes: ${String(recipe.notes || "").slice(0, 160)}`);
  if (notVerified) {
    console.log(`   ⚠ this is the recipe REAL projects get today, and its notes say it was never verified — the measurement is about it, not about any verified sibling banked under another key.`);
  }

  const addr = variant.addressByState[state];
  if (!addr) {
    console.error(`no ${variant.label}-fixture address for state ${state} — add a row to VARIANTS.${variantKey}.addressByState (a plausible in-state address that shares no digits with A's).`);
    process.exit(2);
  }
  const tripwires = aTripwires(state, host);

  // The full payload project B is created from — through the NORMAL creation path below,
  // exactly like a real intake, so resolveRecipeFieldValues sees what production sees.
  const payload = {
    owner: variant.homeownerName, homeownerName: variant.homeownerName,
    homeownerEmail: variant.email, homeownerPhone: variant.phone,
    street: addr.street, city: addr.city, state, zip: addr.zip,
    // A synthetic AHJ for utility scope (the utility key ignores it, and nothing this
    // harness writes may collide with a real jurisdiction row); the REAL one for AHJ scope,
    // because that is what production resolution keys on.
    ahj: scopeType === "utility" ? `Cross-Project Test ${host}` : ahjArg,
    utility, clientId: CLIENT,
    dcKw: variant.dcKw, acKw: variant.acKw, moduleQty: variant.moduleQty, moduleWattage: variant.moduleWattage,
    // Both alias spellings, deliberately — the snapshot is read by exact key and an alias
    // does not stand in (the replay benchmark learned this on inverterMake).
    account: variant.account, meter: variant.meter, exportKw: variant.acKw,
    phase: "Single Phase", voltage: "240", serviceVoltage: "240",
    energySource: "Solar", generationTechnology: "Photovoltaic",
    mainServiceRating: "200", hasBattery: "No",
    moduleMake: "Qcells North America", moduleManufacturer: "Qcells North America",
    moduleModel: variant.moduleModel,
    inverterMake: "Enphase Energy, Inc.", inverterManufacturer: "Enphase Energy, Inc.",
    inverterModel: variant.inverterModel,
    inverterQuantity: variant.inverterQuantity, inverterQty: variant.inverterQuantity,
    inverterWattage: variant.inverterWattage,
    mountType: "roof", racking: "IronRidge XR100",
    tilt: variant.tilt, azimuth: variant.azimuth,
    pvArrays: [{
      quantity: Number(variant.moduleQty), moduleManufacturer: "Qcells North America",
      moduleModel: variant.moduleModel, moduleWattage: Number(variant.moduleWattage),
      tilt: Number(variant.tilt), azimuth: Number(variant.azimuth),
    }],
    permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24",
    roofRafterSpan: "11.5", snow: "25", deadLoad: "3.0", wind: "B",
  };

  if (dryRun) {
    // Everything up to (not including) the browser, with NOTHING written — no project row,
    // no ledger entry, no report file. The plan printout is the entire output.
    const literalSteps = recipe.steps.filter((s) =>
      ["fill", "select", "check"].includes(String(s.action)) && !s.isFinalSubmit
      && String(s.value ?? "").trim() && !String(s.field ?? "").trim());
    console.log(`\nDRY RUN — no browser, no project created, no ledger entry, no report written.`);
    console.log(`\nPROJECT ${variant.label} WOULD BE CREATED (client ${CLIENT}):`);
    console.log(`   ${variant.homeownerName}, ${addr.street}, ${addr.city} ${state} ${addr.zip}`);
    console.log(`   ${variant.dcKw} kW DC / ${variant.acKw} kW AC, ${variant.moduleQty} x ${variant.moduleModel}, ${variant.inverterQuantity} x ${variant.inverterModel}, battery No`);
    console.log(`   account ${variant.account}, meter ${variant.meter}, ${variant.phone}, ${variant.email}`);
    console.log(`\nTRIPWIRES (project A values that must NOT appear):`);
    for (const [k, v] of Object.entries(tripwires)) if (v) console.log(`   ${k.padEnd(24)} ${v}`);
    console.log(`\nRECIPE STEP SHAPE: ${fills} fill/select/check step(s); ${literalSteps.length} carry a recorded LITERAL with no field binding — the place cross-project leaks live:`);
    for (const s of literalSteps.slice(0, 20)) console.log(`   [${s.action}] ${String(s.note ?? "").slice(0, 60)} = "${String(s.value).slice(0, 50)}"`);
    console.log(`\nA live run would leave ONE draft on ${host} under "${variant.homeownerName}" (never submitted), recorded in the draft ledger before the portal opens.`);
    return;
  }

  // -------------------------------------------------------------------------
  // 2. Create project B through the normal creation path.
  // -------------------------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let pid = "";
  let exitCode = 0;
  try {
    const created = createProject(db, payload as never);
    pid = created.project.id;
    const project = created.project as unknown as ProjectRecord;
    console.log(`\ncreated project ${variant.label}: ${pid} (${variant.homeownerName})`);

    const credPortalType = scopeType === "utility" ? "utility" : "AHJ";
    const fieldValues = resolveRecipeFieldValues(db, project, credPortalType);
    const expected = bExpected(variant, addr, state, utility, fieldValues);

    // Decrypted credential, resolved the way the replay benchmark (mirroring
    // repository.ts) resolves it: exact portalType, then by URL, then any for the client.
    const credential = getDecryptedCredential(db, CLIENT, credPortalType)
      ?? getDecryptedCredentialByUrl(db, CLIENT, String(recipe.portalUrl || cred.portalUrl))
      ?? getDecryptedCredentialAny(db, CLIENT, String(recipe.portalUrl || cred.portalUrl))
      ?? undefined;
    if (!credential) throw new Error(`no decryptable credential for ${host}`);

    // One browser profile per PORTAL (not per portal type) — the replay benchmark's
    // isolation discipline: PowerClerk allows one session per account, and a shared
    // profile let one portal's session kill another's run.
    const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
    const userDataDir = path.join(profileBase, CLIENT, credPortalType, host.replace(/[^a-z0-9.-]+/gi, "_"));

    // Placeholder documents for every upload slot the recipe asks for, each page headed
    // "NOT A REAL DOCUMENT" — leaving them blank would cap the walk before review.
    const docsByType: Record<string, string> = {};
    for (const st of recipe.steps ?? []) {
      const docType = String((st as { docType?: unknown }).docType ?? "");
      if (String(st.action) !== "upload" || !docType || docsByType[docType]) continue;
      docsByType[docType] = await writeBenchmarkPlaceholderDoc(
        String(st.note ?? docType).replace(/^upload\s+\S+:\s*/i, "").slice(0, 60) || docType,
        new Date().toISOString(),
      );
    }

    // THE GAP-FILL PLANNER, INJECTED EXACTLY AS PRODUCTION INJECTS IT (repository.ts
    // builds one for every recipe replay). This harness measures the PRODUCTION path —
    // recipe steps plus LLM fills for required fields the recipe never recorded — not a
    // lab version of it. Secrets never reach the LLM: buildPortalPlanner strips them.
    let planner: Awaited<ReturnType<typeof buildPortalPlanner>> | undefined;
    try {
      planner = buildPortalPlanner(db, project, {
        portalType: scopeType === "utility" ? "powerclerk" : "accela",
        scopeType,
        permitType: scopeType === "utility" ? undefined : discipline,
      } as never);
    } catch { planner = undefined; }

    // -----------------------------------------------------------------------
    // 3. WRITE IT DOWN BEFORE WE TOUCH THE PORTAL. This run logs into a real account and
    // starts a real application; it never submits, but the draft stays, and a run that
    // dies mid-way has still created it. The ledger entry is never deleted — not even by
    // this run's own cleanup.
    // -----------------------------------------------------------------------
    recordDraftTouch({
      at: new Date().toISOString(),
      host,
      portalUrl: String(recipe.portalUrl || cred.portalUrl),
      account: String(cred.usernameReference ?? ""),
      projectId: pid,
      purpose: `cross-project-replay ${variant.label}`,
      note: `staging project ${variant.label} ("${variant.homeownerName}") through recipe ${recipe.id} v${recipe.version}; replay stops at review, never submitted`,
    });

    // -----------------------------------------------------------------------
    // 4. Replay through the SAME code path production staging uses. No autoSubmit and no
    // allowFinalSubmit are EVER passed — stageWithRecipe stops at the review marker, and
    // an MFA/CAPTCHA pause ends the run cleanly (reported, never retried).
    // -----------------------------------------------------------------------
    const headless = flag("headless") ? true : (await import("../../portal-bot/src/browser")).resolveHeadless(undefined);
    const { stageWithRecipe } = await import("../../portal-bot/src/index");
    const llmSince = Date.now();
    console.log(`\nLIVE on ${host} (headless=${headless}). One draft named "${variant.homeownerName}" will remain for the operator to discard.\n`);
    const res = await stageWithRecipe(recipe, project, fieldValues, docsByType, [], {
      headless, credential, userDataDir,
      ...(planner ? { gapFillPlanner: planner.planner, gapFillFields: planner.projectFields } : {}),
    });

    // Model-call accounting from llm.ts's own instrumentation, when its export is
    // available (the sibling accounting work may rename it; this degrades to "unavailable"
    // rather than guessing). Counted in-process: replay and gap-fill share this module.
    let modelCalls: Record<string, unknown> = { unavailable: "llm.ts exposes no llmCallsSince/getRecentLlmCalls export" };
    try {
      const llmMod = await import("./llm") as unknown as Record<string, unknown>;
      const fn = (llmMod.llmCallsSince ?? llmMod.getRecentLlmCalls) as ((since: number) => Array<Record<string, unknown>>) | undefined;
      if (typeof fn === "function") {
        const calls = fn(llmSince);
        modelCalls = {
          count: calls.length,
          labels: calls.map((c) => String(c.label ?? "")),
          inTok: calls.reduce((n, c) => n + Number(c.inTok ?? 0), 0),
          outTok: calls.reduce((n, c) => n + Number(c.outTok ?? 0), 0),
        };
      }
    } catch { /* keep unavailable */ }

    // -----------------------------------------------------------------------
    // 5. Verify from the replay's own machinery, then sweep the tripwires.
    // -----------------------------------------------------------------------
    const outcome = mergeStepReport(res);
    const score = scoreReplayOutcome(outcome as never);
    const pauseReason = String((outcome.pauseReason ?? (res as Record<string, unknown>).pauseReason) || "");
    const fieldsVerified = ((outcome.fieldsVerified as string[]) ?? []).map(String);
    const fieldsUnverified = ((outcome.fieldsUnverified as string[]) ?? []).map(String);
    const unresolved = ((outcome.unresolvedFields as string[]) ?? []).map(String);
    const mismatches = ((outcome.reviewMismatches as Array<{ field?: unknown; expected?: unknown; found?: unknown }>) ?? []);

    const planned: PlannedFill[] = plannedFills(recipe.steps, fieldValues);
    // HARD EVIDENCE: values the adapter read back off the portal and confirmed held.
    // The adapter reports names only (never values, by design), so each verified name is
    // paired with the value replay resolves for that step. Two steps can share a bare
    // label ("Manufacturer" twice on PowerClerk) — both are swept, which is disclosed
    // below rather than silently collapsed.
    const verifiedFills: FilledField[] = planned.filter((p) => p.value && nameMatches(fieldsVerified, p.field));
    // SOFT EVIDENCE: values replay would type on steps the portal never confirmed —
    // maybe never reached, maybe typed and not read back. A step in unresolvedFields
    // typed NOTHING (no value, or the adapter refused another project's literal), so it
    // is excluded here and reported separately: claiming its value "possibly landed"
    // would accuse the adapter of a write it provably declined.
    const advisoryFills: FilledField[] = planned.filter((p) =>
      p.value && !nameMatches(fieldsVerified, p.field) && !nameMatches(unresolved, p.field));
    const refusedOrEmpty = planned.filter((p) => nameMatches(unresolved, p.field));

    // CLIENT-SCOPED VALUES ARE NOT CROSS-PROJECT EVIDENCE. The first live Ameren B run
    // returned "LEAKED: 3" — every one was permit@infinitysolarusa.com in an
    // installerEmail-bound field, i.e. the SOLAR COMPANY's own email doing exactly what
    // it should on the company's own filing. It matched A's tripwires only because the
    // learn fixture had reused the installer address as project A's contact email.
    // Everything the client record carries (and the credential's username reference) is
    // therefore handed to the sweep as clientScoped, and classified out of "leaked".
    const clientRow = db.get<Record<string, unknown>>("SELECT * FROM clients WHERE id = ?", [CLIENT]);
    const clientValues = [
      ...Object.values(clientRow ?? {}).map((v) => String(v ?? "")).filter((v) => v.trim().length >= 4),
      String(cred.usernameReference ?? ""),
    ];
    const verifiedSweep = sweepTripwires(verifiedFills, tripwires, expected, clientValues);
    const advisorySweep = sweepTripwires(advisoryFills, tripwires, expected, clientValues);
    // The review screen disagreeing with project B is bad; disagreeing WITH A'S VALUES is
    // the smoking gun — the hardest leak evidence the result carries.
    const mismatchLeaks = mismatches
      .map((m) => ({ field: `review:${String(m.field ?? "")}`, found: String(m.found ?? "") }))
      .filter((m) => m.found && Object.values(tripwires).some((v) => v && valueTraces(m.found, v)));

    const leaks = verifiedSweep.leaked.length + mismatchLeaks.length;
    // The adapter's own review verify compares PROJECT B to the review screen, so its
    // confirmations are B-landed evidence too (reviewFieldsConfirmed >= 3 is the same bar
    // replayBenchmark's top rung uses).
    const reviewConfirmed = Number(outcome.reviewFieldsConfirmed ?? 0);
    const landedKeys = distinctLandedKeys(verifiedSweep);
    const positiveEvidence = Math.max(landedKeys.length, reviewConfirmed);

    let verdict: string;
    let verdictReason: string;
    if (score.measured === false) {
      verdict = "NOT_MEASURED";
      verdictReason = `the run never became a measurement (${score.reason}) — no verdict about substitution is possible`;
      exitCode = 3;
    } else if (leaks > 0) {
      verdict = "LEAKED";
      const first = verifiedSweep.leaked.length
        ? `${verifiedSweep.leaked[0].field} = "${verifiedSweep.leaked[0].value.slice(0, 40)}"`
        : `${mismatchLeaks[0].field} shows "${mismatchLeaks[0].found.slice(0, 40)}"`;
      verdictReason = `${leaks} value(s) on ${variant.label}'s filing trace to the LEARN project — e.g. ${first}`;
      exitCode = 1;
    } else if (positiveEvidence >= MIN_CONFIRMED_FIELDS) {
      verdict = "PASS";
      verdictReason = `no tripwire hit; ${landedKeys.length} distinct ${variant.label} value(s) confirmed by the fill readback (${landedKeys.slice(0, 6).join(", ")}) and ${reviewConfirmed} by the review screen, over ${verifiedSweep.checkedFields} verified field(s)`;
    } else {
      // "Scores need a denominator": zero leaks over near-zero evidence is not a pass.
      verdict = "INSUFFICIENT_EVIDENCE";
      const inner = tripwireVerdict(verifiedSweep, MIN_CONFIRMED_FIELDS);
      verdictReason = `${inner.reason}; the review screen confirmed ${reviewConfirmed} value(s). The data to prove substitution simply is not there — do not read this as a pass.`;
      exitCode = 3;
    }

    // -----------------------------------------------------------------------
    // 6. Report — one JSON a row can be argued with offline, and a human summary.
    // -----------------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const reportPath = path.join(OUT_DIR, `${stamp}-${host.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
    const report = {
      at: new Date().toISOString(),
      host, variant: variant.label, projectId: pid, keepProject,
      recipe: { id: recipe.id, profileKey: recipe.profileKey, version: recipe.version, status: recipe.status, steps: recipe.steps.length, fills, notes: String(recipe.notes || "").slice(0, 300), notVerified },
      resolution: { scopeType, state, utility: scopeType === "utility" ? utility : undefined, ahj: scopeType === "ahj" ? ahjArg : undefined, discipline: scopeType === "ahj" ? discipline : undefined },
      score, pauseReason: pauseReason || null,
      modelCalls,
      verdict, verdictReason,
      tripwires, expected,
      verifiedSweep, advisorySweep,
      mismatchLeaks,
      refusedOrEmpty: refusedOrEmpty.map((p) => ({ field: p.field, source: p.source })),
      literalSteps: planned.filter((p) => p.source === "literal").map((p) => ({ field: p.field, value: p.value.slice(0, 60) })),
      gapFill: outcome.gapFill ?? null,
      requiredStillEmpty: outcome.requiredStillEmpty ?? [],
      fieldsVerified, fieldsUnverified,
      reviewFieldsSeen: Number(outcome.reviewFieldsSeen ?? 0), reviewFieldsConfirmed: reviewConfirmed,
      message: String(outcome.message ?? "").slice(0, 1200),
      caveats: [
        "field names are the adapter's own labels and are not unique — duplicate labels are swept individually and may pair a verified name with both candidate values",
        "verified-sweep values are reconstructed from the same resolver replay uses; the adapter confirms names, not values, so a portal-side reformat is absorbed by the formatting-tolerant matcher",
        "gap-fill reports labels only (never values, by design) — gap-filled fields are unverifiable by this sweep and are listed under gapFill",
      ],
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n================ CROSS-PROJECT REPLAY (${variant.label}) ================`);
    console.log(`recipe               : ${recipe.profileKey} v${recipe.version}${notVerified ? "  (never verified — this is what production replays today)" : ""}`);
    console.log(`replay rung          : ${score.index} ${score.rung} — ${score.reason.slice(0, 140)}`);
    if (pauseReason) console.log(`pause reason         : ${pauseReason} (stopped cleanly — a human gate is nobody's defect)`);
    console.log(`model calls          : ${"count" in modelCalls ? `${modelCalls.count} (${(modelCalls.labels as string[]).slice(0, 6).join(", ") || "none"})` : String(modelCalls.unavailable)}`);
    console.log(`\nTRIPWIRE SWEEP over ${verifiedSweep.checkedFields} portal-confirmed field(s):`);
    console.log(`   ${variant.label} landed        : ${verifiedSweep.landed.length} field(s), ${landedKeys.length} distinct value(s) (${landedKeys.slice(0, 8).join(", ") || "none"})`);
    console.log(`   A leaked             : ${verifiedSweep.leaked.length + mismatchLeaks.length}`);
    for (const l of verifiedSweep.leaked) console.log(`      LEAK  ${l.field} = "${l.value.slice(0, 50)}"  (A's ${l.matchedA.join("/")})`);
    for (const l of mismatchLeaks) console.log(`      LEAK  ${l.field} shows "${l.found.slice(0, 50)}" — traces to project A`);
    console.log(`   shared, not evidence : ${verifiedSweep.shared.length} (values A and B genuinely share prove nothing either way)`);
    if (verifiedSweep.clientScoped.length) console.log(`   client-scoped        : ${verifiedSweep.clientScoped.length} (the company's own values — on every filing by design, not evidence)`);
    console.log(`   unverifiable         : ${verifiedSweep.unverifiable.length} confirmed field(s) matching neither project`);
    console.log(`   ${variant.label} values unseen  : ${verifiedSweep.unfilled.length} (${verifiedSweep.unfilled.slice(0, 8).join(", ")})`);
    console.log(`   review screen        : ${Number(outcome.reviewFieldsSeen ?? 0)} field(s) read, ${reviewConfirmed} project ${variant.label} value(s) confirmed, ${mismatches.length} mismatch(es)`);
    if (advisorySweep.checkedFields) {
      console.log(`   advisory (typed but not portal-confirmed): ${advisorySweep.landed.length} ${variant.label} / ${advisorySweep.leaked.length} A-flavoured / ${advisorySweep.checkedFields} checked — soft evidence only`);
      for (const l of advisorySweep.leaked) console.log(`      advisory A-flavoured  ${l.field} = "${l.value.slice(0, 50)}" (not confirmed on the portal)`);
    }
    if (refusedOrEmpty.length) console.log(`   left blank by the adapter (no value, or another project's literal refused): ${refusedOrEmpty.length}`);
    console.log(`\nVERDICT: ${verdict} — ${verdictReason}`);
    console.log(`\nreport written to ${reportPath}`);
    console.log(`DRAFT TO DISCARD: one on ${host} named "${variant.homeownerName}" (never submitted). The ledger entry stays either way — npx tsx scripts/draft-ledger.ts`);
  } catch (e) {
    console.error(`cross-project replay failed: ${String((e as Error)?.message || e)}`);
    exitCode = 2;
  } finally {
    if (pid && !keepProject) {
      try { deleteProject(db, pid); console.log(`cleaned up project ${pid} (--keep-project to keep it). The draft-ledger entry is NEVER deleted — the portal-side draft is real either way.`); }
      catch { console.warn(`could not delete project ${pid} — remove it by hand`); }
    } else if (pid) {
      console.log(`kept project ${pid} (--keep-project)`);
    }
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(2); });
