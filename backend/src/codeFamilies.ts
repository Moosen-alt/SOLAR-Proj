// ---------------------------------------------------------------------------
// CODE FAMILIES AND EDITIONS OVER TIME — one answer to "what is this code FOR" and "which
// edition applies on a date", for every state, not an Oregon special case.
//
// A state names its codes its own way (ORSC, OSSC, CRC, FBC-R, RCNYS, 780 CMR, UCC …). The
// review, the research merge and the inheritance rule all need the same question answered: which
// canonical FAMILY (residential / building / electrical / fire / energy / mechanical / plumbing)
// an entry governs, and which MODEL code it is built on.
//
// THE PREDICATE IS NOT DUPLICATED. designCriteria.ts owns the token normalizer (normCodeToken) and
// the state-code -> model-code map (STATE_CODE_BASE via baseModelCode); this module imports them and
// only ADDS the state codes that map lacks (the Oregon mechanical/plumbing/energy codes, Michigan,
// Ohio, NC, VA, the Florida volumes …). Those extras belong in STATE_CODE_BASE — a consolidation
// left to the owner of designCriteria.ts (see the build report's open issues).
// ---------------------------------------------------------------------------
import type {
  CodeEdition,
  CodeFamily,
  CodeFamilyAdoptionModel,
  JurisdictionAdoptionModel,
  UpcomingCodeEdition,
} from "../../shared/src/types";
import { baseModelCode, normCodeToken } from "./designCriteria";

export const CODE_FAMILIES: readonly CodeFamily[] = ["residential", "building", "electrical", "fire", "energy", "mechanical", "plumbing"];

export function isCodeFamily(v: unknown): v is CodeFamily {
  return typeof v === "string" && (CODE_FAMILIES as readonly string[]).includes(v);
}

const ADOPTION_MODELS = ["statewide_uniform", "statewide_minimum_local_amend", "local_adoption", "mixed"] as const;
export function isAdoptionModel(v: unknown): v is JurisdictionAdoptionModel["model"] {
  return typeof v === "string" && (ADOPTION_MODELS as readonly string[]).includes(v);
}
export function isFamilyAdoptionModel(v: unknown): v is CodeFamilyAdoptionModel {
  return isAdoptionModel(v) && v !== "mixed";
}

/** The family each MODEL code governs. NFPA 1 / NFPA 101 are fire codes some states adopt in place
 *  of the IFC (FL, MA, ME, MD, IL) — a different numbering, so never cited as the IFC. */
const MODEL_FAMILY: Readonly<Record<string, CodeFamily>> = {
  IRC: "residential", IBC: "building", IEBC: "building", NEC: "electrical", IFC: "fire",
  NFPA1: "fire", NFPA101: "fire", IECC: "energy", IMC: "mechanical", UMC: "mechanical",
  IFGC: "mechanical", IPC: "plumbing", UPC: "plumbing", NSPC: "plumbing",
};

/** State codes built on a model code that designCriteria's STATE_CODE_BASE does not (yet) list.
 *  Only a code whose base the state itself publishes. */
const EXTRA_STATE_CODE_BASE: Readonly<Record<string, string>> = {
  // Oregon specialty codes beyond ORSC/OSSC/OESC/OFC.
  OMSC: "IMC", OPSC: "UPC",
  // California Title 24 parts.
  CMC: "UMC", CPC: "UPC",
  // Michigan, Ohio, North Carolina, Virginia, New York, Florida volumes, Colorado.
  MRC: "IRC", MBC: "IBC", MMC: "IMC", MPC: "IPC",
  RCO: "IRC", OBC: "IBC", OMC: "IMC", OPC: "IPC",
  NCRC: "IRC", NCBC: "IBC", NCFC: "IFC",
  VRC: "IRC", VCC: "IBC", USBC: "IBC", SFPC: "IFC",
  MCNYS: "IMC", PCNYS: "IPC", ECCCNYS: "IECC",
  "FBC-E": "IECC", "FBC-M": "IMC", "FBC-P": "IPC", FFPC: "NFPA1",
  MLECC: "IECC",
};

/** State codes that name a family but are not built on one model code. */
const EXTRA_STATE_CODE_FAMILY: Readonly<Record<string, CodeFamily>> = {
  OEESC: "energy", "T24-P6": "energy", WSEC: "energy", "WSEC-R": "energy", "WSEC-C": "energy",
  ILPC: "plumbing", "UCC-E": "electrical",
  "527CMR12": "electrical", "527CMR1200": "electrical", "527CMR1": "fire", "527CMR100": "fire",
};

