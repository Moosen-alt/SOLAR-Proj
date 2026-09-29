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

  /** The meter number as it appears VERBATIM in a document's text (digits possibly grouped
   *  with spaces/hyphens, as plan sets print them: "METER #123 456 789"), or ''. Lets the
   *  page confirm a bill/photo meter against a plan set that prints it under a label the
   *  regex parser did not know and the model did not cite. Never invents: digits only. */
  function meterInText(text, meter) {
    const d = digits(meter);
    if (d.length < 6 || !text) return '';
    const re = new RegExp('(?<![0-9])' + d.split('').join('[\\s\\-]?') + '(?![0-9])');
    const m = String(text).match(re);
    return m ? m[0] : '';
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
    // ONE notes item for the review list: every pass attributed inside it, never two "Notes:"
    // entries that can contradict each other.
    const line = sections.length ? `Notes — ${sections.map((s) => s.replace(/^Notes \(/, '(')).join(' ‖ ')}` : '';
    return { text: sections.join('\n'), sections, line, dropped };
  }

  // -------------------------------------------------------------------------
  // 3. RESOLUTION — resolve deterministically BEFORE flagging, never by inventing.
  // -------------------------------------------------------------------------
  // Fields a sealed structural letter governs when it and the plan set disagree.
  const STRUCTURAL_FIELDS = new Set(['snow', 'deadLoad', 'roofRafterSpacing', 'roofRafterSpan', 'wind', 'windSpeed', 'riskCategory', 'roofSlope', 'roofMaterial', 'attachmentSpacingIn', 'attachmentEdgeSpacingIn', 'lightFrame', 'roofLiveLoad', 'roofDeadLoad']);
  // The sealed-source rule picks the letter over the plan set only for the SAME quantity. A
  // reading qualified by a roof zone or exposure ("Zone 2n ... Attachments at 24 in O.C.",
  // "exposed modules", "edge", "ridge") is a zone-specific value, not the whole-roof one the
  // plan states; ground vs roof snow and ultimate vs ASD wind are different quantities too.
  // Readings whose qualifiers differ are a CONFLICT naming both, never a resolution.
  const QUANTITY_QUALIFIER = /\bZONES?\s*[:#]?\s*(\d[A-Z]?'?)|\b(NON[-\s]?EXPOSED|EXPOSED|EDGES?|RIDGES?|CORNERS?|EAVES?|HIPS?|PERIMETER|INTERIOR|RAKES?|GROUND\s+SNOW|(?:FLAT|SLOPED|ROOF|DESIGN)\s+(?:ROOF\s+)?SNOW|ULT(?:IMATE)?|V\s*ULT|NOMINAL|ASD|V\s*ASD)\b/gi;
  function quantityContext(excerpt) {
    const out = new Set();
    for (const m of String(excerpt || '').matchAll(QUANTITY_QUALIFIER)) {
      out.add(m[1] ? `ZONE ${m[1].toUpperCase()}` : m[2].toUpperCase().replace(/[-\s]+/g, ' ').replace(/^V ?/, '').replace(/^ULTIMATE$/, 'ULT').replace(/(EDGE|RIDGE|CORNER|EAVE|HIP|RAKE)S$/, '$1'));
    }
    return [...out].sort().join(', ');
  }
  /** The letter governs only when it and every other reading carry the same zone/exposure
   *  qualifiers; returns '' when it may govern, else the conflict note naming the mismatch. */
  function sealedSourceMismatch(letter, others) {
    const lc = quantityContext(letter[0].excerpt);
    const differ = [...letter.slice(1), ...others].filter((o) => quantityContext(o.excerpt) !== lc);
    if (!differ.length) return '';
    const say = (c) => (c ? `qualified by ${c}` : 'unqualified (whole roof)');
    return `not the same quantity — the structural letter's reading is ${say(lc)}, ${differ.map((o) => `the ${where(o)} reading is ${say(quantityContext(o.excerpt))}`).join(', ')}; the sealed-source rule picks the letter only for the same quantity — confirm which value applies`;
  }
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
  // A CALCULATED LIMIT — the ONLY reading withoutCalculations may set aside. FORMULA above only stops
  // a number counting as STATED (the safe direction: the value stays unsure). Dropping a reading is
  // the unsafe direction: a plan set's own worked sizing that disagrees with another sheet ("DC
  // SYSTEM SIZE: 20 x 440W = 8.80 KW DC" vs "SYSTEM SIZE: 8.4 KW DC", "1.25 x 29A = 36.25A, USE 40A
  // PV BREAKER" vs "(N) 30A PV BREAKER") IS a conflict the reviewer must see. So a reading is a
  // calculated limit only when ALL of these hold:
  //   1. its excerpt carries an arithmetic expression (ARITHMETIC, within one clause) ending in
  //      "= <result>" — a labelled value ("WIND SPEED = 110 MPH"), a lumber size ("2 X 6 RAFTERS")
  //      and a bare limit ("6\" MAX") are readings;
  //   2. the calculation labels that RESULT as a limit: MAX / MAXIMUM / ALLOW / ALLOWABLE / ALLOWED /
  //      LIMIT right after the result ("= 40A max PV OCPD") or opening/closing the label that heads
  //      the calculation ("MAX PV OCPD (200A x 120%) - 200A = 40A");
  //   3. the reading's value IS that result (numerically: "40A", "40" and 40 are one value), and the
  //      number appears nowhere else in the excerpt (a line that also states "(N) 40A PV BREAKER"
  //      states it);
  //   4. the field itself is not a limit (a field named max/limit/allow is read FROM such a line).
  const ARITHMETIC = /×|\d\s*%|\bx\s*\(?\d|\*\s*\(?\d|\d\s*\)?\s*[/+]\s*\(?\d|\)\s*[-+]\s*\(?\d/i;
  const LIMIT_WORD = /^(?:MAX(?:IMUM)?|ALLOW(?:ABLE|ED)?|LIMITS?)$/;
  const RESULT_UNIT = /^(?:A|AMPS?|AMPERES?|KW|KWDC|KWAC|W|WATTS?|V|VOLTS?|VDC|VAC|KVA|PSF|MPH|IN|INCH(?:ES)?|FT|%|"|')$/;
  const numbersIn = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  /** The results in an excerpt that a calculation labels as a limit (rules 1 and 2), as numbers. */
  function limitResults(excerpt) {
    const t = clean(excerpt).toUpperCase();
    const out = [];
    for (const m of t.matchAll(/=\s*\$?(\d+(?:\.\d+)?)/g)) {
      const head = t.slice(0, m.index);
      let start = 0;
      for (const b of head.matchAll(/;|[.,](?=\s)/g)) start = b.index + b[0].length;
      const left = head.slice(start);
      if (!ARITHMETIC.test(left)) continue;
      const tail = t.slice(m.index + m[0].length).split(/[;,]|\.(?=\s|$)/)[0];
      const w = tail.split(/[\s()[\]]+/).filter(Boolean);
      const after = LIMIT_WORD.test(w[0] || '') || (RESULT_UNIT.test(w[0] || '') && LIMIT_WORD.test(w[1] || ''));
      const opAt = left.search(/[\d(]/);
      const label = (opAt < 0 ? left : left.slice(0, opAt)).replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
      const before = label.length > 0 && (LIMIT_WORD.test(label[0]) || LIMIT_WORD.test(label[label.length - 1]));
      if (after || before) out.push(Number(m[1]));
    }
    return out;
  }
  /** Rules 1-4: this reading is a limit a calculation worked out, not a reading of the field. */
  function isCalculatedLimit(r) {
    if (!r || !r.excerpt || /MAX|LIMIT|ALLOW/i.test(String(r.field || ''))) return false;
    const n = numbersIn(r.value)[0];
    if (n === undefined) return false;
    if (numbersIn(clean(r.excerpt)).filter((x) => x === n).length !== 1) return false;
    return limitResults(r.excerpt).includes(n);
  }
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

  // Words that are never a person's name: title-block filler, suffixes, and the trust/estate
  // wording around a name ("SMITH FAMILY TRUST" is the Smiths, not a person called FAMILY).
  const NAME_FILLER = /^(?:JR|SR|II|III|IV|MR|MRS|MS|DR|AND|THE|OF|FAMILY|TRUST|TRUSTEES?|LIVING|REVOCABLE|IRREVOCABLE|ESTATE|LLC|INC)$/;
  // Surname particles: part of a compound surname block, never evidence of a given name.
  const SURNAME_PARTICLE = new Set(['DE', 'LA', 'LAS', 'LOS', 'DEL', 'DELLA', 'DA', 'DI', 'DO', 'DOS', 'DAS', 'VAN', 'VON', 'DER', 'DEN', 'TER', 'TEN', 'LE', 'DU', 'ST', 'SAN', 'SANTA', 'BIN', 'BEN']);
  function nameTokens(name) {
    return clean(name).toUpperCase().replace(/\bRESIDENCE\b|\bRES\.?\b|\bPROJECT\b|\bHOUSE\b|\bET\s+(?:AL|UX|VIR)\b/g, '').replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !NAME_FILLER.test(t));
  }
  /** One token list per person, given name first: "SAMPLE, JANE A" → JANE A SAMPLE, and a joint
   *  "JOHN & JANE SAMPLE" → JOHN SAMPLE + JANE SAMPLE (a lone given name takes the surname
   *  block of the last person named). */
  function namePersons(name) {
    let s = clean(name).toUpperCase();
    const comma = s.match(/^([^,&+/]+),\s*(.+)$/);
    if (comma) s = `${comma[2]} ${comma[1]}`;
    const people = s.split(/\s*(?:&|\+|\/|\bAND\b)\s*/).map(nameTokens).filter((t) => t.length);
    const last = people[people.length - 1] || [];
    return people.map((t) => (t.length === 1 && last.length >= 2 && t !== last ? [t[0], ...last.slice(1)] : t));
  }
  const commonSuffix = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++; return k; };
  function personsMatch(pa, pb) {
    if (!pa.length || !pb.length) return false;
    if (pa.length >= 2 && pa.join(' ') === pb.join(' ')) return true;
    const k = commonSuffix(pa, pb);
    if (k >= 1) {
      // The shared ending is the surname block, and a compound surname ("DE LA CRUZ",
      // "GARCIA LOPEZ", "VAN DER BERG") counts ONCE however many tokens it has. A name that
      // is nothing but that block names no given name (ga/gb empty), so it confirms no person.
      const ga = pa.slice(0, pa.length - k).filter((t) => !SURNAME_PARTICLE.has(t));
      const gb = pb.slice(0, pb.length - k).filter((t) => !SURNAME_PARTICLE.has(t));
      return ga.some((t) => gb.includes(t));
    }
    // No shared ending: a reversed name ("SAMPLE JANE") or a double surname on one side only
    // ("JANE SAMPLE-DOE"). Each name's leading token must appear in the other — so a given
    // name is shared — plus one more shared name token.
    const shared = new Set(pa.filter((t) => pb.includes(t) && !SURNAME_PARTICLE.has(t)));
    return pb.includes(pa[0]) && pa.includes(pb[0]) && shared.size >= 2;
  }
  function namesMatch(a, b) {
    // Given name AND surname: a shared surname alone is a spouse or a relative ("PAT SAMPLE"
    // on the bill, "JANE SAMPLE" on the plan set, or "MARIA DE LA CRUZ" vs "JOSE DE LA CRUZ"),
    // not the same person — calling that a match would put a false "matches the plan set"
    // into the resolution text.
    const pa = namePersons(a); const pb = namePersons(b);
    return pa.some((x) => pb.some((y) => personsMatch(x, y)));
  }
  /** The bill's customer name block as printed — every holder of a joint account ("ROBIN L SAMPLE /
   *  DURWOOD W SAMPLE") — when the reading's quoted excerpt is a name list that includes its value;
   *  else the reading's value. The excerpt is used only when it is nothing but names (letters,
   *  spaces, . ' - and the & / + separators), so a quoted sentence never becomes a holder. */
  function billHolderBlock(reading) {
    if (!reading) return '';
    const value = clean(reading.value);
    const ex = clean(String(reading.excerpt || '').replace(/^["'\s]+|["'\s]+$/g, ''));
    if (ex && /^[A-Za-z .'&\/+-]+$/.test(ex) && namePersons(ex).length > namePersons(value).length && namesMatch(ex, value)) return ex;
    return value;
  }
  /** How a non-matching document name relates to the bill holder, for the conflict wording:
   *  'surname-only-doc' — the document prints a surname and no given name ("SAMPLE RESIDENCE",
   *  "DE LA CRUZ RESIDENCE"), so it cannot confirm or deny the person; 'surname-only-bill' —
   *  the bill prints an initial or surname only ("J SAMPLE"), so the given name is not
   *  confirmed; 'kin' — both print a full name, same surname block, different given name (a
   *  spouse or relative); '' — otherwise. */
  function nameRelation(billName, docName) {
    if (namesMatch(billName, docName)) return '';
    let rel = '';
    for (const tb of namePersons(billName)) for (const td of namePersons(docName)) {
      const k = commonSuffix(tb, td);
      let r = '';
      if (k >= 1 && k >= td.length) r = 'surname-only-doc';
      else if (k >= 1 && k >= tb.length) r = 'surname-only-bill';
      else if (k >= 1) r = 'kin';
      else if (td.length === 1 && tb.includes(td[0])) r = 'surname-only-doc';
      else if (tb.length === 1 && td.includes(tb[0])) r = 'surname-only-bill';
      else {
        const shared = td.filter((t) => tb.includes(t));
        if (shared.length === 1 && (shared[0] === td[td.length - 1] || shared[0] === tb[tb.length - 1])) r = 'kin';
      }
      if (r === 'surname-only-doc' || r === 'surname-only-bill') return r;
      if (r) rel = r;
    }
    return rel;
  }

  // "2 Unit Depth" in a racking calc is not a two-unit building: the count-word forms must
  // name a dwelling/structure or use the plural "UNITS".
  const MULTI_UNIT = /\bDUPLEX\b|\bTRIPLEX\b|\bFOURPLEX\b|\bMULTI[-\s]?FAMILY\b|\bMULTI[-\s]?UNIT\b|\bAPARTMENTS?\b|\bCONDO(?:MINIUM)?S?\b|\bTOWNHO(?:ME|USE)S?\b|\b(?:2|3|4|TWO|THREE|FOUR)[-\s]?(?:UNIT|FAMILY)\s+(?:DWELLING|RESIDENCE|BUILDING|HOME|HOUSE|STRUCTURE|APARTMENT)\b|\b(?:2|3|4|TWO|THREE|FOUR)[-\s]?FAMILY\b|\b(?:2|3|4|TWO|THREE|FOUR)[-\s]?UNITS\b|\bUNITS?\s*[:#]\s*[2-9]\b|\bR-?2\s+OCCUPANCY\b|\bOCCUPANCY\s*(?:TYPE|GROUP)?\s*[:=]?\s*R-?2\b|\bADU\b|\bACCESSORY\s+DWELLING\b/i;
  // "TWO FAMILY" / "2-FAMILY" alone is a two-family house (common in MA) — no dwelling noun
  // required. R-3 is NOT a single-family basis: IRC/IBC R-3 covers one- AND two-family
  // dwellings, and the bare token also matches a revision tag ("REV R3").
  const SINGLE_FAMILY = /\bRESIDENCE\b|\bSINGLE[-\s]FAMILY\b|\bMAIN\s+HOUSE\b|\bSFR\b|\bSFD\b|\bDWELLING\b/i;
  const WORK_ON_OUTBUILDING = /(?:ARRAY|MODULES?|\bPV\b|PANELS?)\s+(?:ON|AT|OVER)\s+(?:THE\s+)?(?:\(?[NE]\)?\s+)?(?:DETACHED\s+|EXISTING\s+)?(?:GARAGE|SHED|BARN|CARPORT|ADU|WORKSHOP|OUTBUILDING|SHOP)\b|\bGROUND[-\s]MOUNT/i;
  // Another structure named anywhere in the plan text, or trench scope (a run to or from a
  // detached building). A real PA plan set drew the whole array on a detached structure with a
  // ~119 ft trench back to the house while its text never said "ARRAY ON GARAGE" — so any of
  // these makes "one building" an inference. "UTILITY SERVICE: UNDERGROUND" is the service
  // drop, not trench scope: UNDERGROUND counts only beside a conduit/run/feeder.
  //
  // THE OTHER-BUILDING WORDS — ONE family, read by BOTH the structure derivation (any word present
  // and the structure is ASKED — round-3 convergence rule 2026-09-28) and numberOfBuildings'
  // otherStructureEvidence, so the two never disagree about whether another building is named. A
  // word counts wherever it sits (merely drawn on a site plan or not), and a roof shape ("SHED
  // ROOF") or a submittal ("SHOP DRAWINGS") counts too: a false hit here only means "ask". The one
  // exception is a garage called ATTACHED (the house) — never "NON-ATTACHED" / "NOT ATTACHED".
  // [the words a basis names, the pattern]; a ground mount is no building but puts the array off
  // the house all the same.
  // (Each pattern starts with its own word, so the order is only the order a basis lists them in.)
  const OTHER_BUILDING_FAMILY = [
    ['garage', String.raw`GARAGES?`],
    ['shop', String.raw`SHOPS?`],
    ['shed', String.raw`SHEDS?`],
    ['barn', String.raw`(?:POLE\s+)?BARNS?`],
    ['carport', String.raw`CARPORTS?`],
    ['workshop', String.raw`WORKSHOPS?`],
    ['pool house', String.raw`POOL\s*HOUSES?`],
    ['outbuilding', String.raw`OUTBUILDINGS?`],
    ['pergola', String.raw`PERGOLAS?`],
    ['patio cover', String.raw`PATIO\s+COVERS?`],
    ['ADU', String.raw`ADUS?`],
    ['accessory building', String.raw`ACCESSORY(?:\s+(?:STRUCTURE|BUILDING|DWELLING(?:\s+UNIT)?))?`],
    ['detached building', String.raw`DETACHED(?:\s+(?:GARAGE|STRUCTURE|BUILDING|SHOP|CARPORT))?`],
  ];
  const GROUND_MOUNT_WORDS = String.raw`GROUND[-\s]?MOUNT(?:ED|S)?`;
  const OTHER_STRUCTURE_WORDS = [...OTHER_BUILDING_FAMILY.map(([, re]) => re), GROUND_MOUNT_WORDS].join('|');
  // What a basis may say was checked — generated from the same list, so it never claims a word the
  // pattern does not read.
  const OTHER_BUILDING_NAMES = (() => {
    const n = OTHER_BUILDING_FAMILY.map(([name]) => name);
    return `${n.slice(0, -1).join(', ')} or ${n[n.length - 1]}`;
  })();
  const TRENCH_WORDS = String.raw`TRENCH(?:ES|ING)?|DIRECT[-\s]BUR(?:IAL|IED)|UNDERGROUND\s+(?:PV\s+)?(?:CONDUIT|RUN|FEEDER|CIRCUIT|WIRING)`;
  const OTHER_STRUCTURE = new RegExp(String.raw`\b(?:${OTHER_STRUCTURE_WORDS})\b`, 'gi');
  const TRENCH_SCOPE = new RegExp(String.raw`\b(?:${TRENCH_WORDS})\b`, 'gi');
  // ANOTHER BUILDING NAMED BESIDE THE WORK — the same words, tight adjacency only. A real OR plan set
  // read "GARAGE ROOF #2 (07) <module>", "GARAGE SYSTEM- / MAIN HOUSE SYSTEM-" and a 22-ft trench
  // and never "ARRAY ON GARAGE": the array's building is then a question, not "single-family".
  // Site-plan labels ("DRIVEWAY GARAGE MAIN HOUSE", "(E) SHED", "SHED DECK") are not the work:
  //   - the word directly followed by a roof label WITH its "#" ("GARAGE ROOF #2"; "SHED ROOF 3/12"
  //     is a roof pitch) or a system/array label ("GARAGE SYSTEM", "SHED PV ARRAY") — no filler, so
  //     "DETACHED GARAGE (N) PV ARRAY ON (E) ROOF" (a garage drawn, the array on the house) stays out;
  //   - the word, then only (E)/(N)/EXISTING/NEW/"-"/":", then a module count ("(07)", "16 MODULES");
  //     a roof label then "-"/"(" then the word ("ROOF #2 - GARAGE");
  //   - trench scope within TRENCH_REACH characters of the word, either side ("DETACHED GARAGE (N)
  //     TRENCH", "TRENCH FROM MAIN HOUSE TO DETACHED GARAGE") — quoted as the two words only, never
  //     the text between them (it can carry a street address).
  // An ATTACHED GARAGE is the house and is skipped. Since round 3 this phrase ANSWERS nothing (the
  // structure is asked on any other-building word): it is quoted as the evidence beside the words.
  const OUTB = String.raw`(?:${OTHER_STRUCTURE_WORDS})\b`;
  const SHORT_FILL = String.raw`(?:\s*(?:[-–:,]|\((?:E|N)\)|\b(?:EXISTING|NEW)\b))*\s*`;
  const OUTBUILDING_LABELED = new RegExp([
    String.raw`\b${OUTB}\s*[-:]?\s*(?:ROOF\s*#\s*\d{1,2}\b|(?:(?:PV|SOLAR)\s+)?(?:SYSTEM|ARRAY)\b)`,
    String.raw`\b${OUTB}${SHORT_FILL}(?:\(\d{1,3}\)|\b\d{1,3}\s+(?:(?:PV|SOLAR)\s+)?MODULES?\b|\b\d{1,3}\s+(?:PV|SOLAR)\s+PANELS?\b)`,
    String.raw`\bROOF\s*#\s*\d{1,2}\s*[-–:(]\s*${OUTB}`,
  ].join('|'), 'gi');
  const TRENCH_REACH = 60;
  // "ATTACHED GARAGE" is the house; "NON-ATTACHED" / "NOT ATTACHED" / "UN-ATTACHED" GARAGE is not
  // (a word boundary sits after the hyphen, so the negation is read on its own).
  const attachedGarageAt = (t, m) => {
    if (!/^GARAGES?\b/i.test(m[0])) return false;
    const before = t.slice(Math.max(0, m.index - 20), m.index);
    return /\bATTACHED\s*$/i.test(before) && !/\b(?:NON|NOT|UN)[-\s]*ATTACHED\s*$/i.test(before);
  };
  const upper = (s) => s.toUpperCase().replace(/\s+/g, ' ').trim();
  /** Every other-building match in the (clean) text, the attached-garage exception skipped. */
  const otherBuildingMatches = (t) => [...t.matchAll(OTHER_STRUCTURE)].filter((m) => !attachedGarageAt(t, m));
  /** The other-building WORDS the text names (upper case, each once, in order) — what the structure
   *  derivation abstains on and what numberOfBuildings' evidence names first. */
  function otherBuildingWords(planText) {
    return [...new Set(otherBuildingMatches(clean(planText)).map((m) => upper(m[0])))];
  }
  /** The first other-building-beside-the-work phrase (upper case), or ''. */
  function outbuildingBesideWork(planText) {
    const t = clean(planText);
    if (!t) return '';
    for (const m of t.matchAll(OUTBUILDING_LABELED)) {
      if (!attachedGarageAt(t, m)) return upper(m[0]);
    }
    const trenches = [...t.matchAll(TRENCH_SCOPE)];
    if (!trenches.length) return '';
    for (const m of t.matchAll(OTHER_STRUCTURE)) {
      if (attachedGarageAt(t, m)) continue;
      const end = m.index + m[0].length;
      const near = trenches.find((x) => (x.index >= end && x.index - end <= TRENCH_REACH) || (x.index + x[0].length <= m.index && m.index - (x.index + x[0].length) <= TRENCH_REACH));
      if (near) return near.index > m.index ? `${upper(m[0])} … ${upper(near[0])}` : `${upper(near[0])} … ${upper(m[0])}`;
    }
    return '';
  }
  /** How many other-building words a basis names (the structure's and numberOfBuildings' alike). */
  const STRUCTURE_WORD_CAP = 3;
  /** '' when the plan text names no other structure and no trench scope; otherwise the words
   *  found, each quoted once with its surrounding text, for the UNSURE reason. */
  function otherStructureEvidence(planText) {
    const t = clean(planText);
    if (!t) return '';
    const seen = new Map();
    const takeFrom = (matches, kind, cap) => {
      let n = 0;
      for (const m of matches) {
        const w = upper(m[0]);
        // A building word already quoted inside a longer phrase ("GARAGE" in "GARAGE ROOF #2") is not
        // repeated; trench scope is always named as its own item.
        if (n >= cap || seen.has(w) || (kind === 'structure' && [...seen.keys()].some((k) => k.includes(w)))) continue;
        seen.set(w, { kind, ctx: t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim() });
        n++;
      }
    };
    const take = (re, kind, cap) => takeFrom(t.matchAll(re), kind, cap);
    take(new RegExp(WORK_ON_OUTBUILDING.source, 'gi'), 'structure', 1);
    // The phrase beside the work the structure derivation quotes is quoted first, so both name it.
    const beside = outbuildingBesideWork(t);
    if (beside && !seen.has(beside)) {
      // A trench pair ("SHED … TRENCH") is two words apart: it is quoted as the pair alone.
      const i = t.toUpperCase().indexOf(beside);
      seen.set(beside, { kind: 'structure', ctx: i >= 0 ? t.slice(Math.max(0, i - 30), i + beside.length + 30).trim() : '' });
    }
    // Then the SAME words, in the same order and under the same cap, that the structure derivation
    // abstains on (STRUCTURE_WORD_CAP) — so every building its basis names is named here; then an
    // ATTACHED GARAGE, which the derivation reads as the house but a count of buildings stays a
    // question over (as it always was).
    takeFrom(otherBuildingMatches(t), 'structure', STRUCTURE_WORD_CAP);
    take(OTHER_STRUCTURE, 'structure', STRUCTURE_WORD_CAP);
    take(TRENCH_SCOPE, 'trench', 1);
    if (!seen.size) return '';
    return [...seen].map(([w, e]) => `${e.kind === 'trench' ? 'trench scope ' : ''}${w}${e.ctx ? ` ("…${e.ctx}…")` : ''}`).join(', ');
  }

  function singleFamilyBasis(planText) {
    const t = String(planText || '');
    if (!t.trim()) return null;
    if (MULTI_UNIT.test(t)) return null;
    const m = t.match(SINGLE_FAMILY);
    return m ? m[0] : null;
  }

  // -------------------------------------------------------------------------
  // WHICH BUILDING CARRIES THE ARRAY — the structure description, derived from the plan set
  // (operator ruling 2026-09-28: "Single family most of the time, but can be an ADU/Accessory/garage
  // you can see it on the plan-set how its laid out"). THE ONE DERIVATION: the parser page calls it
  // when it saves (structureFromPlan / structureFromPlanBasis on the project) and the backend loads
  // THIS FILE to derive the same answer at read time for projects already on file
  // (backend/src/applicationDocsAgency.ts structureDescriptionOf) — one regex family, two callers.
  //
  // THE CONSERVATIVE RULE (round-3 convergence, 2026-09-28 — every shape-fitted "beside the work"
  // heuristic answered some near-variant wrongly, so none of them answers any more):
  //   1. Single-family dwelling ONLY when the plan text names NO other building at all (no word of
  //      OTHER_BUILDING_FAMILY anywhere, drawn or not — the one exception an ATTACHED GARAGE) and
  //      the single-family evidence is there ("RESIDENCE" / "SINGLE-FAMILY" / SFR / SFD /
  //      "DWELLING", the plan-set read, or 1 dwelling unit);
  //   2. Accessory building ONLY from an explicit array-on phrase naming the detached building
  //      (ARRAY_ON_ACCESSORY with its negation / SHED ROOF / SHOP DRAWING guards) and no array on
  //      the house;
  //   3. Two-family dwelling (duplex) ONLY from "DUPLEX" or 2 dwelling units — no other building
  //      named, as for 1;
  //   4. EVERYTHING ELSE is asked: a garage / shed merely drawn, a townhouse, a manufactured home, a
  //      plan-set read naming an accessory building or a duplex on its own.
  // An answer is one of the five options of the BCD 5952 structure question, or '' (still asked).
  // The basis quotes only the matched words, never the text around them (a title block's
  // "<NAME> RESIDENCE" would carry the homeowner's name), and says only what was checked.
  const STRUCTURE_OPTIONS = ['Single-family dwelling', 'Two-family dwelling (duplex)', 'Townhouse', 'Manufactured home', 'Accessory building (garage/shed)'];
  // The subject is the ARRAY — never a bare "PANEL", which on a plan set is as often the electrical
  // panel ("SUBPANEL AT DETACHED GARAGE" is not an array on the garage).
  // Scope-of-work wording names the subject many ways ("7.2 KW PV SYSTEM ON A DETACHED GARAGE",
  // "SOLAR MODULES ON THE ROOF OF AN EXISTING DETACHED GARAGE", "PHOTOVOLTAIC SYSTEM ON ...",
  // "ROOFTOP SOLAR ON ...") — each must reach the accessory answer, never fall through to "RESIDENCE".
  const ARRAY_ON = String.raw`(?:ARRAY|MODULES?|\bPV\b|PHOTOVOLTAIC(?:\s+(?:SYSTEM|ARRAY|MODULES?|PANELS?))?|(?:PV|SOLAR)\s+(?:PANELS?|SYSTEM|ARRAY)|\bSOLAR)\s+(?:(?:TO\s+BE|IS|ARE|WILL\s+BE)\s+)?(?:(?:MOUNTED|INSTALLED|LOCATED|PLACED)\s+)?(?:ON\s+TOP\s+OF|ON|AT|OVER|ATOP)\s+(?:(?:THE|AN?)\s+)?(?:ROOF\s+OF\s+(?:(?:THE|AN?)\s+)?)?(?:\(?[NE]\)?\s+)?(?:NEW\s+|EXISTING\s+)?`;
  // "SHED ROOF" / "SHED DORMER" is a roof shape on the house, and "SHOP DRAWINGS" a submittal — not
  // a building.
  const ARRAY_ON_ACCESSORY = new RegExp(`${ARRAY_ON}(?:DETACHED\\s+(?:GARAGE|STRUCTURE|BUILDING|SHOP|CARPORT)|SHEDS?\\b(?!\\s+(?:ROOF|DORMER)S?\\b)|(?:POLE\\s+)?BARNS?|CARPORTS?|ADU|ACCESSORY\\s+(?:DWELLING(?:\\s+UNIT)?|BUILDING|STRUCTURE)|WORKSHOP|OUTBUILDING|SHOP\\b(?!\\s+DRAWINGS?\\b))\\b`, 'gi');
  // "NO MODULES ON SHOP", "NOT ... ", "WITHOUT PV ON ..." says the array is NOT there.
  const NEGATED_BEFORE = /\b(?:NO|NOT|NEVER|WITHOUT|NONE)\s+(?:(?:\([NE]\)|PV|SOLAR|NEW)\s+){0,2}$/i;
  /** The first match of a global regex that is not negated just before it, or null. */
  function firstUnnegated(re, t) {
    for (const m of t.matchAll(re)) {
      if (!NEGATED_BEFORE.test(t.slice(Math.max(0, m.index - 24), m.index))) return m;
    }
    return null;
  }
  const ARRAY_ON_HOUSE = new RegExp(`${ARRAY_ON}(?:MAIN\\s+)?(?:HOUSE|RESIDENCE|DWELLING|HOME)\\b|\\bMAIN\\s+HOUSE\\s*[-:]?\\s*(?:(?:PV|SOLAR)\\s+)?(?:SYSTEM|ARRAY)\\b`, 'gi');
  // WHETHER THE HOUSE IS A MANUFACTURED HOME is NOT read here: the server has the one predicate for
  // it (codeReviewRules.structureType — code titles, disclaimers and unchecked boxes are not an
  // answer), and the caller passes its verdict as opts.manufactured ('yes' / 'no'). With no verdict
  // (the parser page), text that so much as MENTIONS one makes this abstain (defer) rather than read
  // a single-family dwelling over it.
  const MANUFACTURED_MENTION = /\b(?:MANUFACTURED|MOBILE)\s+(?:HOMES?|DWELLINGS?|HOUSING)\b/i;
  const MULTI_UNIT_G = new RegExp(MULTI_UNIT.source, 'gi');
  // THE SINGLE-FAMILY WORD the structure takes: SINGLE_FAMILY without "MAIN HOUSE" — a MAIN house
  // implies another building, so it is never the word that answers "single-family" here (it still
  // resolves numberOfBuildings' one-building read, which also weighs otherStructureEvidence).
  const SINGLE_FAMILY_WORD = /\bRESIDENCE\b|\bSINGLE[-\s]FAMILY\b|\bSFR\b|\bSFD\b|\bDWELLING\b/i;
  /** What a single-family / duplex basis says was checked in the text (generated from the family) —
   *  with the one exception named when the text has it, so the sentence never reads "no garage" over
   *  an attached one. */
  const noOtherBuilding = (t) => `names no other building (${OTHER_BUILDING_NAMES}) and no ground mount${[...t.matchAll(OTHER_STRUCTURE)].some((m) => attachedGarageAt(t, m)) ? ' — its only garage is called ATTACHED (the house)' : ''}`;
  /** { option, basis, ambiguous, defer, checked } from the plan text alone. ambiguous: the text names
   *  something that makes the building uncertain (another building, a multi-unit word, arrays on two
   *  buildings, a manufactured home) — no weaker evidence (the plan-set read, a dwelling-unit count)
   *  may answer over it. defer: only the manufactured-home predicate can settle it (no verdict was
   *  given). checked: non-empty text that passed every gate of rule 1 without a single-family word of
   *  its own — the clause a read / unit-count answer adds to say what the text was checked for. */
  function structureFromText(planText, manufactured, manufacturedBasis) {
    const t = clean(planText);
    const out = (option, basis, ambiguous) => ({ option, basis, ambiguous: Boolean(ambiguous), defer: false, checked: '' });
    const mfgAsked = () => out('', `${manufacturedBasis || 'the structure type reads manufactured home'} — a manufactured home is not derived from the plan set; confirm the structure`, true);
    if (!t) return manufactured === 'yes' ? mfgAsked() : out('', '');
    // (2) ACCESSORY: the array's own building, named in an array-on phrase.
    const acc = firstUnnegated(ARRAY_ON_ACCESSORY, t);
    if (acc) {
      // An array on the house AS WELL ("... ON DETACHED GARAGE" and "... ON MAIN HOUSE") is two
      // buildings — which one the form means is a person's call.
      const house = firstUnnegated(ARRAY_ON_HOUSE, t);
      if (house) return out('', `the plan set reads "${upper(acc[0])}" and "${upper(house[0])}" — arrays on two buildings`, true);
      // ROUND 3 CONSERVATIVE CLOSE (skeptic MF1): an accessory building is NEVER derived. Plan sets put
      // arrays on the garage AND the house, describe an existing array "to remain", or say "not in
      // scope" in wordings no phrase list closes, and a wrong "Accessory" fills a legal form. The
      // phrase is quoted as evidence and the structure is asked (operator ruling 2026-09-28: single
      // family most of the time — derived only when the plan set names no other building).
      return out('', `the plan set reads "${upper(acc[0])}" — the array may be on an accessory building, so the structure is asked`, true);
    }
    // (1)/(3) ANY OTHER BUILDING NAMED, anywhere — asked. The phrase beside the work (a roof label /
    // module count / trench beside the word) is QUOTED as evidence only; it decides nothing.
    const others = otherBuildingWords(t).slice(0, STRUCTURE_WORD_CAP);
    if (others.length) {
      const beside = outbuildingBesideWork(t);
      return out('', `the plan set names ${others.map((w) => `"${w}"`).join(', ')}${beside && !others.includes(beside) ? ` ("${beside}")` : ''} — the array may not be on the house, so the structure is asked`, true);
    }
    const multiHits = [...t.matchAll(MULTI_UNIT_G)];
    if (multiHits.length) {
      // MULTI_UNIT was written as an EXCLUSION filter (a false hit only means "ask"), so a positive
      // answer takes only the word that names the building: "DUPLEX" (not an electrical "DUPLEX
      // RECEPTACLE"). Code titles ("ONE- AND TWO-FAMILY DWELLINGS", "R302.2 TOWNHOUSES"), "BATTERY
      // UNITS: 2", "QTY 2 UNITS", R-2, an ADU, a townhouse — all stay a question. Two-unit words
      // beside "DUPLEX" agree with it.
      const kind = (m) => {
        const w = upper(m[0]);
        if (/^DUPLEX$/.test(w)) {
          const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
          const before = t.slice(Math.max(0, m.index - 8), m.index);
          return /^\s*(?:(?:GFCI|GFI|WP|WEATHERPROOF)\s+)?(?:RECEPT|OUTLET|CONVENIENCE|BREAKER|CONNECTOR|PLUG|DEVICE)/i.test(after) || /\bGF(?:C)?I\s*$/i.test(before) ? 'more' : 'duplex';
        }
        return /\b(?:2|TWO)[-\s]?(?:UNIT|FAMILY)|\bUNITS?\s*:\s*2\b|\b2\s+UNITS\b/.test(w) ? 'twoish' : 'more';
      };
      const kinds = new Set(multiHits.map(kind));
      const words = [...new Set(multiHits.map((m) => upper(m[0])))].slice(0, 3).map((w) => `"${w}"`).join(', ');
      if (kinds.has('duplex') && [...kinds].every((k) => k === 'duplex' || k === 'twoish')) return out(STRUCTURE_OPTIONS[1], `the plan set reads ${words} and ${noOtherBuilding(t)}`);
      return out('', `the plan set reads ${words}`, true);
    }
    if (manufactured === 'yes') return mfgAsked();
    if (manufactured !== 'no' && MANUFACTURED_MENTION.test(t)) return { option: '', basis: '', ambiguous: true, defer: true, checked: '' };
    const sf = t.match(SINGLE_FAMILY_WORD);
    if (sf) return out(STRUCTURE_OPTIONS[0], `the plan set reads "${upper(sf[0])}" and ${noOtherBuilding(t)}`);
    return { ...out('', ''), checked: `the plan text ${noOtherBuilding(t)}` };
  }

  /** One of the five options for a value written in their vocabulary ("single-family dwelling",
   *  "Accessory building"), else ''. Exact option words only — interpreting free text is the
   *  backend's structureTypeMeaning, not a second family here. */
  function structureOption(value) {
    const v = clean(value).toLowerCase();
    if (!v) return '';
    return STRUCTURE_OPTIONS.find((o) => o.toLowerCase() === v || o.toLowerCase().split(' (')[0] === v) || '';
  }

  /**
   * THE STRUCTURE DERIVATION. planText: the plan-set text; opts.reading: the plan-set read's own
   * answer ({ value, excerpt } — the model looked at the site / roof plan layout); opts.dwellingUnits:
   * the parsed unit count; opts.manufactured / opts.manufacturedBasis: the server's manufactured-home
   * verdict ('yes' / 'no'; absent on the page). Returns { option, basis, defer } — option '' means
   * "ask"; defer means "leave it to the server" (the text mentions a manufactured home and no verdict
   * was given — the caller stores nothing).
   *   - the text answers (rules 1-3 in structureFromText) and the read AGREES or is silent: that
   *     answer, with its words;
   *   - they DISAGREE: '' (a person decides — neither reading outranks the other);
   *   - the text is AMBIGUOUS (another building named anywhere, a multi-unit word, arrays on two
   *     buildings, a manufactured home): '' whatever the read or the unit count says;
   *   - the text answers nothing and names nothing that doubts it: the READ may answer only
   *     "Single-family dwelling" (rule 1 — its evidence), and a duplex only beside 2 dwelling units
   *     (rule 3); a read of an accessory building, a townhouse or a manufactured home is asked (rules
   *     2 and 4 — only the text's own array-on phrase derives an accessory building). With no read,
   *     1 dwelling unit is a single-family dwelling, 2 a duplex; 3 or more is asked;
   *   - a parsed unit count that disagrees with a single-family (not 1) or duplex (not 2) answer: ''.
   */
  function structureBasis(planText, opts) {
    opts = opts || {};
    const text = structureFromText(planText, opts.manufactured, opts.manufacturedBasis);
    if (text.defer) return { option: '', basis: '', defer: true };
    const reading = opts.reading && typeof opts.reading === 'object' ? opts.reading : { value: opts.reading };
    const read = structureOption(reading.value);
    const readBasis = read ? `the plan-set read answers "${read}"${reading.excerpt ? ` ("${clean(reading.excerpt).slice(0, 80)}")` : ''}` : '';
    const units = Number(String(opts.dwellingUnits ?? '').trim().match(/^\d+/)?.[0] ?? NaN);
    const withUnits = (r) => {
      if (!r.option || !(units > 0)) return r;
      if ((r.option === STRUCTURE_OPTIONS[0] && units !== 1) || (r.option === STRUCTURE_OPTIONS[1] && units !== 2)) {
        return { option: '', basis: `${r.basis}, but the plan set states ${units} dwelling unit${units === 1 ? '' : 's'} — confirm the structure` };
      }
      return r;
    };
    if (text.option && read && text.option !== read) return { option: '', basis: `${text.basis}, but ${readBasis} — confirm which building carries the array` };
    if (text.option && read) return withUnits({ option: text.option, basis: `${text.basis}; ${readBasis}` });
    if (text.ambiguous && read) return { option: '', basis: `${text.basis}, and ${readBasis} — confirm which building carries the array` };
    if (text.option || text.ambiguous) return withUnits({ option: text.option, basis: text.basis });
    // What the text was checked for, said beside a read / unit-count answer ('' when there was no text).
    const checked = text.checked ? `; ${text.checked}` : '';
    if (read === STRUCTURE_OPTIONS[0]) return withUnits({ option: read, basis: `${readBasis}${checked}` });
    if (read === STRUCTURE_OPTIONS[1] && units === 2) return { option: read, basis: `${readBasis}; the plan set states 2 dwelling units${checked}` };
    if (read) return { option: '', basis: `${readBasis}, but the plan text does not say so itself${read === STRUCTURE_OPTIONS[4] ? ' (no array-on phrase names the building)' : ''} — confirm the structure` };
    if (units === 1) return { option: STRUCTURE_OPTIONS[0], basis: `the plan set states 1 dwelling unit${checked}` };
    if (units === 2) return { option: STRUCTURE_OPTIONS[1], basis: `the plan set states 2 dwelling units${checked}` };
    return { option: '', basis: '' };
  }
  const structureFromPlan = (planText, opts) => structureBasis(planText, opts).option;

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

  // A CALCULATED LIMIT IS NOT A READING OF THE FIELD (dry-run 2026-09-28 B15). Every plan set that
  // prints the 705.12 check — "(200A x 120%) - 200A = 40A max PV OCPD; 30A breaker installed" — raised
  // a fake "PV breaker 30 A vs 40 A" conflict: 40 A is the maximum worked out in a formula, the SLD
  // states 30 A. Only a reading that isCalculatedLimit (the limit-labelled RESULT of a calculation,
  // and the reading's value is that result) is set aside — any other calculation line is a reading,
  // and its disagreement stays a CONFLICT. It is set aside only while at least one other reading
  // quotes a plain line; if every reading is a calculated limit, nothing is dropped. A reading with no
  // excerpt is never dropped (an uncited reading is still a reading).
  function withoutCalculations(rs) {
    const plain = rs.filter((r) => r.excerpt && !isCalculatedLimit(r));
    if (!plain.length) return { kept: rs, dropped: [] };
    return { kept: rs.filter((r) => !isCalculatedLimit(r)), dropped: rs.filter(isCalculatedLimit) };
  }
  const allAgree = (rs) => rs.length > 0 && new Set(rs.map((r) => String(r.value).toUpperCase())).size === 1;
  const calculationNote = (dropped) => dropped.map((d) => `${d.value} is a calculated limit, not a reading (${where(d)}${quote(d)})`).join('; ');

  /**
   * passes:   [{ kind:'vision'|'text', label, docsGiven:[docKind...], response:{fields, lowConfidenceFields, notes, conflicts?, uncertainties?, resolutions?} }]
   * attached: [docKind...] the documents on the page
   * planText: raw plan-set text (single-family basis, RSD contradiction)
   * meterVerdict: the page's one meter verdict (compareMeters), so a flagged `meter` reading
   *               that the cross-check already confirmed is RESOLVED, and a mismatch is a CONFLICT
   */
  function resolveReviewItems({ passes, attached, planText, meterVerdict }) {
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
      const all = c.readings.map((r) => ({ field, value: r.value, source: r.source || 'plan_set', sheet: r.sheet || '', excerpt: r.excerpt || '' }));
      if (field === 'owner') continue; // handled by the account-holder rule below
      // A calculated limit is not a conflict peer: the plain readings decide (withoutCalculations).
      const calc = withoutCalculations(all);
      if (calc.dropped.length && allAgree(calc.kept)) {
        resolved.push({ field, value: calc.kept[0].value, how: `stated on the ${where(calc.kept[0])}${quote(calc.kept[0])}; ${calculationNote(calc.dropped)}`, evidence: calc.kept[0] });
        done.add(field);
        continue;
      }
      const rs = calc.kept;
      if (STRUCTURAL_FIELDS.has(field)) {
        const letter = rs.filter((r) => r.source === 'structural_letter');
        const letterValues = [...new Set(letter.map((r) => String(r.value)))];
        if (letterValues.length === 1) {
          const others = rs.filter((r) => r.source !== 'structural_letter');
          const mismatch = sealedSourceMismatch(letter, others);
          if (mismatch) { pushConflict(field, rs, [mismatch, c.note ? clean(c.note) : ''].filter(Boolean).join(' — ')); continue; }
          resolved.push({ field, value: letter[0].value, how: `sealed structural letter governs the plan set (sealed-source rule): letter ${fmtReading(letter[0])} over ${others.map(fmtReading).join(', ') || 'the other reading'}`, evidence: letter[0] });
          done.add(field);
          continue;
        }
      }
      pushConflict(field, rs, [c.note ? clean(c.note) : '', calculationNote(calc.dropped)].filter(Boolean).join(' — '));
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
      // A JOINT ACCOUNT (operator ruling 2026-09-28: "Durwood is good seeing as they're listed. If
      // they're not listed then primary name on the bill will apply for the NEM"). The bill's name
      // block lists every holder, while the reading's value is often only the first; a plan-set owner
      // who is one of the listed holders IS on the account — no spouse/relative conflict. The owner
      // stays the plan set's; the NEM customer block reads the bill (accountHolders.nemApplicantName).
      const block = bill ? billHolderBlock(bill) : '';
      if (bill && namePersons(block).length > 1) {
        // Only where the VALUE alone misses the owner: a value that already lists the holders resolves
        // through the rule below exactly as before (to the bill's printed block).
        const listed = candidates.find((k) => namesMatch(block, k.value) && !namesMatch(bill.value, k.value));
        if (listed) {
          resolved.push({ field: 'owner', value: listed.value, how: `listed on the utility bill as an account holder ("${block}", ${where(bill)}) — a joint account; the NEM application names the listed owner`, evidence: bill });
          done.add('owner');
        }
      }
      if (!done.has('owner') && bill && (candidates.length || flagged.includes('owner') || c)) {
        const matches = candidates.filter((k) => namesMatch(bill.value, k.value));
        const nonMatch = candidates.filter((k) => !namesMatch(bill.value, k.value));
        if (candidates.length === 0 || matches.length === 1 || (matches.length >= 1 && nonMatch.length === 0)) {
          resolved.push({ field: 'owner', value: bill.value, how: `utility bill account holder is the account of record (${where(bill)})${matches.length ? `, matches the ${matches.map(where).join(' and ')}` : ''}${nonMatch.length ? `; the ${nonMatch.map((k) => `${where(k)} names "${k.value}"`).join(', ')} — confirm with the installer` : ''}`, evidence: bill });
          done.add('owner');
        } else {
          const kin = candidates.filter((k) => nameRelation(bill.value, k.value) === 'kin');
          const bare = candidates.filter((k) => nameRelation(bill.value, k.value) === 'surname-only-doc');
          const partial = candidates.filter((k) => nameRelation(bill.value, k.value) === 'surname-only-bill');
          const says = [];
          if (partial.length) says.push(`the bill prints an initial or surname only ("${bill.value}"), so the given name on ${partial.map((k) => `the ${where(k)} ("${k.value}")`).join(' and ')} is not confirmed`);
          if (bare.length) says.push(`${bare.map((k) => `the ${where(k)} gives a surname only ("${k.value}")`).join(' and ')}, so it cannot confirm the given name`);
          if (kin.length) says.push(`the bill account holder shares only a surname with ${kin.map((k) => `the ${where(k)} ("${k.value}")`).join(' and ')} — a different given name (spouse or relative?)`);
          pushConflict('owner', [bill, ...candidates], says.length
            ? `${says.join('; ')} — confirm whose name goes on the application before filing`
            : 'the bill account holder matches none of the names on the documents — resolve before filing');
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
      if (field === 'meter' && rs.length) {
        const v = String(meterVerdict || '');
        if (/DIGITS MATCH|LIKELY MATCH/i.test(v)) { resolved.push({ field, value: rs[0].value, how: `the meter cross-check confirms it: ${v} (${rs.map(where).join(' / ')})`, evidence: rs[0] }); done.add(field); continue; }
        if (/^MISMATCH/i.test(v)) { pushConflict(field, rs, v); continue; }
      }
      // Two documents agree and at least one reading is confident: one pass's doubt does not
      // outrank the other's certainty (a state read off a meter photo at 50% while the bill
      // prints the address at 97%).
      if (rs.length >= 2 && new Set(rs.map((r) => String(r.value).toUpperCase())).size === 1 && kind !== 'conflicting') {
        const best = rs.reduce((a, b) => (b.confidence > a.confidence ? b : a));
        const sources = new Set(rs.map((r) => r.source));
        if (best.confidence >= 0.75 && sources.size >= 2) {
          resolved.push({ field, value: best.value, how: `two documents agree: ${rs.map((r) => `${where(r)}${quote(r)}`).join('; ')}`, evidence: best });
          done.add(field);
          continue;
        }
      }
      if (field === 'dwellingUnits' || field === 'numberOfBuildings') {
        const stated = rs.find((r) => String(r.value) !== '1' && numberIn(r.excerpt, r.value) && /UNIT|BUILDING|DWELLING/i.test(r.excerpt));
        const outb = field === 'numberOfBuildings' && !stated ? otherStructureEvidence(planText) : '';
        if (outb) {
          // The plan names another structure or trench scope: which building carries the work
          // is an inference, so it stays UNSURE with that evidence and the read's own basis.
          const why = `the plan text names ${outb} — the array may sit on, or run to, another structure; confirm which building(s) carry the work${reason ? `; the read's basis: ${reason}` : ''}`;
          if (rs[0]) unsure.push({ field, value: rs[0].value, evidence: rs[0], why }); else missing.push({ field, suppliedBy: supplier(field), why });
          done.add(field);
          continue;
        }
        if (!stated && sf) {
          // The basis quotes only what the text shows: singleFamilyBasis matches anywhere in the
          // plan text (a site-plan "MAIN HOUSE" label is not the title block).
          resolved.push({ field, value: 1, how: field === 'dwellingUnits' ? `single-family residence: the plan set reads "${sf}" and carries no multi-unit language` : `one building carries the work: the plan set reads "${sf}" and its text names no other structure (${OTHER_BUILDING_NAMES}), no ground mount and no trench run`, evidence: rs[0] || null });
          done.add(field);
          continue;
        }
      }
      if (rs.length >= 2 && new Set(rs.map((r) => String(r.value).toUpperCase())).size > 1) {
        // A calculated limit is not a conflict peer (withoutCalculations) — unless the read itself
        // doubts the plain reading (guessed / unreadable), which stays the reviewer's question.
        const calc = kind === 'guessed' || kind === 'unreadable' ? { kept: rs, dropped: [] } : withoutCalculations(rs);
        if (calc.dropped.length && allAgree(calc.kept)) {
          const best = calc.kept.reduce((a, b) => (b.confidence > a.confidence ? b : a));
          resolved.push({ field, value: best.value, how: `stated on the ${where(best)}${quote(best)}; ${calculationNote(calc.dropped)}`, evidence: best });
          done.add(field);
          continue;
        }
        const peers = calc.kept;
        const why = [reason, calculationNote(calc.dropped)].filter(Boolean).join(' — ');
        if (STRUCTURAL_FIELDS.has(field)) {
          const letter = peers.filter((r) => r.source === 'structural_letter');
          const lv = [...new Set(letter.map((r) => String(r.value)))];
          const mismatch = lv.length === 1 ? sealedSourceMismatch(letter, peers.filter((r) => r.source !== 'structural_letter')) : '';
          if (mismatch) { pushConflict(field, peers, [mismatch, why].filter(Boolean).join(' — ')); continue; }
          if (lv.length === 1) { resolved.push({ field, value: letter[0].value, how: `sealed structural letter governs the plan set (sealed-source rule): letter ${fmtReading(letter[0])} over ${peers.filter((r) => r.source !== 'structural_letter').map(fmtReading).join(', ')}`, evidence: letter[0] }); done.add(field); continue; }
        }
        pushConflict(field, peers, why);
        continue;
      }
      const r = rs[0];
      if (!r) { missing.push({ field, suppliedBy: supplier(field), why: reason || 'not stated in any attached document' }); done.add(field); continue; }
      if (kind === 'conflicting') { pushConflict(field, rs, reason || 'the model reports conflicting readings'); continue; }
      const label = STATED[field];
      const excerpt = String(r.excerpt || '');
      const statedVerbatim = label && excerpt && label.test(excerpt) && !FORMULA.test(excerpt) && !(field === 'existingBuildingArea' && NOT_THIS_AREA.test(excerpt)) && numberIn(excerpt, r.value);
      const wholeFeet = field === 'buildingHeightInches' && Number(r.value) === 0 && /\d+\s*(?:FT|FEET|')\b/i.test(excerpt) && !/\d+\s*(?:IN\b|INCH|")/i.test(excerpt);
      // The sealed letter's "Roof Height 25 ft" IS the building height the permit form asks
      // for (operator rule); the model tends to call it "inferred" because no separate
      // grade-to-ridge figure exists. Deterministic, so it stands whatever kind was attached.
      const roofHeight = field === 'buildingHeightFeet' && /ROOF\s+HEIGHT\s*:?\s*\d+/i.test(excerpt) && numberIn(excerpt, r.value);
      // wholeFeet is deterministic (a height printed as "25 ft" has 0 inches) so it stands
      // whatever kind the model attached; a stated value yields to a genuine doubt.
      if (wholeFeet || roofHeight || (statedVerbatim && kind !== 'guessed' && kind !== 'unreadable' && kind !== 'inferred')) {
        resolved.push({ field, value: r.value, how: `stated on the ${where(r)}${quote(r)}${wholeFeet ? ' — height given in whole feet' : ''}${roofHeight ? " — the letter's Roof Height is the building height unless an elevation states grade-to-ridge" : ''}`, evidence: r });
        done.add(field);
        continue;
      }
      unsure.push({ field, value: r.value, evidence: r, why: reason || (kind ? `${kind} (model confidence ${Math.round(r.confidence * 100)}%)` : `the read flagged it at ${Math.round(r.confidence * 100)}% confidence without a reason — read from ${where(r)}${quote(r)}; verify against the document`) });
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
    // Quote the callout, not the bare keyword: a one-word match ("TRENCH") shows its context.
    const quoteOf = (e) => { const t = clean(e.text); const s = clean(e.snippet); return (t.length >= 24 || !s) ? t : s; };
    const seen = new Set();
    const quotes = [];
    for (const e of hits) {
      const q = `${e.type} p.${e.page}${e.sheet ? ' ' + e.sheet : ''}: "${quoteOf(e).slice(0, 160)}"`;
      if (seen.has(q)) continue;
      seen.add(q); quotes.push(q);
      if (quotes.length >= 3) break;
    }
    return { needed: true, basis: 'excavation evidence on the plan set', quotes };
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

  // An explicit callout is the label with its answer right beside it ("POINT OF
  // INTERCONNECT, LOAD BREAKER 20A/2P", "INTERCONNECTION METHOD: LOAD SIDE TAP"). A label
  // that merely precedes a numbered code note a sentence later ("POINT OF INTERCONNECT 4. THE
  // COMBINED OCPD ... 5. FEEDER TAP INTERCONNECTION ACCORDING TO NEC 705.12") is not one.
  const LABEL_RE = /\b(?:INTERCONNECTION\s+(?:METHOD|TYPE)|POINT\s+OF\s+INTERCONNECT(?:ION)?|POI)\b/i;
  function isExplicit(e) {
    const t = String(e.text || '');
    const lm = t.match(LABEL_RE);
    if (!lm) return false;
    const rest = t.slice(lm.index + lm[0].length);
    const wm = rest.match(TAP_WORDS) || rest.match(BREAKER_WORDS);
    if (!wm) return false;
    const between = rest.slice(0, wm.index);
    return between.length <= 60 && !/[.;]\s|\b\d{1,2}\.\s|ACCORDING|IN\s+ACCORDANCE|\bPER\b|\bNEC\b/i.test(between);
  }
  // A code clause or an option word counts only when it belongs to the tap phrase itself:
  // the same sentence, the same numbered note or the same label. Label pages run one label
  // into the next with no punctuation ("CODE REF: NEC 690.13(B) PRODUCTION METER LABEL
  // LOCATION: MAIN SERVICE PANEL SOLAR CONNECTION LINE SIDE TAP"), so a cite that merely
  // sits nearby belongs to the neighbouring label, not to the tap — and that label is the
  // only TAP evidence a real line-side-tap job may carry.
  const TAP_WORDS_G = new RegExp(TAP_WORDS.source, 'gi');
  const SEGMENT_BREAK = /[.;!?](?=\s+[A-Z(\[])|[·•]|(?:^|\s)\d{1,2}(?:\.\d{1,2})+\.?\s*(?=[A-Z(])|(?:^|\s)\d{1,2}\.\s+(?=[A-Z(])|\b(?:LABEL\s+LOCATION|CODE\s+REF(?:ERENCE)?S?|PER\s+CODE\(?S?\)?|WARNING|CAUTION|DANGER|NOTICE)\s*:|-{2,}\s*PAGE\s+\d+\s*-{2,}/gi;
  const NEW_WORK = /(?:\(N\)|\bNEW)\s*(?:[A-Z]+\s+){0,2}$/i;
  const METHOD_FORM = /^\s*(?:\(\s*(?:LOAD|LINE|SUPPLY)\s*SIDE\s*\)\s*)?INTERCON+ECT/i;

  /** The tap phrase this evidence is about, located in its snippet: the occurrence nearest
   *  the match offset (the scope engine keeps 120 characters before the match), never simply
   *  the first tap word in the snippet — that can be a different mention. */
  function locateTap(e) {
    const s = String(e.snippet || e.text || '');
    const text = clean(e.text);
    const own = (text.match(TAP_WORDS) || [])[0];
    const expected = Math.min(120, s.length) + Math.max(0, text.search(TAP_WORDS));
    let best = null;
    TAP_WORDS_G.lastIndex = 0;
    let m;
    while ((m = TAP_WORDS_G.exec(s))) {
      const same = own && clean(m[0]).toUpperCase() === clean(own).toUpperCase();
      const d = Math.abs(m.index - expected) - (same ? 1e6 : 0);
      if (!best || d < best.d) best = { d, pos: m.index, len: m[0].length };
    }
    return best ? { s, pos: best.pos, len: best.len } : null;
  }

  /** The tap phrase's own sentence / numbered note / label, and whether it is a numbered note. */
  function tapSegment(s, pos, len) {
    let start = 0; let end = s.length; let numbered = false;
    SEGMENT_BREAK.lastIndex = 0;
    let m;
    while ((m = SEGMENT_BREAK.exec(s))) {
      const b0 = m.index; const b1 = m.index + m[0].length;
      if (b1 <= pos) { start = b1; numbered = /^\s*\d/.test(m[0]); }
      else if (b0 >= pos + len) { end = b0; break; }
      if (m[0].length === 0) SEGMENT_BREAK.lastIndex++;
    }
    // Title-block and label soup can run hundreds of characters with no break at all; never
    // look further than 140 characters either side (the old window), so a stray word there
    // ("ALTERNATIVE" in a scrambled title block) cannot reach the tap either.
    if (start < pos - 140) { start = pos - 140; numbered = false; }
    end = Math.min(end, pos + len + 140);
    return { before: s.slice(start, pos), after: s.slice(pos + len, end), segment: s.slice(start, end), numbered };
  }

  function isNoteMention(e) {
    const at = locateTap(e);
    if (!at) return false;
    const { before, after, segment, numbered } = tapSegment(at.s, at.pos, at.len);
    // "(N) SUPPLY SIDE TAP PER NEC 705.11(A)" is new work being called out, cite or not.
    if (NEW_WORK.test(before)) return false;
    if (OPTION_CLAUSE.test(segment)) return true;
    const code = CODE_CLAUSE.test(segment);
    const method = METHOD_FORM.test(after);
    // A numbered note that cites the code for a tap method ("5. FEEDER TAP INTERCONNECTION
    // (LOADSIDE) ACCORDING TO NEC 705.12(B)(1)") is the general list of permitted methods.
    if (numbered && (code || method)) return true;
    // Unnumbered, the same list reads "<METHOD> TAP INTERCONNECTION ACCORDING TO NEC …".
    return method && code;
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
    compareMeters, meterTargets, meterInText,
    mergeNotes, assertsMissingAttached,
    resolveReviewItems, rsdConflict, singleFamilyBasis, namesMatch, billHolderBlock,
    structureBasis, structureFromPlan, structureOption, STRUCTURE_OPTIONS,
    otherStructureEvidence, outbuildingBesideWork, otherBuildingWords,
    licenseLabel, installerLine, identifyUtility,
    locatesDecision, EXCAVATION_TYPES,
    filterTapEvidence, isNoteMention,
    formatReviewList,
  };
});
