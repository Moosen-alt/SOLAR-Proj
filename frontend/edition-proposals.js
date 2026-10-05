// ===========================================================================
// edition-proposals.js — the pending EDITION PROPOSALS on a jurisdiction's code-profile card (#172),
// no DOM, no network.
//
// A due verify check on a HUMAN-VERIFIED code profile never writes the row (hard rule 3): it stores
// a proposal, which GET /api/code-profiles attaches to the row as `editionProposals`. This renders
// them on the KB card so a person can answer: what changed (per code family, the row's edition →
// the proposed one), the cited source and its quoted sentence, when the research found it, and
// Approve / Dismiss buttons. dashboard.js wires the buttons to POST /api/code-profiles/proposals/
// approve | dismiss (the server names the decider).
//
// dashboard.html loads this as a classic script (window.EditionProposals) ahead of the dashboard
// module, and backend/test/editionProposalsPanel.test.ts loads the same file through node:vm. Keep
// it pure: code profile in, HTML out. Every interpolated value is escaped; a source link is shown
// only for an http(s) URL.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EditionProposals = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const httpUrl = (value) => {
    const raw = String(value ?? '').trim();
    return /^https?:\/\//i.test(raw) ? raw : '';
  };

  const SOURCE_LABEL = { research: 'web research', reference: 'shipped reference data' };

  // One proposal's plain-text view (nothing escaped here — renderEditionProposals escapes every value).
  function describeProposal(p) {
    const adoption = p && p.kind === 'adoption_model';
    return {
      fingerprint: String((p && p.fingerprint) || ''),
      title: adoption ? 'Adoption model differs from research' : 'Newer code edition found',
      researched: String((p && p.createdAt) || '').slice(0, 10),
      source: SOURCE_LABEL[p && p.source] || String((p && p.source) || 'research'),
      changes: ((p && Array.isArray(p.changes)) ? p.changes : []).map((c) => ({
        family: String(c.family || ''),
        current: c.current == null || c.current === '' ? '(none on file)' : String(c.current),
        proposed: c.proposed == null || c.proposed === '' ? '(none)' : String(c.proposed),
        sourceUrl: httpUrl(c.sourceUrl),
        quote: c.quote ? String(c.quote) : '',
      })),
      // What Approve does, said on the button's card: an edition proposal RE-VERIFIES the row under
      // the approver's name; an adoption-model one changes only the model, not the row's editions.
      approveMeans: adoption
        ? 'Approve sets the adoption model under your name; the row\'s editions are unchanged.'
        : 'Approve re-verifies this row with the proposed editions under your name.',
    };
  }

  function renderEditionProposals(codeProfile) {
    const list = codeProfile && Array.isArray(codeProfile.editionProposals) ? codeProfile.editionProposals : [];
    if (!list.length) return '';
    const shown = list.map(describeProposal).filter((d) => d.fingerprint);
    if (!shown.length) return '';
    const items = shown.map((d) => {
      const rows = d.changes.map((c) => `
            <li>
              <strong>${esc(c.family)}</strong>: ${esc(c.current)} → <strong>${esc(c.proposed)}</strong>
              ${c.sourceUrl ? ` — <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">cited source</a>` : ' <span class="muted">(no source cited)</span>'}
              ${c.quote ? `<div class="muted" style="margin:2px 0 0">“${esc(c.quote)}”</div>` : ''}
            </li>`).join('');
      return `
        <div class="edition-proposal" data-edition-proposal="${esc(d.fingerprint)}" style="border-left:3px solid var(--warning);padding:4px 8px;margin:4px 0">
          <div><strong>${esc(d.title)}</strong> <span class="muted">— researched ${esc(d.researched || 'date unknown')} from ${esc(d.source)}</span></div>
          <ul style="margin:2px 0 0 16px;padding:0">${rows || '<li class="muted">No change listed.</li>'}</ul>
          <p class="muted" style="margin:4px 0">${esc(d.approveMeans)} Nothing changes until a person decides.</p>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button type="button" style="font-size:12px" data-edition-approve="${esc(d.fingerprint)}">Approve</button>
            <button type="button" class="secondary" style="font-size:12px" data-edition-dismiss="${esc(d.fingerprint)}">Dismiss</button>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="edition-proposals" style="margin-top:6px;font-size:12px">
        <strong>Edition proposals awaiting a person (${shown.length})</strong>
        <span class="muted">— this row is human-verified, so research never changes it on its own.</span>
        ${items}
      </div>`;
  }

  return { renderEditionProposals, describeProposal, esc, httpUrl };
});
