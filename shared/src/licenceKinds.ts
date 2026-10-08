// ---------------------------------------------------------------------------------------------
// WHAT A LICENCE IS — THE ONE VOCABULARY.
//
// A solar company files in several states, and a state issues it several licences: Massachusetts
// alone prints a Construction Supervisor licence, a Home Improvement Contractor registration and an
// Electrical Contractor licence on one company's applications. A number without its KIND cannot be
// put in the right slot — "the first licence on file for the state" put a construction-supervisor
// number wherever a form asked for any licence. Every reader (the form fill, the portal overlay,
// the submit gate, the dashboard editor) speaks this list; clients.licenceFor is the one answer.
//
// The dashboard (frontend/dashboard.js LICENCE_KIND_OPTIONS) carries a copy of the kinds + labels
// because it is vanilla JS; backend/test/licencesByType.test.ts fails when the two drift.
// ---------------------------------------------------------------------------------------------
import type { LicenceKind } from "./types";

export interface LicenceKindInfo {
  kind: LicenceKind;
  /** What the operator sees in the Clients editor. */
  label: string;
  /** A PERSON's licence (it carries a holder's name), not the company's. */
  person: boolean;
  /** May a contractor-licence slot take it? business_registration is never one. */
  contractorLicence: boolean;
}

export const LICENCE_KINDS: readonly LicenceKindInfo[] = [
  { kind: "contractor", label: "Contractor (general / building / residential)", person: false, contractorLicence: true },
  { kind: "electrical_contractor", label: "Electrical contractor", person: false, contractorLicence: true },
  { kind: "construction_supervisor", label: "Construction supervisor", person: true, contractorLicence: true },
  { kind: "home_improvement_contractor", label: "Home improvement contractor", person: false, contractorLicence: true },
  { kind: "solar_contractor", label: "Solar contractor", person: false, contractorLicence: true },
  { kind: "master_electrician", label: "Master / supervising electrician", person: true, contractorLicence: false },
  { kind: "business_registration", label: "Business registration (not a contractor licence)", person: false, contractorLicence: false },
] as const;

export const LICENCE_KIND_SET: ReadonlySet<string> = new Set(LICENCE_KINDS.map((k) => k.kind));

/** EACH STATE'S CONTRACTOR-LICENCE BOARD LABEL — the one label table (#208). Oregon's is the CCB;
 *  the dashboard and /parser read frontend/parser-review.js LICENSE_LABELS, a copy of this table
 *  (vanilla JS), and backend/test/clientLicenceLabel.test.ts fails when the two drift. */
export const LICENCE_BOARD_LABELS: Readonly<Record<string, string>> = {
  OR: "CCB", WA: "L&I contractor registration", CA: "CSLB", AZ: "ROC", TX: "TDLR/TECL", MA: "HIC", PA: "HIC",
  NV: "NSCB", FL: "DBPR/CVC", UT: "DOPL", NJ: "HIC", CT: "HIC", NM: "CID", HI: "DCCA", MD: "MHIC", VA: "DPOR",
  NC: "NCLBGC", SC: "LLR", MN: "DLI", ID: "PWC registration", MT: "contractor registration",
};

/** A state's CONTRACTOR licence label: the state's board ("CCB" for Oregon, "DOPL" for Utah); a known
 *  state with no board label "<ST> contractor licence"; an unknown state the generic "contractor
 *  licence" — never Oregon's. */
export function contractorLicenceLabel(state: string | null | undefined): string {
  const st = String(state ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) return "contractor licence";
  return LICENCE_BOARD_LABELS[st] || `${st} contractor licence`;
}

/** Short words for messages ("construction supervisor licence"). */
export function licenceKindWords(kind: LicenceKind | ""): string {
  switch (kind) {
    case "contractor": return "contractor licence";
    case "electrical_contractor": return "electrical contractor licence";
    case "construction_supervisor": return "construction supervisor licence";
    case "home_improvement_contractor": return "home improvement contractor registration";
    case "solar_contractor": return "solar contractor licence";
    case "master_electrician": return "master / supervising electrician licence";
    case "business_registration": return "business registration";
    default: return "licence";
  }
}

