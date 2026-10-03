// ===========================================================================
// kpi-filings.js — the KPI panel's per-FILING measures (#49 KpiReport.filings, #74), no DOM.
//
// dashboard.html loads this as a classic script (window.KpiFilings) ahead of the dashboard
// module, and backend/test/kpiFilingsPanel.test.ts loads the same file through node:vm, so
// the display rules below are pinned without a browser. Keep it pure: report in, rows/HTML out.
//
// The display rules (issue #74), each one because a bare number lies:
//   - every rate carries "n / of" beside the percent: 100% on three filings is noise, and the
//     report flags it (smallN, below 10) — those rows render greyed, never hidden;
//   - every cycle stat shows median, p90 and n; a null median (n = 0) is "—", never 0 days;
//   - the two AHJ tables are keyed on DIFFERENT things (first pass on the project's AHJ as
//     entered, submit→issued on the KB profile key) — each says what it is keyed on rather
//     than being merged on a guessed join;
//   - the report's own caveats (filings.notes) print under the panel.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.KpiFilings = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const DASH = '—';
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const CAUSE_LABEL = {
    keelix_catchable: 'Keelix-catchable (we fix)',
    design: 'Design (designer fixes)',
    ahj_discretionary: 'AHJ discretionary (reviewer clarification)',
    unclassified: 'Unclassified (no cause bucket)',
  };

  // A rate row: the percent, then n / of. smallN rows render greyed with the n still shown.
  function rateRow(label, r) {
    const rate = r || { n: 0, of: 0, rate: null, smallN: true };
    return { label, value: rate.rate == null ? DASH : `${rate.rate}%`, detail: `${rate.n} / ${rate.of}`, smallN: !!rate.smallN };
  }

  // A cycle row: median, p90 and n. A null median is a dash — "no closed filings" is not "0 days".
  function cycleRow(label, c, unit) {
    const s = c || { median: null, p90: null, n: 0 };
    const fmt = (v) => (v == null ? DASH : `${v}${unit}`);
    return { label, value: fmt(s.median), detail: `p90 ${fmt(s.p90)} · n ${s.n}`, smallN: false };
  }

  // Sections of plain-text rows (nothing escaped here — renderFilingKpis escapes every cell).
  function buildFilingKpiRows(f) {
    if (!f) return [];
    const fp = f.firstPass || {};
    const cc = f.correctionCycles || {};
    const sti = f.submitToIssued || {};
    const ic = f.interconnection || {};
    const gate = f.reviewerGate || {};
    const q = f.humanQueue || {};
    const open = f.openPastP90 || { n: 0, items: [] };
    return [
      { title: 'First-pass rate (permits issued with zero correction notices)', head: ['Measure', 'Rate', 'n / of'],
        rows: [rateRow('All permits', fp.overall)] },
      { title: 'First pass by track', keyedOn: 'filing track', head: ['Track', 'Rate', 'n / of'],
        rows: (fp.byTrack || []).map((t) => rateRow(t.key, t)) },
      { title: 'First pass by AHJ', keyedOn: "the project's AHJ as entered", head: ['AHJ', 'Rate', 'n / of'],
        rows: (fp.byAhj || []).map((t) => rateRow(t.key, t)) },
      { title: `Correction cycles by cause (${cc.permits ?? 0} permit filing(s))`, head: ['Cause', 'Notices', 'Per permit'],
        rows: (cc.byCause || []).map((c) => ({ label: CAUSE_LABEL[c.cause] || c.cause, value: String(c.notices), detail: c.perPermit == null ? DASH : String(c.perPermit), smallN: false })) },
      { title: 'Keelix-catchable notices per 100 permits, by month submitted (target 0)', head: ['Month', 'Per 100', 'Notices / permits'],
        rows: (cc.keelixPer100ByMonth || []).map((m) => ({ label: m.month, value: String(m.per100), detail: `${m.notices} / ${m.permits}`, smallN: m.permits < 10 })) },
      { title: 'Submitted → issued', head: ['Measure', 'Median', 'p90 · n'],
        rows: [cycleRow('This period\'s permits', sti.overall, 'd')] },
      { title: 'Submitted → issued by AHJ (all-time)', keyedOn: 'the KB profile key (state + AHJ)', head: ['Profile key', 'Median', 'p90 · n'],
        rows: (sti.byAhj || []).map((a) => cycleRow(a.key, a, 'd')) },
      { title: 'Interconnection (NEM)', head: ['Measure', 'Value', 'Detail'],
        rows: [
          rateRow('Filings with a deficiency', ic.deficiencyRate),
          cycleRow('Cure days (closed notices)', ic.cureDays, 'd'),
          rateRow('Notices past the cure window', ic.cureBreaches),
          cycleRow('Submitted → approved', ic.submitToApproved, 'd'),
        ] },
      { title: 'Reviewer gate', head: ['Measure', 'Rate', 'n / of'],
        rows: [
          rateRow('False negatives (bucket-A notice the gate did not flag)', gate.falseNegatives),
          rateRow('False positives (blocked, then overridden)', gate.falsePositives),
        ] },
      { title: 'Human work', head: ['Measure', 'Value', 'Detail'],
        rows: [
          cycleRow('Minutes from staged to sent', f.humanMinutes, ' min'),
          { label: 'Required fields left blank per run', value: String(f.blanksFilledPerRun?.avg ?? DASH), detail: `of ${f.blanksFilledPerRun?.of ?? 0} measured run(s)`, smallN: (f.blanksFilledPerRun?.of ?? 0) < 10 },
          { label: 'Waiting on a person to submit', value: String(q.n ?? 0), detail: `oldest ${q.oldestDays == null ? DASH : `${q.oldestDays}d`} · ${q.overAge ?? 0} over ${q.olderThanDays ?? 0}d`, smallN: false, warn: (q.overAge ?? 0) > 0 },
        ] },
      { title: `Open past p90 (${open.n ?? 0})`, head: ['Project', 'Open days', 'Track · p90'], empty: 'No open filing is past its p90.',
        rows: (open.items || []).map((i) => ({ label: i.projectId, href: `#/project/${encodeURIComponent(i.projectId)}`, value: `${i.openDays}d`, detail: `${i.track} · p90 ${i.p90Days}d`, smallN: false, warn: true })) },
    ];
  }

  function renderFilingKpis(f) {
    if (!f) return '';
    const sections = buildFilingKpiRows(f).map((s) => {
      const body = s.rows.length
        ? s.rows.map((r) => `
            <tr class="${r.smallN ? 'kpi-smalln' : ''}${r.warn ? ' text-danger' : ''}"${r.smallN ? ' title="Fewer than 10 filings: read the n, not the percent"' : ''}>
              <td>${r.href ? `<a href="${esc(r.href)}">${esc(r.label)}</a>` : esc(r.label)}</td>
              <td>${esc(r.value)}</td>
              <td>${esc(r.detail)}</td>
            </tr>`).join('')
        : `<tr><td colspan="3" class="muted">${esc(s.empty || 'No filings in this period.')}</td></tr>`;
      return `
        <h4 style="margin-top:16px">${esc(s.title)}${s.keyedOn ? ` <span class="muted" style="font-weight:400">— keyed on ${esc(s.keyedOn)}</span>` : ''}</h4>
        <div class="table-wrap">
          <table>
            <thead><tr>${s.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>`;
    }).join('');
    const notes = (f.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
    return `
      <h3 style="margin-top:24px">Filings <span class="muted" style="font-weight:400">— per permit and NEM filing submitted in the period</span></h3>
      ${sections}
      ${notes ? `<ul class="muted kpi-notes" style="margin-top:12px;font-size:12px">${notes}</ul>` : ''}`;
  }

  return { buildFilingKpiRows, renderFilingKpis, rateRow, cycleRow, esc };
});
