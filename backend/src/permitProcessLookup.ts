// THE PER-JOB PERMIT-PROCESS LOOKUP (B11; operator steer 2026-09-25: "It needs to look up the right
// stuff per job"). One lookup, run when a project names an AHJ with no process of its own — at
// project creation (the QC trigger), not at stage time — answering, for ANY AHJ in any state:
//   who issues the permits (the agency), how the work is permitted (combo vs separate), which portal
//   and which record type each permit files under, which documents/forms each permit needs, and
//   what each permit costs.
//
// It survives the failure modes seen on 2026-09-25:
//   - a 180 s abort: TWO calls (process; documents + fees), each with its own timeout, so an abort
//     loses one part, never both, and the part that returned is kept;
//   - max_tokens truncation: compact JSON with short quotes and a generous budget; a cut-off answer
//     whose JSON does not parse is NOT FOUND, never a partial guess;
//   - a help page taken for a portal: every portal answer goes through the same information-page
//     predicate the stage uses (portalChannel.isInformationalPageUrl) and is refused if it is one.
// Recall round (2026-09-26, the Jefferson shape: a city whose permits its COUNTY issues):
//   - ASK THE AGENCY THAT ISSUES EACH PERMIT: documents/fees and the portal are asked of the top-level
//     agency, else of each per-permit cited agency (≤ 2 groups), else the AHJ; an agency every permit
//     cites is lifted to the top level (liftAgreedAgency). A PREREQUISITE office ("City Hall first,
//     then the County") is never the agency (namesOnlyAsPrerequisite) — it lands as a cited note.
//   - THE PORTAL IS ITS OWN GROUNDED STEP, reading the agency's pages, through ONE door
//     (acceptPortal: cited + portalChannel.hostFitsTrackAndEntity on the permit track — never a
//     utility portal, never a help page); a form's title is never a record type (acceptRecordType).
//   - documents/fees read pages too (fee schedules are PDFs); a page the lookup OPENED counts as seen.
// And it says NOT FOUND instead of guessing: every answer needs a source URL the search returned
// and the words on that page that state it — the quote must itself carry the answer (the agency's
// name, the fee's amount, the structure's words). Nothing from model memory is ever kept.
//
// Output lands 'seeded' through permitProcess.savePermitProcessLookup (a person's verified row is
// never overwritten), and its fees land through feeSchedules.saveFeeSchedule — including the
// DELEGATION (City of Jefferson's fees are collected by Marion County) the fee researcher had read
// and then discarded.
import type { CitedFact, LLMProvider, PermitFeeAnswer, PermitProcessDiscipline, PermitProcessLookup, PermitProcessPermitAnswer, WebLookupResult } from "../../shared/src/types";
import type { AppDb } from "./db";
import { hostFitsTrackAndEntity, isPermitPlatformUrl, portalHostOf } from "./portalChannel";
import { getPermitProcessLookup, normalizeAhjName, savePermitProcessLookup, stateRulesFor } from "./permitProcess";
import { logger } from "./logger";
import { feeScheduleProfileKey, saveFeeSchedule } from "./feeSchedules";
import { parseBracketRow } from "./pdfTables";

export const PROCESS_LOOKUP_SYSTEM = `You look up how RESIDENTIAL ROOFTOP SOLAR PV permits are issued for ONE jurisdiction in the United States.
Answer for the NAMED jurisdiction only (a same-named place in another county or state is a different place).

Find, with web search (search several times with different queries: the city, its county building inspection, the state ePermitting pages, the portal's public records):
1. issuingAgency — the agency that issues this jurisdiction's residential building/structural and electrical permits. A city without its own building program is often served by its COUNTY's building-inspection division or by the state; say which, exactly as the source names it (e.g. "Marion County").
2. permitStructure — "separate" when a PV system needs a structural/building permit AND a separate electrical permit; "combo" when one permit covers both.
3. permits — one entry per permit the job needs (discipline "structural", "electrical", or "combo"), each with:
   - portalUrl: the ONLINE PORTAL where that permit is APPLIED FOR (a citizen-access / permitting-system entry page). NEVER an information, help, FAQ or guide page, and NEVER a PDF.
   - recordType: the RECORD TYPE selected when applying ONLINE on that portal (e.g. Accela's "Residential Structural"), as the portal or a public record on it shows it. A paper application FORM's title is NOT a record type — if you only find form titles, set recordType to null.
   - issuingAgency: the agency that issues THIS permit, when it differs by permit.

Where answers may come from: the jurisdiction's own site; its county's building-inspection site; the state building agency; the permitting portal's public pages and public permit records.

4. prerequisites — a step at ANOTHER office before or beside filing ("submit to City Hall first, then to the County", a zoning sign-off). A prerequisite office is NOT the issuing agency: the issuing agency is the one that issues the permit.

EVERY value carries "sourceUrl" (a page your search returned or you opened) and "quote" (the exact words on that page that state it, under 250 characters, containing the answer itself). If you cannot find a page that states it, set "value": null and say what you searched in "notFound". Never answer from memory. Never guess.

Return ONLY JSON (no prose):
{"issuingAgency": {"value": "<agency>"|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "permitStructure": {"value": "separate"|"combo"|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "prerequisites": [{"value": "<the step, naming the office>", "sourceUrl": "", "quote": ""}],
 "permits": [{"discipline": "structural"|"electrical"|"combo", "label": "<permit name>",
   "issuingAgency": {"value": ..., "sourceUrl": "", "quote": ""},
   "portalUrl": {"value": "<url>"|null, "sourceUrl": "", "quote": "", "notFound": ""},
   "recordType": {"value": "<type>"|null, "sourceUrl": "", "quote": "", "notFound": ""}}]}`;

