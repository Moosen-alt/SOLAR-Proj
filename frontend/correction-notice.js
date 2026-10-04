// ===========================================================================
// correction-notice.js — the "Correction notice (pre-submittal)" panel (#148), no DOM.
//
// dashboard.html loads this as a classic script (window.CorrectionNotice) ahead of the dashboard
// module, and backend/test/correctionNoticePanel.test.ts loads the same file through node:vm, so
// the display rules are pinned without a browser. Keep it pure: notice in, HTML out.
//
// The notice is GET /api/projects/:id/correction-notice's `notice` (backend/src/correctionNotice.ts):
// the gate's findings grouped like an AHJ letter, holds first. This file only draws it:
//   - every item shows its number, its weight (hold / comment / info), the code citation, what the
//     plan states, what is required and the sheet — a blank field is left out, never invented;
//   - the code-basis provenance line prints at the top, so a seeded or default edition is never
//     read as the AHJ's verified one;
//   - prior corrections print with their count, and only when the backend matched some;
//   - every value is escaped: findings quote plan-set text and parser output.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.CorrectionNotice = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const GROUPS = ['Structural', 'Electrical', 'Fire', 'Plan completeness', 'Local requirements'];
  const WEIGHT_LABEL = { hold: 'Hold', comment: 'Comment', info: 'Info' };
  const WEIGHT_CLASS = { hold: 'text-danger', comment: 'cn-comment', info: 'muted' };

  function countsLine(notice) {
    const c = notice.counts || { hold: 0, comment: 0, info: 0 };
    return `${c.hold} hold(s) · ${c.comment} comment(s) · ${c.info} informational`;
  }

  function field(label, value) {
    if (!value) return '';
    return `<div class="cn-field"><span class="muted">${esc(label)}:</span> ${esc(value)}</div>`;
  }

  function renderItem(item) {
    const weight = WEIGHT_LABEL[item.weight] || item.weight;
    return `
      <div class="cn-item cn-${esc(item.weight)}" data-finding-id="${esc(item.findingId)}">
        <div><strong>${esc(item.number)}.</strong> <span class="badge ${WEIGHT_CLASS[item.weight] || ''}">${esc(weight)}</span> <strong>${esc(item.title)}</strong></div>
        ${field('Code', (item.citations || []).join('; '))}
        ${field('Comment', item.comment)}
        ${field('Plan states', item.planStates)}
        ${field('Required', item.required)}
        ${field('Sheet', item.sheet)}
      </div>`;
  }

  function renderCorrectionNotice(notice) {
    if (!notice) return '<p class="muted">Not built yet — the notice is drawn from the reviewer gate once it has run.</p>';
    const items = notice.items || [];
    const sections = GROUPS.map((group) => {
      const inGroup = items.filter((i) => i.group === group);
      if (!inGroup.length) return '';
      return `<h4 style="margin-top:12px">${esc(group)}</h4>${inGroup.map(renderItem).join('')}`;
    }).join('');
    const prior = (notice.priorCorrections || []).map((p) => `<li>${esc(p.title)} <span class="muted">(×${esc(p.count)})</span> — ${esc(p.requiredAction)}</li>`).join('');
    return `
      <p class="muted cn-provenance">${esc(notice.provenanceLine)}</p>
      <p class="cn-counts"><strong>${esc(countsLine(notice))}</strong> <span class="muted">— prepared by the reviewer gate before submittal; not issued by the AHJ.</span></p>
      ${items.length ? sections : '<p class="muted">No corrections: the gate found nothing to hold or comment on.</p>'}
      ${prior ? `<h4 style="margin-top:12px">Prior corrections matching this project <span class="muted" style="font-weight:400">— your organization's records</span></h4><ul class="cn-prior">${prior}</ul>` : ''}`;
  }

  return { renderCorrectionNotice, countsLine, esc, GROUPS };
});
