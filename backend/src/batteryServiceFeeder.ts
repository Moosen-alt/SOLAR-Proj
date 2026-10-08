// ---------------------------------------------------------------------------
// A BATTERY ON AN ELECTRICAL PERMIT BILLS ONE "SERVICES OR FEEDERS: 200 AMPS OR
// LESS" LINE.
//
// Operator rule, 2026-09-24, verbatim: "for battery jobs, when on an elec permit,
// it will count as 'Services/feeders 200 amps or less'". So a project with a
// battery/ESS whose filing carries ELECTRICAL fee items (the electrical permit, a
// combination permit, or a jurisdiction's one undifferentiated permit schedule)
// owes ONE services/feeders <=200A item in addition to the PV kVA item. Never on
// a building/structural filing and never on an interconnection (NEM) application.
//
// THREE QUESTIONS, ONE ANSWER EACH, AND THIS MODULE IS WHERE EACH ONE LIVES:
//
//   1. Does this project have a battery?          batteryStatus()
//   2. Does this filing carry electrical fee items? feeFilingIsElectrical()
//   3. Is this printed/recorded label THE services/feeders <=200A line?
//                                                 isServiceFeeder200Label()
//      (and the 201-400 A line: isServiceFeeder400Label())
//   4. How many service lines, per tier?          serviceLineQuantities()
//      A SERVICE UPGRADE is a service line too (City of Corvallis, live 2026-09-28:
//      "Service 0-200 amps (qty)" stayed 0 on a job upgrading to a 200 A main) — one
//      line in the tier of the main it leaves behind, on top of the battery's.
//
// The portal fee-item answer (feeBracketFields.ts), the electrical PDF
// (ahjForms.ts computed values) and the fee sheet (feeSchedules.ts) all read
// these, so the three surfaces cannot disagree about the same job. A LEAF on
// purpose: feeBracketFields imports feeSchedules, and both need (3) — a copy in
// each would be two regexes answering one question, which this codebase has
// paid for more than once.
// ---------------------------------------------------------------------------

import { serviceAmps, snapshotHasMpuScope } from "./serviceScope";
// The label grammar (question 3) lives in a shared leaf so the replay adapter asks the SAME
// question of a live page; re-exported here, where every backend caller already imports it.
export {
  SERVICE_FEEDER_200A_FIELD, SERVICE_FEEDER_400A_FIELD, isServiceFeeder200Label, isServiceFeeder400Label,
} from "../../shared/src/serviceLineLabels";

/** The charge kinds the fee evaluator writes for this line. Exported so the PDF
 *  side reads the amount by kind rather than by re-matching a label. */
export const SERVICE_FEEDER_CHARGE_KIND = "service_feeder_200a";
export const SERVICE_FEEDER_STATE_SURCHARGE_KIND = "service_feeder_200a_state_surcharge";
export const SERVICE_FEEDER_COMMUNITY_SURCHARGE_KIND = "service_feeder_200a_community_surcharge";
/** The 201-400 A service tier's charge kinds (a service upgrade to a 201-400 A main). */
export const SERVICE_FEEDER_400A_CHARGE_KIND = "service_feeder_400a";
export const SERVICE_FEEDER_400A_STATE_SURCHARGE_KIND = "service_feeder_400a_state_surcharge";
export const SERVICE_FEEDER_400A_COMMUNITY_SURCHARGE_KIND = "service_feeder_400a_community_surcharge";

/** A service upgrade whose line neither tier prices (size unknown, or over 400 A): always
 *  listed UNPRICED, so the filing total stays unresolved. */
export const SERVICE_FEEDER_UPGRADE_UNBILLED_KIND = "service_feeder_upgrade";

/** Is this charge kind a SERVICE LINE (either tier, or an unbilled upgrade) or one of its surcharges? */
export function isServiceLineChargeKind(kind: string | null | undefined): boolean {
  return /^service_feeder_(?:200a|400a|upgrade)(?:_|$)/.test(String(kind ?? ""));
}
/** Is this charge kind a service line's OWN amount (either tier, or an unbilled upgrade), not a surcharge on it? */
export function isServiceLineBaseKind(kind: string | null | undefined): boolean {
  return kind === SERVICE_FEEDER_CHARGE_KIND || kind === SERVICE_FEEDER_400A_CHARGE_KIND || kind === SERVICE_FEEDER_UPGRADE_UNBILLED_KIND;
}


/** The operator-facing name of the line, in the Oregon schedule's own wording. */
export const SERVICE_FEEDER_200A_LABEL = "Services or feeders: 200 amps or less";

export const SERVICE_FEEDER_400A_LABEL = "Services or feeders: 201 amps to 400 amps";

export type BatteryStatus = "yes" | "no" | "unknown";

