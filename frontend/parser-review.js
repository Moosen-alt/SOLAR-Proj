// ===========================================================================
// parser-review.js — the parser page's REVIEW-LIST logic, with no DOM in it.
//
// parser.html loads this as a classic script (window.ParserReview) and the backend unit
// test (backend/test/parserReviewList.test.ts) loads the same file through node:vm, so
// every rule below has a test that fails when the rule is removed. Keep it pure: inputs
// in, verdicts out. Nothing here reads the page, the network or the clock.
//
// The problem it solves (operator, 2026-09-24, a Massachusetts packet): the page showed
// 14 review items plus a meter verdict that were mostly wrong or redundant — the meter
// cross-check contradicted the model's own note, two "Notes:" blocks contradicted each
// other about which documents were supplied, nine "Not fully sure on <field>" lines
// carried no value/evidence/reason, Oregon's CCB/PGE vocabulary leaked into an MA job,
// 811 locates fired for a roof-only breaker job, and a real rapid-shutdown contradiction
// was buried in prose. Each section below is one of those fixes.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.ParserReview = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const DOC_LABEL = { plan_set: 'plan set', utility_bill: 'utility bill', meter_photo: 'meter photo', structural_letter: 'structural letter' };
  const docLabel = (d) => DOC_LABEL[d] || String(d || 'document').replace(/_/g, ' ');

  // -------------------------------------------------------------------------
  // 1. METER CROSS-CHECK — one predicate, computed once from the final fields.
  // -------------------------------------------------------------------------
  function compareMeters(planMeter, ubMeter) {
    const a = digits(planMeter);
    const b = digits(ubMeter);
    if (!a && !b) return 'No meter numbers parsed.';
    if (a && !b) return 'Plan meter parsed. UB or meter photo meter missing.';
    if (!a && b) return 'UB or meter photo meter parsed. Plan-set meter missing.';
    if (a === b) return 'DIGITS MATCH';
    if (a.endsWith(b) || b.endsWith(a)) return 'LIKELY MATCH. One meter value appears truncated.';
    // OCR suffix issue: a meter printed "24787072IN" once read as "247870721".
    if ((b.length === a.length + 1 && b.startsWith(a)) || (a.length === b.length + 1 && a.startsWith(b))) {
      return 'LIKELY MATCH. Extra trailing digit appears to be OCR suffix noise.';
    }
    return `MISMATCH. Plan ${planMeter} vs UB/photo ${ubMeter}.`;
  }

  /** Which form fields a `meter` reading belongs to. The reading's own provenance decides:
   *  a meter read off the bill or the photo is the UB/photo meter even when the TEXT pass
   *  read it (a PDF bill goes through the text pass, not vision); a meter read off the plan
   *  set is the plan meter even when it arrived in the same response as bill fields. */
  function meterTargets({ source, vision, docsGiven }) {
    if (source === 'utility_bill' || source === 'meter_photo') return ['meter', 'ubMeterNumber'];
    if (source === 'plan_set') return ['planMeterNumber'];
    if (vision) return ['meter', 'ubMeterNumber'];
    if (Array.isArray(docsGiven) && docsGiven.length && !docsGiven.includes('plan_set')) return ['meter', 'ubMeterNumber'];
    return ['planMeterNumber'];
  }

  // -------------------------------------------------------------------------
  // 2. NOTES — one attributed section. A pass that was not given a document may not
  //    assert it was "not supplied": the page knows what is attached.
  // -------------------------------------------------------------------------
  const DOC_MENTION = {
    utility_bill: /\butility[\s_]bill\b|\bbill\s+(?:image|photo|scan)\b|\bUB\b|\bno bill\b|\bbill\b/i,
    meter_photo: /\bmeter[\s_](?:photo|image|picture)\b|\bphoto of the meter\b/i,
    plan_set: /\bplan[\s_]set\b|\bplans\b/i,
    structural_letter: /\bstructural[\s_]letter\b|\bPE letter\b|\bengineer(?:ing|'s)? letter\b/i,
  };
  const ABSENCE = /\b(?:no|not|without|missing|only a|only the|could not be (?:read|extracted)|unavailable|absent|omitted|were not|was not|is not|are not)\b/i;
  const ABSENCE_STRONG = /\b(?:not|no|without|missing|only)\b[^.;]{0,40}\b(?:supplied|provided|given|attached|uploaded|available|included|present|shown|submitted)\b|\b(?:no|missing)\s+(?:utility\s+)?(?:bill|meter photo|plan set|structural letter)\b|\bonly (?:a|the) [a-z_ ]{3,30} (?:was|were) (?:provided|supplied|given|attached)\b/i;

  function assertsMissingAttached(sentence, attached) {
    if (!ABSENCE_STRONG.test(sentence) && !(ABSENCE.test(sentence) && /supplied|provided|attached|uploaded/i.test(sentence))) return null;
    for (const doc of attached || []) {
      const re = DOC_MENTION[doc];
      if (re && re.test(sentence)) return doc;
    }
    return null;
  }

  /** passes: [{ label, docsGiven:[...], notes }], attached: the document kinds on the page. */
  function mergeNotes(passes, attached) {
    const dropped = [];
    const sections = [];
    for (const p of passes || []) {
      let text = clean(p.notes);
      if (!text) continue;
      // Parentheticals first — "(no bill supplied)" inside an otherwise useful sentence.
      text = text.replace(/\s*\(([^()]{3,120})\)/g, (m, inner) => {
        const doc = assertsMissingAttached(inner, attached);
        if (doc) { dropped.push({ pass: p.label, text: inner, doc }); return ''; }
        return m;
      });
      const kept = [];
      for (const s of text.split(/(?<=[.;!?])\s+(?=[A-Z(])/)) {
        const doc = assertsMissingAttached(s, attached);
        if (doc) { dropped.push({ pass: p.label, text: s, doc }); continue; }
        kept.push(s);
      }
      const body = kept.join(' ').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      const read = (p.docsGiven || []).map(docLabel).join(' + ') || 'documents';
      sections.push(`Notes (${p.label || 'pass'}, read: ${read}): ${body}`);
    }
    return { text: sections.join('\n'), sections, dropped };
  }

  // -------------------------------------------------------------------------
  // 3. RESOLUTION — resolve deterministically BEFORE flagging, never by inventing.
  // -------------------------------------------------------------------------
  // Fields a sealed structural letter governs when it and the plan set disagree.
  const STRUCTURAL_FIELDS = new Set(['snow', 'deadLoad', 'roofRafterSpacing', 'roofRafterSpan', 'wind', 'windSpeed', 'riskCategory', 'roofSlope', 'roofMaterial', 'attachmentSpacingIn', 'attachmentEdgeSpacingIn', 'lightFrame', 'roofLiveLoad', 'roofDeadLoad']);
  // Fields whose printed value IS the answer: a number read verbatim beside its label is
  // stated, not unsure. Each carries the label words the excerpt must show, so a lone
  // number in a calculation line ("MAX PV OCPD (200A x 120%) - 200 = 40A") never counts.
  const STATED = {
    buildingHeightFeet: /HEIGHT/i,
    buildingHeightInches: /HEIGHT/i,
    moduleHeightAboveRoof: /ABOVE|HEIGHT|MAX/i,
    snow: /SNOW/i,
    windSpeed: /WIND|MPH/i,
    wind: /EXPOSURE/i,
    riskCategory: /RISK|CATEGORY/i,
    roofRafterSpacing: /SPACING|O\.?\s*C\b/i,
    roofRafterSpan: /SPAN/i,
    attachmentSpacingIn: /ATTACHMENT|O\.?\s*C\b|SPACING/i,
    deadLoad: /DEAD|PSF|LBS\s*\/\s*SQ|DISTRIBUTED/i,
    dcKw: /KW|WATT/i,
    acKw: /KW|WATT/i,
    moduleWattage: /\bW\b|WATT/i,
    moduleQty: /MODULE/i,
    busRating: /BUS/i,
    mainBreaker: /MAIN/i,
    numberOfStories: /STOR(?:Y|IES)|FLOORS?/i,
    roofLayers: /LAYER/i,
    roofSlope: /SLOPE|PITCH|\/\s*12/i,
    existingBuildingArea: /AREA|SQ/i,
  };
  const FORMULA = /[=×]|\bMAX\.?\b|\bALLOW|\d\s*%|\bx\s*\d/i;
  const NOT_THIS_AREA = /ROOF\s+AREA|ARRAY\s+AREA|LOT\s+(?:AREA|SIZE)/i;

  // Who supplies a field nothing in the packet states.
  const SUPPLIER = {
    attachmentEdgeSpacingIn: 'structural letter or racking engineer — attachment spacing within 3 ft of roof edges, hips, eaves and ridges',
    attachmentSpacingIn: 'structural letter or racking plan (maximum attachment spacing)',
    existingBuildingArea: 'assessor record or the homeowner (conditioned floor area of the existing house)',
    numberOfStories: 'site survey photos or the homeowner',
    buildingHeightFeet: 'elevation drawing, structural letter ("Roof Height") or site survey',
    buildingHeightInches: 'elevation drawing, structural letter ("Roof Height") or site survey',
    roofLayers: 'installer site survey (existing roofing layer count)',
    account: 'utility bill (account number)',
    utilitySchedule: 'utility bill (rate schedule)',
    meter: 'meter photo or utility bill',
    owner: 'utility bill (account holder of record)',
    parcelNumber: 'assessor / AHJ parcel lookup',
    jobValue: 'installer contract (installed cost)',
    inverterSettings: 'inverter datasheet (UL 1741 SA/SB grid-support listing)',
    pvBreaker: 'SLD backfeed breaker callout (designer)',
    acDiscMakeModel: 'equipment schedule or installer (most plan sets specify only the rating)',
    moduleHeightAboveRoof: 'racking attachment detail (module top above roof surface)',
    contractorCcb: 'installer (state contractor licence number)',
    contractorElectricalLicense: 'installer (electrical contractor licence)',
    dwellingUnits: 'installer or assessor record',
    numberOfBuildings: 'installer (buildings carrying work under this permit)',
    framingType: 'structural letter or site survey (rafter vs truss)',
    permitPath: 'AHJ prescriptive checklist or structural letter',
    gravityWindDesign: 'structural letter',
    locateCalloutText: 'site plan (811 / call-before-dig callout)',
    state: 'utility bill or plan-set cover',
    moduleMake: 'module datasheet / CEC equipment list',
  };
  const supplier = (field) => SUPPLIER[field] || 'not stated in any attached document — ask the installer';

  const numberIn = (excerpt, value) => {
    const v = String(value).trim();
    if (!v) return false;
    if (/^-?\d+(?:\.\d+)?$/.test(v)) {
      const n = Number(v);
      return (String(excerpt).match(/-?\d+(?:\.\d+)?/g) || []).some((t) => Number(t) === n);
    }
    return String(excerpt).toUpperCase().includes(v.toUpperCase());
  };

  function nameTokens(name) {
    return clean(name).toUpperCase().replace(/\bRESIDENCE\b|\bRES\.?\b|\bPROJECT\b|\bHOUSE\b/g, '').replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !/^(?:JR|SR|II|III|IV|MR|MRS|MS|DR|AND|THE|OF)$/.test(t));
  }
  function namesMatch(a, b) {
    const ta = nameTokens(a); const tb = nameTokens(b);
    if (!ta.length || !tb.length) return false;
    const shared = ta.filter((t) => tb.includes(t));
    if (shared.length >= 2) return true;
    return shared.length >= 1 && ta[ta.length - 1] === tb[tb.length - 1];
  }

  const MULTI_UNIT = /\bDUPLEX\b|\bTRIPLEX\b|\bFOURPLEX\b|\bMULTI[-\s]?FAMILY\b|\bMULTI[-\s]?UNIT\b|\bAPARTMENTS?\b|\bCONDO(?:MINIUM)?S?\b|\bTOWNHO(?:ME|USE)S?\b|\b(?:2|3|4|TWO|THREE|FOUR)[-\s]?(?:UNIT|FAMILY)\b|\bUNITS?\s*[:#]?\s*[2-9]\b|\bR-?2\b|\bADU\b|\bACCESSORY\s+DWELLING\b/i;
  const SINGLE_FAMILY = /\bRESIDENCE\b|\bSINGLE[-\s]FAMILY\b|\bR-?3\b|\bMAIN\s+HOUSE\b|\bSFR\b|\bSFD\b|\bDWELLING\b/i;
  const WORK_ON_OUTBUILDING = /(?:ARRAY|MODULES?|\bPV\b|PANELS?)\s+(?:ON|AT|OVER)\s+(?:THE\s+)?(?:\(?[NE]\)?\s+)?(?:DETACHED\s+|EXISTING\s+)?(?:GARAGE|SHED|BARN|CARPORT|ADU|WORKSHOP|OUTBUILDING|SHOP)\b|\bGROUND[-\s]MOUNT/i;

  function singleFamilyBasis(planText) {
    const t = String(planText || '');
    if (!t.trim()) return null;
    if (MULTI_UNIT.test(t)) return null;
    const m = t.match(SINGLE_FAMILY);
    return m ? m[0] : null;
  }

  function readingsFor(passes) {
    const readings = [];
    for (const p of passes || []) {
      const r = p.response || {};
      const defaultSource = p.kind === 'vision' ? ((p.docsGiven || [])[0] || 'utility_bill') : ((p.docsGiven || []).includes('plan_set') ? 'plan_set' : ((p.docsGiven || [])[0] || 'plan_set'));
      for (const [field, entry] of Object.entries(r.fields || {})) {
        if (!entry || entry.value == null || entry.value === '') continue;
        const ev = entry.evidence || {};
        readings.push({ field, value: entry.value, confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.5, source: ev.source || defaultSource, sheet: ev.sheet || '', excerpt: ev.excerpt || '', pass: p.label || p.kind });
      }
    }
    return readings;
  }

  const where = (r) => `${docLabel(r.source)}${r.sheet ? ' ' + r.sheet : ''}`;
  const quote = (r) => (r.excerpt ? `: "${clean(r.excerpt).slice(0, 120)}"` : '');
  const fmtReading = (r) => `${r.value} (${where(r)}${quote(r)})`;

  /**
   * passes:   [{ kind:'vision'|'text', label, docsGiven:[docKind...], response:{fields, lowConfidenceFields, notes, conflicts?, uncertainties?, resolutions?} }]
   * attached: [docKind...] the documents on the page
   * planText: raw plan-set text (single-family basis, RSD contradiction)
   */
  function resolveReviewItems({ passes, attached, planText }) {
    passes = passes || []; attached = attached || [];
    const readings = readingsFor(passes);
    const byField = (f) => readings.filter((r) => r.field === f);
    const resolved = []; const unsure = []; const missing = []; const conflicts = [];
    const done = new Set();

    // Structured conflicts the model reported, keyed by field.
    const conflictByField = new Map();
    for (const p of passes) for (const c of (p.response && p.response.conflicts) || []) {
      if (!c || !c.field || !Array.isArray(c.readings) || c.readings.length < 2) continue;
      if (!conflictByField.has(c.field)) conflictByField.set(c.field, c);
    }
    const uncertaintyByField = new Map();
    for (const p of passes) for (const u of (p.response && p.response.uncertainties) || []) {
      if (u && u.field && !uncertaintyByField.has(u.field)) uncertaintyByField.set(u.field, u);
    }
    const serverResolved = new Map();
    for (const p of passes) for (const s of (p.response && p.response.resolutions) || []) {
      if (s && s.field && !serverResolved.has(s.field)) serverResolved.set(s.field, s);
    }
    const flagged = [];
    for (const p of passes) for (const f of (p.response && p.response.lowConfidenceFields) || []) if (!flagged.includes(f)) flagged.push(f);

    const pushConflict = (field, list, note) => {
      conflicts.push({ field, readings: list.map((r) => ({ value: r.value, source: r.source, sheet: r.sheet || '', excerpt: r.excerpt || '' })), note: note || '' , text: `${field}: ${list.map(fmtReading).join(' vs ')}${note ? ' — ' + note : ''}` });
      done.add(field);
    };

    // (a) conflicts the model reported — resolve by rule where a rule exists.
    for (const [field, c] of conflictByField) {
      const rs = c.readings.map((r) => ({ field, value: r.value, source: r.source || 'plan_set', sheet: r.sheet || '', excerpt: r.excerpt || '' }));
      if (field === 'owner') continue; // handled by the account-holder rule below
      if (STRUCTURAL_FIELDS.has(field)) {
        const letter = rs.filter((r) => r.source === 'structural_letter');
        const letterValues = [...new Set(letter.map((r) => String(r.value)))];
        if (letterValues.length === 1) {
          const others = rs.filter((r) => r.source !== 'structural_letter');
          resolved.push({ field, value: letter[0].value, how: `sealed structural letter governs the plan set (sealed-source rule): letter ${fmtReading(letter[0])} over ${others.map(fmtReading).join(', ') || 'the other reading'}`, evidence: letter[0] });
          done.add(field);
          continue;
        }
      }
      pushConflict(field, rs, c.note ? clean(c.note) : '');
    }

    // (b) owner — the utility bill's account holder is the account of record for NEM.
    {
      const owners = byField('owner');
      const bill = owners.find((r) => r.source === 'utility_bill');
      const others = owners.filter((r) => r.source !== 'utility_bill');
      const c = conflictByField.get('owner');
      if (c) for (const r of c.readings) if (r.source !== 'utility_bill' && !others.some((o) => namesMatch(o.value, r.value))) others.push({ field: 'owner', value: r.value, source: r.source || 'plan_set', sheet: r.sheet || '', excerpt: r.excerpt || '' });
      const candidates = [];
      for (const o of others) if (!candidates.some((k) => namesMatch(k.value, o.value))) candidates.push(o);
      if (bill && (candidates.length || flagged.includes('owner') || c)) {
        const matches = candidates.filter((k) => namesMatch(bill.value, k.value));
        const nonMatch = candidates.filter((k) => !namesMatch(bill.value, k.value));
        if (candidates.length === 0 || matches.length === 1 || (matches.length >= 1 && nonMatch.length === 0)) {
          resolved.push({ field: 'owner', value: bill.value, how: `utility bill account holder is the account of record (${where(bill)})${matches.length ? `, matches the ${matches.map(where).join(' and ')}` : ''}${nonMatch.length ? `; the ${nonMatch.map((k) => `${where(k)} names "${k.value}"`).join(', ')} — confirm with the installer` : ''}`, evidence: bill });
          done.add('owner');
        } else {
          pushConflict('owner', [bill, ...candidates], 'the bill account holder matches none of the names on the documents — resolve before filing');
        }
      } else if (!bill && (c || candidates.length > 1)) {
        pushConflict('owner', candidates, 'no utility bill attached to break the tie — the account holder on the bill is the name of record');
      }
    }

    // (c) server-side deterministic resolutions (e.g. moduleMake from the CEC list).
    for (const [field, s] of serverResolved) {
      if (done.has(field)) continue;
      resolved.push({ field, value: s.value, how: clean(s.how || 'resolved by the server'), evidence: null });
      done.add(field);
    }

    // (d) every field the model flagged.
    const sf = singleFamilyBasis(planText);
    for (const field of flagged) {
      if (done.has(field)) continue;
      const rs = byField(field);
      const u = uncertaintyByField.get(field);
      const kind = u && u.kind ? String(u.kind) : '';
      const reason = u && u.reason ? clean(u.reason) : '';
      if (field === 'dwellingUnits' || field === 'numberOfBuildings') {
        const stated = rs.find((r) => String(r.value) !== '1' && numberIn(r.excerpt, r.value) && /UNIT|BUILDING|DWELLING/i.test(r.excerpt));
        if (!stated && sf && !(field === 'numberOfBuildings' && WORK_ON_OUTBUILDING.test(String(planText || '')))) {
          resolved.push({ field, value: 1, how: field === 'dwellingUnits' ? `single-family residence: title block reads "${sf}" and the plan set carries no multi-unit language` : `one building carries the work: title block reads "${sf}" and no array is drawn on an outbuilding`, evidence: rs[0] || null });
          done.add(field);
          continue;
        }
      }
      if (rs.length >= 2 && new Set(rs.map((r) => String(r.value).toUpperCase())).size > 1) {
        if (STRUCTURAL_FIELDS.has(field)) {
          const letter = rs.filter((r) => r.source === 'structural_letter');
          const lv = [...new Set(letter.map((r) => String(r.value)))];
          if (lv.length === 1) { resolved.push({ field, value: letter[0].value, how: `sealed structural letter governs the plan set (sealed-source rule): letter ${fmtReading(letter[0])} over ${rs.filter((r) => r.source !== 'structural_letter').map(fmtReading).join(', ')}`, evidence: letter[0] }); done.add(field); continue; }
        }
        pushConflict(field, rs, reason);
        continue;
      }
      const r = rs[0];
      if (!r) { missing.push({ field, suppliedBy: supplier(field), why: reason || 'not stated in any attached document' }); done.add(field); continue; }
      if (kind === 'conflicting') { pushConflict(field, rs, reason || 'the model reports conflicting readings'); continue; }
      const label = STATED[field];
      const excerpt = String(r.excerpt || '');
      const statedVerbatim = label && excerpt && label.test(excerpt) && !FORMULA.test(excerpt) && !(field === 'existingBuildingArea' && NOT_THIS_AREA.test(excerpt)) && numberIn(excerpt, r.value);
      const wholeFeet = field === 'buildingHeightInches' && Number(r.value) === 0 && /\d+\s*(?:FT|FEET|')\b/i.test(excerpt) && !/\d+\s*(?:IN\b|INCH|")/i.test(excerpt);
      // wholeFeet is deterministic (a height printed as "25 ft" has 0 inches) so it stands
      // whatever kind the model attached; a stated value yields to a genuine doubt.
      if (wholeFeet || (statedVerbatim && kind !== 'guessed' && kind !== 'unreadable' && kind !== 'inferred')) {
        resolved.push({ field, value: r.value, how: `stated on the ${where(r)}${quote(r)}${wholeFeet ? ' — height given in whole feet' : ''}`, evidence: r });
        done.add(field);
        continue;
      }
      unsure.push({ field, value: r.value, evidence: r, why: reason || (kind ? `${kind} (model confidence ${Math.round(r.confidence * 100)}%)` : `model confidence ${Math.round(r.confidence * 100)}% — read from ${where(r)}${quote(r)} but not stated outright`) });
      done.add(field);
    }

    // (e) structured conflicts from the plan text itself — unless the model already reported
    // the same contradiction under another field name (it files it under electricalCalcText).
    const rsd = rsdConflict(planText);
    const rsdAlready = conflicts.some((c) => /SHUTDOWN\s*[-:–—]\s*NO/i.test(c.text) && /RAPID|690\.12/i.test(c.text));
    if (rsd && !rsdAlready && !done.has('rapidShutdown')) pushConflict('rapidShutdown', rsd.readings, rsd.note);

    const counts = { resolved: resolved.length, unsure: unsure.length, missing: missing.length, conflicts: conflicts.length };
    return { resolved, unsure, missing, conflicts, counts };
  }

  // -------------------------------------------------------------------------
  // 6. RAPID SHUTDOWN — "SHUTDOWN - NO" beside NEC 690.12 labels is a real contradiction
  //    (the customer asked the installer the same question). Structured, not prose.
  // -------------------------------------------------------------------------
  function rsdConflict(planText) {
    const t = String(planText || '');
    const no = t.match(/\bSHUTDOWN\s*[-:–—]\s*NO\b/i);
    if (!no) return null;
    const rsd = t.match(/.{0,50}(?:RAPID[-\s]+SHUTDOWN|690\.12).{0,50}/i);
    if (!rsd) return null;
    return {
      field: 'rapidShutdown',
      readings: [
        { field: 'rapidShutdown', value: 'NO', source: 'plan_set', sheet: 'site/roof plan note', excerpt: clean(no[0]) },
        { field: 'rapidShutdown', value: 'rapid shutdown (NEC 690.12) labels/notes present', source: 'plan_set', sheet: 'electrical notes / labels', excerpt: clean(rsd[0]) },
      ],
      note: 'the plan note says no shutdown while the electrical sheets carry 690.12 rapid-shutdown labels — confirm RSD compliance with the designer before filing',
    };
  }

  // -------------------------------------------------------------------------
  // 4. NO OREGON IN THE GENERIC PATH — licence label by state; utility identified vs
  //    utility with an SOP rule table.
  // -------------------------------------------------------------------------
  const LICENSE_LABELS = {
    OR: 'CCB', WA: 'L&I contractor registration', CA: 'CSLB', AZ: 'ROC', TX: 'TDLR/TECL', MA: 'HIC', PA: 'HIC',
    NV: 'NSCB', FL: 'DBPR/CVC', UT: 'DOPL', NJ: 'HIC', CT: 'HIC', NM: 'CID', HI: 'DCCA', MD: 'MHIC', VA: 'DPOR',
    NC: 'NCLBGC', SC: 'LLR', MN: 'DLI', ID: 'PWC registration', MT: 'contractor registration',
  };
  function licenseLabel(state) {
    return LICENSE_LABELS[String(state || '').trim().toUpperCase()] || 'contractor license';
  }
  const isNA = (v) => !clean(v) || /^(?:N\/?A|NONE|NULL|NOT\s+SHOWN|NOT\s+AVAILABLE|-+)$/i.test(clean(v));
  function installerLine(s, state) {
    if (!s || isNA(s.contractorCompany)) return '';
    const bits = [
      s.contractorCompany,
      isNA(s.contractorCcb) ? '' : `${licenseLabel(state)} ${s.contractorCcb}`,
      isNA(s.contractorElectricalLicense) ? '' : `Elec ${s.contractorElectricalLicense}`,
      isNA(s.contractorMetroCityLicense) ? '' : `Metro/City ${s.contractorMetroCityLicense}`,
      isNA(s.contractorSupervisor) ? '' : `Supervisor ${s.contractorSupervisor}`,
      isNA(s.contractorElectricianLicense) ? '' : `Electrician Lic ${s.contractorElectricianLicense}`,
      isNA(s.contractorPhone) ? '' : s.contractorPhone,
      isNA(s.contractorEmail) ? '' : s.contractorEmail,
    ].filter(Boolean).map(clean);
    return `Plan-set installer read from the title block: ${bits.join(' | ')}`;
  }

  /** PGE / PACIFICORP have operator SOP rule tables. Anything else is either IDENTIFIED
   *  (the documents name it — no rule table, generic rules apply) or UNKNOWN (nothing
   *  named it). Those are different facts and get different words. */
  function identifyUtility(utilityField, text) {
    const u = `${utilityField || ''} ${String(text || '').slice(0, 6000)}`.toUpperCase();
    if (/\bPGE\b|PORTLAND\s+GENERAL/.test(u)) return { norm: 'PGE', name: 'PGE', identified: true, sop: true };
    if (/PACIFICORP|PACIFIC\s+POWER|PAC\s*POWER/.test(u)) return { norm: 'PACIFICORP', name: 'Pacific Power', identified: true, sop: true };
    const name = clean(utilityField);
    if (name && !/^(?:unknown|n\/?a|none|tbd)$/i.test(name)) return { norm: 'OTHER', name, identified: true, sop: false };
    return { norm: 'UNKNOWN', name: '', identified: false, sop: false };
  }

  // -------------------------------------------------------------------------
  // 5. LOCATES — 811 is for digging. The operator's PGE / Pacific Power SOP lists stay
  //    exactly as they are; for a utility without an SOP, locates fire on excavation
  //    evidence only (trench / underground / service relocation / pole).
  // -------------------------------------------------------------------------
  const EXCAVATION_TYPES = ['TRENCH', 'UNDERGROUND', 'SERVICE_RELOCATION', 'POLE'];
  function locatesDecision({ sop, ruleLocatesRequired, nonBreakerTypes, breakerOnly, evidence }) {
    const types = nonBreakerTypes || [];
    if (sop) {
      let needed = types.some((t) => (ruleLocatesRequired || []).includes(t));
      if (!needed && types.length > 0) needed = true;
      if (breakerOnly) needed = false;
      return { needed, basis: needed ? 'operator SOP: scope is not breaker-only' : '', quotes: [] };
    }
    const hits = (evidence || []).filter((e) => EXCAVATION_TYPES.includes(e.type));
    if (!hits.length) return { needed: false, basis: 'no excavation evidence (no trench, underground run, service relocation or pole work on the plan set)', quotes: [] };
    return { needed: true, basis: 'excavation evidence on the plan set', quotes: hits.slice(0, 3).map((e) => `${e.type} p.${e.page}${e.sheet ? ' ' + e.sheet : ''}: "${clean(e.text || e.snippet).slice(0, 140)}"`) };
  }

  // -------------------------------------------------------------------------
  // 6b. TAP vs BREAKER — scope evidence must be the plan's own interconnection callout,
  //     quoted. A general note listing the NEC article for each tap method, or an
  //     alternative-option line, never sets scope.
  // -------------------------------------------------------------------------
  const TAP_WORDS = /(LOAD\s+SIDE\s+TAP|SUPPLY\s+SIDE\s+TAP|LINE\s+SIDE\s+TAP|FEEDER\s+TAP)/i;
  const BREAKER_WORDS = /(LOAD\s+(?:SIDE\s+)?BREAKER|PV\s+BREAKER|BACKFEED(?:ING)?\s+BREAKER|SUPPLY\s+BREAKER)/i;
  const EXPLICIT_LABEL = /\b(?:INTERCONNECTION\s+(?:METHOD|TYPE)|POINT\s+OF\s+INTERCONNECT(?:ION)?|\bPOI\b)\b\s*[:,\-–]?\s*(?:\(?[A-Z0-9 \/]{0,30}\)?\s*[,:\-]?\s*)?/i;
  const CODE_CLAUSE = /\b(?:ACCORDING\s+TO|PER|IN\s+ACCORDANCE\s+WITH|AS\s+(?:PERMITTED|ALLOWED|REQUIRED)\s+BY|COMPL(?:Y|IES|IANT)\s+WITH|SHALL\s+(?:MEET|COMPLY))\b[^.;]{0,50}\b(?:NEC|NFPA\s*70|CEC)\b|\b(?:NEC|CEC)\s*\d{3}\.\d+/i;
  const OPTION_CLAUSE = /\b(?:OPTION(?:AL|S)?|ALTERNAT(?:E|IVE)(?:LY)?|IN\s+LIEU\s+OF|WHERE\s+APPLICABLE|IF\s+(?:A\s+|THE\s+)?(?:LOAD|SUPPLY|LINE|FEEDER)|MAY\s+BE\s+(?:USED|MADE|INSTALLED)|EITHER\b|\bOR\s+(?:A\s+)?(?:LOAD|SUPPLY|LINE|FEEDER)\s+SIDE)\b/i;

  const isExplicit = (e) => EXPLICIT_LABEL.test(String(e.text || '')) && (TAP_WORDS.test(String(e.text || '')) || BREAKER_WORDS.test(String(e.text || '')));
  function tapWindow(e) {
    const snippet = String(e.snippet || e.text || '');
    const m = snippet.search(TAP_WORDS);
    if (m < 0) return snippet;
    return snippet.slice(Math.max(0, m - 140), m + 140);
  }
  function isNoteMention(e) {
    const w = tapWindow(e);
    return CODE_CLAUSE.test(w) || OPTION_CLAUSE.test(w) || /(?:^|\s)\d{1,2}\.\s+(?:[A-Z ()\/-]{0,40})?(?:LOAD|SUPPLY|LINE|FEEDER)\s+(?:SIDE\s+)?TAP\s+INTERCONNECTION/i.test(w);
  }

  /** tapEvidence / breakerEvidence: the scope-engine entries ({type,text,snippet,page,sheet,sheetType}). */
  function filterTapEvidence(tapEvidence, breakerEvidence) {
    const taps = tapEvidence || [];
    const explicitTap = taps.filter(isExplicit);
    const explicitBreaker = (breakerEvidence || []).filter(isExplicit);
    const dropped = [];
    const kept = [];
    for (const e of taps) {
      if (isExplicit(e)) { kept.push(e); continue; }
      if (isNoteMention(e)) { dropped.push({ evidence: e, why: 'code-reference / option note, not the interconnection callout' }); continue; }
      if (explicitBreaker.length && !explicitTap.length) { dropped.push({ evidence: e, why: `the plan's interconnection callout names a breaker ("${clean(explicitBreaker[0].text).slice(0, 80)}")` }); continue; }
      kept.push(e);
    }
    return { kept, dropped, explicitTap, explicitBreaker };
  }

  // -------------------------------------------------------------------------
  // 7. LAYOUT — RESOLVED / UNSURE / MISSING / CONFLICTS, with counts.
  // -------------------------------------------------------------------------
  function formatReviewList(items) {
    if (!items) return [];
    const out = [];
    const c = items.counts || { resolved: items.resolved.length, unsure: items.unsure.length, missing: items.missing.length, conflicts: items.conflicts.length };
    out.push(`CONFLICTS (${c.conflicts})`);
    if (items.conflicts.length) items.conflicts.forEach((x, i) => out.push(`${i + 1}. ${x.text}`)); else out.push('none');
    out.push('');
    out.push(`UNSURE (${c.unsure}) — value + evidence + why`);
    if (items.unsure.length) items.unsure.forEach((x, i) => out.push(`${i + 1}. ${x.field} = ${x.value} — ${x.why}`)); else out.push('none');
    out.push('');
    out.push(`MISSING (${c.missing}) — not stated in the attached documents; who supplies it`);
    if (items.missing.length) items.missing.forEach((x, i) => out.push(`${i + 1}. ${x.field} — ${x.suppliedBy}`)); else out.push('none');
    out.push('');
    out.push(`RESOLVED (${c.resolved}) — value + how`);
    if (items.resolved.length) items.resolved.forEach((x, i) => out.push(`${i + 1}. ${x.field} = ${x.value} — ${x.how}`)); else out.push('none');
    return out;
  }

  return {
    compareMeters, meterTargets,
    mergeNotes, assertsMissingAttached,
    resolveReviewItems, rsdConflict, singleFamilyBasis, namesMatch,
    licenseLabel, installerLine, identifyUtility,
    locatesDecision, EXCAVATION_TYPES,
    filterTapEvidence, isNoteMention,
    formatReviewList,
  };
});
