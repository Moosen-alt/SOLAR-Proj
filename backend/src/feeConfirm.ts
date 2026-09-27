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
//   - WHAT is exactly the rows behind the amount on screen (submissionFees.feeConfirmRows) — the
//     city's structural row AND the county's electrical row on a Coos Bay job, plus the city's
//     "the county collects it" pointer that line was reached through (a person confirming "$160
//     to Coos County" vouches for the hop too) — AND ONLY AS THE PERSON SAW THEM (skeptic MF2).
//     The click sends the amount it displayed and those rows with their versions; if the quote
//     standing now is another amount, or any row was re-saved since (research moves rows in
//     place), it is 409 "the fee changed since you looked" and nothing is written. Confirm used
//     to re-resolve at click time: $360 shown, $440 verified under the person's name.
//   - WHOSE person is recorded too (the confirming org). fee_schedules is shared on purpose, the
//     verified grade with it; the person's NAME is that org's fact and is shown only on its own
//     projects — every other tenant reads "human-verified" + the date (skeptic MF3, rule 6).
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
import { billingTrack, buildPaymentQuote, feeConfirmRows, feeLineConfirmable } from "./submissionFees";
import { getFeeScheduleById, markFeeScheduleVerifiedById } from "./feeSchedules";

/** Labels that name no person. A confirmation under one of these is refused. */
const NOT_A_PERSON = /^(?:dashboard|system|human|operator|auto(?:mation|matic)?|bot|robot|machine|unknown|anonymous|n\/?a|none|test|admin|user|authenticated user)$/i;

/** Is this a person's name we can put beside "verified"? Trimmed, 2–120 chars, has a letter,
 *  and is not a role or placeholder. */
export function isConfirmingPerson(name: string): boolean {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= 120 && /\p{L}/u.test(n) && !NOT_A_PERSON.test(n);
}

/** The amount a person saw on the fee card and the schedule rows (with versions) behind it —
 *  ProjectFeeSheetLine.feeUsd / confirmRows, sent back by the Confirm click. */
export interface FeeConfirmSeen {
  feeUsd: number;
  scheduleRows: Array<{ id: string; updatedAt: string }>;
}

export interface FeeConfirmOutcome {
  track: "permit" | "nem";
  confirmedBy: string;
  /** Rows this confirmation moved to verified. */
  verified: Array<{ scheduleId: string; authority: string; discipline: string }>;
  /** Rows that were already verified by someone (left exactly as they were). verifiedBy is ""
   *  when that someone is another org's person. */
  alreadyVerified: Array<{ scheduleId: string; authority: string; discipline: string; verifiedBy: string }>;
}

