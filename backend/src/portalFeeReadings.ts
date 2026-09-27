// ---------------------------------------------------------------------------
// THE PORTAL'S OWN FEE, READ AUTOMATICALLY OFF THE FILED RECORD (operator 2026-09-27).
//
// Ann Marineau's permit line read "$360.00 (provisional)" — our research — while her City of
// Coos Bay record 187-26-000309-STR sat on the portal with a Fees section the monitor never
// opened. The monitor already visits that record for its STATUS; this module has it read the
// FEES too, and keeps what it read with its provenance:
//
//     read from the portal record 187-26-000309-STR on 2026-09-27
//
// RULES IT KEEPS
//   - A machine read is never "verified" (a person, hard rule 3) and never written to the
//     column a person types (submission_payments.permit_fee_actual_usd — invoices bill from
//     it). It lives in portal_fee_readings and reaches the quote as source "portal_record",
//     confidence "actual": the portal's own number, read by a machine.
//   - ONE RECORD IS NOT THE TRACK. A Coos Bay job files TWO permits (the city's structural,
//     the county's electrical), each its own record with its own fees. The read total is the
//     track's fee only when EVERY filed record of the track has been read (`complete`). A
//     partial read is shown beside the researched number, never in place of it.
//   - FEES GROW. Plan review is invoiced at intake and the permit fee often at issuance, so a
//     read on a record still in review is a LOWER BOUND. submissionFees lets it lead the line
//     only when every record is issued or the read already reaches the researched figure; it
//     feeds learned history only when complete AND final.
//   - Never a $0 from an absence: "Loading...", "no fee invoiced yet" and an unknown shape are
//     stored as WHY nothing was read, with no amount (shared/src/portalFeeItems.ts).
//   - Never someone else's record: the page must name the target's own record number.
//   - It never writes fee_schedules. A schedule a person confirmed stays exactly as confirmed.
//   - Read-only: a GET of the record's own public page, then (Accela's script-loaded Fees) a
//     headless browser that navigates and reads and never clicks. PORTAL_FEE_READ=off stops
//     both; PORTAL_FEE_BROWSER_READ=off stops the browser half.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { PortalFeeRecordReading, PortalFeeRecordSummary, ProjectRecord } from "../../shared/src/types";
import { readAccelaFeeSection, type PortalFeeReadResult } from "../../shared/src/portalFeeItems";
import { trackKind, type TrackKind } from "./permitMonitor";
import { trackSafeUrl } from "./portalChannel";
import { fetchRecordPageText } from "./publicPermitStatus";

/** An Accela Citizen Access record detail page, on any host. */
const ACA_RECORD_PAGE = /\/cap\/capdetail\.aspx/i;
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { logger } from "./logger";

type Row = Record<string, unknown>;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The history row a complete, final read feeds — one per project and track, updated in place
 *  as the fees settle, so re-reading can never double-count a job in another project's median. */
export const PORTAL_RECORD_HISTORY_SOURCE = "portal_record";
const historyId = (projectId: string, track: TrackKind): string => `portal-record-${projectId}-${track}`;

// ── the two doors to the outside, behind a test seam ────────────────────────────────────────
export type RecordTextFetch = (url: string) => Promise<string | null>;
type Seams = { plain?: RecordTextFetch | null; browser?: RecordTextFetch | null };
let seams: Seams = {};
export function setPortalFeeFetchForTests(next: Seams | null): void {
  if (process.env.AUTOPILOT_TEST_SEAMS !== "1") throw new Error("setPortalFeeFetchForTests needs AUTOPILOT_TEST_SEAMS=1 — it is a test seam only.");
  seams = next ?? {};
}
const plainFetch: RecordTextFetch = (url) => (seams.plain ?? fetchRecordPageText)(url);
const browserFetch: RecordTextFetch = async (url) => {
  if (seams.browser) return seams.browser(url);
  const { readRecordPageInBrowser } = await import("../../portal-bot/src/recordPageReader");
  return readRecordPageInBrowser(url);
};

const off = (v: string | undefined): boolean => /^(off|0|false|no)$/i.test(String(v ?? "").trim());

