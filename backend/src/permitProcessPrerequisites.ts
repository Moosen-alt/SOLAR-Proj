// WHAT COUNTS AS A PREREQUISITE (#204) — a deterministic reading of the process lookup's answer, no
// model call. A prerequisite is a step at ANOTHER office that has to happen BEFORE the application
// is filed or the permit is issued. Saratoga Springs' "After the permit is approved and building
// permit is issued we will provide you a digital copy of the approved plans" was stored three times
// as "Approval before the permit" — one of them from the city's BASEMENT permit page — and the
// Required document set panel told the operator to go to another office FIRST. So:
//   1. a sentence about what happens AFTER issuance is never a prerequisite;
//   2. a step that only has to precede the final inspection / occupancy / PTO is not one either;
//   3. a prerequisite comes from a page about THIS permit (residential solar / electrical /
//      building), never another permit type's page or sentence (basement, deck, fence, pool…);
//   4. near-duplicates from different pages collapse into one, keeping every source.
// Used at every door: the page extractor (permitPlatformCatalog.extractPrerequisites), the lookup's
// write (permitProcessLookup), and the registry read of a SEEDED row (permitProcess.rowToLookup) —
// a person's verified row is shown as they verified it (hard rule 3).
import type { CitedFact } from "../../shared/src/types";

/** "after / once / upon the permit is approved / issued" — the permit ITSELF already granted. "After
 *  zoning approval, apply for the permit" is not this: there the approval is another office's. */
const POST_ISSUANCE = /\b(?:after|once|upon|when)\b[^.;]{0,30}?\b(?:(?:the|your|a|an|this)\s+)?(?:(?:building|solar|electrical|residential|pv)\s+)*permits?\s+(?:(?:is|are|has|have|was|were|been|being|gets?)\s+)*(?:approved|issued|finali[sz]ed|finaled|granted|picked up)\b|\b(?:after|upon|following)\s+(?:(?:the|permit)\s+)*issuance\b/i;
/** A step that must happen before the application is filed or the permit is issued. */
const BEFORE_FILING = /\b(?:before|prior to|ahead of)\b[^.;]{0,60}?\b(?:apply\w*|applications?|submi\w*|fil(?:e|es|ed|ing)|issu\w*|pull\w*|obtain\w*\s+(?:(?:a|the|your)\s+)?(?:(?:building|solar|electrical|residential)\s+)?permits?|(?:(?:building|solar|electrical|residential)\s+)?permits?\b(?!\s+(?:final|inspection|closeout|close-out)))|\bfirst\b|\bthen\b[^.;]{0,60}?\b(?:apply|submit|file|permits?)\b|\bin order to (?:apply|submit|file|obtain)|\brequired (?:to|for|with) (?:apply\w*|submi\w*|fil\w*|obtain\w*|(?:the|a|your) (?:(?:building|solar|electrical)\s+)?(?:permits?|applications?))|\bmust (?:be )?(?:accompan\w*|include\w*|attach\w*)\b/i;
/** A "before" that only reaches a milestone AFTER issuance (the final inspection, occupancy, PTO). */
const BEFORE_LATER_MILESTONE = /\b(?:before|prior to)\b[^.;]{0,40}?\b(?:final(?:\s+inspection)?|inspections?|occupancy|energi[sz]\w*|permission to operate|pto|close-?out|interconnect\w*)\b/i;
/** Another permit type, by name. Building / electrical / solar / residential are THIS job's. */
const OTHER_PERMIT_TYPE = /\b(?:basements?|decks?|fences?|fencing|(?:swimming\s+)?pools?|spas?|hot\s+tubs?|signs?(?![\s-]*off)|signage|demolition|sheds?|accessory\s+(?:dwelling|structures?|buildings?)|adus?|grading|excavation|right[\s-]+of[\s-]+way|encroachments?|driveways?|trees?|sewers?|septic|irrigation|retaining\s+walls?|short[\s-]+term\s+rentals?|business\s+licen[cs]es?|home\s+occupations?|fireworks|special\s+events?|water\s+heaters?|re-?roof\w*|siding|windows?|fireplaces?|chimneys?)\b/i;
const THIS_PERMIT = /\b(?:solar|photo-?voltaic|pv|electrical)\b/i;

/** The words of a page's URL path ("/221/Obtaining-a-Basement-Permit" -> "221 obtaining a basement
 *  permit"). The host is not the page's subject. */
function pathWords(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname).replace(/[^A-Za-z0-9]+/g, " ").trim(); } catch { return ""; }
}
/** The page is about ANOTHER permit type: its path or title names one and never solar / PV /
 *  electrical. (A generic "Building" page passes; "Obtaining a Basement Permit" does not.) */
