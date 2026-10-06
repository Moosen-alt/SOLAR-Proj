// ===========================================================================
// code-profile-verify.js — the VERIFY FLOW for a jurisdiction code profile (#209), shared by the
// standalone review page (review.js) and the dashboard's KB tab, no DOM, no network.
//
// Verifying a seeded (AI-researched / imported) code profile is a named person's attestation that
// every value matches its cited source; it locks the row against automatic overwrite (hard rule 3).
// It used to be reachable only from /review. The KB jurisdiction card and the State code profiles
// block now carry the same control:
//   - renderVerifyControl(profile): a SEEDED row gets a "Review / verify" button (plus an empty slot
//     the panel opens into); a VERIFIED row gets "Verified by <name> on <date>" and no button.
//   - renderVerifyPanel(profile): the readable summary of what is about to be locked, the raw JSON
//     the PUT /api/code-profiles/verify sends (editable under "Edit raw"), Mark verified / Cancel.
//   - confirmMessage(name): the rule-3 confirm text. Mark verified never writes without it.
// The server names the verifier (the signed-in user with auth on; the typed name with auth off).
//
// review.html and dashboard.html load this as a classic script (window.CodeProfileVerify), and
// backend/test/codeProfileVerifyPanel.test.ts loads the same file through node:vm. Keep it pure:
// code profile in, HTML/text out. Every interpolated value is escaped; a source link is shown only
// for an http(s) URL.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.CodeProfileVerify = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const httpUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
  const sourceLink = (u) => (httpUrl(u) ? ` <a href="${esc(httpUrl(u))}" target="_blank" rel="noopener">source</a>` : '');
  const KEY_WORDS = { kw: 'kW', dc: 'DC', ac: 'AC', psf: 'psf', mph: 'mph', pv: 'PV', ahj: 'AHJ', nec: 'NEC', ibc: 'IBC', irc: 'IRC', ifc: 'IFC' };
  const humanKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()
    .split(' ').map((w) => KEY_WORDS[w] || w).join(' ').replace(/^[a-z]/, (c) => c.toUpperCase());
  const plainValue = (v) => (v == null ? '' : typeof v === 'object' ? Object.entries(v).filter(([, x]) => x !== '' && x != null).map(([k, x]) => `${humanKey(k)}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('; ') : String(v));

  function profileName(p) {
    return `${(p && p.state) || ''}${p && p.ahj ? ` · ${p.ahj}` : ' (state default)'}`;
  }

  // A readable table of what the person is about to lock as human-verified.
  function profileSummaryHtml(p) {
    const rows = [];
    const section = (title, items) => rows.push(`<div class="rv-vsec"><h4>${esc(title)}</h4>${items.length
      ? `<ul>${items.join('')}</ul>` : '<p class="rv-muted muted">None recorded.</p>'}</div>`);
    section('Adopted codes', ((p && p.adoptedCodes) || []).map((c) =>
      `<li><b>${esc(c.code)} ${esc(c.edition)}</b>${c.title ? ` — ${esc(c.title)}` : ''}${c.basedOn ? ` <span class="rv-muted muted">(based on ${esc(c.basedOn)})</span>` : ''}${c.effectiveDate ? ` <span class="rv-muted muted">effective ${esc(c.effectiveDate)}</span>` : ''}${sourceLink(c.sourceUrl)}</li>`));
    section('Amendments', ((p && p.amendments) || []).map((a) =>
      `<li><b>${esc([a.code, a.section].filter(Boolean).join(' '))}</b>${a.summary ? ` — ${esc(a.summary)}` : ''}${sourceLink(a.sourceUrl)}</li>`));
    const kv = (obj) => Object.entries(obj || {}).filter(([k, v]) => k !== 'sourceUrl' && v !== '' && v != null)
      .map(([k, v]) => `<li><b>${esc(humanKey(k))}:</b> ${esc(plainValue(v))}</li>`);
    const dc = kv(p && p.designCriteria);
    if (dc.length && httpUrl(p.designCriteria && p.designCriteria.sourceUrl)) dc.push(`<li class="rv-muted muted">Design criteria${sourceLink(p.designCriteria.sourceUrl)}</li>`);
    section('Design criteria', dc);
    section('Prescriptive limits', kv(p && p.prescriptive));
    section('Fire setbacks', ((p && p.fireSetbacks) || []).map((f) => `<li>${esc(plainValue(f))}</li>`));
    section('Citations', ((p && p.citations) || []).map((c) =>
      `<li>${esc(c.label || httpUrl(c.sourceUrl) || 'Source')}${sourceLink(c.sourceUrl)}</li>`));
    return rows.join('');
  }

  // What PUT /api/code-profiles/verify receives: the row's values, nothing else (the verify schema).
  function editablePayload(p) {
    return {
      state: p.state, ahj: p.ahj,
      adoptedCodes: p.adoptedCodes, amendments: p.amendments,
      designCriteria: p.designCriteria, prescriptive: p.prescriptive,
      fireSetbacks: p.fireSetbacks, citations: p.citations,
    };
  }

  // Verifying locks the profile against automatic overwrite (hard rule 3) — never on one stray click.
  function confirmMessage(name) {
    return `Mark ${name} verified?\n\nThis locks it from automatic overwrite: later research will not change it. Only confirm after checking every value against its cited source.`;
  }

  function sourcesLine(p) {
    const sources = ((p && p.citations) || []).length;
    return `Check every value against ${sources === 1 ? 'its cited source' : `its ${sources} cited sources`} before verifying.`;
  }

  // "Verified by <name> on <date>" (plain text; the caller escapes). '' for a row that is not verified.
  function verifiedStamp(p) {
    if (!p || p.confidence !== 'verified') return '';
    const day = String(p.verifiedAt || '').slice(0, 10);
    return `Verified${p.verifiedBy ? ` by ${p.verifiedBy}` : ''}${day ? ` on ${day}` : ''}`;
  }

  // The control on a KB card / state row. A row with no key is not a stored code profile (a lookup
  // result with no row) — there is nothing to verify, so nothing renders.
  function renderVerifyControl(p) {
    if (!p || !p.key) return '';
    if (p.confidence === 'verified') {
      return `<div class="cp-verify" style="margin-top:4px;font-size:12px"><span class="badge badge-pass" data-code-profile-verified="${esc(p.key)}">${esc(verifiedStamp(p))}</span></div>`;
    }
    return `<div class="cp-verify" style="margin-top:4px;font-size:12px;text-align:right">
        <button type="button" class="secondary" style="font-size:12px" data-code-profile-verify="${esc(p.key)}" title="Check this seeded profile against its cited sources and mark it human-verified">Review / verify</button>
        <div data-code-profile-verify-slot="${esc(p.key)}" style="text-align:left"></div>
      </div>`;
  }

  // The panel the control opens: same summary + raw JSON + Mark verified as /review.
  function renderVerifyPanel(p) {
    if (!p || !p.key) return '';
    return `
      <div class="rv-verify cp-verify-panel" data-code-profile-verify-panel="${esc(p.key)}" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;margin-top:6px">
        <strong>Verify ${esc(profileName(p))}</strong>
        <div class="rv-vsummary">${profileSummaryHtml(p)}</div>
        <details class="rv-raw">
          <summary>Edit raw</summary>
          <label class="muted" style="display:block;font-size:12px">Profile data (JSON) — correct any value here before verifying</label>
          <textarea data-code-profile-verify-json spellcheck="false" style="width:100%;min-height:180px;font-family:var(--font-mono);font-size:11px">${esc(JSON.stringify(editablePayload(p), null, 2))}</textarea>
        </details>
        <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:6px">
          <span class="muted" style="margin-right:auto">${esc(sourcesLine(p))}</span>
          <button type="button" data-code-profile-verify-confirm="${esc(p.key)}">Mark verified</button>
          <button type="button" class="secondary" data-code-profile-verify-cancel="${esc(p.key)}">Cancel</button>
        </div>
      </div>`;
  }

  // STATE CODE PROFILES (#209): the state-default rows (empty ahj — the fallback every AHJ in the
  // state uses) have no KB card, so the seeded ones are listed here, each with its verify control.
  // (Verified state rows with pending proposals render in edition-proposals.js's block.) None → ''.
  function renderStateVerifyRows(codeProfiles) {
    const rows = (Array.isArray(codeProfiles) ? codeProfiles : [])
      .filter((c) => c && c.key && !String(c.ahj ?? '').trim() && c.confidence !== 'verified')
      .sort((a, b) => String(a.state || '').localeCompare(String(b.state || '')));
    if (!rows.length) return '';
    const items = rows.map((c) => `
        <article class="item" style="margin-bottom:6px" data-state-code-profile-verify="${esc(c.key)}">
          <strong>${esc(String(c.state || '').toUpperCase() || '(no state)')}</strong> <span class="badge">Seeded — verify locally</span>
          <span class="muted" style="font-size:12px">${esc(((c.adoptedCodes || []).map((x) => `${x.code} ${x.edition}`).join(', ')) || 'no codes recorded')}</span>
          ${renderVerifyControl(c)}
        </article>`).join('');
    return `
      <details class="state-code-verify" style="margin-bottom:8px">
        <summary style="font-size:13px"><strong>State code profiles to verify (${rows.length})</strong> <span class="muted">— seeded state defaults; findings say "verify locally" until a person verifies them</span></summary>
        ${items}
      </details>`;
  }

  return {
    esc, httpUrl, profileName, profileSummaryHtml, editablePayload, confirmMessage, sourcesLine,
    verifiedStamp, renderVerifyControl, renderVerifyPanel, renderStateVerifyRows,
  };
});