/** A browser read is a Chromium launch. At most this many per rolling half hour. */
const BROWSER_READS_PER_WINDOW = 6;
const WINDOW_MS = 30 * 60_000;
let windowStart = 0;
let browserReadsInWindow = 0;
function takeBrowserRead(): boolean {
  const now = Date.now();
  if (now - windowStart > WINDOW_MS) { windowStart = now; browserReadsInWindow = 0; }
  if (browserReadsInWindow >= BROWSER_READS_PER_WINDOW) return false;
  browserReadsInWindow++;
  return true;
}
/** The same record is not re-read more than once in this long. */
const REREAD_AFTER_MS = 20 * 60 * 60_000;

// ── which records make up a billing track ───────────────────────────────────────────────────
interface FiledRecord { targetId: string; recordNumber: string; jurisdiction: string; url: string; outcome: string }

/** The filed records of one billing track: the project's ACTIVE tracking targets of that kind.
 *  A target whose own URL is the OTHER track's kind of portal (a permit target bound to
 *  PowerClerk — rule 5's trackSafeUrl, the same predicate the sweep uses) is not a filing of
 *  this track and is left out; a target with no URL at all is a filing we cannot read, and
 *  stays IN — it is what keeps an unreadable county record from being silently dropped. */
function filedRecords(db: AppDb, projectId: string, track: TrackKind): FiledRecord[] {
  const rows = db.query<Row>(
    "SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at, id",
    [projectId],
  );
  const out: FiledRecord[] = [];
  for (const r of rows) {
    if (trackKind(text(r.target_type), text(r.permit_type)) !== track) continue;
    const urls = [text(r.tracking_url), text(r.portal_url)].filter(Boolean);
    const safe = urls.map((u) => trackSafeUrl(track, u)).filter(Boolean);
    if (urls.length && !safe.length) continue;
    out.push({
      targetId: text(r.id),
      recordNumber: text(r.permit_number) || text(r.application_number),
      jurisdiction: text(r.jurisdiction),
      url: safe[0] ?? "",
      outcome: text(r.latest_outcome),
    });
  }
  return out;
}

const isFinalOutcome = (outcome: string): boolean => outcome === "issued";

function mapReading(row: Row): PortalFeeRecordReading {
  const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
  let lines: PortalFeeRecordReading["lines"] = [];
  try { const parsed = JSON.parse(text(row.lines_json) || "[]"); if (Array.isArray(parsed)) lines = parsed; } catch { lines = []; }
  const status = text(row.status) as PortalFeeRecordReading["status"];
  return {
    recordNumber: text(row.record_number),
    jurisdiction: text(row.jurisdiction),
    status: (["read", "not_loaded", "none_invoiced", "unreadable", "wrong_record"] as const).includes(status) ? status : "unreadable",
    totalUsd: num(row.total_usd),
    paidUsd: num(row.paid_usd),
    outstandingUsd: num(row.outstanding_usd),
    lines,
    sourceUrl: text(row.source_url),
    readAt: text(row.read_at),
    attemptedAt: text(row.attempted_at),
    recordOutcome: text(row.record_outcome),
    final: isFinalOutcome(text(row.record_outcome)),
    detail: text(row.detail),
  };
}

/** Every filed record of this track and what was read off each — null when nothing has ever
 *  been attempted (so a project the monitor never reached carries no empty summary). */