export function confirmPublishedFee(
  db: AppDb,
  project: ProjectRecord,
  trackInput: string | null | undefined,
  confirmedBy: string,
  /** The org of the person confirming (the route's requestScope). Recorded on every row it
   *  verifies: the person's NAME is that org's fact and is shown only on its projects (MF3). */
  confirmingOrgId: string,
  /** What the person SAW: the amount on the card and its confirmRows (MF2). Verified only when
   *  that is still what stands; 409 otherwise, 400 when absent. */
  seen: FeeConfirmSeen | null | undefined,
): FeeConfirmOutcome {
  const who = String(confirmedBy ?? "").replace(/\s+/g, " ").trim();
  if (!isConfirmingPerson(who)) {
    throw new HttpError(400, "A fee is confirmed by a named person. Say who is confirming it — \"verified\" on a fee means a person checked it.");
  }
  const orgId = String(confirmingOrgId ?? "").trim();
  if (!orgId) throw new HttpError(400, "A confirmation records the confirming person's organisation — none was given.");
  if (!seen || typeof seen.feeUsd !== "number" || !Number.isFinite(seen.feeUsd) || !Array.isArray(seen.scheduleRows)) {
    throw new HttpError(400, "A confirmation vouches for the amount you saw — send the fee shown (feeUsd) and the schedule rows behind it (scheduleRows). Reload the fee sheet and confirm again.");
  }
  const track = billingTrack(trackInput);
  // CHECK AND WRITE AS ONE: the quote standing now, compared with what the person saw, and the
  // verification — nothing may re-save a row between the comparison and the write.
  return db.transaction(() => {
    const quote = buildPaymentQuote(db, project, track);
    if (!feeLineConfirmable(quote.permitFeeSource, quote.permitFeeConfidence)) {
      throw new HttpError(409, `Nothing to confirm on this ${track === "nem" ? "interconnection" : "permit"} fee: it is `
        + `${quote.permitFeeSource === "published_schedule" ? `already ${quote.permitFeeConfidence}` : `from ${quote.permitFeeSource.replace(/_/g, " ")}`}, `
        + `and only a researched published-schedule amount is confirmed here.`, { confirmable: false, source: quote.permitFeeSource, confidence: quote.permitFeeConfidence });
    }
    const rows = feeConfirmRows(db, project, track);
    if (!rows.length) {
      throw new HttpError(409, "The published schedule behind this fee could not be found to confirm — re-open the fee sheet and try again.");
    }
    // WHAT THE PERSON SAW MUST BE WHAT STANDS: the same amount, on the same rows at the same
    // versions. Otherwise a name goes onto an amount (or an unseen bracket) nobody looked at.
    const sameAmount = quote.permitFeeUsd != null && Math.abs(quote.permitFeeUsd - seen.feeUsd) < 0.005;
    const version = (r: { id: string; updatedAt: string }): string => `${String(r?.id ?? "")}@${String(r?.updatedAt ?? "")}`;
    const nowKeys = new Set(rows.map(version));
    const seenKeys = new Set(seen.scheduleRows.map(version));
    const sameRows = nowKeys.size === seenKeys.size && [...nowKeys].every((k) => seenKeys.has(k));
    if (!sameAmount || !sameRows) {
      throw new HttpError(409, "The fee changed since you looked — reload and confirm again.", {
        changed: true, seenFeeUsd: seen.feeUsd, currentFeeUsd: quote.permitFeeUsd, rowsChanged: !sameRows,
      });
    }
    const outcome: FeeConfirmOutcome = { track, confirmedBy: who, verified: [], alreadyVerified: [] };
    for (const { id } of rows) {
      const row = getFeeScheduleById(db, id);
      if (!row) continue;
      if (row.confidence === "verified") {
        // Another org's person is not named to this org — not in the response, not in its audit.
        outcome.alreadyVerified.push({
          scheduleId: id, authority: row.ahj || row.utility, discipline: row.discipline,
          verifiedBy: row.verifiedOrgId && row.verifiedOrgId === orgId ? row.verifiedBy : "",
        });
        continue;
      }
      markFeeScheduleVerifiedById(db, id, who, orgId);
      outcome.verified.push({ scheduleId: id, authority: row.ahj || row.utility, discipline: row.discipline });
    }
    return outcome;
  });
}

/** WHAT THE PERSON SAW, read off a request body through a whitelist: the displayed amount and
 *  the rows (with versions) behind it. null when the body does not say — which confirmPublishedFee
 *  refuses (400): a confirmation is for the amount on screen, never "whatever stands now". */
export function feeConfirmSeenFrom(body: unknown): FeeConfirmSeen | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.feeUsd == null || b.feeUsd === "" || !Array.isArray(b.scheduleRows)) return null;
  const feeUsd = Number(b.feeUsd);
  if (!Number.isFinite(feeUsd)) return null;
  const scheduleRows = (b.scheduleRows as unknown[]).slice(0, 16).flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const id = String(o.id ?? "").trim().slice(0, 80);
    return id ? [{ id, updatedAt: String(o.updatedAt ?? "").trim().slice(0, 40) }] : [];
  });
  return { feeUsd, scheduleRows };
}
