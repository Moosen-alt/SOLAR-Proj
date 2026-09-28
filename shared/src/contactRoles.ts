// ONE CONTACT, ONE IDENTITY.
//
// A portal contact block (an Accela "Contact Information" dialog, a PowerClerk contact card) is
// ONE person or company. Every name / business / address / email / phone box in it answers for the
// SAME identity — the one its SECTION names. Live City of Corvallis electrical learn, 2026-09-28:
// the Applicant dialog came out as the HOMEOWNER's full name, mailing address and e-mail beside
// the COMPANY's business name and office phone. The same portal's building recipe (learned an hour
// earlier, operator-approved) binds that dialog to the installer's keys, every box.
//
// One set of predicates, asked by the learner's contact pass and its dialog guard (portal-bot
// autoLearnAdapter), the section-email pass (same file), and the replay binder
// (backend recipeReplayBinding R10), so the three cannot disagree about which identity a section
// names or which key a box takes.
//
//   contactSectionRole(heading)   which identity a SECTION HEADING names (company / owner / none)
//   isOptionalExtraSection(text)  "Optional additional inspection contact." — left empty
//   planContactSections(...)      heading order, never position: which section gets which identity
//   contactFieldKind(label)       which part of an identity a box asks for (name, business, …)
//   contactKeyFor(role, kind)     the recipe key that box binds to for that identity
//   contactKeyRole(key)           the identity + kind a recipe key belongs to (both directions)

export type ContactRole = "company" | "owner";

export type ContactFieldKind =
  | "fullName" | "firstName" | "lastName" | "business"
  | "street" | "city" | "state" | "zip" | "email" | "phone";

/** Whose track a filing is on. On a PERMIT portal "Applicant" is the filing company (the operator's
 *  Accela recipes, and every Oregon ePermitting walk); on a utility interconnection "applicant" is
 *  the customer, as fillSectionEmails has always read it. */
export type ContactTrack = "permit" | "nem";

function norm(text: string | null | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").replace(/[*:]+/g, " ").trim().toLowerCase();
}

// Word-anchored on purpose (filter lists fail both ways): "owner" must not fire inside "business
// owner"'s neighbours by accident, "contractor" must not read "subcontractor agreement" as a
// section, and every term is tested MUST-PASS and MUST-EXCLUDE (contactIdentity.test).
const COMPANY_SECTION = /\b(?:contractors?|licensed professionals?|installers?|permit applicant|inspection contacts?|contractor contact|preparer)\b/;
const APPLICANT = /\bapplicants?\b/;
const OWNER_SECTION = /\b(?:property owners?|home ?owners?|owners?|site contacts?|on[- ]site contact|customers?|account holders?|generation system owner)\b/;
// A heading that names no one's identity, whatever else it says.
const NOT_A_PARTY = /\b(?:billing|emergency|designer|engineer|tenant|property manager|interested party|complainant|city staff)\b/;

/** WHICH IDENTITY DOES THIS SECTION HEADING NAME? null when it names none, or names BOTH
 *  ("Owner/Applicant", "Applicant or Owner") — a block that could be either is never guessed. */
export function contactSectionRole(heading: string | null | undefined, opts: { track?: ContactTrack } = {}): ContactRole | null {
  const h = norm(heading);
  if (!h) return null;
  if (NOT_A_PARTY.test(h)) return null;
  const track = opts.track ?? "permit";
  const company = COMPANY_SECTION.test(h) || (track === "permit" && APPLICANT.test(h));
  const owner = OWNER_SECTION.test(h) || (track === "nem" && APPLICANT.test(h));
  if (company && owner) return null;
  if (company) return "company";
  if (owner) return "owner";
  return null;
}

/** "Optional additional inspection contact." A section the portal itself calls OPTIONAL is left
 *  empty — the building learn left Corvallis's second Inspection Contact empty and the operator
 *  approved it. Anchored on "optional": the APPLICANT section's own instruction says "To add
 *  additional contacts, please call or email us", which is not an optional section. */
export function isOptionalExtraSection(text: string | null | undefined): boolean {
  return /\boptional\b/.test(norm(text));
}

export interface ContactSectionOnPage {
  /** The section's heading ("Applicant", "Inspection Contact", "Licensed Professional"). */
  heading: string;
  /** The section's instruction text (for "Optional additional …"). */
  text?: string;
  /** The section offers an Add New control (a Look Up section does not). */
  canAdd?: boolean;
}

