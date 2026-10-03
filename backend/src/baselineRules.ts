import type { ParserPayload, QcStatus, Severity } from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { knownPowerClerkUtility } from "./utilityIdentity";
import { isBillHolderName, nemApplicantName } from "./accountHolders";

export interface BaselineRuleDefinition {
  id: string;
  ruleType: "qc" | "correction" | "monitor";
  name: string;
  jurisdictionScope: string;
  utilityScope: string;
  source: string;
  severity: Severity;
  trigger: string;
  action: string;
}

export interface BaselineQcResult {
  ruleId: string;
  ruleName: string;
  qcStatus: QcStatus;
  severity: Severity;
  message: string;
  fieldName?: string;
}

export const baselineRuleDefinitions: BaselineRuleDefinition[] = [
  {
    id: "xcheck-nem-account-holder",
    ruleType: "qc",
    name: "Applicant vs utility account holder",
    jurisdictionScope: "Any",
    utilityScope: "Any interconnection portal",
    source: "Utility interconnection practice (observed: PacifiCorp APP-111681 suspension)",
    severity: "warning",
    trigger: "The name on the application differs from the account holder printed on the utility bill",
    action: "Add the applicant to the account, put the service in their name, or name the account holder on the application — before filing.",
  },
  {
    id: "or-nem-residential-25kw",
    ruleType: "qc",
    name: "Oregon residential NEM size screen",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0010",
    severity: "warning",
    trigger: "Residential net metering facility over 25 kW DC",
    action: "Flag for non-standard NEM review or commercial/non-residential confirmation.",
  },
  {
    id: "or-nem-tier1-export-25kw",
    ruleType: "qc",
    name: "Oregon Tier 1 export screen",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0030",
    severity: "warning",
    trigger: "Export capacity over 25 kW or generation over 50 kW",
    action: "Flag likely Tier 2/3 utility review path before submission.",
  },
  {
    id: "or-nem-manual-disconnect",
    ruleType: "qc",
    name: "Oregon NEM manual disconnect",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0005",
    severity: "warning",
    trigger: "AC disconnect requirement not identified",
    action: "Confirm lockable load-break disconnect or documented utility exception.",
  },
  {
    id: "or-prescriptive-snow-70",
    ruleType: "qc",
    name: "Oregon prescriptive snow limit",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD Form 440-5952",
    severity: "warning",
    trigger: "Ground snow load over 70 psf or missing",
    action: "Route to engineered path or human structural review.",
  },
  {
    id: "or-prescriptive-deadload-4_5",
    ruleType: "qc",
    name: "Oregon prescriptive dead load limit",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD Form 440-5952",
    severity: "warning",
    trigger: "PV system dead load over 4.5 psf or missing",
    action: "Route to engineered path or verify stamped structural basis.",
  },
  {
    id: "or-prescriptive-roof-framing",
    ruleType: "qc",
    name: "Oregon prescriptive roof framing",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD Form 440-5952",
    severity: "warning",
    trigger: "Rafter/truss spacing missing or over 24 inches",
    action: "Require engineered path or verified framing exception.",
  },
  {
    id: "or-fire-pathways",
    ruleType: "qc",
    name: "Oregon PV firefighter pathways",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD PV Pathways Technical Bulletin",
    severity: "warning",
    trigger: "Rooftop PV with no pathway/site plan evidence",
    action: "Confirm site plan shows required firefighter access and escape pathways.",
  },
  {
    id: "portland-submittal-docs",
    ruleType: "qc",
    name: "Portland solar submittal documents",
    jurisdictionScope: "Portland",
    utilityScope: "",
    source: "Portland Solar Permits",
    severity: "warning",
    trigger: "Portland project missing site/fire/framing/cross-section/racking evidence",
    action: "Flag missing plan sheets before DevHub submission.",
  },
  {
    id: "portland-ready-for-issue",
    ruleType: "monitor",
    name: "Portland ready for issue status",
    jurisdictionScope: "Portland",
    utilityScope: "",
    source: "Portland Solar Permits pre-issuance section",
    severity: "info",
    trigger: "Pre-issuance complete / ready to issue / fees due",
    action: "Flag ready_for_issue and queue human fee/payment/download step.",
  },
  {
    id: "pacpower-ul1741sb",
    ruleType: "qc",
    name: "Pacific Power UL 1741 SB inverter settings",
    jurisdictionScope: "Oregon",
    utilityScope: "Pacific Power/PacifiCorp",
    source: "Pacific Power Customer Generation",
    severity: "warning",
    trigger: "Pacific Power project lacks UL 1741 SB / inverter settings evidence",
    action: "Confirm inverter spec/settings package before NEM submission.",
  },
  {
    id: "pacpower-meter-photo",
    ruleType: "qc",
    name: "Pacific Power meter photo requirement",
    jurisdictionScope: "Oregon",
    utilityScope: "Pacific Power/PacifiCorp",
    source: "Pacific Power Customer Generation",
    severity: "warning",
    trigger: "Pacific Power project missing meter evidence",
    action: "Require meter number/photo before application.",
  },
  {
    id: "pge-powerclerk-docs",
    ruleType: "qc",
    name: "PGE interconnection package",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE",
    source: "PGE Interconnection Resource Library",
    severity: "warning",
    trigger: "PGE project missing SLD/site/spec package evidence",
    action: "Confirm SLD, site/plot plan, equipment specs, and utility bill/meter data.",
  },
];