// The FIRST model code a basis sentence names: "2024 IBC (with IFC and IEBC provisions)" is the IBC.
const MODEL_IN_TEXT: Array<[RegExp, string]> = [
  [/\bNFPA\s*70\b/i, "NEC"],
  [/\bNFPA\s*101\b/i, "NFPA101"],
  [/\bNFPA\s*1\b(?![0-9])/i, "NFPA1"],
  [/\bNational\s+Electrical\s+Code\b/i, "NEC"],
  [/\bNational\s+Standard\s+Plumbing\s+Code\b/i, "NSPC"],
  [/\bInternational\s+Residential\s+Code\b/i, "IRC"],
  [/\bInternational\s+Building\s+Code\b/i, "IBC"],
  [/\bInternational\s+Fire\s+Code\b/i, "IFC"],
  [/\bInternational\s+Energy\s+Conservation\s+Code\b/i, "IECC"],
  [/\bInternational\s+Mechanical\s+Code\b/i, "IMC"],
  [/\bInternational\s+Plumbing\s+Code\b/i, "IPC"],
  [/\bUniform\s+Plumbing\s+Code\b/i, "UPC"],
  [/\bUniform\s+Mechanical\s+Code\b/i, "UMC"],
  [/\b(IRC|IBC|IEBC|IFC|IECC|IMC|IPC|UPC|UMC|IFGC|NEC)\b/, ""],
];

/** The model code a basis sentence ("2021 IRC", "2023 NFPA 70", "2024 IMC and 2024 IFGC") names first. */
export function modelCodeInText(text: string | undefined): string | undefined {
  const s = String(text || "");
  if (!s.trim()) return undefined;
  let best: { at: number; code: string } | null = null;
  for (const [re, code] of MODEL_IN_TEXT) {
    const m = s.match(re);
    if (!m || m.index === undefined) continue;
    const found = code || m[1].toUpperCase();
    if (!best || m.index < best.at) best = { at: m.index, code: found };
  }
  return best?.code;
}

function tokenOf(code: string): string {
  return normCodeToken(String(code || "")).replace(/\s+/g, "");
}

/** The model code an adopted entry is built on: its stated basis first, else the state-code maps. */
export function modelBaseOf(entry: Pick<CodeEdition, "code"> & Partial<Pick<CodeEdition, "basedOn">>): string | undefined {
  const fromBasis = modelCodeInText(entry.basedOn);
  if (fromBasis) return fromBasis;
  const token = tokenOf(entry.code);
  return baseModelCode(entry.code) ?? EXTRA_STATE_CODE_BASE[token] ?? (MODEL_FAMILY[token] ? token : undefined);
}

// Last resort: the family a code's own NAME says ("Idaho State Plumbing Code", "780 CMR … Residential").
const FAMILY_WORDS: Array<[RegExp, CodeFamily]> = [
  [/\bresiden(?:tial|ce)\b|\bdwelling/i, "residential"],
  [/\belectric/i, "electrical"],
  [/\bfire\b/i, "fire"],
  [/\benergy\b/i, "energy"],
  [/\bmechanical\b|\bfuel\s+gas\b/i, "mechanical"],
  [/\bplumbing\b/i, "plumbing"],
  [/\bbuilding\b|\bstructural\b|\bconstruction\s+code\b/i, "building"],
];

/** WHICH FAMILY an adopted entry governs. An explicit `family` wins; then the model code it is built
 *  on (basedOn, then the code token through designCriteria's map and the extras here); then a
 *  family-only state code; then the words of its code/title. Undefined = not decidable. */
export function codeFamilyOf(entry: string | (Pick<CodeEdition, "code"> & Partial<Pick<CodeEdition, "family" | "basedOn" | "title">>)): CodeFamily | undefined {
  const e = typeof entry === "string" ? { code: entry } : entry;
  if (isCodeFamily((e as { family?: unknown }).family)) return (e as { family: CodeFamily }).family;
  const model = modelBaseOf(e);
  if (model && MODEL_FAMILY[model]) return MODEL_FAMILY[model];
  const token = tokenOf(e.code);
  if (EXTRA_STATE_CODE_FAMILY[token]) return EXTRA_STATE_CODE_FAMILY[token];
  const words = `${e.code || ""} ${(e as { title?: string }).title || ""}`;
  for (const [re, fam] of FAMILY_WORDS) if (re.test(words)) return fam;
  return undefined;
}

/** The adoption model a state applies to ONE family: byFamily, else the overall model unless "mixed". */
export function familyAdoptionModel(model: JurisdictionAdoptionModel | null | undefined, family: CodeFamily): CodeFamilyAdoptionModel | undefined {
  if (!model) return undefined;
  const per = model.byFamily?.[family];
  if (isFamilyAdoptionModel(per)) return per;
  return isFamilyAdoptionModel(model.model) ? model.model : undefined;
}

/** The families a state leaves to its cities/counties (what an AHJ-layer research is for). */
export function locallyAdoptedFamilies(model: JurisdictionAdoptionModel | null | undefined): CodeFamily[] {
  return CODE_FAMILIES.filter((f) => familyAdoptionModel(model, f) === "local_adoption");
}

