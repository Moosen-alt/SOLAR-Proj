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

/** Where signatures go on each page: signature widgets and every printed "Signature…" line,
 *  whatever its length ("Signature of Property Owner or Authorized Agent as required by …" is a
 *  signature line too). A line that also names the PRINT NAME ("Print Name / Signature") is the
 *  print-name box's own caption, not a line between two blocks, so it is not an anchor. */
export function signatureAnchors(widgets: PlacedWidget[], items: LabelItem[]): Array<{ page: number; y: number }> {
  const out: Array<{ page: number; y: number }> = [];
  for (const w of widgets) if (/signature/i.test(w.type) && w.rect && w.page != null) out.push({ page: w.page, y: w.rect.y });
  for (const i of items) if (/\bsignature\b/i.test(i.str) && !PRINT_NAME.test(i.str)) out.push({ page: i.page, y: i.y });
  return out;
}

/**
 * THE DECLARANT AND THE PRINTED NAME UNDER ONE SIGNATURE ARE ONE PERSON. A signature block names
 * its signer at most twice: ONE "I, ___" declarant and ONE Print Name. So a pair is exactly one
 * declarant with one Print Name — two Print Names (the owner's and the contractor's, side by side
 * or stacked) are two signers, and so are two declarants (an owner's "I, ___ authorize" and an
 * applicant's "I, ___ certify"). A declarant and a Print Name are in one block when they are on
 * the same page, stacked within 120pt, their HORIZONTAL ranges overlap (side-by-side blocks never
 * pair), and no printed signature line lies between them. Each widget is in at most one pair, the
 * nearest first. A pair bound to DIFFERENT sources is returned — the fill cannot know which person
 * is right (who the agent is is the operator's decision).
 */
export function signerNameConflicts(
  widgets: PlacedWidget[], textFields: Record<string, string>, items: LabelItem[],
): Array<{ fields: string[]; labels: string[]; sources: string[] }> {
  const bound = widgets.filter((w) => w.rect && w.page != null && textFields[w.name]);
  const declarants = bound.filter((w) => signerNamingRole(w) === "declarant");
  const printNames = bound.filter((w) => signerNamingRole(w) === "printName");
  if (!declarants.length || !printNames.length) return [];
  const anchors = signatureAnchors(widgets, items);
  const overlapX = (a: WidgetRect, b: WidgetRect): boolean => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0;
  const candidates: Array<{ d: PlacedWidget; p: PlacedWidget; dist: number }> = [];
  for (const d of declarants) for (const p of printNames) {
    if (d.page !== p.page || !overlapX(d.rect!, p.rect!)) continue;
    const [hi, lo] = d.rect!.y >= p.rect!.y ? [d, p] : [p, d];
    const dist = hi.rect!.y - lo.rect!.y;
    if (dist > 120) continue;
    const gapTop = hi.rect!.y;                        // bottom of the higher widget
    const gapBottom = lo.rect!.y + lo.rect!.height;   // top of the lower widget
    if (anchors.some((s) => s.page === d.page && s.y < gapTop && s.y > gapBottom)) continue;
    candidates.push({ d, p, dist });
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

// ---- A licence section, read off the page --------------------------------------------------------

const LICENCE_SECTION_WORDS = /\blicen[cs]|\bregistration\b|\bregistered\b|construction\s+supervisor|\bHIC\b|\bCSL\b/i;

/**
 * Is this box inside a LICENCE section? The printed line naming the licence nearest the box — on
 * its own row or within 40pt above it (the section's heading line) — is returned; "" when only the
 * widget's own name / captions name a licence; null when nothing near it does.
 */
export function licenceSectionLine(w: PlacedWidget, items: LabelItem[]): string | null {
  const own = `${w.name} ${w.caption || ""} ${w.captions?.left || ""} ${w.captions?.right || ""} ${w.captions?.above || ""}`;
  if (w.rect && w.page != null) {
    const r = w.rect;
    const mid = r.y + r.height / 2;
    const near = items
      .filter((i) => i.page === w.page && i.y >= r.y - 4 && i.y <= r.y + r.height + 40
        && LICENCE_SECTION_WORDS.test(i.str) && !/\bnot\s*applicable\b/i.test(i.str))
      .sort((a, b) => Math.abs(a.y - mid) - Math.abs(b.y - mid))[0];
    if (near) return near.str.replace(/_{2,}/g, " ").replace(/\s+/g, " ").replace(/[:\s]+$/, "").trim().slice(0, 90);
  }
  return LICENCE_SECTION_WORDS.test(own) ? "" : null;
}

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
  const lines: Array<{ page: number; y: number; parts: LabelItem[] }> = [];
  for (const it of [...items].sort((a, b) => (a.page - b.page) || (b.y - a.y) || (a.x - b.x))) {
    const line = lines.find((l) => l.page === it.page && Math.abs(l.y - it.y) < 2.5);
    if (line) line.parts.push(it); else lines.push({ page: it.page, y: it.y, parts: [it] });
  }
  for (const l of lines) {
    const text = l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/_{2,}/g, " ").replace(/\s+/g, " ").trim();
    if (!WORKERS_COMP.test(text) || !/\baffidavit\b/i.test(text)) continue;
    const printed = text.length > 90 ? `${text.slice(0, 87).trimEnd()}…` : text;
    return { label: `Workers' compensation affidavit — the form asks for one ("${printed}", page ${l.page + 1}): attach the signed affidavit and answer it by hand; the product never ticks or signs it` };
  }
  return null;
}

/** Does an operator item already name the workers' compensation affidavit? */
export const namesWorkersComp = (label: string): boolean => WORKERS_COMP.test(label);

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
    const size = p.size && p.size > 0 ? p.size : 9;
    const declarant = /^i\s*,/i.test(label);
    const tail = declarant ? label.replace(/^i\s*,/i, "").replace(/_{2,}/g, " ").trim() : "";
    stand.push({
      name: `${KEY}${i}`, type: "PDFTextField", page: p.page,
      rect: { x: p.x, y: p.y - 3, width: p.maxWidth && p.maxWidth > 0 ? p.maxWidth : 150, height: size + 5 },
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
    // "Not Applicable" ticked as a CONSTANT beside a LICENCE section is a guess that a state licence
    // requirement does not apply to any job — an operator / legal call, never the mapper's. It is
    // left unticked AND named. Elsewhere ("Historic district: Not Applicable") the map stands.
    const section = rule.source.startsWith("lit:") && /\bnot\s*applicable\b/i.test(text) ? licenceSectionLine(w, input.items) : null;
    if (section != null) {
      delete checkboxes[name];
      operatorItems.push({ field: name, label: `${section || widgetLabel(w)} — Not Applicable (not ticked: whether this licence section applies to the job is the operator's call)` });
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
      delete textFields[name];
      operatorItems.push({ field: name, label: `${widgetLabel(w)} (the licence holder's name)` });
      notes.push(`"${name}" is a licence holder's slot; the applicant signer is not the licence holder, so it was left for the operator.`);
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
