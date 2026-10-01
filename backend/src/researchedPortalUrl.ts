// A RESEARCHED PORTAL URL IS WRITTEN TO THE KNOWLEDGE BASE ONLY WHEN IT FITS — the ONE write door
// for every research path: cold-start research (repository.researchAndSaveAhj / …Utility) and the
// form search's learned portal (ahjFormAuto.learnAhjPortalFromResearch, which used to save its URL
// with no check at all). Two questions, both the codebase's single predicates:
//   1. hostFitsTrackAndEntity — the track (rule 5), a person's verified portal, another entity's;
//   2. (permit) statewideEvidence.statewideUrlRefusal — the statewide portal for an AHJ whose own
//      evidence says it files ELSEWHERE (portal-truth D1: Corvallis's research answered
//      aca-oregon, the row kept it, and the next stage served it before D1 was asked).
// The evidence is the shared tables' only — never a client's stored logins: the row is shared by
// every tenant, and its refusal note must not carry one tenant's facts.
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { hostFitsTrackAndEntity, scopeForTrack } from "./portalChannel";
import { portalEntityEvidence } from "./portalRecipes";
import { statewideUrlRefusal } from "./statewideEvidence";

/** Why this researched URL is NOT written for the entity (audited), or "" when it fits. */
export function researchedUrlRefusal(
  db: AppDb,
  track: "permit" | "nem",
  entity: { state?: string; name?: string },
  url: string | null | undefined,
): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  const fit = hostFitsTrackAndEntity(track, portalEntityEvidence(db, { scope: scopeForTrack(track), state: entity.state, name: entity.name }), value, "research");
  let code: string = fit.code;
  let reason = fit.reason;
  if (fit.fits) {
    if (track !== "permit") return "";
    // Track null: every permit the lookup found and every recipe discipline — the row is the AHJ's
    // for all of its permits, so any of them saying "elsewhere" keeps the statewide URL out.
    reason = statewideUrlRefusal(db, { state: entity.state ?? "", ahj: entity.name ?? "", city: "" }, null, value);
    if (!reason) return "";
    code = "statewide_elsewhere";
  }
  addAuditLog(db, null, "system", "kb research", "knowledge.researched_url_not_saved", {
    track, state: entity.state ?? "", entity: entity.name ?? "", url: value, code, reason,
  });
  return reason;
}

/**
 * The research, with its portal URL left out (and a note saying why) when it does not fit. Research
 * that disagrees with the track, with a portal a person verified, lands on another entity's portal,
 * or names the statewide portal for an AHJ that files elsewhere was already refused for THIS stage —
 * but saving it as the entity's seeded row made it the entity's own claim, and the NEXT stage
 * launched it unconfirmed. The rest of the research (documents, steps, notes) is still saved. The
 * caller's research object is untouched, so it still sees (and reports) what was found.
 */
export function researchWithFittedUrl<T extends { portalUrl: string; notes: string }>(
  db: AppDb,
  track: "permit" | "nem",
  entity: { state?: string; name?: string },
  research: T,
): T & { referenceUrl?: string } {
  const url = String(research.portalUrl || "").trim();
  if (!url) return research;
  let reason = "";
  if (researchSaysPortalUnconfirmed(research.notes)) {
    reason = RESEARCH_UNCONFIRMED_REASON;
    addAuditLog(db, null, "system", "kb research", "knowledge.researched_url_not_saved", {
      track, state: entity.state ?? "", entity: entity.name ?? "", url, code: "unconfirmed", reason,
    });
  } else {
    reason = researchedUrlRefusal(db, track, entity, url);
  }
  if (!reason) return research;
  // Not lost: the savers keep it as a REFERENCE link (a note segment), never as portal_url.
  return { ...research, portalUrl: "", referenceUrl: url, notes: `${research.notes || ""} [researched portal not saved: ${url} — ${reason}]`.trim() };
}

// RESEARCH THAT SAYS ITS OWN URL IS NOT THE CONFIRMED PORTAL (issue #8). PNM's research answered
// "The specific portal login URL was not confirmed in this research, so no exact deep link is
// asserted" — and its portalUrl (the utility's reference library) was saved and launched as the
// portal anyway. This is the research's own provenance, not a host judgement (that stays
// hostFitsTrackAndEntity's): when the research disclaims the URL, it is kept as a reference link.
const UNCONFIRMED_PORTAL_NOTE = /\b(?:portal|login|application)(?: login)? (?:url|link|page|address)\b[^.]{0,80}?\b(?:was|is|could|has) not (?:be |been )?(?:confirmed|verified|found)\b|\bno exact (?:deep )?link\b/i;
export const RESEARCH_UNCONFIRMED_REASON = "the research itself says this URL was not confirmed as the application portal";
/** True when the research's notes disclaim the portal URL it returned. */
export function researchSaysPortalUnconfirmed(notes: string | null | undefined): boolean {
  return UNCONFIRMED_PORTAL_NOTE.test(String(notes ?? ""));
}