export const DOCS_FEES_LOOKUP_SYSTEM = `You look up, for ONE issuing agency, what a RESIDENTIAL ROOFTOP SOLAR PV permit application must include and what each permit costs.

For each permit named in the request (structural and/or electrical, or one combo permit):
- documents: the documents and NAMED forms the agency requires for that permit (e.g. "plan set", "prescriptive solar checklist (BCD 440-5952)", a named application form). Only what a source says the agency requires.
- fee: the agency's fee for THIS job (the request gives the system's DC kW, AC kVA and permit path). Give the total for the permit when the schedule prices it ("amountUsd"), the "basis" in words (e.g. "flat fee for prescriptive-path PV", "tier 5.01-15 kVA"), and "lines" (each printed line with its amount, including any state surcharge the same source states). For a tiered electrical fee also give "tiers": [{"maxKva": <number>, "amountUsd": <number>, "label": "<printed tier>"}].

You may OPEN (web_fetch) a few result pages — the agency's own fee schedule (often a PDF), its solar or permit checklist, its application page. Open only the agency's (or its state building agency's) own pages.

EVERY value carries "sourceUrl" (a page your search returned or you opened — the agency's own fee schedule or form is best) and "quote" (the exact printed words, under 250 characters; for a fee the quote must contain the amount). If a source does not state it, "value": null with "notFound". Never answer from memory. Never guess.

Return ONLY JSON:
{"permits": [{"discipline": "structural"|"electrical"|"combo",
  "documents": {"value": ["..."]|null, "sourceUrl": "", "quote": "", "notFound": ""},
  "fee": {"value": {"amountUsd": <number>|null, "basis": "", "lines": [{"label": "", "amountUsd": <number>}], "tiers": [{"maxKva": <number>, "amountUsd": <number>, "label": ""}]}|null, "sourceUrl": "", "quote": "", "notFound": ""}}]}`;

export const PORTAL_LOOKUP_SYSTEM = `You find WHERE ONE issuing agency takes RESIDENTIAL ROOFTOP SOLAR PV permit applications online, and the record type chosen there.

Start from the agency's own building/permit pages (they usually say "apply online at <portal>"); OPEN (web_fetch) them to read the link. A state-run or shared portal (a state ePermitting system, a county's citizen-access portal used by the cities it serves) is the right answer when the agency's own page says applications go there.

For each permit named in the request:
- portalUrl: the ONLINE PORTAL's entry page where that permit is APPLIED FOR (a citizen-access / self-service / permitting-system page). NEVER an information, help, FAQ or guide page, NEVER a PDF, and NEVER a utility's interconnection / net-metering portal.
- recordType: the record / permit type selected when applying ONLINE on that portal, in the portal's or the agency's own words (e.g. "Residential Electrical - Solar"). A paper application FORM's title is NOT a record type — if you only find form titles, set it to null.

EVERY value carries "sourceUrl" (a page your search returned or you opened) and "quote" (the exact words on that page that state it, under 250 characters: for a portal, the words naming or linking it; for a record type, the words naming it). If no page states it, "value": null with "notFound". Never answer from memory. Never guess.

Return ONLY JSON:
{"permits": [{"discipline": "structural"|"electrical"|"combo",
  "portalUrl": {"value": "<url>"|null, "sourceUrl": "", "quote": "", "notFound": ""},
  "recordType": {"value": "<type>"|null, "sourceUrl": "", "quote": "", "notFound": ""}}],
 "prerequisites": [{"value": "<a step at another office>", "sourceUrl": "", "quote": ""}]}`;

type RawFact = { value?: unknown; sourceUrl?: unknown; quote?: unknown; notFound?: unknown } | null | undefined;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const words = (s: string) => str(s).toLowerCase().replace(/[^a-z0-9.]+/g, " ").split(" ").filter((w) => w.length > 2 && !["the", "and", "for", "city", "county", "of"].includes(w));

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const t = str(text);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

/** A cited answer is kept only when it has a real source, a quote, the source is one the search
 *  returned (when we know them), and the quote itself supports the value. */
