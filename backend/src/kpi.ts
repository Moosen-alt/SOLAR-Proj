import { DEFAULT_ORG_ID } from "./db";
import type { AppDb, SqlParam } from "./db";
import { mergeStepReport, MIN_CONFIRMED_FIELDS } from "./replayBenchmark";

type Row = Record<string, SqlParam>;

/**
 * HOW WELL THE AUTOMATION IS ACTUALLY FILING — measured on real production runs.
 *
 * Every other number here is about the business: how long a permit took, how many
 * corrections came back. None of them say whether the robot did its job, and the two are
 * not the same question. A filing staged with three blank required fields still reaches
 * handoff on time, because a human quietly filled them in — the cost lands on a person's
 * afternoon and shows up nowhere.
 *
 * These come from `portal_runs.result_json`, which has always stored the whole run report
 * (the replay's blanks, drift warnings and review-screen check), so this is computed from
 * history rather than requiring new instrumentation — the numbers below are real for runs
 * that already happened. Same definitions as the replay benchmark, via the same reader, so
 * a lab score and a production score cannot mean different things.
 */
export interface StagingQuality {
  runs: number;
  /** Runs whose report could be read at all. */
  measured: number;
  /** Nothing blank, nothing that failed to land, no drift warnings. */
  clean: number;
  cleanRate: number;
  /** Clean AND the portal's own review screen agreed with the project. */
  verified: number;
  verifiedRate: number;
  /** Runs that handed a person something to finish. */
  neededHuman: number;
  avgBlanksPerRun: number;
  /** How many required fields the portals asked for, per run — the denominator under
   *  avgBlanksPerRun. Zero blanks out of thirty required and zero blanks out of nothing
   *  seen are the same headline and opposite facts. */
  avgRequiredPerRun: number;
  /** CLEAN RUNS THAT NEVER SAW A REQUIRED FIELD. Not a failure and not a success: a score
   *  nothing can falsify. If this climbs, the sweep has stopped reaching the pages it is
   *  meant to check and the clean rate above it is drifting loose from the portals. */
  blindClean: number;
  /** The fields most often left blank — what to fix first, in order. */
  topGaps: Array<{ field: string; runs: number }>;
  /** Portals whose replays are drifting: re-anchored selectors, values not holding. */
  driftingPortals: Array<{ portal: string; runs: number }>;
}

export interface KpiReport {
  period: { start: string; end: string };
  projectsSubmitted: number;
  projectsHandedOff: number;        // permit issued + NEM approved — our completion metric
  avgPermitCycleDays: number | null; // submit → permit issued
  avgNemCycleDays: number | null;    // submit → NEM approved
  avgTotalCycleDays: number | null;  // submit → handoff_ready (both complete)
  correctionRate: number;
  avgCorrectionsPerProject: number;
  openCorrections: number;
  overdueCorrections: number;
  slaBreachRate: number;
  throughputPerWeek: number;         // handoffs per week in period
  /** How well the automation filled, not just how fast the business moved. */
  stagingQuality: StagingQuality;
  byUser: Array<{
    userId: string;
    userName: string;
    submitted: number;
    handedOff: number;
    openProjects: number;
    overdueCorrections: number;
    avgCycleDays: number | null;
  }>;
}

export interface ProjectMetricsRecord {
  projectId: string;
  submittedAt: string | null;
  permitIssuedAt: string | null;
  nemApprovedAt: string | null;
  ptoAt: string | null;
  firstCorrectionAt: string | null;
  lastCorrectionAt: string | null;
  correctionCount: number;
  permitCycleDays: number | null;
  nemCycleDays: number | null;
  totalCycleDays: number | null;
  slaBreaches: number;
  assignedUserId: string | null;
  updatedAt: string;
}

