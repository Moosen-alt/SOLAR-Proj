// ---------------------------------------------------------------------------
// ONE-CLICK CONFIRM: A PERSON VOUCHES FOR A RESEARCHED FEE (operator 2026-09-27).
//
// "Permit (AHJ) — City of Coos Bay: provisional — not verified … there is no place to verify
// them." There was a function (feeSchedules.markFeeScheduleVerified) and no door to it. This is
// the door, and it is the ONLY place the dashboard writes "verified" onto a fee:
//
//   - WHO is always a named person. The route passes the signed-in user's name when auth is on
//     (never a body field then) and, with auth off, the name the person typed. A label that is
//     not a person ("dashboard", "system", "human"…) is refused — hard rule 3 says verified means
//     a PERSON, and a machine or a placeholder standing in for one is exactly the lie it forbids.
//   - WHAT is exactly the rows behind the amount on screen: feeForProject's lines for this
//     project and billing track — the city's structural row AND the county's electrical row on
//     a Coos Bay job, plus the city's "the county collects it" pointer that line was reached
//     through (a person confirming "$160 to Coos County" vouches for the hop too).
//   - ONLY a researched published-schedule amount (submissionFees.feeLineConfirmable). An
//     actual, a learned median, an estimate or an already-verified total has nothing on the
//     schedule for a person to confirm, and saying "confirmed" over it would be a false receipt.
//
// From then on the rows are human-verified and no automated pass may change them: research is
// refused against a verified row (saveFeeSchedule), and the portal-record fee reader never
// writes fee_schedules at all.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { billingTrack, buildPaymentQuote, feeLineConfirmable } from "./submissionFees";
import { feeForProject, getFeeScheduleById, markFeeScheduleVerifiedById } from "./feeSchedules";

/** Labels that name no person. A confirmation under one of these is refused. */
const NOT_A_PERSON = /^(?:dashboard|system|human|operator|auto(?:mation|matic)?|bot|robot|machine|unknown|anonymous|n\/?a|none|test|admin|user|authenticated user)$/i;

/** Is this a person's name we can put beside "verified"? Trimmed, 2–120 chars, has a letter,
 *  and is not a role or placeholder. */
export function isConfirmingPerson(name: string): boolean {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= 120 && /\p{L}/u.test(n) && !NOT_A_PERSON.test(n);
}

export interface FeeConfirmOutcome {
  track: "permit" | "nem";
  confirmedBy: string;
  /** Rows this confirmation moved to verified. */
  verified: Array<{ scheduleId: string; authority: string; discipline: string }>;
  /** Rows that were already verified by someone (left exactly as they were). */
  alreadyVerified: Array<{ scheduleId: string; authority: string; discipline: string; verifiedBy: string }>;
}

export function confirmPublishedFee(
  db: AppDb,
  project: ProjectRecord,
  trackInput: string | null | undefined,
  confirmedBy: string,
): FeeConfirmOutcome {
  const who = String(confirmedBy ?? "").replace(/\s+/g, " ").trim();
  if (!isConfirmingPerson(who)) {
    throw new HttpError(400, "A fee is confirmed by a named person. Say who is confirming it — \"verified\" on a fee means a person checked it.");
  }
  const track = billingTrack(trackInput);
  const quote = buildPaymentQuote(db, project, track);
  if (!feeLineConfirmable(quote.permitFeeSource, quote.permitFeeConfidence)) {
    throw new HttpError(409, `Nothing to confirm on this ${track === "nem" ? "interconnection" : "permit"} fee: it is `
      + `${quote.permitFeeSource === "published_schedule" ? `already ${quote.permitFeeConfidence}` : `from ${quote.permitFeeSource.replace(/_/g, " ")}`}, `
      + `and only a researched published-schedule amount is confirmed here.`, { confirmable: false, source: quote.permitFeeSource, confidence: quote.permitFeeConfidence });
  }
  const resolution = feeForProject(db, project, track);
  const lines = resolution?.lines ?? [];
  const ids: Array<{ id: string; authority: string; discipline: string }> = [];
  for (const line of lines) {
    for (const scheduleId of [line.scheduleId, line.delegatedFromScheduleId ?? ""]) {
      if (scheduleId && !ids.some((x) => x.id === scheduleId)) ids.push({ id: scheduleId, authority: line.authority, discipline: line.discipline });
    }
  }
  if (!ids.length) {
    throw new HttpError(409, "The published schedule behind this fee could not be found to confirm — re-open the fee sheet and try again.");
  }
  const outcome: FeeConfirmOutcome = { track, confirmedBy: who, verified: [], alreadyVerified: [] };
  db.transaction(() => {
    for (const { id, authority, discipline } of ids) {
      const row = getFeeScheduleById(db, id);
      if (!row) continue;
      if (row.confidence === "verified") {
        outcome.alreadyVerified.push({ scheduleId: id, authority: row.ahj || row.utility || authority, discipline: row.discipline || discipline, verifiedBy: row.verifiedBy });
        continue;
      }
      markFeeScheduleVerifiedById(db, id, who);
      outcome.verified.push({ scheduleId: id, authority: row.ahj || row.utility || authority, discipline: row.discipline || discipline });
    }
  });
  return outcome;
}
