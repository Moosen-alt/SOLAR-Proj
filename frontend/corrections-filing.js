// ===========================================================================
// corrections-filing.js — the manual corrections form's FILING and NOTICE logic (#58), no DOM.
//
// dashboard.html loads this as a classic script (window.CorrectionsFiling) ahead of the dashboard
// module, and backend/test/correctionsFilingForm.test.ts loads the same file through node:vm, so
// the rules below are pinned without a browser. Keep it pure: inputs in, payload/HTML out. Nothing
// here reads the page, the network or the clock (today is passed in).
//
// Why it exists: POST /api/projects/:id/corrections takes submissionId / noticeId / noticedAt
// (#47), but the form sent only the text, so every typed correction landed with track '' (no
// filing), as its own notice, with its cure clock started at the moment of typing. The form now
// names the filing (the project's SENT submissions, the same set the backend resolves against)
// and the notice's own date, and items typed against the same filing and notice date share one
// noticeId — one notice is one correction cycle, however many items it carries.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.CorrectionsFiling = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const TRACK_LABEL = {
    nem: 'Interconnection (NEM)', building: 'Building', structural: 'Building', electrical: 'Electrical',
    mpu: 'Main panel upgrade', combo: 'Permit (combo)', permit: 'Permit',
  };

  /** The filings a notice can answer: sent (submitted_at set) and not failed, newest first — the
   *  set kpi.resolveCorrectionFiling picks from, so the picker never offers what the server
   *  would not stamp. */
  function sentFilings(submissions) {
    return (Array.isArray(submissions) ? submissions : [])
      .filter((s) => s && String(s.submittedAt ?? '').trim() && s.status !== 'failed')
      .slice()
      .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  }

  function filingLabel(s) {
    const pt = String(s.permitType ?? '').trim().toLowerCase();
    const track = s.submissionType === 'interconnection' ? TRACK_LABEL.nem : (TRACK_LABEL[pt] || (pt ? pt : 'Filing'));
    const number = String(s.permitNumber || s.applicationNumber || s.confirmationNumber || '').trim();
    return `${track} · sent ${String(s.submittedAt).slice(0, 10)}${number ? ` · ${number}` : ''}`;
  }

  /** The picker's <option>s. Every value and label escaped: application numbers come off portals. */
  function filingOptionsHtml(submissions, selectedId) {
    const filings = sentFilings(submissions);
    const none = `<option value="">${filings.length ? 'Filing: not sure' : 'No sent filing on record'}</option>`;
    return none + filings.map((s) =>
      `<option value="${esc(s.id)}"${String(s.id) === String(selectedId ?? '') ? ' selected' : ''}>${esc(filingLabel(s))}</option>`).join('');
  }

  /** YYYY-MM-DD that is a real calendar day, or null. */
  function calendarDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
      ? m[0] : null;
  }

  /** One notice's id: the same project, filing and notice date name the same notice, so items
   *  typed one by one (or after a reload) group under it. No notice date, no grouping: each item
   *  is its own notice, as the server defaults. The project is in the key because notice ids are
   *  counted across projects in the KPI report. */
  function noticeIdFor(projectId, submissionId, noticedAt) {
    if (!noticedAt) return null;
    return `manual:${projectId}:${submissionId || '-'}:${noticedAt}`;
  }

  /** The POST body for the form, or the reason it cannot be sent. `today` is YYYY-MM-DD. */
  function correctionPayload({ projectId, correctionText, submissionId, noticedAt, submissions, today }) {
    const text = String(correctionText ?? '').trim();
    if (!text) return { ok: false, error: 'Paste correction text before adding.' };
    const filing = String(submissionId ?? '').trim();
    if (filing && !sentFilings(submissions).some((s) => String(s.id) === filing)) {
      return { ok: false, error: 'Pick a sent filing of this project, or "not sure".' };
    }
    const rawDate = String(noticedAt ?? '').trim();
    const date = rawDate ? calendarDate(rawDate) : null;
    if (rawDate && !date) return { ok: false, error: 'The notice date is not a date (YYYY-MM-DD).' };
    if (date && today && date > today) return { ok: false, error: 'The notice date is in the future.' };
    const body = { correctionText: text, source: 'manual' };
    if (filing) body.submissionId = filing;
    if (date) {
      body.noticedAt = date;
      body.noticeId = noticeIdFor(projectId, filing, date);
    }
    return { ok: true, body };
  }

  return { esc, sentFilings, filingLabel, filingOptionsHtml, calendarDate, noticeIdFor, correctionPayload };
});
