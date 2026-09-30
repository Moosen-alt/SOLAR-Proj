// WHICH FILINGS A GATE BLOCKER HOLDS — the one answer (gates-proper C2).
//
// The submit gate's decision is project-wide, and every blocker other than the document check used
// to hold EVERY track: a structural design-criteria conflict (snow 28 vs 20 psf) held Eversource's
// interconnection application (Waltham 47103700) and the separate electrical permit (Lincoln City
// f7d7af7e); an electrical busbar finding held the building permit (Salem 6a1c2127); a structural
// finding refused approval of a staged utility draft (Portland 88647deb). The gate, the Stage
// button, the Approve button and prepareSubmission's 409 each asked "does this hold THAT filing?"
// separately — or not at all.
//
// ONE PREDICATE: every blocking item is given a SCOPE here, from what it is about, and every door
// asks scopeHoldsTrack with the track it is judging. The lane (utility vs AHJ permit) comes first,
// then the permit discipline (structural vs electrical); a combination permit ('combo', or the
// legacy trackless 'permit') is one filing covering both trades and is held by either. An UNKNOWN
// NEVER CLEARS: an unrecognised category holds every filing, and a null track (a run tagged with no
// known track) is held by everything.
//
// A LEAF MODULE: types only, so repository / autopilot / nextStep can all import it (repository
// imports autopilot's dependencies; nothing here imports back).
import type { ReviewerFinding, SubmittalTrackType } from "../../shared/src/types";

export type GateHoldScope = "all" | "nem" | "permit" | "building" | "electrical" | "electrical+nem";

export const GATE_TRACKS: readonly SubmittalTrackType[] = ["nem", "building", "electrical", "combo", "permit", "mpu"];

/** Does a blocker of this scope hold a filing of `track`? null = an unknown track: held. */
export function scopeHoldsTrack(scope: GateHoldScope, track: SubmittalTrackType | null): boolean {
  if (track === null || scope === "all") return true;
  const nem = track === "nem";
  // The permit discipline each track files under (portalChannel.recipeDisciplineForTrack's
  // vocabulary): building -> structural; electrical and a panel upgrade -> electrical; combo and the
  // legacy trackless 'permit' -> one filing covering both trades.
  const structural = track === "building" || track === "combo" || track === "permit";
  const electrical = track === "electrical" || track === "mpu" || track === "combo" || track === "permit";
  switch (scope) {
    case "nem": return nem;
    case "permit": return !nem;
    case "building": return structural;
    case "electrical": return electrical;
    case "electrical+nem": return electrical || nem;
    default: return true;
  }
}

/** Every track a blocker of this scope holds (for the gate report's `holds`). */
export function tracksHeld(scope: GateHoldScope): SubmittalTrackType[] {
  return GATE_TRACKS.filter((t) => scopeHoldsTrack(scope, t));
}

// An electrical finding holds the utility filing too — a utility's interconnection review reads
// the one-line, the point of interconnection and its 705.12 math (the 120% busbar rule is the
// utility's question as much as the inspector's), the service ratings, the system size and the
// inverter listing — EXCEPT the items only the electrical PERMIT reads (field-inspection items,
// the Iowa state worksheet). Erring toward holding: an electrical id not on this list holds NEM.
const ELECTRICAL_PERMIT_ONLY = /rapid-shutdown|\.labels|labels-missing|pvws-|ess\.details/i;
// Fire access pathways are a building / fire review item.
const FIRE = /\bfire\b|fire[.-]|pathway/i;
// Findings about a value every application carries: the system size and the equipment it is made of.
const BOTH_APPLICATIONS = /dc-size|ac-size|system-size|module-count|equipment-specs/i;

/**
 * THE SCOPE OF A REVIEWER FINDING, from its id and category. The id wins where it names the
 * subject (a fire pathway is the building review's; a one-line / 705.12 item is the electrical
 * permit's and the utility's); otherwise the category: structural -> the building permit;
 * electrical -> the electrical permit, plus the utility filing unless the id is a permit-only
 * inspection item; utility_nem -> the utility filing; ahj_profile -> the AHJ permit; a critical
 * project field -> criticalFieldHoldScope; anything else (plan_set, portal, installer, ai_review,
 * an unknown) -> every filing.
 */
export function findingHoldScope(f: Pick<ReviewerFinding, "id" | "category">): GateHoldScope {
  const id = String(f.id ?? "");
  const core = /^reviewer\.core\.([a-z]+)$/.exec(id);
  if (core) return criticalFieldHoldScope(core[1]);
  if (FIRE.test(id)) return "building";
  // A VALUE BOTH APPLICATIONS CARRY (skeptic gates-proper MF1): a wrong DC size or incomplete
  // equipment specs is filed as "electrical", but the building application prints the system size
  // (and the valuation computed from it) and the module data too — so it holds every filing, the
  // same answer a MISSING DC gets (criticalFieldHoldScope).
  if (BOTH_APPLICATIONS.test(id)) return "all";
  switch (f.category) {
    case "structural": return "building";
    case "electrical": return ELECTRICAL_PERMIT_ONLY.test(id) ? "electrical" : "electrical+nem";
    case "utility_nem": return "nem";
    case "ahj_profile": return "permit";
    default:
      // plan_set and the rest: a missing one-line is the electrical permit's and the utility's; a
      // code-basis mismatch is the AHJ's; anything else is every filing's.
      if (/\bsld\b|sld-|\.sld/i.test(id)) return "electrical+nem";
      if (/code\.basis/i.test(id)) return "permit";
      return "all";
  }
}

/**
 * THE SCOPE OF A MISSING CRITICAL PROJECT FIELD — the same answer prepareSubmission's own field
 * gate gives (repository.validatePortalFields: every portal needs the homeowner and address; the
 * utility portal needs account / meter / utility; the AHJ portal needs the AHJ). The DC/AC size
 * is on both applications. The interconnection method is the utility's question and the
 * electrical permit's (705.12). Accepts the gate's labels ("Account") or the reviewer's keys
 * ("account"). An unknown field holds every filing.
 */
export function criticalFieldHoldScope(field: string): GateHoldScope {
  const f = String(field ?? "").trim().toLowerCase();
  if (/^(ahj|jurisdiction)/.test(f)) return "permit";
  if (/^(utility|account|meter)\b/.test(f)) return "nem";
  if (/^interconnection/.test(f)) return "electrical+nem";
  return "all";
}

/** A gate CHECK's scope when it carries no per-item `holds`: the permit path is asked only off the
 *  NEM lane (prepareSubmission); every other check holds every filing. */
export function gateCheckDefaultScope(checkId: string): GateHoldScope {
  return checkId === "permit-path" ? "permit" : "all";
}

/** The scope of a learned historical blocker, from classifyCorrectionTrack's three answers
 *  (strong filing signals only; "unclassified" holds every filing — an unknown never clears). */
export function correctionHoldScope(track: "permit" | "nem" | "unclassified"): GateHoldScope {
  return track === "nem" ? "nem" : track === "permit" ? "permit" : "all";
}
