// ---------------------------------------------------------------------------
// ONE VOICE, TWO CHANNELS.
//
// The wording a client sees for "your permit was issued" was living inside clientNotifier as an
// email template. Adding a note to the portal would have made a second copy, and two copies of
// client-facing prose drift — the client then gets one wording in their inbox and a different
// one on the page, for the same event, on the same day. So the words live here and both
// channels render them.
//
// WHAT MAKES A NOTE READ LIKE A PROJECT MANAGER RATHER THAN A STATUS BADGE
//
// Not prose variety. It is that a person's update always answers three things, and a status
// label answers only the first:
//
//   · what happened, with the number, so they can look it up themselves
//   · what it means for them — what they can now do, or not do
//   · whether anything is needed FROM them
//
// That third line is the one that matters. "Correction requested" reads as an emergency; "we're
// reading it now, nothing for you to do yet" is the same fact and a completely different
// Tuesday. Every update below ends with it, including when the answer is "nothing".
//
// WHY THESE ARE TEMPLATES AND NOT LLM-WRITTEN. The event set is four outcomes, so a template
// can be genuinely well written once and then be right every time. An LLM would cost per event,
// and — the real objection — it would occasionally claim something we do not know, in text sent
// to a paying customer under our name. The variation a model would add is not worth a single
// sentence telling somebody they can schedule an install when they cannot.
//
// NEVER IN HERE: correction TEXT. It is raw scraped portal prose and forwarded AHJ email
// carrying homeowner names, phone numbers and examiners' direct lines. The client learns a
// correction landed and that we are on it. The wording stays internal.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { text } from "./json";

/** The name a client sees on every update. PROVISIONAL — the operator has not settled the
 *  company name, so it lives here as one constant with an env override rather than being
 *  scattered through the templates. Change BRAND_NAME in .env, or this default. */
export const BRAND = (process.env.BRAND_NAME || "Keelix").trim() || "Keelix";
import { id } from "./ids";
import { nowIso } from "./time";
import { isNemApprovalOutcome, outcomeTrack, trackKind } from "./permitMonitor";
import { permitStructureAnswer, permitStructureIsCitedOrVerified } from "./applicationDocs";

export interface ClientUpdateContext {
  /** "permit" | "nem" — which track moved. */
  targetType: string;
  /** 'building' | 'electrical' | 'combo' | 'nem'. A project often files a structural AND an
   *  electrical permit; "the permit has been issued" is ambiguous when two are outstanding, and
   *  the client cannot tell which trade they can now schedule. Blank when we do not know, and
   *  the wording then stays deliberately general rather than guessing. */
  permitType?: string;
  /** The jurisdiction's own reference, when the portal gave us one. */
  permitNumber?: string;
  applicationNumber?: string;
}

export interface ClientUpdate {
  /** Email subject line, without the address — callers append that. */
  subject: string;
  /** What happened. One sentence, names the authority, carries the number. */
  headline: string;
  /** What it means for them. */
  meaning: string;
  /** Whether anything is needed from them. NEVER empty — "nothing" is an answer they want. */
  action: string;
}

/** The other track's latest outcome, so an update can say what is still outstanding rather than
 *  implying the whole job is done. Returns "" when there is no other track. */
function otherTrackOutcome(db: AppDb, projectId: string, thisType: string): string {
  const want = thisType === "nem" ? "permit" : "nem";
  // Kind by trackKind — the ONE "what track is this target" answer — judged in JS: a raw
  // `target_type = ?` filter missed a legacy 'permit'-typed NEM filing, so a permit's "issued"
  // update told the client the install could be scheduled while that interconnection was open.
  const row = db.query<{ latest_outcome?: string; target_type?: string; permit_type?: string }>(
    `SELECT latest_outcome, target_type, permit_type FROM permit_check_targets
      WHERE project_id = ? AND active = 1
      ORDER BY last_checked_at DESC`,
    [projectId],
  ).find((r) => trackKind(text(r.target_type), text(r.permit_type)) === want);
  return text(row?.latest_outcome);
}

