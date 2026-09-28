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
  if (/construction\s+supervisor|\bcsl\b/.test(t)) return "construction_supervisor";
  if (/home\s+improvement|\bhic\b/.test(t)) return "home_improvement_contractor";
  if (/\belectrician\b/.test(t)) return "master_electrician";
  if (/business\s+(licen[cs]e|lic\b|registration)|secretary\s+of\s+state|\bubi\b/.test(t)) return "business_registration";
  if (/\belectrical\b.*\b(licen[cs]e|lic|contractor|registration|no|number)\b|\belectrical\s+contractor|\belec\b\.?\s*lic|\bec\s*(licen[cs]e|lic|#|no\b|number)/.test(t)) return "electrical_contractor";
  if (/\bsolar\b.*\b(contractor|licen[cs]e|lic)\b|\bpv\s+contractor/.test(t)) return "solar_contractor";
  if (/\bccb\b|general\s+contractor|building\s+contractor|residential\s+(building\s+)?contractor|construction\s+contractor/.test(t)) return "contractor";
  if (/licen[cs]e|\blic\b|registration\s*(number|no\b|#)|\breg\s*(#|no\b)|contractor\s*(#|no\b|number)/.test(t)) return "generic";
  return null;
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
  // A person's electrician licence (master / supervising / plain "electrician").
  if (/ electrician /.test(t) || / master /.test(t)) return "master_electrician";
  if (/ (electrical|electric|elec|ec|ecl|tecl|el) /.test(t)) return "electrical_contractor";
  if (/ (solar|pv|cvc) /.test(t)) return "solar_contractor";
  if (/ (contractor|general|gc|building|builder|residential|ccb|construction) /.test(t)) return "contractor";
  return "";
}