function str(payload: ParserPayload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(payload: ParserPayload, key: string): number | null {
  const cleaned = str(payload, key).replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

// THE AC DISCONNECT PART — ONE ANSWER FOR QC AND FOR THE PORTAL FILING (leak sweep 2026-09-28).
//
// The plan set's part (acDiscMakeModel, split into make + model; the legacy acDiscMake/acDiscModel
// keys win when a snapshot carries them) beats the installer's standard part. The standard part is a
// default for a plan set that leaves the part to the installer, and it is cross-checked against the
// plan set's own rating and fusing — a disagreement is named for the operator, never filed.
export interface PlanSetDisconnectPart { make: string; model: string; named: boolean }
export function planSetDisconnectPart(payload: Record<string, unknown>): PlanSetDisconnectPart {
  const s = (k: string): string => String(payload[k] ?? "").trim();
  let make = s("acDiscMake");
  let model = s("acDiscModel");
  const combined = s("acDiscMakeModel").replace(/\s+/g, " ");
  if (combined && !/^(n\/?a|none|unknown|not (specified|shown|listed))$/i.test(combined) && (!make || !model)) {
    const tokens = combined.split(" ");
    // The model is the first part-number-shaped token after the make ("Square D DU222RB",
    // "Eaton DG222NRB 60A" -> DG222NRB): letters AND digits, 4+ characters, not a rating.
    const idx = tokens.findIndex((t, i) => i > 0 && /[a-z]/i.test(t) && /\d/.test(t) && t.replace(/[^a-z0-9]/gi, "").length >= 4 && !/^\d+(a|v|amps?|volts?)$/i.test(t));
    // No part number and the words describe a RATING ("60A NON-FUSIBLE AC DISCONNECT") — that is the
    // schedule's rating line, not a manufacturer; it names no part.
    const ratingText = idx <= 0 && /\bdisconnect\b|\bfus(?:ed|ible)\b|^\d+\s*a\b|\bamps?\b|\bvolts?\b|\b\d+\s*v\b/i.test(combined);
    const splitMake = idx > 0 ? tokens.slice(0, idx).join(" ") : ratingText ? "" : combined;
    const splitModel = idx > 0 ? tokens[idx] : "";
    make = make || splitMake;
    model = model || splitModel;
  }
  return { make, model, named: Boolean(make || model) };
}
export interface DisconnectConflict { ruleId: "xcheck-disconnect-fusing" | "xcheck-disconnect-rating"; ruleName: string; message: string; fieldName: string }
/** Where the installer's standard part contradicts the plan set's rating or fusing. Asserts only what
 *  the part number itself states (Eaton DG-series: "DG221URB" — "U" unfused, frame "221" = 30 A /
 *  2-pole / 240 V); an unrecognised model asserts nothing. */
export function standardDisconnectConflicts(stdModel: string, plan: { fused?: string | null; amps?: number | null }): DisconnectConflict[] {
  const out: DisconnectConflict[] = [];
  const model = String(stdModel ?? "").trim();
  if (!model) return out;
  const discFused = String(plan.fused ?? "").toLowerCase();
  const modelIsNonFused = /dg\d{3}u/i.test(model);
  const modelIs30A = /dg2\s*2\s*1/i.test(model.replace(/[^a-z0-9]/gi, ""));
  if (modelIsNonFused && /fusible/.test(discFused) && !/non/.test(discFused)) {
    out.push({
      ruleId: "xcheck-disconnect-fusing", ruleName: "AC disconnect fusing vs the standard part", fieldName: "acDiscFused",
      message: `The plan set specifies a FUSIBLE AC disconnect, but the installer's standard part (${model}) is non-fusible. Confirm which is actually being installed before the utility application is filed — the disconnect make/model is left blank on the utility application until then.`,
    });
  }
  if (modelIs30A && plan.amps != null && plan.amps > 30) {
    out.push({
      ruleId: "xcheck-disconnect-rating", ruleName: "AC disconnect rating vs the standard part", fieldName: "acDiscAmps",
      message: `The plan set calls for a ${plan.amps} A AC disconnect, but the installer's standard part (${model}) is rated 30 A. Confirm the disconnect size before filing — the disconnect make/model is left blank on the utility application until then.`,
    });
  }
  return out;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function result(
  ruleId: string,
  ruleName: string,
  qcStatus: QcStatus,
  severity: Severity,
  message: string,
  fieldName?: string,
): BaselineQcResult {
  return { ruleId, ruleName, qcStatus, severity, message, fieldName };
}

/**
 * Do two names refer to the same person (or a household that includes them)?
 *
 * Deliberately GENEROUS — a false alarm on "ROBERT J SMITH" vs "Bob Smith" would train
 * operators to click past the one warning that stops a suspended application. It answers
 * "could these be the same person / is the applicant on this account", not "are these
 * strings equal". Only a genuine disagreement of PERSON is reported.
 *
 * Joint accounts are the common shape ("JOHN & JANE SMITH", "SMITH, JOHN A"), so the bill
 * side is treated as a SET of names: agreement means the applicant appears among them.
 */
export function namesAgree(applicant: string, accountHolder: string): boolean {
  const TITLES = /^(mr|mrs|ms|miss|dr|rev|sir|madam|mister)$/;
  const SUFFIXES = /^(jr|sr|ii|iii|iv|v)$/;
  const tokens = (s: string): string[] =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .replace(/[^a-z\s&]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !TITLES.test(t) && !SUFFIXES.test(t) && t !== "and" && t !== "&");

  const a = tokens(applicant);
  const b = tokens(accountHolder);
  if (a.length === 0 || b.length === 0) return true; // nothing to compare — say nothing

  // The account holder's surname is the last token of the LAST name on the bill; a joint
  // account usually shares it ("JOHN & JANE SMITH"). If the applicant shares no surname
  // with the account at all, they are plainly a different household.
  const aLast = a[a.length - 1];
  const bSet = new Set(b);
  if (!bSet.has(aLast)) return false;

  // Surname matches. Now the given name must also be accounted for, or this is a
  // DIFFERENT PERSON IN THE SAME HOUSEHOLD — a spouse, which is exactly the Simmons case
  // and exactly what the utility rejects.
  const aGiven = a.slice(0, -1);
  if (aGiven.length === 0) return true; // surname only — nothing more to disagree about

  return aGiven.some((g) => {
    if (bSet.has(g)) return true;
    // Initial vs full name, in either direction: "J Smith" vs "John Smith".
    if (g.length === 1) return b.some((t) => t.startsWith(g));
    return b.some((t) => t.length === 1 && g.startsWith(t));
  });
}

export function evaluateBaselineRules(payload: ParserPayload, ctx?: EffectiveCodeContext): BaselineQcResult[] {
  const out: BaselineQcResult[] = [];
  const state = str(payload, "state").toUpperCase();
  const ahj = str(payload, "ahj");
  const utility = str(payload, "utility");
  const utilityUpper = utility.toUpperCase();
  const dcKw = num(payload, "dcKw");
  // System additions: NEM program caps apply to the TOTAL generation on the
  // service, so screen on the combined (new + existing) size when present.
  const combinedDcKw = num(payload, "combinedDcKw");
  const screenDcKw = combinedDcKw != null && (dcKw == null || combinedDcKw > dcKw) ? combinedDcKw : dcKw;
  const combinedNote = screenDcKw !== dcKw ? " (combined new + existing system size)" : "";
  const exportKw = num(payload, "exportKw");
  const snow = num(payload, "snow");
  const deadLoad = num(payload, "deadLoad");
  const rafterSpacing = num(payload, "roofRafterSpacing");
  const wind = str(payload, "wind");
  const split = `${str(payload, "splitPagesText")}\n${str(payload, "utilityDownloadChecklistText")}`;
  const notes = `${str(payload, "utilityUploadNotesText")}\n${str(payload, "projectDescriptionText")}\n${str(payload, "sitePlanNotesText")}`;
  // A KNOWN NON-OREGON STATE IS NEVER OREGON. The AHJ-name fallback exists for payloads with no
  // state; with one, "Portland" (Maine), "Salem" (Massachusetts) or "Washington County"
  // (Pennsylvania) must not pull Oregon's NEM program, prescriptive limits or PGE's package in.
  const nonOregonState = !!state && state !== "OR";
  const isOregon = state === "OR" || (!nonOregonState && /oregon|portland|hillsboro|beaverton|gresham|clackamas|washington county/i.test(ahj));
  const isPortland = isOregon && /portland/i.test(ahj);
  // WHICH UTILITY, by the one anchored, state-gated identity (utilityIdentity) — a CA PG&E job
  // ("Pacific Gas and Electric", "PGE") or WA's "Pacific County PUD" is neither Pacific Power nor
  // Portland General, and must not be told a Pacific Power meter photo is missing.
  const knownUtility = knownPowerClerkUtility({ state, utility });
  const isPacific = knownUtility === "pacificorp";
  const isPge = knownUtility === "portland_general";

  // PRESCRIPTIVE-PATH SCREENS — data-driven when a jurisdiction code context is
  // provided (the per-AHJ adopted-codes profile), so any state/county with limits
  // recorded gets the same screening Oregon always had. Without a context, the
  // legacy behavior is preserved exactly: Oregon regex + the historical constants.
  // The Oregon NEM PROGRAM rules below (25 kW residential cap, manual disconnect)
  // stay Oregon-gated — they are OAR 860-039 utility-program policy, not adopted
  // building-code data. Rule IDs keep their legacy "or-…" form for Oregon (blocker
  // gating, QC history, and the goldens key off them) and use "<state>-…" elsewhere.
  // A LIMIT FRAGMENT IS NOT A PRESCRIPTIVE PATH (permitPath.ts says the same): Florida's seeded
  // state profile carries allowedWindExposures ["B","C","D"] — correct design-criteria data that
  // says nothing about a prescriptive PV path — and this file's screens printed "should be B or C
  // or D for the prescriptive path" from it. Outside Oregon the screens run only where the
  // jurisdiction's own research names a prescriptive path, or a NUMERIC structural limit (snow,
  // dead load, spacing) is recorded for it — an exposure list alone is not a screen. A researched
  // "publishes no prescriptive path" (false) switches every screen off.
  const rawLimits = ctx
    ? ctx.prescriptive
    : isOregon
      ? { maxGroundSnowPsf: 70, maxPvDeadLoadPsf: 4.5, maxRafterSpacingIn: 24, allowedWindExposures: ["B", "C"], maxExportKwWithoutStudy: 25 }
      : {};
  const screensApply = isOregon || rawLimits.hasPrescriptivePath === true
    || (rawLimits.hasPrescriptivePath !== false && [rawLimits.maxGroundSnowPsf, rawLimits.maxPvDeadLoadPsf, rawLimits.maxRafterSpacingIn].some((v) => typeof v === "number"));
  const limits = screensApply ? rawLimits : { ...(rawLimits.maxExportKwWithoutStudy != null ? { maxExportKwWithoutStudy: rawLimits.maxExportKwWithoutStudy } : {}) };
  const jurisLabel = ctx && !(state === "OR" || /oregon/i.test(ahj)) ? (ctx.ahj || ctx.state || "the jurisdiction") : "Oregon";
  const idPrefix = (ctx ? (ctx.state || "jurisdiction") : "OR").toLowerCase() === "or" ? "or" : (ctx?.state || "jurisdiction").toLowerCase();
  const prescriptiveIds = idPrefix === "or"
    ? { snow: "or-prescriptive-snow-70", dead: "or-prescriptive-deadload-4_5", framing: "or-prescriptive-roof-framing", wind: "or-prescriptive-wind-exposure", fire: "or-fire-pathways", export: "or-nem-tier1-export-25kw" }
    : { snow: `${idPrefix}-prescriptive-snow`, dead: `${idPrefix}-prescriptive-deadload`, framing: `${idPrefix}-prescriptive-roof-framing`, wind: `${idPrefix}-prescriptive-wind-exposure`, fire: `${idPrefix}-fire-pathways`, export: `${idPrefix}-export-study-screen` };

  // -------------------------------------------------------------------------
  // DETERMINISTIC PARSER CROSS-CHECKS — jurisdiction-agnostic arithmetic over
  // the parsed payload. These catch exactly the extraction errors (transposed
  // digits, unit swaps, wrong-system values) that otherwise surface as an AHJ
  // correction cycle days later. Warning severity only: never a hard block.
  // -------------------------------------------------------------------------
  const moduleQty = num(payload, "moduleQty") ?? num(payload, "moduleQuantity");
  const moduleWattage = num(payload, "moduleWattage") ?? num(payload, "moduleWatts");
  if (moduleQty != null && moduleWattage != null && dcKw != null && moduleQty > 0 && moduleWattage > 0) {
    const computedDc = (moduleQty * moduleWattage) / 1000;
    // Tolerance: 150 W absolute floor, or 1.5% for larger systems — plan sets
    // legitimately round the nameplate (140 × 430 W = 60.2 stated as "60 kW").
    const tolerance = Math.max(0.15, dcKw * 0.015);
    if (Math.abs(computedDc - dcKw) > tolerance) {
      out.push(result(
        "xcheck-module-math",
        "Module math vs DC size",
        "warning",
        "warning",
        `${moduleQty} × ${moduleWattage} W = ${computedDc.toFixed(2)} kW DC, but dcKw is ${dcKw}. One of the three was misread — verify against the plan set before staging.`,
        "dcKw",
      ));
    }
  }
  const existingDcKw = num(payload, "existingDcKw");
  if (dcKw != null && existingDcKw != null && combinedDcKw != null && Math.abs(combinedDcKw - (dcKw + existingDcKw)) > 0.1) {
    out.push(result(
      "xcheck-combined-size",
      "Combined system size arithmetic",
      "warning",
      "warning",
      `combinedDcKw ${combinedDcKw} ≠ new ${dcKw} + existing ${existingDcKw} = ${(dcKw + existingDcKw).toFixed(2)} kW. Verify which value the plan set actually states.`,
      "combinedDcKw",
    ));
  }
  const acKw = num(payload, "acKw");
  if (dcKw != null && acKw != null && dcKw > 0 && acKw > dcKw * 1.1) {
    out.push(result(
      "xcheck-dc-ac-ratio",
      "DC/AC ratio sanity",
      "warning",
      "warning",
      `AC size ${acKw} kW exceeds DC size ${dcKw} kW by >10% — almost always a swapped or misread value. Verify both against the plan set.`,
      "acKw",
    ));
  }
  // NEC 705/240: the backfed PV breaker must be ≥ 125% of the inverters'
  // continuous output current. invOutputW/pvMicroOutputW hold rated output
  // CURRENT in amps per unit (see the parser prompt).
  const pvBreaker = num(payload, "pvBreaker");
  const unitAmps = num(payload, "invOutputW") ?? num(payload, "pvMicroOutputW");
  const unitQty = num(payload, "invOutputW") != null ? (num(payload, "invQty") ?? 1) : (num(payload, "pvMicroQty") ?? num(payload, "invQty") ?? 1);
  // PLAUSIBILITY GUARD: these fields are DOCUMENTED as amps per unit, but real
  // payloads sometimes carry the WATT rating (e.g. an IQ8M parsed as 325). A
  // per-unit residential inverter output above 100 A — or a computed minimum
  // beyond any residential backfeed breaker — means the units are off, and a
  // false warning would erode trust in every other cross-check. Stay silent.
  if (pvBreaker != null && unitAmps != null && unitAmps > 0 && unitAmps <= 100 && unitQty > 0) {
    const minBreaker = 1.25 * unitAmps * unitQty;
    if (minBreaker <= 400 && pvBreaker < minBreaker - 0.01) {
      out.push(result(
        "xcheck-pv-breaker-125",
        "PV breaker 125% continuous-output check",
        "warning",
        "warning",
        `PV breaker ${pvBreaker} A is below 125% of the inverters' continuous output (${unitQty} × ${unitAmps} A × 1.25 = ${minBreaker.toFixed(1)} A minimum). Verify the breaker size or the inverter output current.`,
        "pvBreaker",
      ));
    }
  }

  // AC DISCONNECT vs the installer's STANDARD part. Utility portals require a disconnect
  // make and model, and a plan set's equipment schedule specifies only the RATING ("60A
  // NON-FUSIBLE AC DISCONNECT, 240V") — it leaves the part to the installer, so make/model
  // comes from a per-installer default. That default is a CONSTANT while the plan set
  // varies per job, which is exactly where a silent mismatch hides: filing a 30 A
  // non-fusible part against a plan set calling for a 60 A FUSIBLE switch is wrong on the
  // application AND wrong on the roof. Surface the disagreement instead of letting the
  // default quietly win. Observed on real plan sets: two of four called for FUSIBLE while
  // the installer's standard part is non-fusible.
  // The client's standard part reaches this payload from runQcForProject (qc.ts), read from the
  // project's OWN client row; a plan set that names its own disconnect part is filed as named
  // (portalRecipes), so the standard part is not in play and nothing is cross-checked.
  const stdModel = String((payload as Record<string, unknown>).standardDisconnectModel ?? "").trim();
  if (stdModel && !planSetDisconnectPart(payload).named) {
    for (const c of standardDisconnectConflicts(stdModel, { fused: str(payload, "acDiscFused"), amps: num(payload, "acDiscAmps") })) {
      out.push(result(c.ruleId, c.ruleName, "warning", "warning", c.message, c.fieldName));
    }
  }

  // THE APPLICANT MUST BE ON THE UTILITY ACCOUNT.
  // An interconnection application is filed against a SERVICE, and the utility will only
  // accept it from someone listed on that service's account. The homeowner on the plan set
  // and the name printed on the utility bill are two different facts, and when they
  // disagree the application is suspended — not corrected, suspended, with a clock on it.
  //
  // Live: David Simmons' PacifiCorp application (APP-111681) was filed with
  // homeownerName "David Simmons" while the bill we had already parsed read
  // "STEPHANIE SIMMONS". PacifiCorp's reply: "David Simmons is not listed on the account.
  // They will need to be added to the account as a co-customer or have the electric service
  // put into their name; and/or to have the primary electric account holders name added to
  // the application" — 10 business days to fix or the request may be withdrawn. Both names
  // were in the payload at QC time; nothing compared them.
  //
  // Utility-agnostic: every interconnection portal asks who holds the account.
  const applicantName = str(payload, "homeownerName") || str(payload, "owner");
  const accountHolder = str(payload, "ubAccountHolder");
  const utilityName = str(payload, "utility");
  // A bill read that is not a holder at all — the utility's website ("Pnm.Com", #28), a phone or
  // number line, the utility's own name, a bill label — is not a different person: comparing it
  // told the operator the application would be filed in the name of a web address. Ask for the
  // holder instead. The rejected read is NOT echoed: it may be a number line off the bill.
  if (accountHolder && !isBillHolderName(accountHolder, utilityName)) {
    out.push(result(
      "xcheck-nem-account-holder",
      "Applicant vs utility account holder",
      "warning",
      "warning",
      `Utility account holder not read from the bill — verify. What the bill reader returned is not a person or ` +
        `business (a web address, email, phone or number line, the utility's own name, or a bill label), so it is ` +
        `ignored. Enter the account holder exactly as the bill's customer block prints it: the interconnection ` +
        `application names the account holder${applicantName ? `, and until one is entered it names ${applicantName}` : ""}.`,
      "ubAccountHolder",
    ));
  } else if (applicantName && accountHolder && !namesAgree(applicantName, accountHolder)) {
    out.push(result(
      "xcheck-nem-account-holder",
      "Applicant vs utility account holder",
      "warning",
      "warning",
      `The application names ${applicantName}, but the utility bill's account holder is ${accountHolder}. ` +
        `An interconnection request from someone not listed on the account gets suspended. Before filing, either add ` +
        `the applicant to the account as a co-customer, put the service in their name, or name ${accountHolder} on the ` +
        `application as the account holder. As filed, the interconnection application names ${nemApplicantName(accountHolder, applicantName, utilityName)} ` +
        `(the bill's primary holder — operator ruling 2026-09-28); the permits keep ${applicantName}.`,
      "ubAccountHolder",
    ));
  }

  if (isOregon && screenDcKw != null && screenDcKw > 25) {
    out.push(result(
      "or-nem-residential-25kw",
      "Oregon residential NEM size screen",
      "warning",
      "warning",
      `DC size is ${screenDcKw} kW${combinedNote}. Confirm this is not a residential OAR 860-039 net metering project capped at 25 kW.`,
      "dcKw",
    ));
  }

  // Export-study screen: threshold from the jurisdiction profile (Oregon Tier 1 = 25 kW
  // export / 50 kW DC). The DC arm stays at 2x the export limit, matching the legacy 25/50 pair.
  const exportLimit = limits.maxExportKwWithoutStudy;
  if (exportLimit != null && ((screenDcKw != null && screenDcKw > exportLimit * 2) || (exportKw != null && exportKw > exportLimit))) {
    out.push(result(
      prescriptiveIds.export,
      idPrefix === "or" ? "Oregon Tier 1 export screen" : `${jurisLabel} export/interconnection study screen`,
      "warning",
      "warning",
      idPrefix === "or"
        ? `Generation/export may exceed Tier 1 screens (${screenDcKw ?? "?"} kW DC${combinedNote} / ${exportKw ?? "?"} kW export). Confirm Tier 2/3 utility path.`
        : `Generation/export may exceed the ${exportLimit} kW screen (${screenDcKw ?? "?"} kW DC${combinedNote} / ${exportKw ?? "?"} kW export). Confirm the utility study path.`,
      "exportKw",
    ));
  }

  if (isOregon && !/yes|required|provided|shown|lockable|visible/i.test(str(payload, "acDiscReq"))) {
    out.push(result(
      "or-nem-manual-disconnect",
      "Oregon NEM manual disconnect",
      "warning",
      "warning",
      "AC/manual disconnect requirement was not clearly identified. Confirm lockable load-break disconnect or documented utility exception.",
      "acDiscReq",
    ));
  }

  if (limits.maxGroundSnowPsf != null && (snow == null || snow > limits.maxGroundSnowPsf)) {
    out.push(result(
      prescriptiveIds.snow,
      `${jurisLabel} prescriptive snow limit`,
      "warning",
      "warning",
      snow == null ? "Ground snow load is missing for prescriptive-path screening." : `Ground snow load ${snow} psf exceeds ${jurisLabel} prescriptive ${limits.maxGroundSnowPsf} psf screen.`,
      "snow",
    ));
  }

  if (limits.maxPvDeadLoadPsf != null && (deadLoad == null || deadLoad > limits.maxPvDeadLoadPsf)) {
    out.push(result(
      prescriptiveIds.dead,
      `${jurisLabel} prescriptive dead load limit`,
      "warning",
      "warning",
      deadLoad == null ? "PV dead load is missing for prescriptive-path screening." : `PV dead load ${deadLoad} psf exceeds ${jurisLabel} prescriptive ${limits.maxPvDeadLoadPsf} psf screen.`,
      "deadLoad",
    ));
  }

  if (limits.maxRafterSpacingIn != null && (rafterSpacing == null || rafterSpacing > limits.maxRafterSpacingIn)) {
    out.push(result(
      prescriptiveIds.framing,
      `${jurisLabel} prescriptive roof framing`,
      "warning",
      "warning",
      rafterSpacing == null ? "Roof framing spacing is missing." : `Roof framing spacing ${rafterSpacing} inches exceeds ${jurisLabel} prescriptive ${limits.maxRafterSpacingIn} inch screen.`,
      "roofRafterSpacing",
    ));
  }

  const allowedWind = limits.allowedWindExposures;
  if (allowedWind && allowedWind.length && wind && !allowedWind.some((w) => new RegExp(`\\b${w}\\b`, "i").test(wind))) {
    out.push(result(
      prescriptiveIds.wind,
      `${jurisLabel} prescriptive wind exposure`,
      "warning",
      "warning",
      `Wind exposure "${wind}" should be ${allowedWind.join(" or ")} for the prescriptive path.`,
      "wind",
    ));
  }

  // Fire pathway screen follows the prescriptive screens: any jurisdiction with
  // prescriptive limits recorded (or legacy Oregon) expects pathway evidence.
  const firePathwayScreen = Object.values(limits).some((v) => v != null && (!Array.isArray(v) || v.length > 0));
  if (firePathwayScreen && !hasAny(`${split}\n${notes}`, [/fire/i, /pathway/i, /access path/i, /escape path/i, /site.*plan/i])) {
    out.push(result(
      prescriptiveIds.fire,
      `${jurisLabel} PV firefighter pathways`,
      "warning",
      "warning",
      "No site/fire pathway evidence found. Confirm required firefighter access and escape pathways are shown.",
      "splitPagesText",
    ));
  }

  if (isPortland) {
    const missing: string[] = [];
    if (!hasAny(split, [/site/i, /plot/i])) missing.push("site/plot plan");
    if (!hasAny(`${split}\n${notes}`, [/fire/i, /pathway/i, /access path/i])) missing.push("fire access path");
    if (!hasAny(split, [/roof/i, /framing/i])) missing.push("roof framing/roof plan");
    if (!hasAny(split, [/section/i, /cross/i])) missing.push("roof cross-section");
    if (!hasAny(split, [/rack/i, /mount/i, /attachment/i])) missing.push("racking attachment");
    if (missing.length) {
      out.push(result(
        "portland-submittal-docs",
        "Portland solar submittal documents",
        "warning",
        "warning",
        `Portland package may be missing: ${missing.join(", ")}.`,
        "splitPagesText",
      ));
    }
  }

  if (isPacific && !hasAny(`${split}\n${notes}`, [/UL\s*1741\s*SB/i, /inverter settings/i, /smart inverter/i])) {
    out.push(result(
      "pacpower-ul1741sb",
      "Pacific Power UL 1741 SB inverter settings",
      "warning",
      "warning",
      "Pacific Power project lacks clear UL 1741 SB / inverter settings evidence.",
      "utilityUploadNotesText",
    ));
  }

  if (isPacific && !str(payload, "meter") && !str(payload, "ubMeterNumber")) {
    out.push(result(
      "pacpower-meter-photo",
      "Pacific Power meter photo requirement",
      "warning",
      "warning",
      "Pacific Power application should include meter evidence; no meter number was captured.",
      "meter",
    ));
  }

  if (isPge) {
    const pgeMissing: string[] = [];
    if (!hasAny(split, [/SLD/i, /3-line/i, /single line/i])) pgeMissing.push("SLD/3-line");
    if (!hasAny(split, [/site/i, /plot/i])) pgeMissing.push("site/plot plan");
    if (!hasAny(split, [/module/i])) pgeMissing.push("module spec");
    if (!hasAny(split, [/inverter/i, /microinverter/i])) pgeMissing.push("inverter spec");
    if (!str(payload, "account") && !str(payload, "ubAccountNumber")) pgeMissing.push("utility account");
    if (pgeMissing.length) {
      out.push(result(
        "pge-powerclerk-docs",
        "PGE interconnection package",
        "warning",
        "warning",
        `PGE package may be missing: ${pgeMissing.join(", ")}.`,
        "utilityDownloadChecklistText",
      ));
    }
  }

  // EXISTING-SYSTEM / NEM-ADDITION SCREENS (advisory — warnings only, never a
  // blocker). Additions must disclose the existing system on interconnection
  // applications; screen for the disclosure data being present and for the CA
  // NEM1/NEM2 grandfathering expansion allowance.
  const hasExisting = /^yes$/i.test(str(payload, "hasExistingSystem")) || /^yes$/i.test(str(payload, "existingSystem"));
  if (hasExisting) {
    const existingDcKw = num(payload, "existingDcKw");
    const existingInvMake = str(payload, "existingInvMake") || str(payload, "existingInverterMake");
    const existingInvModel = str(payload, "existingInvModel") || str(payload, "existingInverterModel");
    const disclosureMissing: string[] = [];
    if (existingDcKw == null) disclosureMissing.push("existing system DC size (existingDcKw)");
    if (!existingInvMake || !existingInvModel) disclosureMissing.push("existing inverter make/model");
    if (combinedDcKw == null) disclosureMissing.push("combined (existing + new) DC size (combinedDcKw)");
    if (disclosureMissing.length) {
      out.push(result(
        "existing-system-disclosure",
        "Existing-system disclosure",
        "warning",
        "warning",
        `Addition to an existing system: interconnection applications must disclose the existing system, but these are missing: ${disclosureMissing.join(", ")}. Enter them from the plan set / prior NEM paperwork.`,
        "existingDcKw",
      ));
    }

    const agreementNumber =
      str(payload, "existingNemAgreementNumber") || str(payload, "nemAgreementNumber") || str(payload, "agreementNumber");
    if (!agreementNumber) {
      out.push(result(
        "existing-system-nem-agreement",
        "Existing NEM agreement number",
        "warning",
        "warning",
        "Addition to an existing system: the NEM/interconnection application usually asks for the EXISTING interconnection agreement number, and none was captured. Pull it from the prior PTO letter / NEM agreement.",
        "existingNemAgreementNumber",
      ));
    }

    // CA NEM1/NEM2 grandfathering: a legacy-tariff system generally keeps its
    // grandfathered status only within a ONE-TIME expansion allowance of
    // max(1 kW, 10% of the existing size). A larger addition can move the whole
    // system to the current tariff (NEM3/NBT). Advisory only.
    const nemTariff = str(payload, "nemTariff") || str(payload, "existingNemTariff");
    if (/nem\s*-?\s*[12]\b|nem\s*-?\s*2\.0|nem\s*-?\s*1\.0/i.test(nemTariff) && existingDcKw != null && combinedDcKw != null) {
      const additionKw = combinedDcKw - existingDcKw;
      const allowanceKw = Math.max(1, 0.10 * existingDcKw);
      if (additionKw > allowanceKw) {
        out.push(result(
          "existing-system-nem-grandfathering",
          "NEM grandfathering expansion allowance",
          "warning",
          "warning",
          `Existing system is on ${nemTariff}: the addition of ${additionKw.toFixed(2)} kW DC exceeds the one-time expansion allowance of ${allowanceKw.toFixed(2)} kW (greater of 1 kW / 10% of the existing ${existingDcKw} kW). The expansion may forfeit grandfathered NEM status and move the whole system to the current tariff — confirm with the utility before submitting.`,
          "combinedDcKw",
        ));
      }
    }
  }

  return out;
}

