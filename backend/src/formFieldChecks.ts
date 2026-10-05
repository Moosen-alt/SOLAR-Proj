// ---------------------------------------------------------------------------
// WHAT A BLANK PRINTS, CHECKED AGAINST WHAT WE PUT IN IT.
//
// City of Waltham's residential application (live, 2026-09-28) came back with the homeowner's
// phone number in the agent's EMAIL box, an Oregon CCB number in the Massachusetts construction-
// supervisor licence slot, the org's signer declaring "I, ___" above the homeowner's printed name
// under the same signature, and the estimated-cost table empty. The mapper had seen only widget
// NAMES, and the names were shifted onto neighbouring boxes.
//
// These are the ONE predicates for those questions, read by both doors: the mapper's post-map
// sanitisation (ahjFormAuto) and the fill (ahjForms.fillLoadedForm). Geometry and printed text
// only — no project values, no model. Each refuses only a CLEAR case; an uncertain reading never
// blocks (it leaves the fill as it was).
// ---------------------------------------------------------------------------

import type { CaptionSide, LabelItem, WidgetCaptions, WidgetRect } from "./formTextLayer";
import type { LicenceKind } from "../../shared/src/types";
import { kindForSlot, LICENCE_KIND_SET, LICENCE_KINDS } from "../../shared/src/licenceKinds";

const PERSON_KINDS: ReadonlySet<string> = new Set(LICENCE_KINDS.filter((k) => k.person).map((k) => k.kind));

/** A form widget with where it sits and what is printed around it (inspectFormFields). */
export interface PlacedWidget {
  name: string;
  type: string;
  page?: number;
  rect?: WidgetRect;
  captions?: WidgetCaptions;
  /** THE printed caption (formTextLayer.primaryCaption) — "" when it could not be told. */
  caption?: string;
}

/** A blank the product cannot fill, named by its printed label, for the operator to complete. */
export interface OperatorItem { field?: string; label: string }

/** How a widget is named to a person: its printed caption, else its widget name. An "I, ___"
 *  blank is named by its own line ("I, ___, as Owner/Authorized Agent"); a caption that is a
 *  sentence of prose (a declaration under the box) is not a label, so the name stands.
 *
 *  A FRAGMENT caption ("#", "Approval", "Date" — at most one word) under a widget whose name says
 *  more AND contains that word ("License #"… "Zoning Board Approval", "Expiration Date") takes the
 *  name: it is the same label, longer. A name that does NOT contain the caption's word may be
 *  shifted off a neighbouring box (Waltham's "Contact Email" box is captioned "Telephone"), so the
 *  printed caption still outranks it; an auto-generated or run-on name ("Text12", a 70-character
 *  cost-row name) is never the more meaningful label. */
export function widgetLabel(w: Pick<PlacedWidget, "name" | "caption" | "captions">): string {
  if (/^i,?$/i.test(String(w.captions?.left || "").trim())) {
    const tail = String(w.captions?.right || "").trim();
    return `I, ___${tail ? `${tail.startsWith(",") ? "" : " "}${tail}` : ""}`;
  }
  const caption = String(w.caption || "").replace(/[:\s]+$/, "").trim();
  if (!caption || caption.length > 60) return w.name;
  const capWords = labelWords(caption);
  if (capWords.length <= 1 && meaningfulName(w.name)) {
    const nameWords = labelWords(w.name);
    if (nameWords.length > capWords.length && (!capWords.length || nameWords.includes(capWords[0]))) return tidyName(w.name);
  }
  return caption;
}
const LABEL_STOP = new Set(["the", "and", "of", "to", "by", "for", "text", "field", "box", "check", "undefined", "row", "fill"]);
/** The words of a label a person reads (camelCase / underscores split; no digits, no filler). */
const labelWords = (s: string): string[] =>
  String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((x) => x.length >= 2 && !LABEL_STOP.has(x));
const tidyName = (s: string): string => String(s || "").replace(/_+/g, " ").replace(/\s+/g, " ").replace(/[:\s]+$/, "").trim();
/** A widget name a person could read as a label: short, words not glued to counters ("Text12",
 *  "applicant6"), at least two real words. */
function meaningfulName(name: string): boolean {
  const t = tidyName(name);
  if (!t || t.length > 40 || /[a-z]\d|\d[a-z]/i.test(t)) return false;
  return labelWords(t).length >= 2;
}

// ---- B2: the contact-shape guard -------------------------------------------------------------

const EMAIL_WORDS = /\be-?\s?mail\b/i;
const PHONE_WORDS = /\b(?:tele)?phone\b|\btel\b|\bcell\b|\bmobile\b|\bfax\b/i;

/** "email" / "phone" when a caption or name says exactly one of them; null otherwise. */
export function contactKind(text: string | undefined): "email" | "phone" | null {
  const t = String(text || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_]+/g, " ");
  const e = EMAIL_WORDS.test(t);
  const p = PHONE_WORDS.test(t);
  return e && !p ? "email" : p && !e ? "phone" : null;
}

/** What kind of contact box a widget is: its printed caption outranks its name. */
export function widgetContactKind(w: Pick<PlacedWidget, "name" | "caption">): "email" | "phone" | null {
  return contactKind(w.caption) ?? contactKind(w.name);
}

/**
 * Refuse only the clear cross-type mismatch: an email box given a value with no "@", a phone box
 * given a value containing "@". Never a digit count — formatUsPhone passes extensions and foreign
 * numbers through on purpose, and they are real phone numbers.
 */