function mapMetrics(row: Row): ProjectMetricsRecord {
  return {
    projectId: String(row.project_id),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    permitIssuedAt: row.permit_issued_at == null ? null : String(row.permit_issued_at),
    nemApprovedAt: row.nem_approved_at == null ? null : String(row.nem_approved_at),
    ptoAt: row.pto_at == null ? null : String(row.pto_at),
    firstCorrectionAt: row.first_correction_at == null ? null : String(row.first_correction_at),
    lastCorrectionAt: row.last_correction_at == null ? null : String(row.last_correction_at),
    correctionCount: Number(row.correction_count ?? 0),
    permitCycleDays: row.permit_cycle_days == null ? null : Number(row.permit_cycle_days),
    nemCycleDays: row.nem_cycle_days == null ? null : Number(row.nem_cycle_days),
    totalCycleDays: row.total_cycle_days == null ? null : Number(row.total_cycle_days),
    slaBreaches: Number(row.sla_breaches ?? 0),
    assignedUserId: row.assigned_user_id == null ? null : String(row.assigned_user_id),
    updatedAt: String(row.updated_at),
  };
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

export function touchProjectMetrics(db: AppDb, projectId: string): void {
  const now = new Date().toISOString();

  // Pull lifecycle timestamps from permit_status_checks and corrections
  const submitRow = db.get<Row>(
    "SELECT MIN(started_at) as t FROM portal_runs WHERE project_id = ? AND status NOT IN ('failed')",
    [projectId],
  );
  const permitRow = db.get<Row>(
    "SELECT MIN(created_at) as t FROM permit_status_checks WHERE project_id = ? AND outcome = 'issued'",
    [projectId],
  );
  const nemRow = db.get<Row>(
    "SELECT MIN(created_at) as t FROM permit_status_checks WHERE project_id = ? AND outcome = 'nem_approved'",
    [projectId],
  );
  const corrRows = db.query<Row>(
    "SELECT created_at, closed_at, sla_days FROM corrections WHERE project_id = ? ORDER BY created_at ASC",
    [projectId],
  );

  const submittedAt = submitRow?.t != null ? String(submitRow.t) : null;
  const permitIssuedAt = permitRow?.t != null ? String(permitRow.t) : null;
  const nemApprovedAt = nemRow?.t != null ? String(nemRow.t) : null;
  // handoff_ready is our completion milestone — submit scope ends when both permit issued + NEM approved
  const handoffRow = db.get<Row>(
    "SELECT MIN(created_at) as t FROM project_notes WHERE project_id = ? AND note_type = 'handoff'",
    [projectId],
  );
  const handoffAt = handoffRow?.t != null ? String(handoffRow.t) : null;
  const firstCorrectionAt = corrRows.length > 0 ? String(corrRows[0].created_at) : null;
  const lastCorrectionAt = corrRows.length > 0 ? String(corrRows[corrRows.length - 1].created_at) : null;
  const correctionCount = corrRows.length;

  let slaBreaches = 0;
  for (const c of corrRows) {
    const slaDays = Number(c.sla_days ?? 5);
    const created = new Date(String(c.created_at));
    const due = new Date(created.getTime() + slaDays * 86_400_000);
    const closed = c.closed_at ? new Date(String(c.closed_at)) : new Date();
    if (closed > due) slaBreaches++;
  }

  const daysBetween = (a: string | null, b: string | null) =>
    a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000 * 10) / 10 : null;

  const permitCycleDays = daysBetween(submittedAt, permitIssuedAt);
  const nemCycleDays = daysBetween(submittedAt, nemApprovedAt);
  // total cycle = submit → handoff_ready (permit issued + NEM approved — our actual completion)
  const totalCycleDays = daysBetween(submittedAt, handoffAt);

  db.run(
    `INSERT INTO project_metrics
      (project_id, submitted_at, permit_issued_at, nem_approved_at, pto_at,
       first_correction_at, last_correction_at, correction_count,
       permit_cycle_days, nem_cycle_days, total_cycle_days, sla_breaches, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       submitted_at = excluded.submitted_at,
       permit_issued_at = excluded.permit_issued_at,
       nem_approved_at = excluded.nem_approved_at,
       pto_at = excluded.pto_at,
       first_correction_at = excluded.first_correction_at,
       last_correction_at = excluded.last_correction_at,
       correction_count = excluded.correction_count,
       permit_cycle_days = excluded.permit_cycle_days,
       nem_cycle_days = excluded.nem_cycle_days,
       total_cycle_days = excluded.total_cycle_days,
       sla_breaches = excluded.sla_breaches,
       updated_at = excluded.updated_at`,
    [
      projectId, submittedAt, permitIssuedAt, nemApprovedAt, null /* pto outside our scope */,
      firstCorrectionAt, lastCorrectionAt, correctionCount,
      permitCycleDays, nemCycleDays, totalCycleDays, slaBreaches, now,
    ],
  );
}