export function portalFeeSummary(db: AppDb, projectId: string, track: TrackKind): PortalFeeRecordSummary | null {
  const readings = db.query<Row>(
    "SELECT * FROM portal_fee_readings WHERE project_id = ? AND track = ? AND source_kind = 'portal_record'",
    [projectId, track],
  );
  if (!readings.length) return null;
  const byTarget = new Map(readings.map((r) => [text(r.target_id), mapReading(r)]));
  const filed = filedRecords(db, projectId, track);
  const records: PortalFeeRecordReading[] = [];
  const unread: PortalFeeRecordSummary["unread"] = [];
  for (const f of filed) {
    const reading = byTarget.get(f.targetId);
    if (reading && reading.status === "read" && reading.totalUsd != null) {
      // Finality is the record's status WHEN IT WAS READ: fees read while in review are a lower
      // bound even after the record is issued, until a read after issuance says otherwise.
      records.push(reading);
    } else {
      if (reading) records.push(reading);
      unread.push({
        recordNumber: f.recordNumber,
        jurisdiction: f.jurisdiction,
        reason: reading ? reading.detail || reading.status : "not read yet",
      });
    }
  }
  const read = records.filter((r) => r.status === "read" && r.totalUsd != null);
  const complete = filed.length > 0 && unread.length === 0;
  const totalUsd = read.length ? round2(read.reduce((s, r) => s + Number(r.totalUsd), 0)) : null;
  const provenance = read.length
    ? `read from the portal record${read.length === 1 ? "" : "s"} ${read.map((r) => `${r.recordNumber || "(no number)"} on ${r.readAt.slice(0, 10)}`).join(" and ")}`
    : "";
  return { track, complete, totalUsd, final: read.length > 0 && read.every((r) => r.final), records, unread, provenance };
}

/** Upsert one record's reading. A refusal (nothing read) never overwrites an earlier READ —
 *  fees do not disappear, so a later "Loading..." or an unknown shape is our failure, not a
 *  refund — it only moves `attempted_at`.
 *
 *  NOT EVEN THE RECORD'S OUTCOME (skeptic MF1, 2026-09-27). `record_outcome` on a read row is
 *  the record's status WHEN THOSE AMOUNTS WERE READ, and finality is derived from it
 *  (mapReading). A refused re-read after the record was issued used to stamp "issued" onto a $99
 *  read while it was in review — the lower bound became the final "actual", fed learned history
 *  and moved a neighbour's quote. Only a SUCCESSFUL read of the same record changes the amounts,
 *  the outcome, or the finality. Consequence, on purpose: until a read succeeds, the stored
 *  outcome still differs from the target's, so readAndRecordPortalFees keeps re-trying on each
 *  sweep visit instead of waiting 20h (browser launches stay capped by takeBrowserRead). */
