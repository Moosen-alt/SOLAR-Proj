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
 *  sentence of prose (a declaration under the box) is not a label, so the name stands. */
export function widgetLabel(w: Pick<PlacedWidget, "name" | "caption" | "captions">): string {
  if (/^i,?$/i.test(String(w.captions?.left || "").trim())) {
    const tail = String(w.captions?.right || "").trim();
    return `I, ___${tail ? `${tail.startsWith(",") ? "" : " "}${tail}` : ""}`;
  }
  const caption = String(w.caption || "").replace(/[:\s]+$/, "").trim();
  return caption && caption.length <= 60 ? caption : w.name;
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

// ---- B4: one signer, one name ---------------------------------------------------------------------

const PRINT_NAME = /\bprint(?:ed)?\s*name\b|\bname\s*\(?\s*print/i;
/** Does this widget name the person who signs — an "I, ___" declarant or a Print Name line? */
export function signerNamingRole(w: PlacedWidget): "declarant" | "printName" | null {
  if (/^i,?$/i.test(String(w.captions?.left || "").trim())) return "declarant";
  if (PRINT_NAME.test(String(w.caption || "")) || PRINT_NAME.test(w.name.replace(/([a-z])([A-Z])/g, "$1 $2"))) return "printName";
  return null;
}

/** Where signatures go on each page: signature widgets and short printed "Signature…" captions. */
export function signatureAnchors(widgets: PlacedWidget[], items: LabelItem[]): Array<{ page: number; y: number }> {
  const out: Array<{ page: number; y: number }> = [];
  for (const w of widgets) if (/signature/i.test(w.type) && w.rect && w.page != null) out.push({ page: w.page, y: w.rect.y });
  for (const i of items) if (/\bsignature\b/i.test(i.str) && !PRINT_NAME.test(i.str) && i.str.trim().length <= 60) out.push({ page: i.page, y: i.y });
  return out;
}

/**
 * THE DECLARANT AND THE PRINTED NAME UNDER ONE SIGNATURE ARE ONE PERSON. Two signer-naming widgets
 * are in one signature block when they are on the same page within 120pt of each other and no
 * signature line lies between them (so an owner block and the agent block below it never pair).
 * A block whose signer-naming widgets are bound to DIFFERENT sources is returned — the fill
 * cannot know which person is right (who the agent is is the operator's decision).
 */
export function signerNameConflicts(
  widgets: PlacedWidget[], textFields: Record<string, string>, items: LabelItem[],
): Array<{ fields: string[]; labels: string[]; sources: string[] }> {
  const signers = widgets.filter((w) => w.rect && w.page != null && textFields[w.name] && signerNamingRole(w));
  if (signers.length < 2) return [];
  const anchors = signatureAnchors(widgets, items);
  const paired = (a: PlacedWidget, b: PlacedWidget): boolean => {
    if (a.page !== b.page) return false;
    const [hi, lo] = a.rect!.y >= b.rect!.y ? [a, b] : [b, a];
    const gapTop = hi.rect!.y;                        // bottom of the higher widget
    const gapBottom = lo.rect!.y + lo.rect!.height;   // top of the lower widget
    if (hi.rect!.y - lo.rect!.y > 120) return false;
    return !anchors.some((s) => s.page === a.page && s.y < gapTop && s.y > gapBottom);
  };
  // Connected groups of paired signer widgets.
  const groups: PlacedWidget[][] = [];
  for (const w of signers) {
    const joined = groups.filter((g) => g.some((x) => paired(x, w)));
    const merged = [w, ...joined.flat()];
    for (const g of joined) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups
    .filter((g) => g.length >= 2 && new Set(g.map((w) => textFields[w.name])).size >= 2)
    .map((g) => [...g].sort((a, b) => (a.page! - b.page!) || (b.rect!.y - a.rect!.y)))   // read top-down
    .map((g) => ({ fields: g.map((w) => w.name), labels: g.map(widgetLabel), sources: [...new Set(g.map((w) => textFields[w.name]))] }));
}

// ---- B6: vision placements that no widget covers --------------------------------------------------

/** Does an overlay placement (text start x, baseline y) land on a widget? Vision coordinates drift
 *  a few points, so the widget is widened by a small margin. */
export function placementOnWidget(p: { page: number; x: number; y: number }, widgets: PlacedWidget[]): boolean {
  return widgets.some((w) => w.rect && w.page === p.page
    && p.x >= w.rect.x - 12 && p.x <= w.rect.x + w.rect.width
    && p.y >= w.rect.y - 8 && p.y <= w.rect.y + w.rect.height + 8);
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
    // "Not Applicable" ticked as a CONSTANT is a guess that a requirement (a state licence section)
    // does not apply to any job — an operator / legal call, never the mapper's.
    if (rule.source.startsWith("lit:") && /\bnot\s*applicable\b/i.test(text)) {
      delete checkboxes[name];
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

/** Operator items as printed labels, de-duplicated, in order. */
export function operatorItemLabels(items: Array<OperatorItem | string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const label = String(typeof it === "string" ? it : it.label || it.field || "").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

export type { CaptionSide };
