// THE RATE CARD, as a pure function — what a client owes for the filings we captured as submitted.
//
// Operator + Mark, 2026-09-29: "$100 per permit, $50 per interconnection, never more than $200 a
// project"; an interconnection filed on its own is $75 (it is the hardest filing, not a discount).
// Billed per filing WHEN IT IS FILED (the captured confirmation is the billing event); corrections
// and resubmissions are $0 lines so the statement shows the work; a cancelled job bills nothing.
//
// THE CAP IS PER PROJECT FOR ITS LIFETIME, not per month: building + electrical in September and the
// interconnection in October is still one $200 project, so a month's charge is the increment the
// month's filings add to the project's running total under the cap. Every month is re-derived from
// the filings, so the same inputs always give the same statement.
//
// DUPLICATE ROWS ARE ONE FILING: a portal run and a manual capture can both record the same
// application number (Ike's NEM carried two interconnection rows with one PGENM number); a filing
// is keyed by (type, permit type, number) and billed once, on its earliest submitted_at.

export type FilingKind = "permit" | "interconnection";

export interface RateCard {
  /** Per permit filing (building, electrical, combo, MPU-as-its-own-permit). */
  permitUsd: number;
  /** Per interconnection filing when the project also has a permit filing. */
  interconnectionUsd: number;
  /** Per interconnection filing when the project has NO permit filing at all. */
  interconnectionOnlyUsd: number;
  /** Lifetime cap per project. */
  projectCapUsd: number;
  /** 1 = list; a founding rate or a volume tier scales every line (0.75 = 25% off). */
  multiplier: number;
}

export const LIST_RATE_CARD: RateCard = { permitUsd: 100, interconnectionUsd: 50, interconnectionOnlyUsd: 75, projectCapUsd: 200, multiplier: 1 };

export interface Filing {
  projectId: string;
  kind: FilingKind;
  /** building | electrical | combo | mpu | "" for an interconnection. */
  permitType: string;
  /** The application / permit / confirmation number the portal gave us ("" when none was captured). */
  number: string;
  /** ISO timestamp the filing was captured as submitted. */
  submittedAt: string;
  /** Free text kept on the line (the submission's notes / who submitted). */
  note: string;
}

export interface BilledLine {
  projectId: string;
  kind: FilingKind;
  permitType: string;
  number: string;
  submittedAt: string;
  /** The list charge for this filing before the cap. */
  listUsd: number;
  /** What this filing adds to the project's total under the cap (0 when the cap was already reached). */
  billedUsd: number;
  /** The project's running total after this filing. */
  runningUsd: number;
  note: string;
}

const key = (f: Filing): string => `${f.kind}|${f.permitType}|${f.number.trim().toLowerCase()}`;

/** One row per real filing: duplicates of (kind, permit type, number) keep the EARLIEST capture. A row
 *  with no number at all is its own filing (nothing to dedupe against). */
export function dedupeFilings(filings: Filing[]): Filing[] {
  const byKey = new Map<string, Filing>();
  const unnumbered: Filing[] = [];
  for (const f of [...filings].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (!f.number.trim()) { unnumbered.push(f); continue; }
    if (!byKey.has(key(f))) byKey.set(key(f), f);
  }
  return [...byKey.values(), ...unnumbered].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** Price ONE project's filings in submission order under the cap. `hasAnyPermit` decides the
 *  interconnection rate for the whole project (a permit filed in any month makes the IA a bundle line). */
export function priceProject(filings: Filing[], card: RateCard): BilledLine[] {
  const ordered = dedupeFilings(filings);
  const hasAnyPermit = ordered.some((f) => f.kind === "permit");
  const round = (n: number): number => Math.round(n * 100) / 100;
  let running = 0;
  const cap = round(card.projectCapUsd * card.multiplier);
  return ordered.map((f) => {
    const base = f.kind === "permit" ? card.permitUsd : hasAnyPermit ? card.interconnectionUsd : card.interconnectionOnlyUsd;
    const listUsd = round(base * card.multiplier);
    const billedUsd = round(Math.max(0, Math.min(listUsd, cap - running)));
    running = round(running + billedUsd);
    return { projectId: f.projectId, kind: f.kind, permitType: f.permitType, number: f.number, submittedAt: f.submittedAt, listUsd, billedUsd, runningUsd: running, note: f.note };
  });
}

/** The month's lines for a client: every project priced over its LIFETIME, then only the lines whose
 *  filing was captured inside [monthStart, monthEnd) are returned — with the cap already applied
 *  against earlier months. */
export function monthLines(allFilings: Filing[], card: RateCard, monthStart: string, monthEnd: string): BilledLine[] {
  const byProject = new Map<string, Filing[]>();
  for (const f of allFilings) byProject.set(f.projectId, [...(byProject.get(f.projectId) || []), f]);
  const out: BilledLine[] = [];
  for (const filings of byProject.values()) {
    for (const line of priceProject(filings, card)) {
      if (line.submittedAt >= monthStart && line.submittedAt < monthEnd) out.push(line);
    }
  }
  return out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

export function monthBounds(yyyyMm: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyyMm);
  if (!m) throw new Error(`month must be YYYY-MM, got "${yyyyMm}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const start = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, mo, 1)).toISOString();
  return { start, end };
}