export interface ContactSectionPlan {
  index: number;
  heading: string;
  role: ContactRole | null;
  why: string;
}

/** WHICH SECTION GETS WHICH IDENTITY — by HEADING, never by position. Corvallis Step 4 prints
 *  Licensed Professional (a CCB look-up), Inspection Contact, and a second, optional Inspection
 *  Contact: position 0/1 would have put the company in the look-up and the HOMEOWNER in the
 *  optional box. A heading that names no identity, an optional section, a repeat of a heading
 *  already planned, and a section with no Add New are all left alone, each with its reason. */
export function planContactSections(sections: ContactSectionOnPage[], opts: { track?: ContactTrack } = {}): ContactSectionPlan[] {
  const seen = new Set<string>();
  return sections.map((s, index) => {
    const heading = String(s.heading ?? "").replace(/\s+/g, " ").trim();
    const key = norm(heading);
    const role = contactSectionRole(heading, opts);
    if (!role) return { index, heading, role: null, why: heading ? "the heading names no identity" : "no heading found" };
    if (isOptionalExtraSection(s.text) || isOptionalExtraSection(heading)) return { index, heading, role: null, why: "the portal calls this section optional — left empty" };
    if (seen.has(key)) return { index, heading, role: null, why: "a repeat of a section already filled — left empty" };
    if (s.canAdd === false) return { index, heading, role: null, why: "no Add New control (a look-up section)" };
    seen.add(key);
    return { index, heading, role, why: role === "company" ? "the filing company" : "the property owner" };
  });
}

/** WHICH PART OF AN IDENTITY DOES THIS BOX ASK FOR? null for anything else in a contact dialog
 *  ("Type:", "Title", "Fax", "Address Line 2"). */