export function pageIsOtherPermitType(sourceUrl: string, title = ""): boolean {
  const subject = `${pathWords(sourceUrl)} ${String(title ?? "")}`;
  return OTHER_PERMIT_TYPE.test(subject) && !THIS_PERMIT.test(subject);
}

/** A step without the extractor's "Kind (lead): " label (permitPlatformCatalog PREREQ_KINDS). */
function stepBody(value: string): string {
  return String(value ?? "").replace(/^[A-Z][A-Za-z /]{2,40}(?:\s*\([^)]{0,40}\))?:\s+/, "");
}

/** Why this text is NOT a prerequisite, or null when it may be one. `kind` is the extractor's label
 *  ("Approval before the permit" claims a before-filing step, so it must state one). */
export function prerequisiteRefusal(text: string, sourceUrl = "", opts: { title?: string; kind?: string; quote?: string } = {}): string | null {
  // The extractor's own label ("Approval before the permit: …") is ours, not the page's words.
  const s = stepBody(text).replace(/\s+/g, " ").trim();
  const words = `${s} ${String(opts.quote ?? "")}`;
  if (!s) return "empty";
  if (pageIsOtherPermitType(sourceUrl, opts.title)) return "the source page is about another permit type";
  // "a basement permit", "fence permits": a sentence about another permit type's own process.
  if (new RegExp(`${OTHER_PERMIT_TYPE.source}[^.;]{0,20}?\\bpermits?\\b`, "i").test(words) && !THIS_PERMIT.test(words)) return "the sentence is about another permit type";
  const beforeFiling = BEFORE_FILING.test(words);
  if (POST_ISSUANCE.test(words) && !beforeFiling) return "it says what happens after the permit is approved / issued";
  if (BEFORE_LATER_MILESTONE.test(words) && !beforeFiling) return "it precedes a milestone after issuance (final inspection / occupancy / PTO), not the filing";
  if (opts.kind === "Approval before the permit" && !beforeFiling) return "it does not say the step comes before the application or the permit's issuance";
  return null;
}

// ── Near-duplicates ───────────────────────────────────────────────────────────────────────
// Words every prerequisite shares ("approval required before the permit"): two steps are the same
// step when what is LEFT (the office, the thing to obtain) is the same.
const GENERIC = new Set(("the a an and or of to for from with by on in at as is are be been will we you your our this that these those it its "
  + "must shall need needs required require requires requirement before prior after then first once upon when obtain obtained submit submitted "
  + "apply applying application applications permit permits approval approved approve issued issuance issue building city county department "
  + "office please all any may can each also have has prior other").split(" "));
function stem(w: string): string {
  return w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, "") : w;
}
/** The distinctive words of a step. */
function distinctive(value: string): Set<string> {
  return new Set(stepBody(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3 && !GENERIC.has(w)).map(stem).filter((w) => !GENERIC.has(w)));
}
function normalized(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
/** Same step in other words: identical text or quote, or the same distinctive words (Jaccard
 *  >= 0.6 over at least two of them). "Fire" vs "Planning" department approval share none. */
export function samePrerequisite(a: Pick<CitedFact<string>, "value" | "quote">, b: Pick<CitedFact<string>, "value" | "quote">): boolean {
  if (normalized(String(a.value)) === normalized(String(b.value))) return true;
  if (a.quote && b.quote && normalized(a.quote) === normalized(b.quote)) return true;
  const x = distinctive(String(a.value)), y = distinctive(String(b.value));
  if (x.size < 2 || y.size < 2) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.6;
}

/** THE ONE READING: drop what is not a prerequisite, collapse near-duplicates into the first, which
 *  keeps every other source in alsoSourceUrls. Order is kept. */
export function classifyPrerequisites<T extends CitedFact<string>>(facts: ReadonlyArray<T> | null | undefined): T[] {
  const out: T[] = [];
  for (const f of facts ?? []) {
    if (!f || typeof f.value !== "string" || !f.value.trim()) continue;
    if (prerequisiteRefusal(f.value, f.sourceUrl, { quote: f.quote })) continue;
    const i = out.findIndex((o) => samePrerequisite(o, f));
    if (i < 0) { out.push({ ...f }); continue; }
    const kept = out[i];
    const also = [...(kept.alsoSourceUrls ?? []), f.sourceUrl, ...(f.alsoSourceUrls ?? [])].filter((u) => u && u !== kept.sourceUrl);
    out[i] = { ...kept, alsoSourceUrls: [...new Set(also)] };
  }
  return out;
}
