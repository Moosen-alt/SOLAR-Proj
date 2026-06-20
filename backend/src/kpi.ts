import type { AppDb, SqlParam } from "./db";

type Row = Record<string, SqlParam>;

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
    "SELECT MIN(created_at) as t FROM portal_runs WHERE project_id = ? AND status NOT IN ('failed','cancelled')",
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
  options: { startDate?: string; endDate?: string } = {},
): KpiReport {
  const start = options.startDate || new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const end = options.endDate || new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const metrics = db.query<Row>(
    "SELECT * FROM project_metrics WHERE submitted_at >= ? AND submitted_at <= ?",
    [start, end + "T23:59:59"],
  ).map(mapMetrics);

  const allCorrections = db.query<Row>(
    `SELECT c.*, p.assigned_user_id FROM corrections c
     JOIN projects p ON c.project_id = p.id
     WHERE c.created_at >= ? AND c.created_at <= ?`,
    [start, end + "T23:59:59"],
  );
  const openCorrections = Number(
    db.get<Row>("SELECT COUNT(*) as cnt FROM corrections WHERE closed_at IS NULL")?.cnt ?? 0,
  );
  const overdueCorrections = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM corrections
       WHERE closed_at IS NULL
         AND (due_at < ? OR (due_at IS NULL AND date(created_at, '+' || sla_days || ' days') < ?))`,
      [today, today],
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
       WHERE status = 'handoff_ready' AND updated_at >= ? AND updated_at <= ?`,
      [start, end + "T23:59:59"],
    )?.cnt ?? 0,
  );

  // Per-user breakdown
  const users = db.query<Row>("SELECT * FROM users WHERE active = 1");
  const byUser = users.map((u) => {
    const uid = String(u.id);
    const userMetrics = metrics.filter((m) => m.assignedUserId === uid);
    const userCycles = userMetrics.map((m) => m.totalCycleDays).filter((v): v is number => v !== null);
    const userOverdue = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM corrections c
         JOIN projects p ON c.project_id = p.id
         WHERE p.assigned_user_id = ? AND c.closed_at IS NULL
           AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))`,
        [uid, today, today],
      )?.cnt ?? 0,
    );
    const userOpen = Number(
      db.get<Row>(
        "SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ? AND status NOT IN ('handoff_ready','blocked')",
        [uid],
      )?.cnt ?? 0,
    );
    return {
      userId: uid,
      userName: String(u.name),
      submitted: userMetrics.length,
      handedOff: Number(
        db.get<Row>(
          "SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ? AND status = 'handoff_ready' AND updated_at >= ? AND updated_at <= ?",
          [uid, start, end + "T23:59:59"],
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
    byUser,
  };
}
