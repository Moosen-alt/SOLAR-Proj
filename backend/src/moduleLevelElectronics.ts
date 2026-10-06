// ONE ANSWER TO "DOES THIS DESIGN CARRY MODULE-LEVEL ELECTRONICS?" (issue #213).
//
// The Iowa PV worksheet read optimizer EQUIPMENT (dcDcConverterEvidence) while the rapid-shutdown
// rule (codeReviewRules.isMlpeDesign) knew only microinverter wording and brands — so an S440
// optimizer on every module was "module-level electronics" on the worksheet and a plain string
// system to the reviewer, which hard-blocked it once the edition was verified. Both now ask here.
//
// Read from the EQUIPMENT, never from prose. "optimizer" anywhere in the joined plan text marked a
// Tesla string system DC-DC "Yes" because a rail spec sheet says it "secures and bonds most
// micro-inverters and optimizers to rail", and a micro system whose notes say "MLPE (microinverters
// or optimizers)" likewise. Evidence is:
//   - an inverter/MLPE model field naming an optimizer;
//   - an EQUIPMENT-SCHEDULE line in the text: an optimizer / DC-DC converter label followed by a
//     separator or quantity and an optimizer MODEL ("OPTIMIZER: (20) SOLAREDGE S440"), or a quantity
//     + model + label ("(20) TIGO TS4-A-O OPTIMIZERS"). A model token alone is not evidence (an RSD
//     datasheet lists its optimizer siblings), nor is the word alone.
// The model token is a FAMILY SHAPE across RSD-integrated optimizer makers (SolarEdge P/S series,
// Tigo TS4, Huawei SUN2000-…-P), not a brand allowlist, and a brand name alone (SolarEdge sells
// batteries and string inverters too) is never evidence here. A SolarEdge STRING INVERTER on its own
// is not module-level equipment either: the worksheet's own reading of it lives in
// dcDcConverterEvidence, and the reviewer keeps it a string design (evidenceSpecificity.test).
const OPTIMIZER_MODEL = String.raw`(?:P\d{3,4}[A-Z]{0,3}|S\d{3,4}[A-Z]?|TS4-(?:A-|R-)?2?O|SUN2000-\d{3,4}W-P\w*)`;
const OPTIMIZER_LABEL = String.raw`(?:(?:POWER|DC)\s+)?OPTIMI[SZ]ERS?|DC[-\s]?(?:TO[-\s]?)?DC\s+CONVERTERS?`;
const MAKE_WORDS = String.raw`(?:[A-Z][A-Za-z.&-]*\s+){0,2}`;
// Every schedule shape carries a QUANTITY: a line without one is a note about optimizers, not a
// count of them ("RSD BY OPTIMIZERS: S101" is a sheet reference). "(22) …", "22 x …", "22 NEW …".
const SCHEDULE_LABEL_FIRST = String.raw`\b(?:${OPTIMIZER_LABEL})\s*(?:[:=|#\u2013\u2014-]\s*|\bQTY\b\s*[:#]?\s*)?\(?\s*\d{1,3}\s*\)?\s*(?:x\s*)?${MAKE_WORDS}${OPTIMIZER_MODEL}\b`;
const SCHEDULE_QTY_FIRST = String.raw`(?:\(\s*\d{1,3}\s*\)|\b\d{1,3}\s*x)\s*${MAKE_WORDS}${OPTIMIZER_MODEL}\b[^.;]{0,30}?\b(?:${OPTIMIZER_LABEL})\b`;
// "8 NEW SOLAREDGE POWER OPTIMIZERS S440" / "(30) POWER OPTIMIZERS: S500" — quantity, label, model.
const SCHEDULE_QTY_LABEL_MODEL = String.raw`(?:\(\s*\d{1,3}\s*\)|\b\d{1,3})\s+(?:NEW\s+|\(N\)\s*)?${MAKE_WORDS}(?:${OPTIMIZER_LABEL})\s*[,:=\u2013\u2014-]?\s*(?:MODEL\s*[:#]?\s*)?${OPTIMIZER_MODEL}\b`;
const SCHEDULE_SHAPES = [SCHEDULE_LABEL_FIRST, SCHEDULE_QTY_FIRST, SCHEDULE_QTY_LABEL_MODEL];

