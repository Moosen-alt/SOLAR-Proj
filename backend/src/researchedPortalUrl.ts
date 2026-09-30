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
): T {
  const url = String(research.portalUrl || "").trim();
  if (!url) return research;
  const reason = researchedUrlRefusal(db, track, entity, url);
  if (!reason) return research;
  return { ...research, portalUrl: "", notes: `${research.notes || ""} [researched portal not saved: ${url} — ${reason}]`.trim() };
}