/** A battery MODEL field that says there is NO battery ("N/A", "N.A.", "(none)", "None proposed",
 *  "No ESS", "Not in scope", "-"). One answer for the two places a placeholder must not become a
 *  battery: normalize.ts, where hasBattery is DERIVED from the model, and essRequirements, where the
 *  required set grows a blocking spec-sheet row (#246). Normalized first (case, dots, parentheses,
 *  spacing), so the spellings an operator actually types all read the same. */
export function isPlaceholderBatteryModel(value: unknown): boolean {
  const v = String(value ?? "").toLowerCase().replace(/[().]/g, "").replace(/\s+/g, " ").trim();
  return /^(?:n\/?a|none(?: proposed| planned| installed)?|no(?: battery| batteries| ess| storage)?|nil|null|not (?:included|applicable|used|proposed|in scope)|0|[-\u2013\u2014]+)$/.test(v);
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** DOES THIS PROJECT HAVE A BATTERY? — tri-state.
 *
 *  THE POSITIVE HALF IS portalRecipes.ts's energySource predicate, exactly: the
 *  one that decides whether a utility portal is told "Solar PV and Battery" and
 *  so whether ~17 storage questions get asked at all. hasBattery Yes (written by
 *  normalize.ts from batteryModel / batteryQuantity), OR a battery model, OR a
 *  battery quantity above zero — the fallback covers a snapshot that never went
 *  through normalisation. Reading the same evidence means the fee line and the
 *  portal's own battery declaration cannot disagree about one job.
 *
 *  THE NEGATIVE HALF IS autoLearn.ts's: only an EXPLICIT "no" is a no.
 *  normalize.ts writes hasBattery "No" whenever a parsed plan set carries no
 *  battery model or quantity, so every parsed project answers; a snapshot with
 *  no hasBattery and no battery evidence was never parsed, and silence about a
 *  battery is not a statement that there isn't one. That case is "unknown", and
 *  every caller must treat it as neither answer (an unknown must not read as
 *  reassurance — a "0" typed into a fee box, or a fee sheet without the line,
 *  would both claim a fact nobody established). */
export function batteryStatus(snapshot: Record<string, unknown> | null | undefined): BatteryStatus {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const flag = str(s.hasBattery);
  const qty = Number(str(s.batteryQuantity) || str(s.batteryQty) || 0);
  if (/^(yes|true|y)$/i.test(flag) || str(s.batteryModel) !== "" || (Number.isFinite(qty) && qty > 0)) return "yes";
  if (/^(no|false|none|n)$/i.test(flag)) return "no";
  return "unknown";
}

/** DOES THIS FILING CARRY ELECTRICAL FEE ITEMS?
 *
 *  `track` is the billing/fee track ("permit" | "nem") or a submittal track;
 *  `discipline` is the fee discipline ("structural" | "electrical" | "combo" |
 *  "") or a submittal track name. The vocabulary is portalChannel
 *  .recipeDisciplineForTrack's: "electrical" and "mpu" file the electrical
 *  permit, "combo" is ONE filing covering both trades, "building"/"structural"
 *  is the structural permit alone.
 *
 *  "" ON THE PERMIT TRACK IS THE WHOLE PROJECT'S PERMIT — an undifferentiated
 *  schedule row, which feeSchedules.applicableSchedules treats as "the whole
 *  answer" for every permit this project owes. Every permit project files an
 *  electrical permit (submittalTracks.requiredTracks always adds either "combo"
 *  or "building"+"electrical"), so that row covers the electrical filing. A
 *  caller asking specifically for the structural permit passes "structural". */
export function feeFilingIsElectrical(track: string | null | undefined, discipline: string | null | undefined): boolean {
  const t = str(track).toLowerCase();
  const d = str(discipline).toLowerCase();
  if (t === "nem" || d === "nem") return false;
  if (t === "building" || t === "structural") return false;
  if (d === "structural" || d === "building") return false;
  return d === "" || d === "electrical" || d === "combo" || d === "mpu" || d === "permit";
}

/** How many SERVICE LINES a filing's electrical fee items carry, per tier — the ONE
 *  answer the portal's fee-item boxes (feeBracketFields), the electrical PDF's
 *  services row (ahjForms computed.servicesFeeders200Qty) and the fee sheet
 *  (feeSchedules) all read. Each is a string, because each is typed into a box:
 *    - a number ("0", "1", "2") when every contribution is known;
 *    - "" when any contribution is unknown. "" is DEFINED-but-empty on purpose: the
 *      replay adapter types a defined empty key as blank, whereas an undefined key
 *      would replay the LEARN project's recorded literal — exactly the frozen answer
 *      this exists to stop — and "0" would assert a fact nobody established.
 *
 *  CONTRIBUTIONS:
 *    1. A SERVICE UPGRADE the plan set's scope names (serviceScope.hasMpuScope — the
 *       predicate the MPU permit track and the reviewer's MPU callout read): ONE line,
 *       in the tier of the service it leaves behind (serviceAmps: the MAIN, never the
 *       bus — "a new 225A main bus with a 200A main breaker" is a 200 A service).
 *       <= 200 A → the 0-200 tier; 201-400 A → the 201-400 tier; larger → neither of
 *       these boxes. An upgrade whose size nobody knows makes BOTH tiers unknown.
 *       A parsed plan set with no upgrade language is "no service work": 0.
 *    2. A BATTERY (operator rule 2026-09-24): one <=200A services/feeders line.
 *
 *  A battery job that ALSO upgrades a <=200 A service counts TWO <=200A lines — the
 *  operator's battery rule is "in addition", and the service is its own line.
 *
 *  "Parsed" is read the way batteryStatus reads it: normalize.ts writes hasBattery on
 *  every parsed project, so a snapshot with no battery answer at all was never parsed,
 *  and its silence about a service upgrade is not a statement that there is none. */
export interface ServiceLineQuantities {
  /** The services/feeders <=200A (0-200 A) box. */
  le200: string;
  /** The services/feeders 201-400 A box. */
  t201to400: string;
}

export function serviceLineQuantities(snapshot: Record<string, unknown> | null | undefined): ServiceLineQuantities {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const battery = batteryStatus(s);
  const upgrade = snapshotHasMpuScope(s);
  // Service work: "upgrade" | "none" | unknown (null).
  const service: "upgrade" | "none" | null = upgrade ? "upgrade" : battery !== "unknown" ? "none" : null;
  const amps = service === "upgrade" ? serviceAmps(s) : null;
  const tier: "le200" | "t400" | "over" | null = service !== "upgrade" ? null
    : amps == null ? null : amps <= 200 ? "le200" : amps <= 400 ? "t400" : "over";
  const serviceUnknown = service === null || (service === "upgrade" && tier === null);

  const le200Service = serviceUnknown ? null : tier === "le200" ? 1 : 0;
  const le200Battery = battery === "yes" ? 1 : battery === "no" ? 0 : null;
  const le200 = le200Service == null || le200Battery == null ? "" : String(le200Service + le200Battery);
  const t201to400 = serviceUnknown ? "" : tier === "t400" ? "1" : "0";
  return { le200, t201to400 };
}

/** The quantity a services/feeders <=200A box is answered with — serviceLineQuantities'
 *  <=200A tier (see there). Kept under its old name: the portal key, the PDF and the fee
 *  sheet each read it. */
export function serviceFeeder200Quantity(snapshot: Record<string, unknown> | null | undefined): string {
  return serviceLineQuantities(snapshot).le200;
}

/** The quantity a services/feeders 201-400 A box is answered with. */
export function serviceFeeder400Quantity(snapshot: Record<string, unknown> | null | undefined): string {
  return serviceLineQuantities(snapshot).t201to400;
}

/** The service lines a filing's FEE SHEET carries: the KNOWN lines of the same count
 *  the boxes type, as numbers, with WHY (for the charge's own wording).
 *
 *  A box types "" when any contribution is unknown; a fee sheet cannot price "" — so it
 *  carries every line that IS known (a battery's line stays whatever the upgrade's size)
 *  and names the one that is not: `upgradeTierUnbilled` is an upgrade whose service size
 *  nobody knows (or one larger than 400 A, a tier neither box covers), which the evaluator
 *  lists UNPRICED so the total stays unresolved rather than smaller. An unknown battery still adds nothing and claims nothing. */
export interface ServiceLineCounts {
  le200: number;
  t201to400: number;
  battery: boolean;
  upgrade: boolean;
  /** The upgrade's service size (serviceAmps) when the scope names an upgrade. */
  upgradeAmps: number | null;
  /** An upgrade is in scope and its service line is in neither priced tier: its size is
   *  unknown, or it is larger than 400 A. */
  upgradeTierUnbilled: boolean;
}
export function serviceLineCounts(snapshot: Record<string, unknown> | null | undefined): ServiceLineCounts {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const battery = batteryStatus(s) === "yes";
  const upgrade = snapshotHasMpuScope(s);
  const upgradeAmps = upgrade ? serviceAmps(s) : null;
  const le200Upgrade = upgradeAmps != null && upgradeAmps <= 200 ? 1 : 0;
  const t400Upgrade = upgradeAmps != null && upgradeAmps > 200 && upgradeAmps <= 400 ? 1 : 0;
  return {
    le200: (battery ? 1 : 0) + le200Upgrade,
    t201to400: t400Upgrade,
    battery, upgrade, upgradeAmps,
    upgradeTierUnbilled: upgrade && (upgradeAmps == null || upgradeAmps > 400),
  };
}