export function contactShapeRefusal(kind: "email" | "phone" | null, value: string): string | null {
  const v = String(value ?? "").trim();
  if (!v || !kind) return null;
  if (kind === "email" && !v.includes("@")) return "an email box, and the value mapped to it is not an email address";
  if (kind === "phone" && v.includes("@")) return "a phone box, and the value mapped to it is an email address";
  return null;
}

// ---- B7: attestations the product never makes --------------------------------------------------

/** A box that attests a document is ATTACHED / on file (a workers' compensation affidavit). The
 *  product has no workers'-comp support, so ticking it would be a false attestation. */
export function attestsAttachedDocument(text: string | undefined): boolean {
  return /workers['’]?\s*comp|\baffidavit\b/i.test(String(text || ""));
}

// ---- B3: the licence holder is not the applicant -----------------------------------------------

/** A slot naming a state LICENCE HOLDER ("Licensed Construction Supervisor", "Licence holder"). */
export function isLicenceHolderSlot(text: string | undefined): boolean {
  const t = String(text || "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return /\blicen[cs]ed\s+(?:construction\s+)?(?:supervisor|contractor|electrician|plumber|professional)\b|\blicen[cs]e\s*holder\b/i.test(t);
}

/** The licence sources a mapped slot may bind. ccbLicenseNumber is Oregon's CCB number. */
export const STATE_LICENCE_SOURCE = "client.stateContractorLicense";
export const OREGON_CCB_SOURCE = "client.ccbLicenseNumber";
/** client.stateLicence.<kind> — THIS job's state's licence of that kind (number); .expires / .holder. */
export const TYPED_LICENCE_PREFIX = "client.stateLicence.";
export const typedLicenceSource = (kind: LicenceKind, field: "number" | "expires" | "holder" = "number"): string =>
  `${TYPED_LICENCE_PREFIX}${kind}${field === "number" ? "" : `.${field}`}`;

/** What a licence source asks for: a kind (or "generic" — the licence the form's permit takes) and
 *  which part (number / expiry / holder). null for a source that is not a licence. `oregonCcb` marks
 *  client.ccbLicenseNumber / ccbExpiration, which on a form are Oregon's CCB and nothing else. */
export interface LicenceSourceRef { kind: LicenceKind | "generic"; field: "number" | "expires" | "holder"; oregonCcb?: boolean }
const NAMED_LICENCE_SOURCES: Record<string, LicenceSourceRef> = {
  [STATE_LICENCE_SOURCE]: { kind: "generic", field: "number" },
  [OREGON_CCB_SOURCE]: { kind: "contractor", field: "number", oregonCcb: true },
  "client.ccbExpiration": { kind: "contractor", field: "expires", oregonCcb: true },
  "client.electricalLicenseNumber": { kind: "electrical_contractor", field: "number" },
  "client.electricianLicenseNumber": { kind: "master_electrician", field: "number" },
  "client.electricalSupervisorName": { kind: "master_electrician", field: "holder" },
  "client.constructionSupervisorLicenseNumber": { kind: "construction_supervisor", field: "number" },
  "client.constructionSupervisorLicenseExpiration": { kind: "construction_supervisor", field: "expires" },
  "client.homeImprovementLicenseNumber": { kind: "home_improvement_contractor", field: "number" },
  "client.homeImprovementLicenseExpiration": { kind: "home_improvement_contractor", field: "expires" },
};
export function licenceSourceRef(source: string | undefined): LicenceSourceRef | null {
  const src = String(source ?? "");
  if (NAMED_LICENCE_SOURCES[src]) return NAMED_LICENCE_SOURCES[src];
  if (!src.startsWith(TYPED_LICENCE_PREFIX)) return null;
  const [kind, field] = src.slice(TYPED_LICENCE_PREFIX.length).split(".");
  if (!LICENCE_KIND_SET.has(kind)) return null;
  if (field && field !== "expires" && field !== "holder") return null;
  return { kind: kind as LicenceKind, field: (field || "number") as LicenceSourceRef["field"] };
}

/** A "licence holder" NAME slot ("Licensed Construction Supervisor:") — not one that also asks for
 *  the number ("Licensed Construction Supervisor / License Number"). */
export function isLicenceHolderNameSlot(text: string | undefined): boolean {
  const t = String(text || "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return isLicenceHolderSlot(t) && !/licen[cs]e\s*(?:number|no\b|#)|registration\s*(?:number|no\b|#)|\bnumber\b/i.test(t);
}

/**
 * THE SLOT'S PRINTED CAPTION NAMES ITS LICENCE (unverified maps). A licence source bound to a slot
 * whose caption names ANOTHER kind is read as the caption's kind — "HIC Registration Number" bound
 * to the construction-supervisor source takes the HIC number; a holder NAME slot bound to a number
 * source takes the holder. A caption that names no kind ("License Number") leaves the source as
 * bound. The name is read only when the widget has no caption (names are often shifted). Returns
 * the effective ref, or null when the source is not a licence source.
 */
export function slotLicenceRef(w: Pick<PlacedWidget, "name" | "caption">, source: string): { ref: LicenceSourceRef; overridden: boolean } | null {
  const ref = licenceSourceRef(source);
  if (!ref) return null;
  const printed = String(w.caption || "").trim() || w.name;
  const slot = kindForSlot(printed);
  let out = ref;
  if (slot && slot !== "generic" && slot !== ref.kind) out = { kind: slot, field: ref.field };
  // A PERSON's licence named on a holder NAME slot takes the person, never the number.
  if (out.field === "number" && out.kind !== "generic" && PERSON_KINDS.has(out.kind) && isLicenceHolderNameSlot(printed)) out = { ...out, field: "holder" };
  return { ref: out, overridden: out.kind !== ref.kind || out.field !== ref.field };
}

// ---- B5: estimated cost / valuation --------------------------------------------------------------

/** THE valuation-slot predicate (the fill-time default and the post-map check both read it). The
 *  original tight names, widened to estimated / construction cost — a table of trade rows. */
const VALUATION_SLOT = /((estimated|declared)\s+)?job\s+valu(e|ation)|declared\s+valuation|valuation\s+of\s+(the\s+)?work|estimated\s+value\b|^valuation$|estimated\s+(total\s+)?costs?\b|cost\s+of\s+construction|construction\s+costs?\b/i;
const tidy = (s: string | undefined): string => String(s || "").replace(/[:\s]+$/, "").trim();
export const VALUATION_SOURCES = new Set(["computed.estimatedJobValue", "computed.declaredValuation"]);

export function isValuationSlot(w: Pick<PlacedWidget, "name" | "caption">): boolean {
  return VALUATION_SLOT.test(tidy(w.name)) || VALUATION_SLOT.test(tidy(w.caption));
}
export function isTotalRow(w: Pick<PlacedWidget, "name" | "caption">): boolean {
  return /\btotal\b/i.test(`${w.name} ${w.caption || ""}`);
}

// ---- The parcel box and the description of work ---------------------------------------------------

/** A parcel / APN / tax lot / tax map / map-and-lot box. */
const PARCEL_SLOT = /\bparcel\b|\bapn\b|\btax\s*(?:lot|map|account)\b|\bmap\s*(?:and|&|\/)\s*(?:tax\s*)?lot\b|\bassessor'?s?\s*(?:parcel|map|account)\b/i;
/** …but never the parcel's size, area or zoning, and never a box that also asks for the address or a
 *  name ("Site address or parcel #" takes whichever the operator gives it). */
const NOT_PARCEL_ID = /\b(?:size|area|acres?|acreage|sq|square|zon(?:e|ing)|frontage|width|depth|address|street|name|owner)\b/i;
export const PARCEL_SOURCE = "snapshot.parcelNumber";
/** A description-of-work box ("DESCRIPTION OF WORK", "Scope of work", "Project description"). */
const DESCRIPTION_SLOT = /\bdescription\s+of\s+(?:the\s+)?(?:proposed\s+)?(?:work|project|improvements?)\b|\bscope\s+of\s+(?:the\s+)?work\b|\bwork\s+description\b|\bproject\s+description\b|\bdescribe\s+(?:the\s+)?(?:proposed\s+)?work\b/i;
export const DESCRIPTION_SOURCE = "computed.descriptionOfWork";
const printedWords = (s: string | undefined): string => tidy(String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " "));

export function isParcelSlot(caption: string | undefined): boolean {
  const t = printedWords(caption);
  return PARCEL_SLOT.test(t) && !NOT_PARCEL_ID.test(t);
}
export function isDescriptionSlot(caption: string | undefined): boolean {
  return DESCRIPTION_SLOT.test(printedWords(caption));
}

/**
 * THE PARCEL BOX AND THE DESCRIPTION OF WORK, BY WHAT THE BOX PRINTS (Yamhill County's building
 * application, live 2026-09-28: the description of work was written into "Tax map/parcel no" and its
 * own rows stayed blank). The one rule the map sanitisation (sanitizeAcroMap, placements included)
 * and the flat fill (unverified maps only — a person's verified binding stands, hard rule 3) read:
 *  - a parcel / tax lot / tax map / APN box takes the project's parcel number, or stays blank —
 *    never another value;
 *  - a description-of-work box takes the project's description of work (a constant the map wrote
 *    there is a description too, and stands).
 * A check mark (lit:X) and an operator item are never rebound. null = the source stands.
 */
export function captionSourceRule(caption: string | undefined, source: string): { source: string; why: string } | null {
  const src = String(source ?? "").trim();
  if (!src || src.startsWith("operator:") || /^lit:.{0,2}$/.test(src)) return null;
  if (isParcelSlot(caption)) {
    if (src === PARCEL_SOURCE || /parcel|taxlot|maplot|\bapn\b/i.test(src.replace(/[^A-Za-z.]/g, ""))) return null;
    return { source: PARCEL_SOURCE, why: "a parcel box takes the project's parcel number (or stays blank)" };
  }
  if (isDescriptionSlot(caption)) {
    if (/^computed\.descriptionOfWork/.test(src) || src.startsWith("lit:")) return null;
    return { source: DESCRIPTION_SOURCE, why: "a description-of-work box takes the project's description of work" };
  }
  return null;
}

// ---- Addresses: a street cell with its own City / State / ZIP cells takes the street only ------------

/** Site-address sources that already carry city, state and ZIP. */
const FULL_SITE_ADDRESS_SOURCES = new Set(["project.projectAddress", "computed.fullAddress"]);
const STREET_LINE_SOURCES = new Set([...FULL_SITE_ADDRESS_SOURCES, "computed.streetAddress"]);
/** A site City / State / ZIP source, and the owner-mailing source that replaces it on a mailing row. */
const MAILING_PART_FOR: Record<string, string> = {
  "project.city": "computed.homeownerMailingCity",
  "project.state": "computed.homeownerMailingState",
  "project.zip": "computed.homeownerMailingZip",
  "computed.cityStateZip": "computed.homeownerMailingCityStateZip",
};
const CITY_STATE_ZIP_SOURCES = new Set([...Object.keys(MAILING_PART_FOR), ...Object.values(MAILING_PART_FOR), "snapshot.homeownerMailingCityStateZip"]);
/** The caption's own words, past a "SECTION - " prefix the flat mapper writes ("PROPERTY OWNER - City:"). */
const ownCaption = (caption: string): string => printedWords(caption).split(/\s+-\s+/).pop() ?? "";
const CITY_STATE_ZIP_CELL = /^\W*(?:city|state|zip|postal)\b/i;
const ADDRESS_CELL = /\baddress\b|\bstreet\b/i;
const EMAIL_CELL = /\be-?\s?mail\b|\bweb\s*site\b/i;
const MAILING_CELL = /\bmail(?:ing)?\b|\bowner'?s?\b/i;

/** A cell the address rule reads: its printed caption, its source and where it sits. */
export interface AddressCell { key: string; caption: string; source: string; page?: number; rect?: WidgetRect }

/**
 * THE STREET LINE AND THE OWNER'S MAILING ADDRESS, BY THE ROW THE CELL SITS ON (#72: Valencia County's
 * printed row "MAILING ADDRESS | CITY | STATE | ZIP" took the full one-line site address in its
 * MAILING ADDRESS cell, so city, state and ZIP printed twice). One rule for both mappers' output
 * (sanitizeAcroMap, placements included) and the flat fill (unverified maps only — a person's
 * verified binding stands, hard rule 3):
 *  - an address cell whose ROW has its own CITY / STATE / ZIP cells takes the street line only
 *    (computed.streetAddress); a lone one (SITE ADDRESS, PROJECT LOCATION) keeps the full address;
 *  - an OWNER / MAILING address cell bound to the site reads the owner-mailing source instead (the
 *    install address unless the project records another — buildContext, the 2026-09-27 ruling), and
 *    the City / State / ZIP cells on its row read the mailing parts, so a recorded mailing address
 *    is never split across two addresses.
 * Only a cell bound to a site-address source is touched (a contractor's address stays the
 * contractor's). Returns key → the rebound source and why; a cell not in the map stands.
 */
export function addressRowRebinds(cells: AddressCell[]): Map<string, { source: string; why: string }> {
  const out = new Map<string, { source: string; why: string }>();
  const sameRow = (a: AddressCell, b: AddressCell): boolean => {
    if (!a.rect || !b.rect || (a.page ?? 0) !== (b.page ?? 0)) return false;
    const tolerance = Math.max(4, Math.min(a.rect.height, b.rect.height) / 2);
    return Math.abs((a.rect.y + a.rect.height / 2) - (b.rect.y + b.rect.height / 2)) <= tolerance;
  };
  // An owner's address block often prints its City / State / ZIP on the line right BELOW the street
  // (Yamhill's "Property Owner - Address:" over "City/State/Zip:", ABQ's OWNER: ADDRESS over ZIP):
  // those are the mailing cell's own too — it is a street line, not a lone one-line address.
  const lineBelow = (a: AddressCell, b: AddressCell): boolean => {
    if (!a.rect || !b.rect || (a.page ?? 0) !== (b.page ?? 0)) return false;
    const drop = (a.rect.y + a.rect.height / 2) - (b.rect.y + b.rect.height / 2);
    const overlaps = b.rect.x < a.rect.x + a.rect.width && a.rect.x < b.rect.x + b.rect.width;
    return overlaps && drop > Math.max(4, Math.min(a.rect.height, b.rect.height) / 2) && drop <= 2.5 * Math.max(a.rect.height, b.rect.height);
  };
  const isCityStateZipCell = (c: AddressCell): boolean =>
    CITY_STATE_ZIP_CELL.test(ownCaption(c.caption)) || CITY_STATE_ZIP_SOURCES.has(String(c.source ?? "").trim());
  for (const cell of cells) {
    const src = String(cell.source ?? "").trim();
    const caption = printedWords(cell.caption);
    if (!STREET_LINE_SOURCES.has(src) || !ADDRESS_CELL.test(caption) || EMAIL_CELL.test(caption)) continue;
    const neighbours = cells.filter((o) => o !== cell && sameRow(cell, o) && isCityStateZipCell(o));
    if (MAILING_CELL.test(caption)) {
      const own = [...neighbours, ...cells.filter((o) => o !== cell && lineBelow(cell, o) && isCityStateZipCell(o))];
      const to = own.length || src === "computed.streetAddress" ? "computed.homeownerMailingStreet" : "computed.homeownerMailingFullAddress";
      out.set(cell.key, { source: to, why: "an owner / mailing address takes the owner's mailing address, not the site's" });
      for (const n of own) {
        const part = MAILING_PART_FOR[String(n.source ?? "").trim()];
        if (part) out.set(n.key, { source: part, why: "a City / State / ZIP cell on the owner's mailing-address row takes the mailing address's part" });
      }
      continue;
    }
    if (neighbours.length && FULL_SITE_ADDRESS_SOURCES.has(src)) {
      out.set(cell.key, { source: "computed.streetAddress", why: "an address cell with its own City / State / ZIP cells takes the street line only" });
    }
  }
  return out;
}

/** A vision placement's box as the checks read it: its baseline and width, one line tall. */
export function placementRect(p: PlacementLike): WidgetRect {
  const size = p.size && p.size > 0 ? p.size : 9;
  return { x: p.x, y: p.y - 3, width: p.maxWidth && p.maxWidth > 0 ? p.maxWidth : 150, height: size + 5 };
}

// ---- B4: one signer, one name ---------------------------------------------------------------------

const PRINT_NAME = /\bprint(?:ed)?\s*name\b|\bname\s*\(?\s*print/i;
/** Does this widget name the person who signs — an "I, ___" declarant or a Print Name line? */
export function signerNamingRole(w: PlacedWidget): "declarant" | "printName" | null {
  if (/^i,?$/i.test(String(w.captions?.left || "").trim())) return "declarant";
  if (PRINT_NAME.test(String(w.caption || "")) || PRINT_NAME.test(w.name.replace(/([a-z])([A-Z])/g, "$1 $2"))) return "printName";
  return null;
}

/** The page's printed text as VISUAL LINES: text runs on one page whose baselines sit within 2.5pt,
 *  joined left to right. A PDF splits a line into runs anywhere (a font change, a justified gap), so
 *  what a line STARTS with is read off the joined line, never off a run. */
function visualLines(items: LabelItem[]): Array<{ page: number; y: number; text: string }> {
  const lines: Array<{ page: number; y: number; parts: LabelItem[] }> = [];
  for (const it of [...items].sort((a, b) => (a.page - b.page) || (b.y - a.y) || (a.x - b.x))) {
    const line = lines.find((l) => l.page === it.page && Math.abs(l.y - it.y) < 2.5);
    if (line) line.parts.push(it); else lines.push({ page: it.page, y: it.y, parts: [it] });
  }
  return lines.map((l) => ({
    page: l.page, y: l.y,
    text: l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/_{2,}/g, " ").replace(/\s+/g, " ").trim(),
  }));
}

/** The words a signature line may carry BEFORE "Signature" ("Owner's Signature", "Contractor /
 *  Agent Signature", "Property Owner or Authorized Agent Signature"): whose signature it is, at most
 *  three of them, joined by or / and / & / slashes. A closed list on purpose — prose that mentions a
 *  signature ("I understand my signature below is made under oath") is never a signature line. */
const SIGNER_PREFIX_WORDS = new Set(["owner", "owners", "homeowner", "homeowners", "property", "applicant", "applicants", "contractor", "contractors", "agent", "agents", "authorized", "authorised"]);
const PREFIX_CONNECTORS = new Set(["or", "and"]);

/** Does this printed line START with "Signature" (optionally after a short signer prefix)? */
export function isSignatureLine(text: string): boolean {
  const t = String(text || "").replace(/_{2,}/g, " ").trim();
  const at = /\bsignature\b/i.exec(t);
  if (!at) return false;
  const prefix = t.slice(0, at.index);
  if (!/^[A-Za-z'’`\s/&-]*$/.test(prefix)) return false;
  const words = prefix.toLowerCase().replace(/['’`]s\b/g, "s").split(/[^a-z]+/).filter(Boolean);
  const roles = words.filter((w) => !PREFIX_CONNECTORS.has(w));
  return roles.length <= 3 && roles.every((w) => SIGNER_PREFIX_WORDS.has(w));
}

/** Where signatures go on each page: signature widgets (a vision pass's signature placement stands
 *  in as one — signatureStandIns) and every printed line that STARTS with "Signature", whatever its
 *  length ("Signature of Property Owner or Authorized Agent as required by …"). A line that also
 *  names the PRINT NAME ("Signature / Print Name") is the print-name box's own caption, not a line
 *  between two blocks, so it is not an anchor. */
export function signatureAnchors(widgets: PlacedWidget[], items: LabelItem[]): Array<{ page: number; y: number }> {
  const out: Array<{ page: number; y: number }> = [];
  for (const w of widgets) if (/signature/i.test(w.type) && w.rect && w.page != null) out.push({ page: w.page, y: w.rect.y });
  for (const l of visualLines(items)) if (isSignatureLine(l.text) && !PRINT_NAME.test(l.text)) out.push({ page: l.page, y: l.y });
  return out;
}

/** A vision pass's signature placements as stand-in signature WIDGETS, so a scanned form with no text
 *  layer still has its signature lines to separate two blocks (signatureAnchors reads this shape).
 *  The name is a sentinel no real widget carries; it is bound to nothing. */
export function signatureStandIns(signatures: ReadonlyArray<{ page: number; x: number; y: number; width: number; height: number }> | undefined): PlacedWidget[] {
  return (signatures ?? []).map((s, i) => ({
    name: `\u0000signature#${i}`, type: "PDFSignature", page: s.page,
    rect: { x: s.x, y: s.y, width: s.width, height: s.height },
  }));
}

/**
 * THE DECLARANT AND THE PRINTED NAME UNDER ONE SIGNATURE ARE ONE PERSON. A signature block names
 * its signer at most twice: ONE "I, ___" declarant and ONE Print Name. So a pair is exactly one
 * declarant with one Print Name — two Print Names (the owner's and the contractor's, side by side
 * or stacked) are two signers, and so are two declarants (an owner's "I, ___ authorize" and an
 * applicant's "I, ___ certify").
 *
 * A declarant pairs with the NEAREST Print Name BELOW it on the same page (within 120pt), wherever it
 * sits across the page — a right-column Print Name on the signature row under a left-hand "I, ___"
 * is the same signer — so long as the two are NOT ON THE SAME ROW (their vertical ranges do not
 * overlap: side-by-side boxes on one row are two blocks) and no SIGNATURE LINE lies between them (a
 * printed line that starts with "Signature", or a signature widget). Each widget is in at most one
 * pair, the nearest first. A pair bound to DIFFERENT sources is returned — the fill cannot know
 * which person is right (who the agent is is the operator's decision).
 */
export function signerNameConflicts(
  widgets: PlacedWidget[], textFields: Record<string, string>, items: LabelItem[],
): Array<{ fields: string[]; labels: string[]; sources: string[] }> {
  const bound = widgets.filter((w) => w.rect && w.page != null && textFields[w.name]);
  const declarants = bound.filter((w) => signerNamingRole(w) === "declarant");
  const printNames = bound.filter((w) => signerNamingRole(w) === "printName");
  if (!declarants.length || !printNames.length) return [];
  const anchors = signatureAnchors(widgets, items);
  const centerX = (r: WidgetRect): number => r.x + r.width / 2;
  const candidates: Array<{ d: PlacedWidget; p: PlacedWidget; dist: number }> = [];
  for (const d of declarants) {
    const nearest = printNames
      // BELOW and not on the same row: the Print Name's CENTRE is under the declarant's bottom — tall
      // boxes on stacked rows may overlap by a point or two (22pt boxes 20pt apart; forms-fill-3 R5).
      .filter((p) => p.page === d.page && p.rect!.y + p.rect!.height / 2 < d.rect!.y && d.rect!.y - p.rect!.y <= 120)
      .map((p) => ({ p, dist: d.rect!.y - p.rect!.y, dx: Math.abs(centerX(d.rect!) - centerX(p.rect!)) }))
      .sort((a, b) => (a.dist - b.dist) || (a.dx - b.dx))[0];
    if (!nearest) continue;
    const gapTop = d.rect!.y;                                          // bottom of the declarant
    const gapBottom = nearest.p.rect!.y + nearest.p.rect!.height;      // top of the Print Name
    if (anchors.some((s) => s.page === d.page && s.y < gapTop && s.y > gapBottom)) continue;
    candidates.push({ d, p: nearest.p, dist: nearest.dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  const used = new Set<string>();
  const pairs: PlacedWidget[][] = [];
  for (const { d, p } of candidates) {
    if (used.has(d.name) || used.has(p.name)) continue;
    used.add(d.name); used.add(p.name);
    if (textFields[d.name] !== textFields[p.name]) pairs.push([d, p].sort((a, b) => b.rect!.y - a.rect!.y));   // read top-down
  }
  return pairs
    .sort((a, b) => (a[0].page! - b[0].page!) || (b[0].rect!.y - a[0].rect!.y))
    .map((pair) => ({ fields: pair.map((w) => w.name), labels: pair.map(widgetLabel), sources: pair.map((w) => textFields[w.name]) }));
}

// ---- B6: vision placements that no widget covers --------------------------------------------------

/** Does an overlay placement (text start x, baseline y) land on a widget? Vision coordinates drift
 *  a few points, so the widget is widened by a small margin. */
export function placementOnWidget(p: { page: number; x: number; y: number }, widgets: PlacedWidget[]): boolean {
  return widgets.some((w) => w.rect && w.page === p.page
    && p.x >= w.rect.x - 12 && p.x <= w.rect.x + w.rect.width
    && p.y >= w.rect.y - 8 && p.y <= w.rect.y + w.rect.height + 8);
}

// ---- "Not Applicable" is the operator's call ------------------------------------------------------

/** The operator item for a constant "Not Applicable" tick the mapper returned and the product removed. */
export const NOT_APPLICABLE_ITEM = "Not Applicable box left unticked — tick it by hand only if it truly applies";

// ---- The workers' compensation affidavit, read off the page ---------------------------------------

const WORKERS_COMP = /workers['’`]?\s*comp/i;

/**
 * A FORM THAT ASKS FOR A WORKERS' COMPENSATION AFFIDAVIT gets a named operator item, whatever the
 * model returned: the printed line naming it (workers' compensation AND affidavit on one line of
 * the text layer) is read deterministically. The product never ticks or signs it — the person who
 * attaches the affidavit does. null when no line names one (an "Owner's Affidavit" alone, or a
 * workers' compensation CERTIFICATE, is not this).
 */
export function workersCompAffidavitItem(items: LabelItem[]): OperatorItem | null {
  // One visual line per (page, baseline within 2.5pt), read left to right — a heading split into
  // runs ("Workers' Compensation Insurance" + "Affidavit") is still one line.
  for (const l of visualLines(items)) {
    const text = l.text;
    if (!WORKERS_COMP.test(text) || !/\baffidavit\b/i.test(text)) continue;
    const printed = text.length > 90 ? `${text.slice(0, 87).trimEnd()}…` : text;
    return { label: `Workers' compensation affidavit — the form asks for one ("${printed}", page ${l.page + 1}): attach the signed affidavit and answer it by hand; the product never ticks or signs it` };
  }
  return null;
}

/** Does an operator item already name the workers' compensation AFFIDAVIT? Both words: an item for a
 *  carrier or policy box ("Workers' Comp Insurance Carrier") is not the affidavit requirement. */
export const namesWorkersComp = (label: string): boolean => WORKERS_COMP.test(label) && /\baffidavit\b/i.test(label);

// ---- Vision placements pass the same map checks as widgets ----------------------------------------

/** A vision placement as stored (ahjForms.OverlayField's shape, the fields the checks read). */
export interface PlacementLike { source: string; page: number; x: number; y: number; size?: number; maxWidth?: number; label?: string }

/**
 * THE SAME MAP CHECKS FOR A VISION PLACEMENT AS FOR A WIDGET. A placement kept as an overlay (a
 * printed blank with no widget, or every blank on a flat form) used to skip the licence-holder, the
 * one-signer and the Total-only checks. Each labelled placement stands in as a widget — its printed
 * label as the caption, its baseline and width as the box, an "I, ___" label as a declarant — and
 * the union goes through sanitizeAcroMap, the one set of rules. A placement with no label is kept
 * as it is (nothing printed to check it against). Returns the widget map, the placements kept (a
 * rebound source rides along) and what was dropped, named.
 */
export function sanitizePlacements<P extends PlacementLike>(input: {
  widgets: PlacedWidget[]; items: LabelItem[]; state: string;
  textFields: Record<string, string>; checkboxes: Record<string, { source: string; equals?: string }>;
  placements: P[];
}): { textFields: Record<string, string>; checkboxes: Record<string, { source: string; equals?: string }>; placements: P[]; operatorItems: OperatorItem[]; notes: string[] } {
  const KEY = "\u0000placement#";
  const stand: PlacedWidget[] = [];
  const textFields = { ...input.textFields };
  input.placements.forEach((p, i) => {
    const label = String(p.label ?? "").trim();
    if (!label || !p.source || p.source.startsWith("operator:")) return;
    const declarant = /^i\s*,/i.test(label);
    const tail = declarant ? label.replace(/^i\s*,/i, "").replace(/_{2,}/g, " ").trim() : "";
    stand.push({
      name: `${KEY}${i}`, type: "PDFTextField", page: p.page,
      rect: placementRect(p),
      caption: declarant ? "" : label,
      ...(declarant ? { captions: { left: "I,", ...(tail ? { right: tail } : {}) } } : {}),
    });
    textFields[`${KEY}${i}`] = p.source;
  });
  if (!stand.length) return { textFields: input.textFields, checkboxes: input.checkboxes, placements: input.placements, operatorItems: [], notes: [] };
  const checked = sanitizeAcroMap({ widgets: [...input.widgets, ...stand], items: input.items, state: input.state, textFields, checkboxes: input.checkboxes });
  const placements = input.placements.flatMap((p, i) => {
    const key = `${KEY}${i}`;
    if (!(key in textFields)) return [p];                // not checked (no label): kept as it was
    const source = checked.textFields[key];
    return source ? [source === p.source ? p : { ...p, source }] : [];
  });
  const widgetFields = Object.fromEntries(Object.entries(checked.textFields).filter(([k]) => !k.startsWith(KEY)));
  // A stand-in's key never reaches a person: it reads as the placement's printed label.
  const named = (s: string): string => s.replace(/\u0000placement#(\d+)/g, (_, i: string) => String(input.placements[Number(i)]?.label ?? "").trim());
  const operatorItems = checked.operatorItems.map((it) => (it.field?.startsWith(KEY) ? { label: named(it.label) } : { ...it, label: named(it.label) }));
  const notes = checked.notes.map(named);
  return { textFields: widgetFields, checkboxes: checked.checkboxes, placements, operatorItems, notes };
}

// ---- The post-map sanitisation (acquisition) -----------------------------------------------------

export interface MapSanitizeResult {
  textFields: Record<string, string>;
  checkboxes: Record<string, { source: string; equals?: string }>;
  operatorItems: OperatorItem[];
  notes: string[];
}

/**
 * The deterministic half of the mapping rules, applied to what the model returned:
 *  - a workers'-comp / affidavit box is never bound (an operator item instead);
 *  - a constant "Not Applicable" tick is never kept, wherever it sits (an operator item instead);
 *  - a licence-holder NAME slot never binds to the applicant signer; the Oregon CCB never binds on
 *    another state's form (buildContext also blanks it at fill time);
 *  - in a cost table (a Total-captioned valuation slot exists) the valuation source keeps only the
 *    Total and at most one trade row;
 *  - a declarant and a printed name under one signature bound to different people are both
 *    dropped and named for the operator.
 */
export function sanitizeAcroMap(input: {
  widgets: PlacedWidget[]; items: LabelItem[]; state: string;
  textFields: Record<string, string>; checkboxes: Record<string, { source: string; equals?: string }>;
}): MapSanitizeResult {
  const byName = new Map(input.widgets.map((w) => [w.name, w]));
  const textFields = { ...input.textFields };
  const checkboxes = { ...input.checkboxes };
  const operatorItems: OperatorItem[] = [];
  const notes: string[] = [];
  const widgetOf = (name: string): PlacedWidget => byName.get(name) ?? { name, type: "" };
  const st = String(input.state || "").trim().toUpperCase();
  const oregon = !st || st === "OR";

  for (const [name, rule] of Object.entries(checkboxes)) {
    const w = widgetOf(name);
    const text = `${w.name} ${w.caption || ""} ${w.captions?.left || ""} ${w.captions?.right || ""}`;
    if (attestsAttachedDocument(text)) {
      delete checkboxes[name];
      operatorItems.push({ field: name, label: `${widgetLabel({ name, caption: w.captions?.left || w.captions?.right })} (a document attestation — attach it and tick by hand)` });
      notes.push(`"${name}" attests an attached document; not ticked (source was ${rule.source}).`);
      continue;
    }
    // "Not Applicable" ticked as a CONSTANT is a guess that a requirement (a state licence section, a
    // district review) does not apply to ANY job — an operator / legal call, never the mapper's. EVERY
    // one is left unticked and named; which section it sits in is not read off the layout.
    if (rule.source.startsWith("lit:") && /\bnot\s*applicable\b/i.test(text)) {
      delete checkboxes[name];
      operatorItems.push({ field: name, label: NOT_APPLICABLE_ITEM });
      notes.push(`"${name}" (Not Applicable) was not ticked: whether it applies is the operator's call.`);
    }
  }
  for (const [name, source] of Object.entries(textFields)) {
    const w = widgetOf(name);
    if (attestsAttachedDocument(`${w.name} ${w.caption || ""}`)) {
      delete textFields[name];
      operatorItems.push({ field: name, label: widgetLabel(w) });
      continue;
    }
    // THE PARCEL BOX AND THE DESCRIPTION OF WORK (captionSourceRule): the printed caption decides.
    const bound = captionSourceRule(String(w.caption || "").trim() || w.name, source);
    if (bound) {
      textFields[name] = bound.source;
      notes.push(`"${name}" prints "${widgetLabel(w)}" — ${bound.why}; its source ${source} was rebound to ${bound.source}.`);
      continue;
    }
    if (source === "computed.applicantSignerName" && (isLicenceHolderSlot(w.name) || isLicenceHolderSlot(w.caption))) {
      // The holder of the licence the caption names, when it names one; else the operator's.
      const kind = kindForSlot(String(w.caption || "").trim() || w.name);
      if (kind === "construction_supervisor" || kind === "master_electrician") {
        textFields[name] = typedLicenceSource(kind, "holder");
        notes.push(`"${name}" is a licence holder's slot; bound to the ${kind.replace(/_/g, " ")} licence's holder, not the applicant signer.`);
        continue;
      }
      delete textFields[name];
      operatorItems.push({ field: name, label: `${widgetLabel(w)} (the licence holder's name)` });
      notes.push(`"${name}" is a licence holder's slot; the applicant signer is not the licence holder, so it was left for the operator.`);
      continue;
    }
    // THE PRINTED CAPTION NAMES THE LICENCE (slotLicenceRef, the fill's own rule): a licence source
    // of another kind is rebound to the caption's kind.
    const slot = slotLicenceRef(w, source);
    if (slot?.overridden && slot.ref.kind !== "generic") {
      textFields[name] = typedLicenceSource(slot.ref.kind, slot.ref.field);
      notes.push(`"${name}" prints "${widgetLabel(w)}"; its licence source was rebound to ${textFields[name]}.`);
      continue;
    }
    if (source === OREGON_CCB_SOURCE && !oregon) {
      textFields[name] = STATE_LICENCE_SOURCE;
      notes.push(`"${name}" was bound to the Oregon CCB number on a ${st} form; rebound to the ${st} contractor licence on file.`);
    }
  }

  // THE STREET LINE AND THE OWNER'S MAILING ADDRESS (addressRowRebinds): the row the cell sits on decides.
  const addressCells = Object.entries(textFields).map(([name, source]) => {
    const w = widgetOf(name);
    return { key: name, caption: String(w.caption || "").trim() || name, source, page: w.page, rect: w.rect };
  });
  for (const [name, bound] of addressRowRebinds(addressCells)) {
    notes.push(`"${name}" prints "${widgetLabel(widgetOf(name))}" — ${bound.why}; its source ${textFields[name]} was rebound to ${bound.source}.`);
    textFields[name] = bound.source;
  }

  // Cost table: a Total-captioned valuation slot exists on the form.
  const valuationWidgets = input.widgets.filter((w) => /text/i.test(w.type) && isValuationSlot(w));
  if (valuationWidgets.some(isTotalRow)) {
    const bound = Object.entries(textFields).filter(([, s]) => VALUATION_SOURCES.has(s)).map(([n]) => widgetOf(n));
    const totals = bound.filter(isTotalRow);
    const trades = bound.filter((w) => !isTotalRow(w));
    const keepTrade = totals.length === 1 && trades.length === 1;
    const drop = totals.length === 1 ? (keepTrade ? [] : trades) : bound;
    for (const w of drop) delete textFields[w.name];
    if (drop.length) notes.push(`Estimated cost: kept ${totals.length === 1 ? "the Total row" : "no row (the table has no single Total)"}; ${drop.length} other row(s) left blank.`);
  }

  for (const c of signerNameConflicts(input.widgets, textFields, input.items)) {
    for (const f of c.fields) delete textFields[f];
    operatorItems.push({ label: `${c.labels.join(" / ")} (one signer, bound to different people: ${c.sources.join(" vs ")} — fill by hand)` });
    notes.push(`Declarant and printed name under one signature were bound to different sources (${c.sources.join(", ")}); both left for the operator.`);
  }
  return { textFields, checkboxes, operatorItems, notes };
}

/** Operator items as printed labels, de-duplicated, in order. The same item twice (one blank,
 *  named by the map and again by the fill) is listed once; ONE label on two DIFFERENT boxes (two
 *  "Expiration Date" blanks, one per licence) is two items, each told apart by its box's name —
 *  collapsing them would hide a blank the operator must fill. */
export function operatorItemLabels(items: Array<OperatorItem | string>): string[] {
  const norm = items.map((it) => ({
    label: String(typeof it === "string" ? it : it.label || it.field || "").trim(),
    field: typeof it === "string" ? "" : String(it.field ?? "").trim(),
  })).filter((it) => it.label);
  const fieldsByLabel = new Map<string, Set<string>>();
  for (const it of norm) {
    if (!it.field) continue;
    const key = it.label.toLowerCase();
    fieldsByLabel.set(key, (fieldsByLabel.get(key) ?? new Set<string>()).add(it.field));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of norm) {
    const shared = (fieldsByLabel.get(it.label.toLowerCase())?.size ?? 0) > 1;
    const label = shared && it.field ? `${it.label} — the box named "${tidyName(it.field)}"` : it.label;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    // An unnamed copy of a label several boxes carry is already said by each box's own line.
    if (shared && !it.field) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

export type { CaptionSide };