// The permit side's done outcomes; the NEM side answers through isNemApprovalOutcome — the one
// "is this NEM target approved" predicate (permitMonitor.ts), never a second list here.
const DONE_OUTCOMES = new Set(["issued", "approved"]);
const isDoneOutcome = (outcome: string): boolean => DONE_OUTCOMES.has(outcome) || isNemApprovalOutcome(outcome);

/** The project's OTHER permit filings not yet issued, named ("the building permit"). A target of
 *  this filing's own discipline is this filing; with the discipline unknown, every permit filing
 *  not done counts (the issued one already reads issued). */
function openSiblingPermits(db: AppDb, projectId: string, permitType: string, structure: { combo: boolean }): string[] {
  const mine = text(permitType).toLowerCase();
  const rows = db.query<{ latest_outcome?: string; target_type?: string; permit_type?: string }>(
    "SELECT latest_outcome, target_type, permit_type FROM permit_check_targets WHERE project_id = ? AND active = 1",
    [projectId],
  );
  return Array.from(new Set(rows
    .filter((r) => trackKind(text(r.target_type), text(r.permit_type)) === "permit" && !DONE_OUTCOMES.has(text(r.latest_outcome))
      && (!mine || text(r.permit_type).toLowerCase() !== mine))
    .map((r) => permitPhrase(clientFacingPermitType(text(r.permit_type), structure)))));
}

/**
 * "the electrical permit" when we know, plain "the permit" when we do not. Never a guess: naming
 * the wrong trade tells a client to schedule the wrong crew.
 */
function permitPhrase(permitType: string): string {
  switch (text(permitType).toLowerCase()) {
    case "electrical": return "the electrical permit";
    case "building": case "structural": return "the building permit";
    case "combo": return "the combination building & electrical permit";
    default: return "the permit";
  }
}

/**
 * The same filing named as an APPLICATION rather than a permit.
 *
 * A correction lands against a filing that is not a permit yet — "the city sent the electrical
 * permit back" reads as a permit having been issued and then withdrawn, which is a different and
 * much worse Tuesday. Derived from permitPhrase so the two cannot drift: one switch, one list of
 * disciplines. An unknown discipline collapses to the general "the application", which is what
 * this sentence has always said.
 */
function applicationPhrase(permitType: string): string {
  const which = permitPhrase(permitType);
  return which === "the permit" ? "the application" : `${which} application`;
}

/**
 * The outcomes a client hears about. THE ONE LIST — shouldNotifyClient derives its gate from
 * this rather than keeping a parallel copy, the same way the API-key allowlist is derived from
 * the product registry. Two lists of "what the client is told about" would eventually disagree,
 * and the failure is silent in both directions: an event with wording but no gate is never sent,
 * and an event with a gate but no wording used to send a blank line.
 */
export const CLIENT_FACING_OUTCOMES = ["issued", "ready_for_issue", "nem_approved", "correction_flagged"] as const;

