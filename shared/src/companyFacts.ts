// A COMPANY'S FACTS NEVER TRAVEL IN A SHARED RECIPE (leak sweep 2026-09-28, company-leak-3 / -6).
//
// Recipes are shared across every company and org. A literal the learn run recorded under a
// company-identity label — the installer's insurer, bond, HIC/CSL/CCB registration, website, the
// contractor's street — or a closed-vocabulary company ATTESTATION (the workers'-comp exemption
// "I am a sole proprietor with no employees", "a liability insurance policy", "I'm a contractor",
// one company's licence option) is that company's answer, and replayed on another company's job it
// is a wrong value or a false sworn statement. One set of predicates, asked by the replay guard
// (portal-bot recipeAdapter.looksLikeProjectData), the save-time guard (portalRecipes
// savePortalRecipeSteps) and the replay binder (recipeReplayBinding R8).
import { labelWords } from "./portalSafety";
import { kindForSlot } from "./licenceKinds";

/** A label naming a fact about the INSTALLER COMPANY (read after splitting control ids into words:
 *  "WCStrNum" -> "WC Str Num"). */
export const COMPANY_IDENTITY_LABEL = /\b(?:insur\w*|polic(?:y|ies)|bond(?:ed|ing|s)?|surety|workers?'?\s*comp\w*|registr\w*|hic|csl|ccb|ubi|licen[cs]\w*|title|web\s*site|website|supervis\w*|master|journeyman|contractor|installer|company|business|firm|ein|tax\s*id|str?\s+(?:num(?:ber)?|no|name|nm))\b/i;

/** Read a recorded label (or control id) as words, then ask whether it names a company fact. A
 *  LICENCE SLOT is always one — whatever the portal calls it ("CSL #", "HIC Reg #", "EC Lic",
 *  "Reg. No."): licenceKinds.kindForSlot, the one "which licence does this label name" predicate, is
 *  asked here too, so the replay guard (recipeAdapter.looksLikeProjectData) and the save-time guard
 *  (portalRecipes.withholdCompanyIdentityLiterals) give ONE answer. */
export function isCompanyIdentityLabel(label: string | null | undefined): boolean {
  const raw = String(label ?? "");
  const words = labelWords(raw);
  return COMPANY_IDENTITY_LABEL.test(words) || kindForSlot(raw) !== null || kindForSlot(words) !== null;
}

/** A company ATTESTATION a check/select answers: workers' comp, employees, sole proprietor /
 *  partnership, liability insurance / insured, licensed professional, "I am / I'm a (licensed)
 *  contractor". NOT the notices a person has authorized agreeing to ("I have read", "I agree",
 *  "I acknowledge", "I certify the information is true") — those are true for every company. */
export const COMPANY_ATTESTATION_LABEL = /workers?'?\s*comp(?:ensation)?|\bemployees?\b|sole\s+proprietor|\bpartnership\b|liability\s+insurance|\binsurance\s+(?:policy|type|coverage|carrier)|\binsured\b|licensed\s+professional|\bi\s+am\s+an?\s+(?:licensed\s+)?(?:contractor|electrician)\b|\bi'?m\s+an?\s+(?:licensed\s+)?(?:contractor|electrician)\b/i;
const LICENCE_OPTION_LABEL = /licen[cs]|registr|\bhic\b|\bcsl\b|\bccb\b/i;

export interface CompanyFactStepLike {
  action?: string;
  value?: string;
  note?: string;
  isFinalSubmit?: boolean;
  selector?: { label?: string; name?: string; text?: string } | null;
}
/** Is this closed-vocabulary step (a check / select) one company's answer about itself? A select
 *  whose chosen option carries a licence number ("ZZ Elec State ES 40404") under a licence label is
 *  one company's licence. */
export function isCompanyAttestationStep(step: CompanyFactStepLike | null | undefined): boolean {
  if (!step || step.isFinalSubmit) return false;
  if (step.action !== "check" && step.action !== "select") return false;
  const label = labelWords([step.selector?.label, step.selector?.name, step.selector?.text, step.note].filter(Boolean).join(" "));
  const value = String(step.value ?? "");
  if (COMPANY_ATTESTATION_LABEL.test(label) || COMPANY_ATTESTATION_LABEL.test(value)) return true;
  return step.action === "select" && LICENCE_OPTION_LABEL.test(label) && /\d{3,}/.test(value);
}

/** A licence / docket / registration value that is a PLACEHOLDER, not an identifier: "TEST-160001",
 *  "placeholder", "XXX-1234", "0000" (leak sweep 2026-09-28 — a client record carried a test docket
 *  that a complete recipe would have filed). Never filed; named for the operator instead. */
export function looksLikePlaceholderIdentifier(value: unknown): boolean {
  const v = String(value ?? "").trim();
  return Boolean(v) && /^test[-_ ]|placeholder|x{3,}|^0+$/i.test(v);
}
/** The filing-value keys that carry a company's licence / docket / registration IDENTIFIER (any
 *  state's: ccbLicenseNumber, electricalLicenseNumber, …LicenseNumber, docketNumber, …Registration). */
export const COMPANY_IDENTIFIER_KEY = /licen[sc]e(?:number|no)?$|^docket(?:number)?$|registration(?:number|no)?$/i;

/** An opaque stamp of the company a recorded attestation belongs to — never the client id itself
 *  (a client id can be the company's own name, and recipes are shared). "" for no client. */
export function companyFactStamp(clientId: string | null | undefined): string {
  const id = String(clientId ?? "").trim();
  if (!id) return "";
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = `company-fact:${id}`;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ text.charCodeAt(text.length - 1 - i), 0x811c9dc5);
  }
  return `cf${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}
