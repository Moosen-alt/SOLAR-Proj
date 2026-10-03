// WHOSE PERMIT FEE IS IT? (issue #56)
//
// A permit fee is owed to the agency that ISSUES the permit, which is not always the AHJ on the
// project. In New Mexico a village or county with no building department only reviews zoning; the
// state Construction Industries Division (CID — or MHD for a manufactured home) issues the building
// and electrical permits and charges for them off a published state schedule
// (permitProcess.stateTradeIssuerFor). Fee research, the payment quote and the fee sheet all used to
// key on project.ahj, so a Los Lunas job queued research for "Village of Los Lunas (permit/structural)"
// and the card read a valuation guess under the village's name. The village's own charge is a
// separate, small zoning / site-development review fee.
//
// SCOPE, ON PURPOSE: only the cited STATE rule re-keys the fee here. An operator's or a lookup's
// split issuer (permitProcess.trackIssuer layers a/b) keeps the fee path it has today — those
// projects reach the issuing agency's fee through sourced delegation rows (collectedByProfileKey,
// Marion County for the City of Jefferson), and moving them is a separate decision.
import { projectForTrack, stateTradeIssuerFor } from "./permitProcess";
import type { IssuerProject } from "./permitProcess";

/** The project as THIS track's permit fee reads it: the track-scoped view naming the state issuer
 *  (projectForTrack — the same view staging files with) when a cited state rule issues the permit,
 *  else the project itself (the same object). `track` is a submittal track ("building",
 *  "electrical", "combo"); a bare "permit" asks about the permit filing as a whole. NEM → project. */
export function permitFeeProject<T extends IssuerProject>(project: T, track: string | null | undefined = "permit"): T {
  const view = projectForTrack(project, track);
  return view !== project && view.trackView?.source === "state_rule" ? view : project;
}

/** The submittal track a fee discipline is filed on (the inverse of recipeDisciplineForTrack). */
export function trackForFeeDiscipline(discipline: string | null | undefined): string {
  return discipline === "structural" ? "building" : discipline === "electrical" ? "electrical" : discipline === "combo" ? "combo" : "permit";
}

/** THE AHJ'S OWN CHARGE when a state agency issues the permits: its zoning / site-development
 *  review, which comes first (permitProcess.stateTradeIssuerFor's `localReviewer`). null when the
 *  AHJ issues its own permits (Albuquerque), or the state rule did not take effect for this project
 *  (an operator named another issuer). */
export function localPermitReview(project: IssuerProject): { ahj: string; issuer: string } | null {
  const view = permitFeeProject(project, "permit");
  if (view === project) return null;
  const st = stateTradeIssuerFor(project);
  if (!st || !st.localReviewer.trim()) return null;
  return { ahj: st.localReviewer.trim(), issuer: st.value };
}