/**
 * WHAT A SLOT ASKS FOR, read from its PRINTED caption (or, with no caption, its name): a licence
 * kind when the slot names one ("Licensed Construction Supervisor", "HIC Registration Number",
 * "Electrical License no", "Supervising Electrician License no", "CCB License no"); "generic" for a
 * licence slot that does not say which ("License Number", "Contractor License #", "Registration
 * Number"); null when the text is not about a licence at all. The person licences and the named
 * registrations are read before the bare "electrical" / "contractor" words inside them.
 */
export function kindForSlot(text: string | undefined | null): LicenceKind | "generic" | null {
  const t = String(text ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_]+/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;
  // "CS License No." is the construction supervisor's (canonicalLicenceKind reads "CS" that way too).
  if (/construction\s+supervisor|\bcsl\b|\bcs\s*(?:licen[cs]e|lic\b|#|no\b|number)/.test(t)) return "construction_supervisor";
  if (/home\s+improvement|\bhic\b/.test(t)) return "home_improvement_contractor";
  // A supervising / master electrician is a PERSON's licence — "Electrical Supervisor" included.
  if (/\belectrician\b|\belectrical\s+supervisor\b|\bsupervising\s+electric/.test(t)) return "master_electrician";
  // THE CCB NAMES ITS LICENCE OUTRIGHT (Oregon's Construction Contractors Board — the contractor
  // licence), read BEFORE the trade words: an "Electrical Contractor CCB #" box asks for the electrical
  // contractor's CCB number, never the BCD electrical licence.
  if (/\bccb\b/.test(t)) return "contractor";
  if (/business\s+(licen[cs]e|lic\b|registration)|secretary\s+of\s+state|\bubi\b/.test(t)) return "business_registration";
  // TECL = Texas Electrical Contractor Licence.
  if (/\belectrical\b.*\b(licen[cs]e|lic|contractor|registration|no|number)\b|\belectrical\s+contractor|\belec\b\.?\s*lic|\bec\s*(licen[cs]e|lic|#|no\b|number)|\btecl\b/.test(t)) return "electrical_contractor";
  if (/\bsolar\b.*\b(contractor|licen[cs]e|lic)\b|\bpv\s+contractor/.test(t)) return "solar_contractor";
  // CSLB = California's Contractors State License Board licence (the contractor's).
  if (/\bccb\b|\bcslb\b|general\s+contractor|building\s+contractor|residential\s+(building\s+)?contractor|construction\s+contractor/.test(t)) return "contractor";
  // SHORT LABELS NAME A LICENCE TOO (licences skeptic L1): "ROC #" (Arizona's Registrar of Contractors
  // issues both the contractor and the electrical classes — generic), "Reg. No.", "Lic. No.".
  if (/licen[cs]e|\blic\b|registration\s*(number|no\b|#)|\breg\b\.?\s*(#|no\b|number)|contractor\s*(#|no\b|number)|\broc\b/.test(t)) return "generic";
  return null;
}

// ---------------------------------------------------------------------------------------------
// WHICH FILING-VALUE KEY CARRIES WHICH KIND (licences skeptic L1/L2/L3). The portal overlay
// (clients.licenceOverlay) answers one number key and one expiry key per kind it carries, plus the
// GENERIC pair (ccbLicenseNumber / ccbExpiration: "the contractor licence THIS filing takes" — the
// CCB on an Oregon job, elsewhere the licence the permit's track takes). The binder (learn), the
// replay binding (R9) and the replay adapter all read a step's label kind against these maps — one
// predicate (kindForSlot), the forms' "caption decides" rule on the portal side.
// ---------------------------------------------------------------------------------------------
export const GENERIC_LICENCE_NUMBER_KEY = "ccbLicenseNumber";
export const GENERIC_LICENCE_EXPIRY_KEY = "ccbExpiration";
export const LICENCE_NUMBER_KEY_BY_KIND: Readonly<Partial<Record<LicenceKind, string>>> = {
  contractor: "contractorLicenseNumber",
  electrical_contractor: "electricalLicenseNumber",
  construction_supervisor: "constructionSupervisorLicenseNumber",
  home_improvement_contractor: "homeImprovementLicenseNumber",
  master_electrician: "electricianLicenseNumber",
};
export const LICENCE_EXPIRY_KEY_BY_KIND: Readonly<Partial<Record<LicenceKind, string>>> = {
  contractor: "contractorLicenseExpiration",
  electrical_contractor: "electricalLicenseExpiration",
  construction_supervisor: "constructionSupervisorLicenseExpiration",
  home_improvement_contractor: "homeImprovementLicenseExpiration",
  master_electrician: "electricianLicenseExpiration",
};

/** A licence NUMBER or EXPIRY key and the kind it carries ("generic" for the ccb pair); null for any
 *  other key (a holder's NAME — electricalSupervisorName — is not a licence number). */
export function licenceKeyInfo(key: string | null | undefined): { kind: LicenceKind | "generic"; expiry: boolean } | null {
  const k = String(key ?? "");
  if (k === GENERIC_LICENCE_NUMBER_KEY) return { kind: "generic", expiry: false };
  if (k === GENERIC_LICENCE_EXPIRY_KEY) return { kind: "generic", expiry: true };
  for (const [kind, key2] of Object.entries(LICENCE_NUMBER_KEY_BY_KIND)) if (key2 === k) return { kind: kind as LicenceKind, expiry: false };
  for (const [kind, key2] of Object.entries(LICENCE_EXPIRY_KEY_BY_KIND)) if (key2 === k) return { kind: kind as LicenceKind, expiry: true };
  return null;
}

/** The key a label of `kind` reads (number or expiry); a CCB-named label keeps the generic pair (on
 *  an Oregon job it IS the CCB). null when the kind has no key (solar, business registration). */
export function licenceKeyForKind(kind: LicenceKind, expiry: boolean, label: string): string | null {
  if (kind === "contractor" && /\bccb\b/i.test(label)) return expiry ? GENERIC_LICENCE_EXPIRY_KEY : GENERIC_LICENCE_NUMBER_KEY;
  return (expiry ? LICENCE_EXPIRY_KEY_BY_KIND : LICENCE_NUMBER_KEY_BY_KIND)[kind] ?? null;
}

/**
 * AT REPLAY: a step bound to a licence key whose LABEL names a different licence kind reads the
 * label kind's key for THIS job — never another kind's number ("CSL Number" bound to the generic
 * ccbLicenseNumber typed the electrical contractor's number on an electrical filing). Returns null
 * when there is nothing to decide (not a licence key; the label names no kind or a generic licence;
 * the kinds agree), else `{ key }` — null key = the label's kind has no key: blank, for a person.
 */
export function licenceKeyForLabel(boundKey: string | null | undefined, label: string | null | undefined): { key: string | null; labelKind: LicenceKind } | null {
  const info = licenceKeyInfo(boundKey);
  if (!info) return null;
  const labelKind = kindForSlot(label);
  if (!labelKind || labelKind === "generic") return null;
  const key = licenceKeyForKind(labelKind, info.expiry, String(label ?? ""));
  if (key === boundKey) return null;
  return { key, labelKind };
}

/**
 * A stored or typed kind, as the canonical kind — "" when it names none. Free text an operator (or
 * an older import) typed: "EC", "Electrical", "CSL", "HIC", "general contractor", "home_improvement".
 * Order matters: the person licences and the named registrations are read before the bare
 * "electrical" / "contractor" words that also appear inside them.
 */
export function canonicalLicenceKind(raw: string | undefined | null): LicenceKind | "" {
  const t = ` ${String(raw ?? "").toLowerCase().replace(/[_\-/]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (!t.trim()) return "";
  if (LICENCE_KIND_SET.has(t.trim().replace(/ /g, "_"))) return t.trim().replace(/ /g, "_") as LicenceKind;
  if (/ (business|secretary of state|sos|ubi) /.test(t) && !/ contractor /.test(t)) return "business_registration";
  if (/ (construction supervisor|csl|cs) /.test(t)) return "construction_supervisor";
  if (/ (home improvement|hic) /.test(t)) return "home_improvement_contractor";
  // A person's electrician licence (master / supervising / plain "electrician", an "electrical
  // supervisor") — the same reading kindForSlot makes of a slot.
  if (/ electrician /.test(t) || / master /.test(t) || / electrical supervisor /.test(t) || / supervising electric/.test(t)) return "master_electrician";
  if (/ (electrical|electric|elec|ec|ecl|tecl|el) /.test(t)) return "electrical_contractor";
  if (/ (solar|pv|cvc) /.test(t)) return "solar_contractor";
  if (/ (contractor|general|gc|building|builder|residential|ccb|construction) /.test(t)) return "contractor";
  return "";
}