export function isClientFacingOutcome(outcome: string): boolean {
  return (CLIENT_FACING_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * WHAT THE PERMIT STRUCTURE LETS US SAY TO A CLIENT (leak sweep unknown-as-fact-client-email-combo-
 * default, 2026-09-28). A job whose structure is NOT confirmed gets ONE 'combo' track by default
 * (submittalTracks.requiredTracks) — a template default, not a fact — and its target's permit_type
 * 'combo' told the client "the combination building & electrical permit" was issued and "the
 * building and electrical side is cleared, so the installation can be scheduled" while Waltham's
 * separate wire permit had never been filed. ONE answer (applicationDocs.permitStructureAnswer +
 * permitStructureIsCitedOrVerified); a partial record we cannot ask about is NOT confirmed.
 */
export function clientPermitStructure(project: Partial<ProjectRecord>): { confirmed: boolean; combo: boolean } {
  if (typeof project.state !== "string" || typeof project.ahj !== "string" || !project.parserSnapshot) return { confirmed: false, combo: false };
  try {
    const answer = permitStructureAnswer(project as ProjectRecord);
    const confirmed = answer.structure !== "unknown" && permitStructureIsCitedOrVerified(answer);
    return { confirmed, combo: confirmed && answer.structure === "combo" };
  } catch {
    return { confirmed: false, combo: false };
  }
}

/** The permit_type a client-facing sentence may name: 'combo' only for a CONFIRMED combination permit. */
export function clientFacingPermitType(permitType: string, structure: { combo: boolean }): string {
  return text(permitType).trim().toLowerCase() === "combo" && !structure.combo ? "" : text(permitType);
}

/** Both trades are tracked on this job and the OTHER one is already issued — so "the building and
 *  electrical side is cleared" is backed by the targets themselves, whatever the structure answer. */
function otherTradeIssued(db: AppDb, projectId: string, permitType: string): boolean {
  const mine = text(permitType).toLowerCase();
  const trade = (t: string) => (t === "electrical" ? "electrical" : t === "building" || t === "structural" ? "building" : "");
  if (!trade(mine)) return false;
  return db.query<{ latest_outcome?: string; target_type?: string; permit_type?: string }>(
    "SELECT latest_outcome, target_type, permit_type FROM permit_check_targets WHERE project_id = ? AND active = 1",
    [projectId],
  ).some((r) => trackKind(text(r.target_type), text(r.permit_type)) === "permit"
    && DONE_OUTCOMES.has(text(r.latest_outcome)) && trade(text(r.permit_type).toLowerCase()) !== ""
    && trade(text(r.permit_type).toLowerCase()) !== trade(mine));
}

/**
 * The client-facing wording for one status change, or null when this outcome is not something a
 * client is told about. The null is the gate — it keeps internal states internal.
 */
export function clientUpdateFor(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "ahj" | "utility"> & Partial<ProjectRecord>,
  outcome: string,
  ctx: ClientUpdateContext,
): ClientUpdate | null {
  // THE OUTCOME'S FAMILY MUST BE THIS TRACK'S. "Permit issued" on the NEM track's target, or
  // "interconnection approved" on a permit's, is not an update about this filing — it is a
  // reading a person must look at (the writer records it as unconfirmed and raises a
  // human-review item). Wording it here would tell the client the city issued a permit because a
  // utility page said "issued". The same family half of the provenance predicate the writer and
  // shouldNotifyClient ask (outcomeTrack), asked again at the wording door.
  const family = outcomeTrack(outcome);
  if (family && family !== trackKind(String(ctx.targetType || ""), "")) return null;
  const ahj = text(project.ahj) || "the jurisdiction";
  const utility = text(project.utility) || "the utility";
  const ref = text(ctx.permitNumber) || text(ctx.applicationNumber);
  const structure = clientPermitStructure(project);
  const permitType = clientFacingPermitType(text(ctx.permitType), structure);
  const which = permitPhrase(permitType);
  const whichApplication = applicationPhrase(permitType);
  const refPhrase = ref ? `, reference ${ref}` : "";
  const other = otherTrackOutcome(db, project.id, ctx.targetType);
  const otherDone = isDoneOutcome(other);
  const hasOther = Boolean(other);

  switch (outcome) {
    case "issued": {
      // ANOTHER PERMIT OF THIS JOB STILL IN REVIEW (live 2026-09-28: the electrical permit issued
      // while the building permit sat in review) — "that clears the permit side" would be false.
      const siblings = openSiblingPermits(db, project.id, text(ctx.permitType), structure);
      if (siblings.length) {
        const list = siblings.join(" and ");
        return {
          subject: "Permit issued",
          headline: `${ahj} has issued ${which}${refPhrase}.`,
          meaning: `${list.charAt(0).toUpperCase()}${list.slice(1)} ${siblings.length > 1 ? "are" : "is"} still in review, so the installation cannot be scheduled yet.`,
          action: `Nothing needed from you. We are watching ${list}${hasOther && !otherDone ? ` and the ${utility} interconnection` : ""} and will tell you the day it moves.`,
        };
      }
    }
      return {
        subject: "Permit issued",
        headline: `${ahj} has issued ${which}${refPhrase}.`,
        // THE CLAIM IS CONDITIONAL, and the operator caught it not being so. The action line
        // already named the outstanding interconnection, while this line said the install could
        // be scheduled — the two contradicted each other in the same paragraph. A permit is not
        // permission to energise, so with the interconnection still open this states what was
        // actually cleared and nothing more.
        // …and "the building and electrical side is cleared" is a claim about EVERY permit of the job:
        // made only when the permit structure is confirmed (cited / verified / state rule / curated)
        // or both trades are tracked here and the other one is already issued. Otherwise the true
        // sentence is narrower, and says what we are still confirming.
        meaning: hasOther && !otherDone
          ? "That clears the permit side."
          : structure.confirmed || otherTradeIssued(db, project.id, text(ctx.permitType))
            ? "The building and electrical side is cleared, so the installation can be scheduled."
            : `That clears this permit. We are confirming whether ${ahj} also requires a separate electrical permit before the installation is scheduled.`,
        action: hasOther && !otherDone
          ? `Nothing needed from you. The ${utility} interconnection is still in review — we are watching it and will tell you the day it moves.`
          : "Nothing needed from you.",
      };

    case "ready_for_issue":
      return {
        subject: "Permit ready for issue",
        headline: `${ahj} has ${which} ready for issue${refPhrase}.`,
        // The distinction that saves a phone call: approved is not the same as in your hand.
        meaning: "It is approved but not released yet — most jurisdictions want a fee paid or the permit collected first.",
        action: "Nothing needed from you yet. We are confirming which applies here and will come straight back to you.",
      };

    case "nem_approved":
      return {
        subject: "Interconnection approved",
        headline: `${utility} has approved the interconnection${refPhrase}.`,
        meaning: "The permission-to-operate path is open.",
        action: hasOther && !otherDone
          ? `Nothing needed from you. The ${ahj} permit is still in review — we are watching it and will tell you the day it moves.`
          : "Nothing needed from you.",
      };

    case "correction_flagged":
      return {
        subject: "Correction requested",
        // WHICH filing came back. A project files a structural AND an electrical application; a
        // client told only that "the application" was returned cannot tell which of the two is
        // stalled, and the reference number alone makes them go and look it up.
        headline: `${ahj} has sent ${whichApplication} back with a correction${refPhrase}.`,
        // Deliberately does NOT quote the correction. See the header.
        meaning: "The reviewer wants changes before it can go further. This is routine and it is not a rejection.",
        // The single most useful sentence we send. A correction notice with no instruction reads
        // as an emergency; most of the time there is nothing for them to do at all.
        action: "Nothing for you to do yet. We are reading exactly what they asked for and will come back to you with it — and tell you if we need anything from your designer.",
      };

    default:
      return null;
  }
}

/** The note as it appears on the client's portal — the three lines, as a PM would write them. */
export function clientUpdateNoteBody(update: ClientUpdate): string {
  return [update.headline, update.meaning, update.action].join(" ");
}

/** The email body. Same words, plus the greeting and the link the email needs. */
export function clientUpdateEmailBody(
  update: ClientUpdate,
  opts: { company: string; address: string; statusLine: string; link: string },
): string {
  return [
    `Hi ${opts.company || "there"},`,
    "",
    `Update on your solar project at ${opts.address || "the project site"}:`,
    "",
    update.headline,
    update.meaning,
    update.action,
    "",
    `Live status page (no login needed): ${opts.link}`,
    "",
    "— Solar Submission Autopilot (automated update; reply to reach the team)",
  ].join("\n");
}

/**
 * Record the update as a client-visible note.
 *
 * Inserts directly rather than calling repository.addProjectNote, which would be the obvious
 * reuse: repository.ts imports clientNotifier (it is the one trigger site for status-change
 * notifications), so clientNotifier importing repository back is a cycle. Same guard the
 * codebase already applies between jobQueue and repository.
 *
 * note_type is ALWAYS client_update. project_notes also holds pm_note, blocker, handoff and
 * system_note, which are where an operator writes things like "client is chasing, do not mention
 * the re-inspection fee yet" — the portal filters on this one type and nothing else.
 */
export function recordClientUpdateNote(db: AppDb, projectId: string, update: ClientUpdate): void {
  db.run(
    `INSERT INTO project_notes (id, project_id, note_type, body, created_by, created_at)
     VALUES (?, ?, 'client_update', ?, 'client-notifier (automated)', ?)`,
    [id(), projectId, clientUpdateNoteBody(update), nowIso()],
  );
}