export function contactFieldKind(label: string | null | undefined): ContactFieldKind | null {
  const l = norm(label).replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  if (!l) return null;
  if (/\bfax\b/.test(l)) return null;
  if (/\bfirst\s*name\b|\bgiven name\b/.test(l)) return "firstName";
  if (/\blast\s*name\b|\bsurname\b|\bfamily name\b/.test(l)) return "lastName";
  if (/\bname of (?:business|company|organi[sz]ation|firm)\b|\b(?:business|company|organi[sz]ation|firm)(?: name)?\b|\bdba\b/.test(l)) return "business";
  if (/\be-?mail\b/.test(l)) return "email";
  if (/\b(?:phone|telephone|mobile|cell)\b/.test(l)) return "phone";
  if (/\b(?:zip|postal)\b/.test(l)) return "zip";
  if (/^state\b|\bstate\s*\/\s*province\b/.test(l)) return "state";
  if (/^city\b|\bcity\s*\/\s*town\b/.test(l)) return "city";
  if (/\b(?:address )?line ?2\b|\bapt\b|\bsuite\b|\bunit\b/.test(l)) return null;
  // A SPLIT street (the work-location search: "Street No.", "Street Name") is not a contact box.
  if (/\bstreet\s*(?:no\b|num|#|name|type|suffix|dir)/.test(l)) return null;
  if (/\bmailing address\b|\bstreet(?: address)?\b|^address(?: line)?(?: ?1)?\b|\baddress line ?1\b/.test(l)) return "street";
  if (/\bfull name\b|^name$|\bcontact name\b|\bapplicant name\b|\bowner name\b|\bcontact person\b/.test(l)) return "fullName";
  return null;
}

/** The recipe key each part of each identity binds to — the keys resolveRecipeFieldValues
 *  defines (clients.clientStagingOverlay for the company; the project's own for the owner, whose
 *  mailing address is the installation address when none is on file — operator ruling 2026-09-27). */
export const CONTACT_KEYS: Record<ContactRole, Record<ContactFieldKind, string | null>> = {
  company: {
    fullName: "installerContactName", firstName: "installerFirstName", lastName: "installerLastName",
    business: "installerCompanyName", street: "installerStreet", city: "installerCity", state: "installerState",
    zip: "installerZip", email: "installerEmail", phone: "installerPhone",
  },
  owner: {
    fullName: "homeownerName", firstName: "homeownerFirstName", lastName: "homeownerLastName",
    // A homeowner has no business name: an Owner block's business box stays blank.
    business: null, street: "street", city: "city", state: "state", zip: "zip",
    email: "homeownerEmail", phone: "homeownerPhone",
  },
};

export function contactKeyFor(role: ContactRole, kind: ContactFieldKind): string | null {
  return CONTACT_KEYS[role][kind];
}

// Keys a planner or an older recipe binds identity boxes to beyond the canonical ones.
const KEY_ALIASES: Record<string, { role: ContactRole; kind: ContactFieldKind }> = {
  installerAddress: { role: "company", kind: "street" },
  installerStreetName: { role: "company", kind: "street" },
  projectName: { role: "owner", kind: "fullName" },
  ownerEmail: { role: "owner", kind: "email" },
  ownerPhone: { role: "owner", kind: "phone" },
  projectAddress: { role: "owner", kind: "street" },
  ubAccountHolder: { role: "owner", kind: "fullName" },
  ubAccountHolderFirstName: { role: "owner", kind: "firstName" },
  ubAccountHolderLastName: { role: "owner", kind: "lastName" },
  ubAccountHolderEmail: { role: "owner", kind: "email" },
  ubAccountHolderPhone: { role: "owner", kind: "phone" },
};

/** Which identity (and which part of it) a recipe key belongs to — the canonical keys, the phone
 *  segment keys (installerPhoneArea / …Prefix / …Line), and the aliases above. null for any key
 *  that is not a contact identity's (a licence number, a fee box, the valuation). */
export function contactKeyRole(key: string | null | undefined): { role: ContactRole; kind: ContactFieldKind; segment: string } | null {
  const k = String(key ?? "").trim();
  if (!k) return null;
  const seg = /^(.*Phone)(Area|Prefix|Line)$/.exec(k);
  const base = seg ? seg[1] : k;
  const segment = seg ? seg[2] : "";
  for (const role of ["company", "owner"] as ContactRole[]) {
    for (const [kind, key2] of Object.entries(CONTACT_KEYS[role]) as Array<[ContactFieldKind, string | null]>) {
      if (key2 && key2 === base) return { role, kind, segment };
    }
  }
  const alias = KEY_ALIASES[base];
  return alias ? { ...alias, segment } : null;
}

/** The key a box bound to `key` takes in a block that belongs to `role` — itself when it already
 *  belongs to that identity; the other identity's matching key when it does not (phone segments
 *  keep their segment); null when that identity has no such part (an Owner block's business
 *  name). Undefined when `key` is not an identity key at all (leave the step alone). */
export function contactKeyForRole(key: string | null | undefined, role: ContactRole): string | null | undefined {
  const owned = contactKeyRole(key);
  if (!owned) return undefined;
  if (owned.role === role) return String(key);
  const counterpart = CONTACT_KEYS[role][owned.kind];
  if (!counterpart) return null;
  return owned.segment && owned.kind === "phone" ? `${counterpart}${owned.segment}` : counterpart;
}

/** The role a recorded step's own words say its contact block belongs to: the learner's
 *  "[applicant]" / "[site contact]" note marks and "contact(applicant): …" notes, then an ACA
 *  section control id ("…_Applicant_9479Edit_btnAddNew"), then the recorded section heading. null
 *  when nothing says. */
export function contactRoleOfStep(step: {
  note?: string; selector?: { css?: string; name?: string; label?: string; text?: string; fallbacks?: Array<{ css?: string }> };
  fingerprint?: { id?: string; section?: string };
}, opts: { track?: ContactTrack } = {}): ContactRole | null {
  const note = String(step.note ?? "");
  const mark = /(?:\[|contact\()\s*(applicant|contractor|company|licensed professional|inspection contact|site contact|owner|property owner|homeowner)\s*(?:\]|\))/i.exec(note);
  if (mark) return contactSectionRole(mark[1], opts);
  const ids = [step.fingerprint?.id, step.selector?.css, ...(step.selector?.fallbacks ?? []).map((f) => f.css)].map((v) => String(v ?? ""));
  for (const id of ids) {
    const m = /PlaceHolderMain_([A-Za-z]+?)(?:\d+)?_\w*?Edit_/.exec(id);
    if (!m) continue;
    const r = contactSectionRole(m[1].replace(/([a-z])([A-Z])/g, "$1 $2"), opts);
    if (r) return r;
  }
  return contactSectionRole(step.fingerprint?.section, opts);
}