export function acceptCited<T>(
  raw: RawFact,
  opts: { seenUrls: string[]; supports: (value: T, quote: string) => boolean; coerce: (v: unknown) => T | null; what: string },
): CitedFact<T> {
  const notFound = (why: string): CitedFact<T> => ({ value: null, sourceUrl: str(raw?.sourceUrl), quote: str(raw?.quote).slice(0, 300), origin: "lookup", notFound: why });
  if (!raw || raw.value == null || raw.value === "") return notFound(str(raw?.notFound) || `no source stated the ${opts.what}`);
  const value = opts.coerce(raw.value);
  if (value == null) return notFound(`the ${opts.what} returned was not usable`);
  const sourceUrl = str(raw.sourceUrl);
  const quote = str(raw.quote).slice(0, 300);
  if (!/^https?:\/\//i.test(sourceUrl) || quote.length < 8) return notFound(`the ${opts.what} came without a source page and its words — not kept`);
  const host = portalHostOf(sourceUrl);
  // A PORTAL may cite itself (its own entry page) when it is a known permit platform; anything else
  // must be a page the search returned.
  const selfCitedPortal = opts.what === "portal" && isPermitPlatformUrl(sourceUrl) && portalHostOf(String(value)) === host;
  if (opts.seenUrls.length && !selfCitedPortal && !opts.seenUrls.some((u) => portalHostOf(u) === host)) {
    return notFound(`the ${opts.what}'s source (${host}) is not a page the search returned — not kept`);
  }
  if (!opts.supports(value, quote)) return notFound(`the quoted words do not state the ${opts.what} ("${quote.slice(0, 80)}")`);
  return { value, sourceUrl, quote, origin: "lookup" };
}

// The DISTINCTIVE words of a name must be in the quote ("Marion" of "Marion County Public Works –
// Building Inspection Division"); the generic organisational words need not be.
const GENERIC_ORG_WORDS = new Set(["public", "works", "building", "inspection", "inspections", "division", "department", "dept", "services", "service",
  "development", "community", "permit", "permits", "permitting", "office", "program", "codes", "code", "planning", "bureau", "agency", "government"]);
const supportsName = (value: string, quote: string) => {
  const w = words(value).filter((x) => !GENERIC_ORG_WORDS.has(x));
  const q = quote.toLowerCase();
  const need = w.length ? w : words(value);
  return need.length > 0 && need.every((x) => q.includes(x));
};
// A PREREQUISITE IS NEVER THE ISSUING AGENCY (Jefferson, OR: "Structural permits must be submitted
// to City Hall first before going to the County"). A quote whose every mention of the value sits in
// a prerequisite clause — named BEFORE a "first"/"before going to" marker, or as a zoning/land-use
// sign-off — does not state that the value ISSUES the permit. A name AFTER the marker (the county it
// then goes to) is the destination and still counts.
const PREREQ_MARKER = /\bfirst\b[^.;]{0,40}?\b(?:before|then|prior to)\b|\bbefore (?:going|submitting|applying|being (?:sent|submitted)|it goes|they go) to\b|\bprior to (?:submitting|applying|going)\b/i;
const ZONING_SIGNOFF = /\b(?:zoning|land[- ]use|planning)\s+(?:approval|sign[- ]?off|clearance|review|verification)\b/i;
export function namesOnlyAsPrerequisite(value: string, quote: string): boolean {
  const need = words(value).filter((x) => !GENERIC_ORG_WORDS.has(x));
  const w = need.length ? need : words(value);
  if (!w.length) return false;
  const mentions = str(quote).split(/(?<=[.;!?])\s+/).filter((s) => w.every((x) => s.toLowerCase().includes(x)));
  if (!mentions.length) return false;
  return mentions.every((s) => {
    const low = s.toLowerCase();
    const at = Math.min(...w.map((x) => low.indexOf(x)));
    const m = PREREQ_MARKER.exec(s);
    if (m && at < m.index) return true;
    return ZONING_SIGNOFF.test(s) && !/\bissu/i.test(s);
  });
}
const supportsAgency = (value: string, quote: string) => supportsName(value, quote) && !namesOnlyAsPrerequisite(value, quote);
const supportsPrerequisite = (value: string, quote: string) =>
  (PREREQ_MARKER.test(quote) || ZONING_SIGNOFF.test(quote) || /\b(?:approv|sign[- ]?off|clearance)/i.test(quote)) && words(value).some((w) => quote.toLowerCase().includes(w));

/** ONE door for a portal URL, used by the process part and the portal step alike: cited (acceptCited:
 *  a real source the search/fetch returned, words that name it), SOMEWHERE AN APPLICATION IS FILED,
 *  and on the PERMIT track (rule 5, portalChannel.hostFitsTrackAndEntity: never a utility /
 *  interconnection portal, never a help/guide page or document). */
export function acceptPortal(raw: RawFact, seenUrls: string[]): CitedFact<string> {
  const portal = acceptCited<string>(raw, {
    seenUrls, what: "portal", coerce: (v) => (/^https?:\/\//i.test(str(v)) ? str(v) : null),
    // A portal's own page, or a page that names the portal's host.
    supports: (v, q) => {
      const host = portalHostOf(v);
      return Boolean(host) && (q.toLowerCase().includes(host) || /portal|apply online|e-?permitting|citizen access|self[- ]?service|online permit|accela/i.test(q));
    },
  });
  if (!portal.value) return portal;
  const fit = hostFitsTrackAndEntity("building", null, portal.value, "research");
  if (!fit.fits) {
    const why = fit.code === "not_a_portal" ? `${portal.value} is an information page, not an application portal — not kept` : `${fit.reason} — not kept`;
    return { ...portal, value: null, notFound: why };
  }
  return portal;
}
/** A record type in the portal's or agency's words; a paper FORM's title is not one. */
const FORM_TITLE = /\b(?:form|application|checklist|worksheet|packet|affidavit)\b|\.pdf\b/i;
export function acceptRecordType(raw: RawFact, seenUrls: string[]): CitedFact<string> {
  const rt = acceptCited<string>(raw, { seenUrls, what: "record type", coerce: (v) => str(v) || null, supports: supportsName });
  if (rt.value && FORM_TITLE.test(rt.value)) return { ...rt, value: null, notFound: `"${rt.value}" is a form's title, not an online record type — not kept` };
  return rt;
}
function parsePrerequisites(raw: unknown, seenUrls: string[]): CitedFact<string>[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 5)
    .map((r) => acceptCited<string>(r as RawFact, { seenUrls, what: "prerequisite", coerce: (v) => str(v).slice(0, 200) || null, supports: supportsPrerequisite }))
    .filter((r) => r.value);
}

const supportsStructure = (value: string, quote: string) =>
  value === "separate"
    ? /separate|electrical (?:\w+ ){0,3}permits?|also (?:need|require)|in addition|two permits|each (?:require|need)|both (?:a )?(?:structural|building)/i.test(quote)
    : /combin|combo|single permit|one permit|includes? (?:the )?electrical/i.test(quote);
const supportsAmount = (fee: PermitFeeAnswer, quote: string) => {
  const amounts = [fee.amountUsd, ...fee.lines.map((l) => l.amountUsd)].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (!amounts.length) return false;
  const q = quote.replace(/,/g, "");
  return amounts.some((n) => q.includes(n.toFixed(2)) || q.includes(String(n)));
};
/** "Marion County (Marion County Public Works Building Inspection Division)" → "Marion County": the
 *  agency's NAME, which is what an address grid, a fee key and a person read. */
const agencyName = (v: unknown): string | null => {
  let s = str(v).replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+[–—-]\s+.*$/, "").replace(/,.*$/, "").trim();
  // "Marion County Building" / "Marion County Public Works Building Inspection" → "Marion County".
  const tokens = s.split(/\s+/);
  while (tokens.length > 1 && GENERIC_ORG_WORDS.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  s = tokens.join(" ");
  // A name made only of generic words ("Building Inspections Division" → "Building") names NO
  // agency: asking "Building" for documents/fees asks nobody. Not usable → NOT FOUND.
  if (!words(s).some((w) => !GENERIC_ORG_WORDS.has(w))) return null;
  return s || null;
};
const asDiscipline = (v: unknown): PermitProcessDiscipline | null => {
  const s = str(v).toLowerCase();
  if (/elec/.test(s)) return "electrical";
  if (/struct|build/.test(s)) return "structural";
  if (/combo|combin/.test(s)) return "combo";
  return s ? "other" : null;
};

export function parseProcessPart(text: string, seenUrls: string[], stopReason: string | null): {
  issuingAgency: CitedFact<string>; permitStructure: CitedFact<"separate" | "combo">; permits: PermitProcessPermitAnswer[]; prerequisites: CitedFact<string>[]; problem: string;
} {
  const truncated = stopReason === "max_tokens" || stopReason === "pause_turn";
  const json = parseJsonLoose(text);
  const nf = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
  if (!json) {
    const why = truncated ? "the lookup's answer was cut off before it finished — not kept" : "the lookup returned no readable answer";
    return { issuingAgency: nf(why), permitStructure: nf(why), permits: [], prerequisites: [], problem: why };
  }
  const issuingAgency = acceptCited<string>(json.issuingAgency as RawFact, { seenUrls, what: "issuing agency", coerce: agencyName, supports: supportsAgency });
  const permitStructure = acceptCited<"separate" | "combo">(json.permitStructure as RawFact, {
    seenUrls, what: "permit structure", coerce: (v) => (/separ/i.test(str(v)) ? "separate" : /combo|combin/i.test(str(v)) ? "combo" : null), supports: supportsStructure,
  });
  const permits: PermitProcessPermitAnswer[] = [];
  for (const p of (Array.isArray(json.permits) ? json.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    if (!discipline) continue;
    permits.push({
      discipline,
      label: str(p.label) || discipline,
      issuingAgency: acceptCited<string>(p.issuingAgency as RawFact, { seenUrls, what: "issuing agency", coerce: agencyName, supports: supportsAgency }),
      portalUrl: acceptPortal(p.portalUrl as RawFact, seenUrls),
      recordType: acceptRecordType(p.recordType as RawFact, seenUrls),
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not looked up yet" },
      fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not looked up yet" },
    });
  }
  return { issuingAgency, permitStructure, permits, prerequisites: parsePrerequisites(json.prerequisites, seenUrls), problem: truncated ? "answer was cut off (kept only fully parsed, cited values)" : "" };
}

/** The portal step's answer: per discipline, the cited portal and record type (the same doors as
 *  the process part), plus any cited prerequisite the agency's pages state. */
export function parsePortalPart(text: string, seenUrls: string[], stopReason: string | null): {
  byDiscipline: Map<PermitProcessDiscipline, { portalUrl: CitedFact<string>; recordType: CitedFact<string> }>; prerequisites: CitedFact<string>[]; problem: string;
} {
  const out = new Map<PermitProcessDiscipline, { portalUrl: CitedFact<string>; recordType: CitedFact<string> }>();
  const json = parseJsonLoose(text);
  if (!json) return { byDiscipline: out, prerequisites: [], problem: stopReason === "max_tokens" || stopReason === "pause_turn" ? "portal answer was cut off — not kept" : "portal lookup returned no readable answer" };
  for (const p of (Array.isArray(json.permits) ? json.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    if (!discipline) continue;
    out.set(discipline, { portalUrl: acceptPortal(p.portalUrl as RawFact, seenUrls), recordType: acceptRecordType(p.recordType as RawFact, seenUrls) });
  }
  return { byDiscipline: out, prerequisites: parsePrerequisites(json.prerequisites, seenUrls), problem: "" };
}

/** WHEN EVERY PERMIT'S CITED AGENCY AGREES and the top level found none, the top level is that
 *  agency, with the first permit's citation (Jefferson: both permits cited "Marion County", the
 *  top level came back null, and part two then asked the city). */
export function liftAgreedAgency(top: CitedFact<string>, permits: PermitProcessPermitAnswer[]): CitedFact<string> {
  if (top.value || !permits.length) return top;
  if (!permits.every((p) => p.issuingAgency.value)) return top;
  const names = new Set(permits.map((p) => normalizeAhjName(String(p.issuingAgency.value))));
  if (names.size !== 1) return top;
  const { notFound: _nf, ...cited } = permits[0].issuingAgency;
  return { ...cited, origin: "lookup" };
}

/** WHO TO ASK for documents, fees and the portal: the top-level agency; else the per-permit cited
 *  agencies (one group per distinct agency, at most MAX_AGENCY_GROUPS — a permit with no cited
 *  agency, or beyond the cap, joins the largest group); else the AHJ itself. */
export const MAX_AGENCY_GROUPS = 2;
export function agenciesToAsk(ahj: string, top: CitedFact<string>, permits: Array<Pick<PermitProcessPermitAnswer, "discipline" | "issuingAgency">>, disciplines: PermitProcessDiscipline[]): Array<{ agency: string; disciplines: PermitProcessDiscipline[] }> {
  if (top.value) return [{ agency: top.value, disciplines }];
  const groups = new Map<string, { agency: string; disciplines: PermitProcessDiscipline[] }>();
  for (const p of permits) {
    if (!p.issuingAgency.value) continue;
    const k = normalizeAhjName(p.issuingAgency.value);
    const g = groups.get(k) ?? { agency: p.issuingAgency.value, disciplines: [] };
    g.disciplines.push(p.discipline);
    groups.set(k, g);
  }
  if (!groups.size) return [{ agency: ahj, disciplines }];
  const ordered = [...groups.values()].sort((a, b) => b.disciplines.length - a.disciplines.length);
  const kept = ordered.slice(0, MAX_AGENCY_GROUPS);
  const placed = new Set(kept.flatMap((g) => g.disciplines));
  for (const d of disciplines) if (!placed.has(d)) kept[0].disciplines.push(d);
  return kept;
}

export function parseDocsFeesPart(text: string, seenUrls: string[], stopReason: string | null): {
  byDiscipline: Map<PermitProcessDiscipline, { documents: CitedFact<string[]>; fee: CitedFact<PermitFeeAnswer> }>; problem: string;
} {
  const out = new Map<PermitProcessDiscipline, { documents: CitedFact<string[]>; fee: CitedFact<PermitFeeAnswer> }>();
  const json = parseJsonLoose(text);
  if (!json) return { byDiscipline: out, problem: stopReason === "max_tokens" || stopReason === "pause_turn" ? "documents/fees answer was cut off — not kept" : "documents/fees lookup returned no readable answer" };
  for (const p of (Array.isArray(json.permits) ? json.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    if (!discipline) continue;
    const documents = acceptCited<string[]>(p.documents as RawFact, {
      seenUrls, what: "required documents",
      coerce: (v) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 20) : null),
      supports: (v, q) => v.some((d) => words(d).some((w) => q.toLowerCase().includes(w))),
    });
    const fee = acceptCited<PermitFeeAnswer>(p.fee as RawFact, {
      seenUrls, what: "fee",
      coerce: (v) => {
        const o = v as Record<string, unknown>;
        if (!o || typeof o !== "object") return null;
        const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : Number.isFinite(Number(x)) && str(x) !== "" ? Number(x) : null);
        const lines = (Array.isArray(o.lines) ? o.lines : []).map((l: Record<string, unknown>) => ({ label: str(l?.label), amountUsd: num(l?.amountUsd) as number })).filter((l) => l.label && l.amountUsd != null);
        const tiers = (Array.isArray(o.tiers) ? o.tiers : []).map((t: Record<string, unknown>) => ({ maxKva: num(t?.maxKva), amountUsd: num(t?.amountUsd), label: str(t?.label) }))
          .filter((t) => t.maxKva != null && t.amountUsd != null) as Array<{ maxKva: number; amountUsd: number; label: string }>;
        const answer: PermitFeeAnswer & { tiers?: typeof tiers } = { amountUsd: num(o.amountUsd), basis: str(o.basis), lines };
        if (tiers.length) answer.tiers = tiers;
        return answer.amountUsd == null && !lines.length && !tiers.length ? null : answer;
      },
      supports: supportsAmount,
    });
    out.set(discipline, { documents, fee });
  }
  return { byDiscipline: out, problem: "" };
}

export interface PermitProcessLookupRun {
  saved: boolean;
  reason: string;
  lookup: PermitProcessLookup | null;
  calls: Array<{ part: string; grounded: number; searches?: number; stopReason: string | null; error?: string; pagesRead: number; readPages?: boolean; agency?: string }>;
  /** The model's raw answers and the URLs its searches returned — for offline re-scoring only
   *  (never stored by the job). */
  raw?: { process: string; documentsFees: string; processUrls: string[]; documentsFeesUrls: string[]; portal?: string; portalUrls?: string[] };
}

/**
 * THE BOUND (per lookup, worst case). Calls: process 1 (+1 retry on an abort) + portal ≤ 2 + documents/
 * fees ≤ 2 = 6. Searches: 8 (+8) + 2×4 + 2×5 = 34. Page fetches (readPages): 2×3 + 2×3 = 12, each capped
 * at DESIGN_LOOKUP_MAX_PAGE_TOKENS. Time: the portal and documents/fees calls run CONCURRENTLY after
 * the process part, so wall time ≤ 2 × LOOKUP_PART_BUDGET_MS (process + retry) + one part budget =
 * 15 min at the 300 s default. Every call carries its own abort; an aborted/ungrounded call keeps
 * NOTHING (no search results → no value), so a timeout never saves a guess.
 */
const PORTAL_SEARCHES = 4;
const PORTAL_FETCHES = 3;
const DOCS_SEARCHES = 5;
const DOCS_FETCHES = 3;
const partBudgetMs = () => Math.max(300000, Number(process.env.PERMIT_PROCESS_LOOKUP_TIMEOUT_MS) || 0);
const seenOf = (r: WebLookupResult) => [...r.resultUrls, ...(r.fetchedUrls ?? [])];

/**
 * Run the lookup for one AHJ and land it. `force` re-runs over a seeded row (never over a verified
 * one — the write path refuses). System facts (DC kW / AC kVA / path) only shape the fee question.
 */
export async function runPermitProcessLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  input: { state: string; ahj: string; utility?: string; dcKw?: string | number; acKw?: string | number; permitPath?: string; force?: boolean },
): Promise<PermitProcessLookupRun> {
  const calls: PermitProcessLookupRun["calls"] = [];
  const existing = getPermitProcessLookup(db, input.state, input.ahj);
  if (existing?.confidence === "verified") return { saved: false, reason: "a person verified this AHJ's process", lookup: existing, calls };
  if (existing && !input.force) return { saved: false, reason: "already looked up (seeded)", lookup: existing, calls };
  if (!llm.webLookup) return { saved: false, reason: "no web lookup available (no model key)", lookup: existing, calls };
  const ask = llm.webLookup.bind(llm);
  const logCall = (part: string, r: WebLookupResult, extra: { readPages?: boolean; agency?: string } = {}) =>
    calls.push({ part, grounded: r.groundedSearches, searches: r.searches, stopReason: r.stopReason, error: r.error, pagesRead: r.pagesRead, ...extra });

  const where = `Jurisdiction: ${input.ahj}\nState: ${input.state}`;
  // Part one decides WHICH agency the later parts ask about, so an abort here is retried ONCE (an
  // abort is transient; an answer that ran and found nothing is not retried).
  const askProcess = () => ask({ label: "permitProcessLookup.process", system: PROCESS_LOOKUP_SYSTEM, user: where, maxTokens: 8000, maxSearches: 8, readPages: false, timeoutMs: partBudgetMs() });
  let p1 = await askProcess();
  logCall("process", p1, { readPages: false });
  if (p1.error && /abort|timeout|timed out|overloaded|5\d\d/i.test(p1.error)) {
    p1 = await askProcess();
    logCall("process (retry)", p1, { readPages: false });
  }
  const ungrounded = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
  const part1 = p1.groundedSearches > 0
    ? parseProcessPart(p1.text, seenOf(p1), p1.stopReason)
    : { issuingAgency: ungrounded(p1.error ? `lookup failed: ${p1.error.slice(0, 120)}` : "no web search returned results — nothing kept from memory"), permitStructure: ungrounded("no grounded search"), permits: [] as PermitProcessPermitAnswer[], prerequisites: [] as CitedFact<string>[], problem: p1.error ?? "ungrounded" };

  // ASK THE AGENCY THAT ISSUES EACH PERMIT. Lift an agency every permit agrees on; then group.
  const issuingAgency = liftAgreedAgency(part1.issuingAgency, part1.permits);
  const disciplines: PermitProcessDiscipline[] = part1.permits.length ? part1.permits.map((p) => p.discipline) : (part1.permitStructure.value === "combo" ? ["combo"] : ["structural", "electrical"]);
  const groups = agenciesToAsk(input.ahj, issuingAgency, part1.permits, disciplines);
  const byDiscipline = new Map(part1.permits.map((p) => [p.discipline, p] as const));
  const system = `System: ${str(input.dcKw) || "?"} kW DC, ${str(input.acKw) || "?"} kVA AC, permit path: ${str(input.permitPath) || "unknown"}`;

  // THE PORTAL IS ITS OWN GROUNDED STEP (reading the agency's pages), for the permits part one left
  // without a cited portal or record type; documents/fees read pages too. All run concurrently.
  const tasks: Array<Promise<{ kind: "portal" | "docs"; agency: string; disciplines: PermitProcessDiscipline[]; r: WebLookupResult }>> = [];
  for (const g of groups) {
    const needPortal = g.disciplines.filter((d) => !byDiscipline.get(d)?.portalUrl.value || !byDiscipline.get(d)?.recordType.value);
    const head = `Issuing agency: ${g.agency}\nFor permits in: ${input.ahj}, ${input.state}`;
    if (needPortal.length) {
      tasks.push(ask({ label: "permitProcessLookup.portal", system: PORTAL_LOOKUP_SYSTEM, user: `${head}\nPermits: ${needPortal.join(", ")}`, maxTokens: 6000, maxSearches: PORTAL_SEARCHES, readPages: true, maxFetches: PORTAL_FETCHES, timeoutMs: partBudgetMs() })
        .then((r) => ({ kind: "portal" as const, agency: g.agency, disciplines: needPortal, r })));
    }
    tasks.push(ask({ label: "permitProcessLookup.documentsFees", system: DOCS_FEES_LOOKUP_SYSTEM, user: `${head}\nPermits: ${g.disciplines.join(", ")}\n${system}`, maxTokens: 8000, maxSearches: DOCS_SEARCHES, readPages: true, maxFetches: DOCS_FETCHES, timeoutMs: partBudgetMs() })
      .then((r) => ({ kind: "docs" as const, agency: g.agency, disciplines: g.disciplines, r })));
  }
  const answers = await Promise.all(tasks);

  // Keyed by (agency, discipline): each group's answer fills only the permits asked of that agency.
  const portalFor = new Map<PermitProcessDiscipline, { portalUrl: CitedFact<string>; recordType: CitedFact<string> }>();
  const docsFor = new Map<PermitProcessDiscipline, { documents: CitedFact<string[]>; fee: CitedFact<PermitFeeAnswer> }>();
  const problems: string[] = [part1.problem];
  const prerequisites = [...part1.prerequisites];
  const raw = { process: p1.text, documentsFees: "", processUrls: p1.resultUrls, documentsFeesUrls: [] as string[], portal: "", portalUrls: [] as string[] };
  for (const a of answers) {
    logCall(a.kind === "portal" ? "portal" : "documentsFees", a.r, { readPages: true, agency: a.agency });
    const grounded = a.r.groundedSearches > 0;
    if (a.kind === "portal") {
      raw.portal += (raw.portal ? "\n" : "") + a.r.text;
      raw.portalUrls.push(...seenOf(a.r));
      const pp = grounded ? parsePortalPart(a.r.text, seenOf(a.r), a.r.stopReason) : { byDiscipline: new Map(), prerequisites: [], problem: a.r.error ?? "portal lookup ungrounded" };
      if (pp.problem) problems.push(pp.problem);
      prerequisites.push(...pp.prerequisites);
      for (const d of a.disciplines) {
        // A single combo answer covers each asked discipline only when that is all it answered.
        const hit = pp.byDiscipline.get(d) ?? (pp.byDiscipline.size === 1 && pp.byDiscipline.has("combo") ? pp.byDiscipline.get("combo") : undefined);
        if (hit) portalFor.set(d, hit);
      }
    } else {
      raw.documentsFees += (raw.documentsFees ? "\n" : "") + a.r.text;
      raw.documentsFeesUrls.push(...seenOf(a.r));
      const df = grounded ? parseDocsFeesPart(a.r.text, seenOf(a.r), a.r.stopReason) : { byDiscipline: new Map(), problem: a.r.error ?? "ungrounded" };
      if (df.problem) problems.push(df.problem);
      for (const d of a.disciplines) {
        const hit = df.byDiscipline.get(d);
        if (hit) docsFor.set(d, hit);
        else if (!docsFor.has(d)) docsFor.set(d, { documents: ungrounded(df.problem || "not found"), fee: ungrounded(df.problem || "not found") });
      }
    }
  }

  const permits: PermitProcessPermitAnswer[] = (part1.permits.length ? part1.permits : disciplines.map((d) => ({
    discipline: d, label: d as string,
    issuingAgency: ungrounded("not found"), portalUrl: ungrounded("not found"), recordType: ungrounded("not found"),
    documents: ungrounded("not found"), fee: ungrounded("not found"),
  }))).map((p) => {
    const pf = portalFor.get(p.discipline);
    const df = docsFor.get(p.discipline);
    return {
      ...p,
      // The portal step FILLS what part one could not cite; it never replaces a cited answer.
      portalUrl: p.portalUrl.value || !pf ? p.portalUrl : pf.portalUrl,
      recordType: p.recordType.value || !pf ? p.recordType : pf.recordType,
      documents: df?.documents ?? ungrounded("not found"),
      fee: df?.fee ?? ungrounded("not found"),
    };
  });
  const uniquePrereqs = prerequisites.filter((x, i) => prerequisites.findIndex((y) => str(y.value).toLowerCase() === str(x.value).toLowerCase()) === i);
  const notes = [
    ...problems.filter(Boolean),
    ...(issuingAgency !== part1.issuingAgency ? [`Issuing agency lifted from the permits' agreeing cited agencies (${issuingAgency.value}).`] : []),
    ...uniquePrereqs.map((x) => `Prerequisite: ${x.value} — ${x.sourceUrl}`),
  ];
  // A RE-RUN NEVER FORGETS A CITED ANSWER. Over an existing seeded row, a value this run could not
  // establish (an aborted part, a search that came up empty) keeps the earlier cited answer.
  const merged = mergeWithEarlier(existing, { issuingAgency, permitStructure: part1.permitStructure, permits });
  const res = savePermitProcessLookup(db, {
    state: input.state, ahj: input.ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: merged.issuingAgency, permitStructure: merged.permitStructure, permits: merged.permits, notes,
    prerequisites: uniquePrereqs.length ? uniquePrereqs : existing?.prerequisites,
  });
  if (res.saved && res.lookup) {
    try { applyLookupFees(db, res.lookup); } catch (err) { logger.warn("permit-process", `fee landing failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { saved: res.saved, reason: res.reason, lookup: res.lookup, calls, raw };
}

function keep<T>(now: CitedFact<T>, before: CitedFact<T> | undefined): CitedFact<T> {
  return now.value == null && before && before.value != null ? before : now;
}
export function mergeWithEarlier(
  earlier: PermitProcessLookup | null,
  now: { issuingAgency: CitedFact<string>; permitStructure: CitedFact<"separate" | "combo">; permits: PermitProcessPermitAnswer[] },
): typeof now {
  if (!earlier) return now;
  const permits = now.permits.map((p) => {
    const b = earlier.permits.find((e) => e.discipline === p.discipline);
    if (!b) return p;
    return {
      ...p, issuingAgency: keep(p.issuingAgency, b.issuingAgency), portalUrl: keep(p.portalUrl, b.portalUrl),
      recordType: keep(p.recordType, b.recordType), documents: keep(p.documents, b.documents), fee: keep(p.fee, b.fee),
    };
  });
  for (const b of earlier.permits) if (!permits.some((p) => p.discipline === b.discipline)) permits.push(b);
  return { issuingAgency: keep(now.issuingAgency, earlier.issuingAgency), permitStructure: keep(now.permitStructure, earlier.permitStructure), permits };
}

/** The lower bound a printed tier label states ("5.01 to 15 kva" → 5.01), through the same bounds
 *  grammar the fee-table reader and the portal-label binder use (pdfTables.parseBracketRow). */
export function printedMinKva(label: string | undefined): number | null {
  const text = str(label);
  if (!text) return null;
  try {
    const parsed = parseBracketRow({ row: { page: 1, y: 0, cells: [text], xs: [0], height: 10 }, matched: [], label: text, money: [], continuations: [], section: "" } as never);
    return typeof parsed.minKw === "number" && Number.isFinite(parsed.minKw) ? parsed.minKw : null;
  } catch {
    return null;
  }
}

const SURCHARGE_WORDS = /\bsurcharge/i;
/**
 * A STATE SURCHARGE THE AGENCY'S OWN SOURCE STATES (close M3: Marion County's E-01 prints "State
 * surcharge (12% of permit fee)"; the answer held $94 + $11.28, the schedule dropped it, and the
 * cited STATE_PERMIT_RULES surcharge was read nowhere). Applied only when ALL hold:
 *   - the state has a cited surcharge rule, and the percentage is within its maximum;
 *   - the fee's QUOTE (the words that passed acceptCited) itself prints a state surcharge AND its
 *     percentage — the basis prose and the line labels alone never apply one;
 *   - a surcharge line the answer itemised, if any, is that percentage of the base (±$0.02).
 * Anything short of that is left to the quote's "state surcharge not included" note.
 */
export function citedStateSurcharge(state: string, fee: CitedFact<PermitFeeAnswer>): { percent: number; quote: string; sourceUrl: string } | null {
  const rule = stateRulesFor(state).surcharge;
  const max = typeof rule?.value === "number" ? rule.value * 100 : null;
  if (max == null || !fee.value) return null;
  const quote = str(fee.quote);
  const m = /state\s+surcharge[^.;$]{0,40}?(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%[^.;$]{0,20}?state\s+surcharge/i.exec(quote);
  if (!m) return null;
  const percent = Number(m[1] ?? m[2]);
  if (!Number.isFinite(percent) || percent <= 0 || percent > max + 1e-9) return null;
  const lines = fee.value.lines ?? [];
  const sLine = lines.find((l) => SURCHARGE_WORDS.test(l.label ?? ""));
  if (sLine && typeof sLine.amountUsd === "number") {
    const base = lines.filter((l) => l !== sLine && !SURCHARGE_WORDS.test(l.label ?? "")).reduce((sum, l) => sum + (typeof l.amountUsd === "number" ? l.amountUsd : 0), 0);
    if (!(base > 0) || Math.abs(base * percent / 100 - sLine.amountUsd) > 0.02) return null;
  }
  return { percent, quote: m[0].trim(), sourceUrl: fee.sourceUrl };
}

/**
 * THE LOOKUP'S FEES LAND THROUGH THE FEE WRITE PATH. When a DIFFERENT agency issues the permits
 * (a county for a city), the AHJ's rows DELEGATE to that agency (collectedByProfileKey, sourced
 * by the agency answer's citation); the agency's per-discipline fees are saved under ITS key.
 * saveFeeSchedule keeps every refusal it owns (verified rows, open conflicts, unsourced fees).
 */
export function applyLookupFees(db: AppDb, lookup: PermitProcessLookup): Array<{ discipline: string; saved: boolean; reason: string }> {
  const out: Array<{ discipline: string; saved: boolean; reason: string }> = [];
  for (const permit of lookup.permits) {
    if (permit.discipline === "other") continue;
    const agency = permit.issuingAgency.value ? permit.issuingAgency : lookup.issuingAgency;
    const agencyName = str(agency.value);
    const delegates = agencyName && normalizeAhjName(agencyName) !== normalizeAhjName(lookup.ahj);
    const owner = delegates ? agencyName : lookup.ahj;
    if (delegates) {
      const r = saveFeeSchedule(db, { state: lookup.state, ahj: lookup.ahj, track: "permit", discipline: permit.discipline }, {
        found: true, reason: "", basis: "other", brackets: [], sourceUrl: agency.sourceUrl, sourceQuote: agency.quote, sourceKind: "official",
        collectedByProfileKey: feeScheduleProfileKey({ state: lookup.state, ahj: agencyName }, "permit"),
        notes: `Per-job lookup: ${agencyName} issues ${lookup.ahj}'s ${permit.discipline} permits.`,
      });
      out.push({ discipline: `${permit.discipline} (delegation)`, saved: r.saved, reason: r.reason ?? "" });
    }
    const fee = permit.fee;
    if (!fee.value) continue;
    const tiers = (fee.value as PermitFeeAnswer & { tiers?: Array<{ maxKva: number; amountUsd: number; label: string }> }).tiers ?? [];
    // THE PRINTED LOWER BOUND, NOT THE PREVIOUS ROW'S UPPER ONE (close M1). "5.01 to 15 kva" is the
    // row the agency's fee table and its portal's quantity box both print; writing its lower bound
    // as 5 made this project's bracket keys (feeBracketQuantity:5-15) differ from the SAME row as a
    // recorded recipe names it (5.01-15), so a borrowed recipe's recorded quantity replayed
    // unbound. The previous row's upper bound is only the fallback for a label that prints none.
    const surcharge = citedStateSurcharge(lookup.state, fee);
    // With a surcharge applied by the evaluator, a flat fee's bracket is the BASE line (the
    // surcharge's own line and a total that already includes it would count it twice).
    const baseLine = fee.value.lines.find((l) => !SURCHARGE_WORDS.test(l.label ?? "") && typeof l.amountUsd === "number");
    const brackets = tiers.length
      ? tiers.map((t, i) => ({ minKw: printedMinKva(t.label) ?? (i === 0 ? 0 : tiers[i - 1].maxKva), maxKw: t.maxKva, feeUsd: t.amountUsd, label: t.label || `up to ${t.maxKva} kVA` }))
      : [{
        feeUsd: (surcharge && baseLine ? baseLine.amountUsd : null) ?? fee.value.amountUsd ?? fee.value.lines[0]?.amountUsd ?? NaN,
        label: (surcharge && baseLine ? baseLine.label : "") || fee.value.lines[0]?.label || fee.value.basis || `${permit.label} fee`,
      }];
    const r = saveFeeSchedule(db, { state: lookup.state, ahj: owner, track: "permit", discipline: permit.discipline }, {
      found: true, reason: "", basis: tiers.length ? "system_kw" : "flat", brackets, sourceUrl: fee.sourceUrl, sourceQuote: fee.quote, sourceKind: "official",
      notes: `Per-job lookup (seeded): ${fee.value.basis}`.slice(0, 400),
    }, surcharge ? { citedStateSurcharge: surcharge } : {});
    out.push({ discipline: permit.discipline, saved: r.saved, reason: r.reason ?? "" });
  }
  return out;
}