export function recordPortalFeeReading(
  db: AppDb,
  input: {
    projectId: string; targetId: string; track: TrackKind; recordNumber: string; jurisdiction: string;
    platform: string; sourceUrl: string; recordOutcome: string; result: PortalFeeReadResult | { ok: false; reason: "wrong_record"; detail: string };
  },
): { changed: boolean; status: string } {
  const ts = nowIso();
  const prior = db.get<Row>(
    "SELECT * FROM portal_fee_readings WHERE project_id = ? AND target_id = ? AND source_kind = 'portal_record'",
    [input.projectId, input.targetId],
  );
  const r = input.result;
  if (!r.ok) {
    if (prior && text(prior.status) === "read") {
      db.run("UPDATE portal_fee_readings SET attempted_at = ? WHERE id = ?", [ts, text(prior.id)]);
      return { changed: false, status: "read" };
    }
    if (prior) {
      db.run(
        "UPDATE portal_fee_readings SET status = ?, detail = ?, source_url = ?, record_outcome = ?, attempted_at = ? WHERE id = ?",
        [r.reason, r.detail.slice(0, 400), input.sourceUrl, input.recordOutcome, ts, text(prior.id)],
      );
    } else {
      db.run(
        `INSERT INTO portal_fee_readings (id, project_id, target_id, track, source_kind, record_number, jurisdiction, platform, source_url, status, detail, record_outcome, attempted_at)
         VALUES (?, ?, ?, ?, 'portal_record', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), input.projectId, input.targetId, input.track, input.recordNumber, input.jurisdiction, input.platform, input.sourceUrl, r.reason, r.detail.slice(0, 400), input.recordOutcome, ts],
      );
    }
    return { changed: false, status: r.reason };
  }
  const reading = r.reading;
  const linesJson = JSON.stringify(reading.lines);
  const same = prior && text(prior.status) === "read" && Number(prior.total_usd) === reading.totalUsd && text(prior.lines_json) === linesJson;
  if (prior) {
    db.run(
      `UPDATE portal_fee_readings SET status = 'read', detail = '', record_number = ?, jurisdiction = ?, platform = ?, source_url = ?,
         total_usd = ?, paid_usd = ?, outstanding_usd = ?, lines_json = ?, excerpt = ?, record_outcome = ?, read_at = ?, attempted_at = ? WHERE id = ?`,
      [input.recordNumber, input.jurisdiction, input.platform, input.sourceUrl, reading.totalUsd, reading.paidUsd, reading.outstandingUsd,
        linesJson, reading.excerpt, input.recordOutcome, same ? text(prior.read_at) || ts : ts, ts, text(prior.id)],
    );
  } else {
    db.run(
      `INSERT INTO portal_fee_readings (id, project_id, target_id, track, source_kind, record_number, jurisdiction, platform, source_url, status,
         total_usd, paid_usd, outstanding_usd, lines_json, excerpt, record_outcome, read_at, attempted_at)
       VALUES (?, ?, ?, ?, 'portal_record', ?, ?, ?, ?, 'read', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id(), input.projectId, input.targetId, input.track, input.recordNumber, input.jurisdiction, input.platform, input.sourceUrl,
        reading.totalUsd, reading.paidUsd, reading.outstandingUsd, linesJson, reading.excerpt, input.recordOutcome, ts, ts],
    );
  }
  return { changed: !same, status: "read" };
}

/** Feed learned history the way an operator-entered fee does — ONE row per project and track,
 *  and only once the read is the whole track (complete) and settled (every record issued).
 *  Anything less is removed, so a job whose fees are still growing never drags another
 *  project's median down. The row's source marks it machine-read: submissionFees never calls a
 *  median that contains one "verified". */
export function refreshPortalFeeHistory(db: AppDb, project: Pick<ProjectRecord, "id" | "state" | "ahj" | "utility">, track: TrackKind): void {
  const summary = portalFeeSummary(db, project.id, track);
  const rowId = historyId(project.id, track);
  if (!summary || !summary.complete || !summary.final || summary.totalUsd == null || summary.totalUsd <= 0) {
    db.run("DELETE FROM permit_fee_history WHERE id = ?", [rowId]);
    return;
  }
  const readAt = summary.records.map((r) => r.readAt).filter(Boolean).sort().slice(-1)[0] || nowIso();
  db.run(
    `INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET fee_usd = excluded.fee_usd, recorded_at = excluded.recorded_at, state = excluded.state, ahj = excluded.ahj, utility = excluded.utility`,
    [rowId, text(project.state), text(project.ahj), text(project.utility), track, summary.totalUsd, PORTAL_RECORD_HISTORY_SOURCE, project.id, readAt],
  );
}

/** Does the page name THIS record? Separators ignored, like the status fetch's relevance rule. */
function pageNamesRecord(pageText: string, recordNumber: string): boolean {
  const want = recordNumber.replace(/[\s-]+/g, "").toUpperCase();
  return !!want && pageText.replace(/[\s-]+/g, "").toUpperCase().includes(want);
}

/** READ EVERY FILED PERMIT RECORD'S FEES NOW — the fee panel's "Read the fee from the portal"
 *  button, for when the weekly sweep has not reached a record yet. Same reader, same refusals,
 *  same throttle on browser launches; only the once-per-20h re-read wait is skipped, because a
 *  person asked. Sequential on purpose: one browser at a time. */
export async function readProjectPortalFees(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "state" | "ahj" | "utility">,
): Promise<Array<{ recordNumber: string; jurisdiction: string; status: string; skipped?: string }>> {
  const out: Array<{ recordNumber: string; jurisdiction: string; status: string; skipped?: string }> = [];
  for (const record of filedRecords(db, project.id, "permit")) {
    const r = await readAndRecordPortalFees(db, project, record.targetId, { force: true })
      .catch((err) => ({ status: "failed", skipped: err instanceof Error ? err.message.slice(0, 200) : "read failed" }));
    out.push({ recordNumber: record.recordNumber, jurisdiction: record.jurisdiction, ...r });
  }
  return out;
}

/**
 * THE MONITOR'S HOOK: after a target's status is recorded, read that record's fees.
 * Never throws at the sweep (the caller also guards) and never touches the status.
 */
export async function readAndRecordPortalFees(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "state" | "ahj" | "utility">,
  targetId: string,
  opts: { force?: boolean } = {},
): Promise<{ status: string; skipped?: string }> {
  if (off(process.env.PORTAL_FEE_READ)) return { status: "skipped", skipped: "PORTAL_FEE_READ=off" };
  const target = db.get<Row>("SELECT * FROM permit_check_targets WHERE id = ? AND project_id = ?", [targetId, project.id]);
  if (!target || Number(target.active ?? 0) !== 1) return { status: "skipped", skipped: "no active target" };
  const track = trackKind(text(target.target_type), text(target.permit_type));
  // The interconnection side (PowerClerk) prints no fee on the application page we can read;
  // NEM fees stay with research + the operator until a portal shape is captured.
  if (track !== "permit") return { status: "skipped", skipped: "nem track" };
  const record = filedRecords(db, project.id, track).find((f) => f.targetId === targetId);
  if (!record || !record.url) return { status: "skipped", skipped: "no track-safe record URL" };
  // ONLY THE RECORD'S OWN PAGE. A portal home or search URL is not a record; constructing a
  // CapDetail link from a display number is a guess (Oregon's 4-part numbers do not map). Judged
  // by the ACA record page's own path, not the host, so an Accela site on a city's own domain
  // (…/CitizenAccess/Cap/CapDetail.aspx) is read the same way as aca-oregon.accela.com.
  if (!ACA_RECORD_PAGE.test(record.url)) {
    return { status: "skipped", skipped: "not an Accela record-detail URL" };
  }
  if (!record.recordNumber) return { status: "skipped", skipped: "target has no record number" };
  const prior = db.get<Row>("SELECT status, read_at, attempted_at, record_outcome FROM portal_fee_readings WHERE project_id = ? AND target_id = ? AND source_kind = 'portal_record'", [project.id, targetId]);
  const lastTry = Date.parse(text(prior?.attempted_at));
  // A record whose status moved since the last read (issued, typically — when the permit fee is
  // invoiced) is re-read at once; otherwise at most once per REREAD_AFTER_MS.
  const outcomeMoved = !!prior && text(prior.record_outcome) !== record.outcome;
  if (!opts.force && !outcomeMoved && Number.isFinite(lastTry) && Date.now() - lastTry < REREAD_AFTER_MS) {
    return { status: "skipped", skipped: "read recently" };
  }

  const base = {
    projectId: project.id, targetId, track, recordNumber: record.recordNumber, jurisdiction: record.jurisdiction,
    platform: "accela", sourceUrl: record.url, recordOutcome: record.outcome,
  };
  let pageText = await plainFetch(record.url).catch(() => null);
  let result: PortalFeeReadResult = pageText ? readAccelaFeeSection(pageText) : { ok: false, reason: "no_fee_section", detail: "The record page could not be fetched." };
  if (!result.ok && result.reason === "not_loaded" && !off(process.env.PORTAL_FEE_BROWSER_READ) && takeBrowserRead()) {
    const rendered = await browserFetch(record.url).catch(() => null);
    if (rendered) {
      pageText = rendered;
      result = readAccelaFeeSection(rendered);
    }
  }
  if (pageText && !pageNamesRecord(pageText, record.recordNumber)) {
    const out = recordPortalFeeReading(db, { ...base, result: { ok: false, reason: "wrong_record", detail: `The page at the target's URL does not name record ${record.recordNumber} — refusing to read someone else's fees.` } });
    return { status: out.status };
  }
  const out = recordPortalFeeReading(db, { ...base, result });
  refreshPortalFeeHistory(db, project, track);
  if (out.changed) {
    logger.info("fees", "read the portal's own fee off a filed record", {
      projectId: project.id, targetId, recordNumber: record.recordNumber, totalUsd: result.ok ? result.reading.totalUsd : null,
    });
  }
  return { status: out.status };
}