// --- Editions over time -------------------------------------------------------------------

export interface EditionsInEffect {
  family: CodeFamily;
  /**
   *  in_effect         — one edition applies on the date.
   *  phase_in          — the new edition took effect and the previous one is still allowed.
   *  previous_in_effect— the recorded edition is not effective yet; the one it replaces applies.
   *  undated           — an edition is on file with no effective date: it is the recorded one,
   *                      but nothing says WHEN it took effect (never read as "confirmed current").
   *  unknown           — nothing on file for this family, or the recorded edition is not yet
   *                      effective and its predecessor is not recorded.
   */
  status: "in_effect" | "phase_in" | "previous_in_effect" | "undated" | "unknown";
  allowed: Array<{ code: string; edition: string; role: "current" | "previous" }>;
  note: string;
}

const isoDay = (v: string | undefined): string => (/^\d{4}-\d{2}-\d{2}/.test(String(v || "")) ? String(v).slice(0, 10) : "");

/**
 * WHICH EDITION(S) OF A FAMILY APPLY ON DATE D — the one helper every caller asks.
 * A phase-in (effective <= D < mandatory, previous edition recorded) allows BOTH editions: a plan
 * stamped to the previous one is not wrong during the window.
 */
export function editionsInEffect(entries: CodeEdition[], family: CodeFamily, date: string): EditionsInEffect {
  const d = isoDay(date) || new Date().toISOString().slice(0, 10);
  const mine = entries.filter((e) => codeFamilyOf(e) === family && String(e.edition || "").trim());
  if (!mine.length) return { family, status: "unknown", allowed: [], note: `No ${family} edition on file.` };
  // The newest-effective entry that has taken effect on D; else the earliest future one.
  const dated = mine.filter((e) => isoDay(e.effectiveDate));
  const effective = dated.filter((e) => isoDay(e.effectiveDate) <= d).sort((a, b) => isoDay(b.effectiveDate).localeCompare(isoDay(a.effectiveDate)));
  const current = effective[0];
  if (current) {
    const mandatory = isoDay(current.mandatoryDate);
    const prev = String(current.previousEdition || "").trim();
    if (mandatory && d < mandatory && prev) {
      return {
        family, status: "phase_in",
        allowed: [{ code: current.code, edition: current.edition, role: "current" }, { code: current.code, edition: prev, role: "previous" }],
        note: `${current.code} ${current.edition} took effect ${isoDay(current.effectiveDate)}; ${current.code} ${prev} is still allowed until ${mandatory}.`,
      };
    }
    return { family, status: "in_effect", allowed: [{ code: current.code, edition: current.edition, role: "current" }], note: `${current.code} ${current.edition} in effect since ${isoDay(current.effectiveDate)}.` };
  }
  const future = dated.sort((a, b) => isoDay(a.effectiveDate).localeCompare(isoDay(b.effectiveDate)))[0];
  if (future) {
    const prev = String(future.previousEdition || "").trim();
    return prev
      ? { family, status: "previous_in_effect", allowed: [{ code: future.code, edition: prev, role: "previous" }], note: `${future.code} ${future.edition} takes effect ${isoDay(future.effectiveDate)}; ${future.code} ${prev} applies until then.` }
      : { family, status: "unknown", allowed: [], note: `${future.code} ${future.edition} takes effect ${isoDay(future.effectiveDate)}; the edition in effect before it is not on file.` };
  }
  const undated = mine[0];
  return { family, status: "undated", allowed: [{ code: undated.code, edition: undated.edition, role: "current" }], note: `${undated.code} ${undated.edition} is on file with no effective date.` };
}

/** Announced editions whose anticipated date has passed on `asOf` AND after the row was last
 *  researched (`researchedAt`): the row may be describing a code that has since changed. An upcoming
 *  edition the last research already saw past its date is NOT due again (no re-research loop). */
export function upcomingDue(upcoming: UpcomingCodeEdition[] | undefined, researchedAt: string | undefined, asOf: string): UpcomingCodeEdition[] {
  const now = isoDay(asOf) || new Date().toISOString().slice(0, 10);
  const last = isoDay(researchedAt);
  return (upcoming ?? []).filter((u) => {
    const when = isoDay(u.anticipatedDate);
    return !!when && when <= now && (!last || last < when);
  });
}

/** "OFC 2025 (2024 IFC)" — a compact label for proposals and reports. */
export function editionLabel(e: Pick<CodeEdition, "code" | "edition"> & Partial<Pick<CodeEdition, "basedOn">>): string {
  return `${e.code} ${e.edition}${e.basedOn ? ` (${e.basedOn})` : ""}`.trim();
}