// NOT EQUIPMENT, THOUGH IT MATCHES THE SHAPE (Helm review of #233). Each of these softened a
// rapid-shutdown blocker to a warning:
//   - a SHEET REFERENCE: "S101" is a structural sheet number with the S440's shape, so "SEE SHEET
//     S101" / "PER S101" is never a model;
//   - a zero count: "(0) S440 OPTIMIZERS";
//   - a negated statement: "NO OPTIMIZERS", "OPTIMIZERS NOT USED", a field holding "No optimizers".
const REFERENCE_WORDS = /\b(?:SEE|SHEET|SHT|DWG|DRAWING|REF(?:ER(?:ENCE)?)?|PER|DETAIL|PAGE|PG)\b/i;
const NEGATED_IN = /\b(?:no|not|none|n\/a|without)\b/i;
const NEGATION_BEFORE = /\b(?:no|not|never|without|excluding|except)\s+(?:[a-z]+\s+){0,2}$/i;
const NEGATION_AFTER = /^[^.;]{0,30}?\b(?:not\s+(?:used|provided|installed|included|required|applicable)|n\/a|by\s+others|excluded|removed|deleted)\b|^\s*[:\u2013\u2014-]?\s*(?:no|n\/a|none)\b/i;

function scheduleLine(text: string): RegExpExecArray | null {
  for (const shape of SCHEDULE_SHAPES) {
    const re = new RegExp(shape, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const qty = Number(m[0].match(/\d{1,3}/)?.[0] ?? "0");
      if (qty < 1 || REFERENCE_WORDS.test(m[0]) || NEGATED_IN.test(m[0])) continue;
      if (NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
      if (NEGATION_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40))) continue;
      return m;
    }
  }
  return null;
}
const LABEL_IN_FIELD = new RegExp(String.raw`\b(?:${OPTIMIZER_LABEL})\b`, "i");
const MODEL_IN_FIELD = new RegExp(String.raw`^\s*${MAKE_WORDS}${OPTIMIZER_MODEL}\b`, "i");

/** The equipment fields that name module-level electronics. invModel/inverterModel name the
 *  inverter (an optimizer model there is the parser filing the MLPE in the inverter slot);
 *  mciMake/mciModel are the module-level converter fields. */
const EQUIPMENT_FIELDS = ["invModel", "inverterModel", "mciMake", "mciModel"] as const;

export interface ModuleLevelElectronicsEvidence {
  present: boolean;
  /** Human-readable reason, e.g. `equipment line "(22) SOLAREDGE S440 POWER OPTIMIZERS"` — the
   *  matched line only, never the text around it. */
  basis: string;
  /** Where it was read: the field name, or the text source's label. Empty when absent. */
  source: string;
  /** An equipment FIELD (parser output) or a document's own text. */
  fromField: boolean;
  /** The field value or the matched schedule line itself. Empty when absent. */
  excerpt: string;
}

const NONE: ModuleLevelElectronicsEvidence = { present: false, basis: "", source: "", fromField: false, excerpt: "" };

/** Module-level DC electronics (RSD-integrated optimizers / DC-DC converters) shown as EQUIPMENT:
 *  an equipment field naming one, or an equipment-schedule line with a quantity and an optimizer
 *  model in one of `texts`. Microinverters are answered by the callers' own micro fields. */
export function moduleLevelElectronicsEquipment(
  fields: Record<string, unknown>,
  texts: Array<{ label: string; text: string }>,
): ModuleLevelElectronicsEvidence {
  for (const k of EQUIPMENT_FIELDS) {
    const v = String(fields[k] ?? "").trim();
    if (v && !NEGATED_IN.test(v) && !REFERENCE_WORDS.test(v) && (LABEL_IN_FIELD.test(v) || MODEL_IN_FIELD.test(v))) return { present: true, basis: `${k} "${v}"`, source: k, fromField: true, excerpt: v };
  }
  for (const s of texts) {
    const t = String(s.text ?? "").replace(/\s+/g, " ");
    const m = scheduleLine(t);
    if (m) {
      // The matched line itself, never a window around it: on a cover sheet the neighbouring words
      // are the title block (homeowner name, address, APN).
      const line = m[0].slice(0, 120);
      return { present: true, basis: `equipment line "${line}"`, source: s.label, fromField: false, excerpt: line };
    }
  }
  return NONE;
}