export function getKpiReport(
  db: AppDb,
  options: { startDate?: string; endDate?: string; orgId?: string | null } = {},
): KpiReport {
  // Tenant scope. `null` reads across every org (superadmin); omitting it means the
  // default tenant, so a forgotten filter under-reports rather than leaking.
  const orgId = options.orgId === null ? null : (options.orgId || DEFAULT_ORG_ID);
  const orgAnd = (col: string) => (orgId ? ` AND ${col} = ?` : "");
  const orgP = orgId ? [orgId] : [];
  const start = options.startDate || new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const end = options.endDate || new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const metrics = db.query<Row>(
    `SELECT m.* FROM project_metrics m
     JOIN projects p ON p.id = m.project_id${orgId ? " AND p.org_id = ?" : ""}
     WHERE m.submitted_at >= ? AND m.submitted_at <= ?`,
    [...orgP, start, end + "T23:59:59"],
  ).map(mapMetrics);

  const allCorrections = db.query<Row>(
    `SELECT c.*, p.assigned_user_id FROM corrections c
     JOIN projects p ON c.project_id = p.id${orgId ? " AND p.org_id = ?" : ""}
     WHERE c.created_at >= ? AND c.created_at <= ?`,
    [...orgP, start, end + "T23:59:59"],
  );
  const openCorrections = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM corrections c
       JOIN projects p ON p.id = c.project_id${orgId ? " AND p.org_id = ?" : ""}
       WHERE c.closed_at IS NULL`,
      orgP,
    )?.cnt ?? 0,
  );
  const overdueCorrections = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM corrections c
       JOIN projects p ON p.id = c.project_id${orgId ? " AND p.org_id = ?" : ""}
       WHERE c.closed_at IS NULL
         AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))`,
      [...orgP, today, today],
    )?.cnt ?? 0,
  );

  const projectsWithCorrections = new Set(allCorrections.map((c) => String(c.project_id))).size;
  const totalSlaBreaches = allCorrections.filter((c) => {
    const slaDays = Number(c.sla_days ?? 5);
    const due = new Date(new Date(String(c.created_at)).getTime() + slaDays * 86_400_000);
    const closed = c.closed_at ? new Date(String(c.closed_at)) : new Date();
    return closed > due;
  }).length;

  const permitCycles = metrics.map((m) => m.permitCycleDays).filter((v): v is number => v !== null);
  const nemCycles = metrics.map((m) => m.nemCycleDays).filter((v): v is number => v !== null);
  const totalCycles = metrics.map((m) => m.totalCycleDays).filter((v): v is number => v !== null);

  const periodDays = Math.max(1, (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000);
  // Completion = handoff_ready (permit issued + NEM approved) — our actual deliverable
  const handoffCount = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM projects
       WHERE status = 'handoff_ready'${orgAnd("org_id")} AND updated_at >= ? AND updated_at <= ?`,
      [...orgP, start, end + "T23:59:59"],
    )?.cnt ?? 0,
  );

  // Per-user breakdown
  const users = db.query<Row>(
    `SELECT * FROM users WHERE active = 1${orgAnd("org_id")}`,
    orgP,
  );
  const byUser = users.map((u) => {
    const uid = String(u.id);
    const userMetrics = metrics.filter((m) => m.assignedUserId === uid);
    const userCycles = userMetrics.map((m) => m.totalCycleDays).filter((v): v is number => v !== null);
    const userOverdue = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM corrections c
         JOIN projects p ON c.project_id = p.id${orgId ? " AND p.org_id = ?" : ""}
         WHERE p.assigned_user_id = ? AND c.closed_at IS NULL
           AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))`,
        [...orgP, uid, today, today],
      )?.cnt ?? 0,
    );
    const userOpen = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ?${orgAnd("org_id")} AND status NOT IN ('handoff_ready','blocked')`,
        [uid, ...orgP],
      )?.cnt ?? 0,
    );
    return {
      userId: uid,
      userName: String(u.name),
      submitted: userMetrics.length,
      handedOff: Number(
        db.get<Row>(
          `SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ?${orgAnd("org_id")} AND status = 'handoff_ready' AND updated_at >= ? AND updated_at <= ?`,
          [uid, ...orgP, start, end + "T23:59:59"],
        )?.cnt ?? 0,
      ),
      openProjects: userOpen,
      overdueCorrections: userOverdue,
      avgCycleDays: avg(userCycles),
    };
  });

  return {
    period: { start, end },
    projectsSubmitted: metrics.length,
    projectsHandedOff: handoffCount,
    avgPermitCycleDays: avg(permitCycles),
    avgNemCycleDays: avg(nemCycles),
    avgTotalCycleDays: avg(totalCycles),
    correctionRate: metrics.length > 0 ? Math.round((projectsWithCorrections / metrics.length) * 100) : 0,
    avgCorrectionsPerProject: metrics.length > 0
      ? Math.round((allCorrections.length / metrics.length) * 10) / 10
      : 0,
    openCorrections,
    overdueCorrections,
    slaBreachRate: allCorrections.length > 0
      ? Math.round((totalSlaBreaches / allCorrections.length) * 100)
      : 0,
    throughputPerWeek: Math.round((handoffCount / periodDays) * 7 * 10) / 10,
    stagingQuality: getStagingQuality(db, { start, end, orgId }),
    byUser,
  };
}

/**
 * Staging quality over a period, read back out of the runs we already recorded.
 *
 * Deliberately CONSERVATIVE about what counts as measured: a run whose result_json cannot
 * be parsed, or that carries no replay report at all (a learn run, an adapter that never
 * reached the form), is excluded rather than counted as clean. A quality metric that scores
 * "we could not tell" as "fine" is the same failure the replay benchmark was built to stop
 * — it reported a filing the portal was refusing as `replayed_clean` for three runs.
 */
export function getStagingQuality(
  db: AppDb,
  opts: { start: string; end: string; orgId?: string | null },
): StagingQuality {
  const orgId = opts.orgId === null ? null : (opts.orgId || DEFAULT_ORG_ID);
  const rows = db.query<Row>(
    `SELECT r.result_json AS rj
       FROM portal_runs r
       JOIN projects p ON p.id = r.project_id${orgId ? " AND p.org_id = ?" : ""}
      WHERE r.run_type = 'prepare_submit'
        AND r.started_at >= ? AND r.started_at <= ?`,
    [...(orgId ? [orgId] : []), opts.start, opts.end + "T23:59:59"],
  );

  const gapCounts = new Map<string, number>();
  const driftCounts = new Map<string, number>();
  let measured = 0, clean = 0, verified = 0, neededHuman = 0, blanksTotal = 0;
  let requiredTotal = 0, blindClean = 0;

  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.rj || "{}")); } catch { continue; }
    const rep = mergeStepReport(parsed);
    // No replay report on this run — a learn, or an adapter that never reached the form.
    // Not evidence of quality either way.
    if (rep.executed === undefined && rep.requiredStillEmpty === undefined) continue;
    measured++;

    const blanks = (rep.requiredStillEmpty as string[] | undefined) ?? [];
    const unresolved = new Set(((rep.unresolvedFields as string[] | undefined) ?? []).map(String));
    const skipped = ((rep.skipped as string[] | undefined) ?? [])
      .filter((s) => !/final submit|NOT clicked/i.test(String(s)));   // declining submit is the rule, not a fault
    const failed = skipped.filter((s) => !unresolved.has(String(s)));
    const drift = (rep.driftWarnings as string[] | undefined) ?? [];
    const healed = ((rep.healedSteps as unknown[] | undefined) ?? []).length;
    const fieldsSeen = Number(rep.reviewFieldsSeen ?? 0);
    // Reading the page is not checking it — the benchmark's own bar, so the two agree.
    const confirmedFields = Number(rep.reviewFieldsConfirmed ?? 0);
    const mismatches = ((rep.reviewMismatches as unknown[] | undefined) ?? []).length;

    blanksTotal += blanks.length;
    for (const b of blanks.slice(0, 12)) {
      const key = String(b).replace(/ — the portal flagged this field$/, "").slice(0, 60);
      if (key) gapCounts.set(key, (gapCounts.get(key) ?? 0) + 1);
    }
    if (drift.length || healed) {
      const portal = String((rep.portalName as string) || "unknown").slice(0, 40);
      driftCounts.set(portal, (driftCounts.get(portal) ?? 0) + 1);
    }

    // A FILING THE PORTAL'S OWN REVIEW SCREEN CONTRADICTS IS NOT CLEAN.
    //
    // It ran without a stumble and it is still wrong — the live shape of this was a
    // PowerClerk filing where every step executed, nothing was blank, and the preparer
    // block held the homeowner's name instead of the contractor's. The replay benchmark
    // says DO NOT SUBMIT about that run; a headline number that called it clean would be
    // saying the opposite thing about the same filing.
    // ABSENT IS NOT ZERO. Every run staged before this field existed carries no
    // requiredFieldsSeen at all, and treating that as "saw nothing" would flag the entire
    // back catalogue as unfalsifiable on the day the feature shipped — the same mistake as
    // counting an unreadable run as clean, pointing the other way. Absence means old build.
    const sawRequired = Array.isArray(rep.requiredFieldsSeen);
    const requiredSeen = sawRequired ? (rep.requiredFieldsSeen as string[]).length : 0;
    requiredTotal += requiredSeen;

    const isClean = !blanks.length && !failed.length && !drift.length && !healed && !mismatches;
    if (isClean) clean++;
    // A clean run that never saw a required control did not prove the filing is complete;
    // it proved only that it found nothing to object to, which is also what a run that never
    // looked reports. Counted separately so the clean rate can be read honestly.
    if (isClean && sawRequired && requiredSeen === 0) blindClean++;
    // The top bar, same as the benchmark's: clean AND the portal's own review screen agreed.
    if (isClean && fieldsSeen > 0 && confirmedFields >= MIN_CONFIRMED_FIELDS) verified++;
    if (blanks.length || failed.length || mismatches) neededHuman++;
  }

  const pct = (n: number): number => (measured ? Math.round((n / measured) * 1000) / 10 : 0);
  const top = (m: Map<string, number>, k: string): Array<{ [key: string]: string | number }> =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ [k]: name, runs: n }));

  return {
    runs: rows.length,
    measured,
    clean,
    cleanRate: pct(clean),
    verified,
    verifiedRate: pct(verified),
    neededHuman,
    avgBlanksPerRun: measured ? Math.round((blanksTotal / measured) * 10) / 10 : 0,
    avgRequiredPerRun: measured ? Math.round((requiredTotal / measured) * 10) / 10 : 0,
    blindClean,
    topGaps: top(gapCounts, "field") as Array<{ field: string; runs: number }>,
    driftingPortals: top(driftCounts, "portal") as Array<{ portal: string; runs: number }>,
  };
}
