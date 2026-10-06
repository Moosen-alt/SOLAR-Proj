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
const SCHEDULE_LABEL_FIRST = new RegExp(String.raw`\b(?:${OPTIMIZER_LABEL})\s*(?:[:=|#-]|\(\s*\d{1,3}\s*\)|\bQTY\b)\s*(?:\(?\s*\d{1,3}\s*\)?\s*(?:x\s*)?)?${MAKE_WORDS}${OPTIMIZER_MODEL}\b`, "i");
const SCHEDULE_QTY_FIRST = new RegExp(String.raw`(?:\(\s*\d{1,3}\s*\)|\b\d{1,3}\s*x)\s*${MAKE_WORDS}${OPTIMIZER_MODEL}\b[^.;]{0,30}?\b(?:${OPTIMIZER_LABEL})\b`, "i");
// "8 NEW SOLAREDGE POWER OPTIMIZERS S440" / "(30) POWER OPTIMIZERS: S500" — quantity, label, model.
const SCHEDULE_QTY_LABEL_MODEL = new RegExp(String.raw`(?:\(\s*\d{1,3}\s*\)|\b\d{1,3})\s+(?:NEW\s+|\(N\)\s*)?${MAKE_WORDS}(?:${OPTIMIZER_LABEL})\s*[,:=-]?\s*(?:MODEL\s*[:#]?\s*)?${OPTIMIZER_MODEL}\b`, "i");
const LABEL_IN_FIELD = new RegExp(String.raw`\b(?:${OPTIMIZER_LABEL})\b`, "i");
const MODEL_IN_FIELD = new RegExp(String.raw`^\s*${MAKE_WORDS}${OPTIMIZER_MODEL}\b`, "i");

/** The equipment fields that name module-level electronics. invModel/inverterModel name the
 *  inverter (an optimizer model there is the parser filing the MLPE in the inverter slot);
 *  mciMake/mciModel are the module-level converter fields. */
const EQUIPMENT_FIELDS = ["invModel", "inverterModel", "mciMake", "mciModel"] as const;

export interface ModuleLevelElectronicsEvidence {
  present: boolean;
  /** Human-readable reason, e.g. `equipment line "… (22) SOLAREDGE S440 POWER OPTIMIZERS …"`. */
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
    if (v && (LABEL_IN_FIELD.test(v) || MODEL_IN_FIELD.test(v))) return { present: true, basis: `${k} "${v}"`, source: k, fromField: true, excerpt: v };
  }
  for (const s of texts) {
    const t = String(s.text ?? "").replace(/\s+/g, " ");
    const m = SCHEDULE_LABEL_FIRST.exec(t) ?? SCHEDULE_QTY_FIRST.exec(t) ?? SCHEDULE_QTY_LABEL_MODEL.exec(t);
    if (m) {
      return {
        present: true,
        basis: `equipment line "${t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim()}"`,
        source: s.label,
        fromField: false,
        // The matched line itself, not a window: a cover sheet's neighbouring words are the title
        // block (homeowner name, address).
        excerpt: m[0].slice(0, 120),
      };
    }
  }
  return NONE;
}