/**
 * THE TRIGGER (project creation / first QC): enqueue the lookup for an AHJ that has no process of its
 * own — no lookup row, no hand-written profile, no seeded process profile — when a model key and the
 * job worker are available. Returns true when a lookup was queued (the caller then leaves fee
 * research to the lookup job, which knows WHICH agency to research).
 */
export async function ensurePermitProcessLookedUp(
  db: AppDb,
  project: { id: string; state: string; ahj: string; utility?: string; parserSnapshot?: Record<string, unknown> },
): Promise<boolean> {
  if (process.env.PERMIT_PROCESS_LOOKUP === "off" || !process.env.ANTHROPIC_API_KEY) return false;
  const ahj = str(project.ahj);
  if (!ahj || !str(project.state)) return false;
  if (getPermitProcessLookup(db, project.state, ahj)) return false;
  try {
    const { findAhjProcessProfile } = await import("./processProfiles");
    if (findAhjProcessProfile(project as never)) return false;
    const jobQueue = await import("./jobQueue");
    if (!jobQueue.jobWorkerRunning()) return false;
    const key = `${str(project.state).toLowerCase()}|${normalizeAhjName(ahj)}`;
    const recent = db.get<{ id: string }>(
      "SELECT id FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ? AND (status IN ('pending','running') OR created_at > ?) LIMIT 1",
      [`%"lookupKey":${JSON.stringify(key)}%`, new Date(Date.now() - 24 * 3600 * 1000).toISOString()],
    );
    if (recent) return true;
    const snap = project.parserSnapshot ?? {};
    jobQueue.enqueueJob(db, "permit_process_lookup", {
      state: str(project.state), ahj, utility: str(project.utility), lookupKey: key,
      dcKw: str(snap.dcKw ?? snap.systemSizeDcKw), acKw: str(snap.acKw ?? snap.systemSizeAcKw), permitPath: str(snap.permitPath),
    }, { priority: 3, maxRetries: 2, projectId: project.id });
    logger.info("permit-process", `per-job permit-process lookup queued for ${ahj} (${project.state})`);
    return true;
  } catch {
    return false;
  }
}
