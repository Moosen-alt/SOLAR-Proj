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
import { hostFitsTrackAndEntity, isInformationalPageUrl, isPathTenantedHost, isPermitPlatformUrl, isVendorDomain, isVendorRootOrMarketing, portalHostOf, portalTenantKey, portalTenantOf, salesforceTenantKind, trackSafeUrl, type PortalEntity } from "./portalChannel";
import { ahjNameCore, getPermitProcessLookup, normalizeAhjName, savePermitProcessLookup, stateRulesFor } from "./permitProcess";
import { CONNECTOR_WORDS, DEPARTMENT_WORDS, GENERIC_ORG_WORDS, agencyNameKey, sameAgencyName, stripDepartmentPhrase } from "./agencyName";
// Re-exported: the agency-name identity helpers moved to agencyName.ts (pure, no lookup stack) so
// permitProcess can ask the same question without importing this module back (a cycle).
export { agencyNameKey, sameAgencyName };
import { logger } from "./logger";
import { feeScheduleProfileKey, saveFeeSchedule } from "./feeSchedules";
import { parseBracketRow } from "./pdfTables";
import { candidateNamedBy, chooseRecordType, classifyDocument, DOCUMENT_URL, staleOrOtherFeeSource, detectPlatform, documentLinks, excerptFor, extractCodeEditions, extractPrerequisites, isAgencyOwnUrl, isOfficialAgencyHost, linksAnotherModule, platformOfUrl, readPortalCatalog, registrableDomain, resolvePortalFromPages, solarRecordTypeCandidates, tenantContradictsAgency, wordsNameAnotherJurisdiction, type PortalCatalog, type PortalResolution, type RecordTypeCandidate } from "./permitPlatformCatalog";
import { createPageReader, feeLinePrintedTogether, quoteOnPage, type PageReader, type ReadPage } from "./agencyPageReader";
import { documentFetchDisabled } from "./documentFetch";
export { registrableDomain };

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
  // EVERY source — a portal citing its own entry page included — must be a page the search returned
  // or the lookup opened (seenUrls carries both). The old exemption let a known-platform URL cite
  // itself unseen, which is a door for a remembered URL ("aca.accela.com/<tenant>"); and an empty
  // seen list is not a pass.
  if (!opts.seenUrls.some((u) => portalHostOf(u) === host)) {
    return notFound(`the ${opts.what}'s source (${host}) is not a page the search returned — not kept`);
  }
  if (!opts.supports(value, quote)) return notFound(`the quoted words do not state the ${opts.what} ("${quote.slice(0, 80)}")`);
  return { value, sourceUrl, quote, origin: "lookup" };
}

// The DISTINCTIVE words of a name must be in the quote ("Marion" of "Marion County Public Works –
// Building Inspection Division"); the generic organisational words need not be.
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

// "A host where one instance serves many agencies" and "a vendor's domain" are portalChannel's
// isPathTenantedHost / isVendorDomain — ONE definition each (lookup-close-5 MF2: this door kept its
// own two lists beside the catalog's and the platform list's, and mygov.us / mygovernmentonline.org /
// geocivix / bsaonline fell between them).
/** ONE door for a portal URL, used by the process part and the portal step alike: cited (acceptCited:
 *  a real source the search/fetch returned, words that name it), SOMEWHERE AN APPLICATION IS FILED,
 *  and on the PERMIT track (rule 5, portalChannel.hostFitsTrackAndEntity: never a utility /
 *  interconnection portal, never a help/guide page or document). */
// A PLATFORM PAGE CITING ITSELF (lookup-recall-2, R3): a portal URL whose own page WE READ and whose
// markers name a permit platform (ACA / EnerGov / …) — e.g. an Accela Citizen Access tenant on the
// city's own domain, cited by itself with its menu words ("Building Application Engineering
// Application …") — supports itself: our read attests what it is, not the model's quote. It still
// passes the attestation above and rule 5 below (a utility portal or a help page never passes).
// `platformPages` holds the URLs we read and found a platform on (host, and tenant on a shared host).
// ── THE ONE PORTAL DOOR (lookup-close-4, D1) ───────────────────────────────────────────────
// Four rounds patched the portal doors one path at a time (the process part, the portal step, the
// page-read resolver, the model-cited catalog) and each time a sibling path lacked the last guard.
// Now ONE function judges EVERY candidate at the ONE place a permit's portalUrl is assigned
// (finalPortal in runPermitProcessLookup), whatever its source, and the parse-time doors are the
// same function with what they know at parse time. It asks, in order:
//   (a) RULE 5 — hostFitsTrackAndEntity on the permit track: never a utility / interconnection
//       portal, never a help page or a document; a Salesforce site only on the government
//       allowlist or a human-VERIFIED KB row for this AHJ (ctx.entity).
//   (b) ATTESTATION — the portal's own host (its tenant, on a shared host) is a search result or a
//       page the model fetched or we read; or the agency's own seen page, on the same organisation's
//       domain, quotes a link on that domain (eba6fa0); or a page WE READ links exactly this URL
//       (0b5c967: the resolver's evidence, now an explicit kind, ctx.agencyLinks). A citing page
//       that merely says "apply online" never vouches for a URL the model wrote itself.
//   (c) JURISDICTION TYPE — a tenant, an own-domain label or the quote's words whose type word
//       contradicts the type of the jurisdiction that ISSUES THIS PERMIT is another jurisdiction's
//       portal: for a permit the AHJ / its top-level agency issues, ctx.typeNames = [AHJ, top agency]
//       (MARIONCOUNTY is never the City of Marion's own portal, whoever cites it); for a permit
//       another cited agency issues, that agency alone (its portal serves only its permit).
//   (d) THE SOURCE IS NAMED: the decision carries where the portal came from and what attested it,
//       and the caller writes it into the saved notes.
export type PortalCandidateSource = "process part" | "portal step" | "agency page (our read)";
export interface PortalDoorContext {
  /** Search results, pages the model fetched, pages we read. */
  seenUrls: string[];
  /** URLs we read whose own markers name a permit platform (the R3 self-citation door). */
  platformPages?: string[];
  /** Links on pages WE read (page -> href): a page we read linking exactly the URL attests it. */
  agencyLinks?: Array<{ page: string; href: string }>;
  /** Every name in play (the AHJ, the top agency, this permit's agency) — their distinctive keys. */
  names?: string[];
  /** The names whose jurisdiction TYPE the portal must not contradict (see (c)); no type check when empty. */
  typeNames?: string[];
  /** This AHJ's KB evidence (verified rows) for rule 5's Salesforce carve-out and the verified-portal rule. */
  entity?: PortalEntity | null;
}
/** Why the door refused: OUTRIGHT — rule 5, the vendor's own site, a deep link into another module,
 *  the issuer's jurisdiction type — no further evidence changes it, so the caller neither reads that
 *  tenant's pages nor its catalog (lookup-close-5 MF1); or for want of evidence (unattested / uncited),
 *  which a later search result or a page we read may supply; or "none" (nothing claimed). */
export type PortalRefusal = "rule5" | "vendor" | "module" | "type" | "unattested" | "uncited" | "none";
export const OUTRIGHT_REFUSALS: ReadonlySet<PortalRefusal | "ok"> = new Set<PortalRefusal | "ok">(["rule5", "vendor", "module", "type"]);
export interface PortalDecision {
  fact: CitedFact<string>;
  source: PortalCandidateSource;
  /** How the accepted portal's host was attested (null when refused). */
  attestedBy: string | null;
  /** "ok", or why it was refused (PortalRefusal). */
  code: PortalRefusal | "ok";
}
export function acceptPortalForPermit(raw: RawFact, source: PortalCandidateSource, ctx: PortalDoorContext): PortalDecision {
  const claimed = str(raw?.value);
  const url = /^https?:\/\//i.test(claimed) ? claimed : "";
  // A portal refused for want of EVIDENCE (unattested / uncited) was still NAMED by a source: the
  // fact keeps the claim (CitedFact.claimed), so "named, not kept" is never read as "nothing named"
  // (permitProcess.statewidePortalFor — portal-truth D1).
  const refused = (code: PortalRefusal, notFound: string): PortalDecision => ({
    fact: { value: null, sourceUrl: str(raw?.sourceUrl), quote: str(raw?.quote).slice(0, 300), origin: "lookup", notFound, ...(url && (code === "unattested" || code === "uncited") ? { claimed: url } : {}) },
    source, attestedBy: null, code,
  });
  const host = portalHostOf(url);
  const quote = str(raw?.quote).slice(0, 300);
  const platformPages = ctx.platformPages ?? [];
  let attestedBy: string | null = null;
  if (host) {
    // THE OUTRIGHT QUESTIONS FIRST — no search result or page read changes their answer, and the
    // caller reads a refused tenant's pages for nothing (close-5 MF1).
    // (a) RULE 5, with this AHJ's verified evidence when the caller has it.
    const fit = hostFitsTrackAndEntity("building", ctx.entity ?? null, url, "research");
    if (!fit.fits) {
      return refused("rule5", fit.code === "not_a_portal" ? `${url} is an information page, not an application portal — not kept` : `${fit.reason} — not kept`);
    }
    // (a'') THE VENDOR'S OWN SITE (lookup-close-6 MF4): a permit-software vendor's marketing page
    // (www.tylertech.com/products/…, www.cityview.com/solutions/permitting — its words say "online
    // permit portal") or a shared instance naming no tenant is nobody's application portal, whoever
    // cites it — the same predicate the page-read resolver asks (isVendorRootOrMarketing). A platform
    // host was exempt from the information-page rule, so nothing else asked this at the door.
    if (isVendorDomain(host) && isVendorRootOrMarketing(url)) {
      return refused("vendor", `${url} is the permit-software vendor's own site (its marketing / root page, or a shared instance naming no tenant), not an agency's application portal — not kept`);
    }
    // (a') A DEEP LINK INTO ANOTHER MODULE of the tenant (module=Licenses / Enforcement …, close-2
    // V8b) is not the permit portal, whoever cites it — the same predicate the page-read resolver asks.
    if (linksAnotherModule(url)) {
      return refused("module", `${url} is a deep link into another module of the portal (licences / enforcement / business …), not where a permit is filed — not kept`);
    }
    // (c) JURISDICTION TYPE against the issuer of THIS permit.
    const typeNames = (ctx.typeNames ?? []).filter(Boolean);
    if (typeNames.length) {
      const names = [...new Set([...typeNames, ...(ctx.names ?? [])].filter(Boolean))];
      const byTenant = tenantContradictsAgency(url, names, typeNames);
      const byWords = wordsNameAnotherJurisdiction(quote, names, typeNames);
      if (byTenant || byWords) {
        return refused("type", `${url} is another jurisdiction's portal (${byTenant ? "its tenant / domain" : "the words citing it"} name a different jurisdiction type than ${typeNames.join(" / ")}, which issues this permit) — not kept`);
      }
    }
    // (b) THE PORTAL'S OWN HOST MUST BE ATTESTED (close MF2): a search result or a page the lookup
    // opened on that host — on a path-tenanted host (one Accela / citizenserve / MyGov instance
    // serving many agencies) that same TENANT. The one other page-quoted attestation: the AGENCY'S
    // OWN page (a seen source on the same organisation's domain, never a vendor's) quotes a link on
    // that organisation's domain — a county page linking citizenaccess.<county>.gov. A vendor-hosted
    // URL (aca-prod.accela.com/<tenant>, *.tylerhost.net, <tenant>.geocivix.com) written into a page's
    // quote is the model's word, not the page's — unless a page WE read links it (agencyLinks).
    const shared = isPathTenantedHost(host);
    const sourceHost = portalHostOf(str(raw?.sourceUrl));
    const seenSelf = ctx.seenUrls.some((u) => portalHostOf(u) === host && (!shared || portalTenantKey(u) === portalTenantKey(url)));
    const ownDomainLink = !shared && !isVendorDomain(host) && registrableDomain(host) === registrableDomain(sourceHost)
      && quote.toLowerCase().includes(host) && ctx.seenUrls.some((u) => portalHostOf(u) === sourceHost);
    const linkedFrom = (ctx.agencyLinks ?? []).find((l) => pageKey(l.href) === pageKey(url));
    attestedBy = seenSelf ? (shared ? "its tenant on the shared host was a search result / a page opened or read" : "its host was a search result / a page opened or read")
      : ownDomainLink ? `the agency's own seen page (${sourceHost}) quotes this link on its own domain`
        : linkedFrom ? `a page we read links it (${linkedFrom.page})` : null;
    if (!attestedBy) {
      return refused("unattested", `the portal ${url} was never returned by the search, opened by the lookup, or linked by a page we read${shared ? " (that tenant on the shared host)" : ""} — not kept`);
    }
  }
  const portal = acceptCited<string>(raw, {
    seenUrls: ctx.seenUrls, what: "portal", coerce: (v) => (/^https?:\/\//i.test(str(v)) ? str(v) : null),
    // A portal's own page, or a page that names the portal's host.
    supports: (v, q) => {
      const h = portalHostOf(v);
      if (!h) return false;
      const selfCited = portalHostOf(str(raw?.sourceUrl)) === h
        && platformPages.some((u) => portalHostOf(u) === h && (!isPathTenantedHost(h) || portalTenantKey(u) === portalTenantKey(v)));
      return selfCited || q.toLowerCase().includes(h) || /portal|apply online|e-?permitting|citizen access|self[- ]?service|online permit|accela/i.test(q);
    },
  });
  if (!portal.value) {
    const none = raw?.value == null || raw.value === "";
    return { fact: none || !url ? portal : { ...portal, claimed: url }, source, attestedBy: null, code: none ? "none" : "uncited" };
  }
  return { fact: portal, source, attestedBy, code: "ok" };
}
/** DOES A REDIRECT'S LANDING NAME THIS JURISDICTION (portal-truth D3)? Its tenant on a shared
 *  instance ("aca-prod.accela.com/CORVALLIS"), an official agency host of it, or the landing page's
 *  own title / opening words ("City of Corvallis - Permit System"). Another city's tenant or a
 *  vendor's site names none of them — a named URL landing there is not this AHJ's portal. */
export function landingNamesJurisdiction(url: string, page: Pick<ReadPage, "title" | "text">, names: string[], state?: string): boolean {
  const cores = [...new Set(names.map(ahjNameCore).filter((c) => c.length >= 4))];
  if (!cores.length) return false;
  const tenant = portalTenantOf(url).replace(/[^a-z0-9]/g, "");
  if (tenant && cores.some((c) => tenant.includes(c))) return true;
  const host = portalHostOf(url);
  if (host && !isVendorDomain(host) && isOfficialAgencyHost(host, names, state)) return true;
  const words = `${str(page.title)} ${str(page.text).slice(0, 3000)}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cores.some((c) => words.includes(c));
}
/** The parse-time door (the process part, the portal step): the same function with what parse time
 *  knows — attestation and rule 5; the issuer's jurisdiction type is judged at finalPortal. */
export function acceptPortal(raw: RawFact, seenUrls: string[], platformPages: string[] = [], entity: PortalEntity | null = null): CitedFact<string> {
  return acceptPortalForPermit(raw, "process part", { seenUrls, platformPages, entity }).fact;
}
/** THE ONE RECORD-TYPE PREDICATE (lookup-close-6 MF1): a record type is what is selected ON a
 *  portal, so it belongs to the SAVED portal's tenant — and every source of one is judged by this,
 *  whether the portal's own catalog, part one's cited type, the portal step's, the earlier row's
 *  (mergeWithEarlier) or the "is a record type still needed" question. It holds only when a portal is
 *  saved for the permit AND the type's source page is
 *    - that portal's own tenant (the same host; on a path-tenanted host the same tenant): the
 *      catalog's module page, a public record on it; or
 *    - the ISSUING AGENCY'S OWN page — its own domain by name (isAgencyOwnUrl: isAgencyOwnDomain on every TLD, any
 *      .gov is not enough, lookup-close-7 R1) — naming no other jurisdiction (its words about its
 *      portal: "select Residential Solar") — never a vendor's host (another tenant's module page, the
 *      vendor's site) and never a page whose domain or words name another jurisdiction.
 *  Nothing holds with no saved portal: a county tenant's type beside a refused county portal
 *  (the close-5 skeptic's S1a / S1b), or an earlier row's type beside this run's other portal (S1d),
 *  is not the permit's record type. */
export function recordTypeBelongsToPortal(
  rt: Pick<CitedFact<string>, "value" | "sourceUrl" | "quote"> | null | undefined,
  portalUrl: string | null | undefined,
  ctx: { names?: string[]; typeNames?: string[]; state?: string } = {},
): boolean {
  if (!rt?.value) return false;
  const portal = str(portalUrl);
  const portalHost = portalHostOf(portal);
  const source = str(rt.sourceUrl);
  const sourceHost = portalHostOf(source);
  if (!portalHost || !sourceHost) return false;
  if (sourceHost === portalHost) return !isPathTenantedHost(portalHost) || portalTenantKey(source) === portalTenantKey(portal);
  if (isVendorDomain(sourceHost) || isPathTenantedHost(sourceHost)) return false;
  const names = (ctx.names ?? []).filter(Boolean);
  const typeNames = (ctx.typeNames ?? names).filter(Boolean);
  // THIS agency's own domain (lookup-close-7 R1) — never merely any .gov: another town's .gov page, or the
  // state's page for a permit the city issues, is not where this portal's record type is named.
  return isAgencyOwnUrl(source, names, ctx.state, typeNames) && !wordsNameAnotherJurisdiction(str(rt.quote), names, typeNames);
}
/** The same, as the not-found a refused record type is saved with. */
export function recordTypeForPortal(rt: CitedFact<string> | null, portalUrl: string | null | undefined, ctx: { names?: string[]; typeNames?: string[]; state?: string } = {}): CitedFact<string> | null {
  if (!rt?.value || recordTypeBelongsToPortal(rt, portalUrl, ctx)) return rt;
  const why = portalHostOf(str(portalUrl))
    ? `the record type "${rt.value}" is cited to ${portalHostOf(rt.sourceUrl) || "no page"} — neither the saved portal's own tenant (${portalHostOf(str(portalUrl))}) nor the issuing agency's own page — not kept`
    : `the record type "${rt.value}" is what is selected on a portal, and no portal was kept for this permit — not kept`;
  // The refused citation's page is not the record type's source: the reason names it; the fact does not.
  return { ...rt, value: null, sourceUrl: "", quote: "", notFound: why };
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
/** Every number the quote PRINTS (commas dropped), whole tokens only — "$5,001" is 5001, never 50;
 *  a percentage is not an amount. */
export function printedAmounts(quote: string): number[] {
  return [...quote.replace(/,/g, "").matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d%]|\.\d|\s*%)/g)].map((m) => Number(m[1]));
}
/** EVERY AMOUNT KEPT IS PRINTED (close MF1): each line and each tier must be in the quote, and the
 *  total must be printed too or be exactly the sum of its printed lines ($67.25 + $8.07). One printed
 *  number never vouches for an invented one beside it (a job-computed $216 "per kW" line, a $50 the
 *  quote does not carry). */
export const supportsAmount = (fee: PermitFeeAnswer, quote: string) => {
  const printed = printedAmounts(quote);
  const has = (n: number) => printed.some((p) => Math.abs(p - n) < 0.005);
  const lines = fee.lines.map((l) => l.amountUsd).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const tiers = ((fee as PermitFeeAnswer & { tiers?: Array<{ amountUsd: number }> }).tiers ?? []).map((t) => t.amountUsd);
  const total = typeof fee.amountUsd === "number" && Number.isFinite(fee.amountUsd) ? fee.amountUsd : null;
  if (total == null && !lines.length && !tiers.length) return false;
  if (![...lines, ...tiers].every(has)) return false;
  if (total != null && !has(total) && !(lines.length > 1 && Math.abs(lines.reduce((s, n) => s + n, 0) - total) < 0.01)) return false;
  return true;
};
/** A fee priced by valuation or by a rate (per kW, per $1,000, per sq ft, "each additional") has no
 *  flat amount — one printed row of it is never the job's fee. */
const RATED_FEE = /valuation|project cost|construction cost|each additional|for the first \$|per\s+(?:kw|kilowatt|watt|sq|square|\$?1,?000|thousand|hour)|\/\s*kw\b|square\s*f(?:ee|oo)t|sq\.?\s*ft/i;
/** "Marion County (Marion County Public Works Building Inspection Division)" → "Marion County": the
 *  agency's NAME, which is what an address grid, a fee key and a person read. */
const agencyName = (v: unknown): string | null => {
  let s = str(v).replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+[–—\-/|]\s+.*$/, "").replace(/,.*$/, "").replace(/[\s/|:;.,\-–—]+$/, "").trim();
  // "Marion County Building" / "Marion County Public Works Building Inspection" / "City of
  // Charleston Permit Center" → the name (DEPARTMENT_WORDS, the set agencyNameKey reads); never
  // through a connector ("Idaho Division of Building Safety" stays whole — MF6).
  s = stripDepartmentPhrase(s.split(/\s+/), false).join(" ");
  // A name made only of generic words ("Building Inspections Division" → "Building", "Department of
  // Building and Safety") names NO agency: asking it for documents/fees asks nobody. Not usable →
  // NOT FOUND.
  if (!words(s).some((w) => !DEPARTMENT_WORDS.has(w) && !CONNECTOR_WORDS.has(w))) return null;
  return s || null;
};
const asDiscipline = (v: unknown): PermitProcessDiscipline | null => {
  const s = str(v).toLowerCase();
  if (/elec/.test(s)) return "electrical";
  if (/struct|build/.test(s)) return "structural";
  if (/combo|combin/.test(s)) return "combo";
  return s ? "other" : null;
};

export function parseProcessPart(text: string, seenUrls: string[], stopReason: string | null, platformPages: string[] = [], entity: PortalEntity | null = null): {
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
      portalUrl: acceptPortal(p.portalUrl as RawFact, seenUrls, platformPages, entity),
      recordType: acceptRecordType(p.recordType as RawFact, seenUrls),
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not looked up yet" },
      fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not looked up yet" },
    });
  }
  return { issuingAgency, permitStructure, permits, prerequisites: parsePrerequisites(json.prerequisites, seenUrls), problem: truncated ? "answer was cut off (kept only fully parsed, cited values)" : "" };
}

/** The portal step's answer: per discipline, the cited portal and record type (the same doors as
 *  the process part), plus any cited prerequisite the agency's pages state. */
export function parsePortalPart(text: string, seenUrls: string[], stopReason: string | null, platformPages: string[] = [], entity: PortalEntity | null = null): {
  byDiscipline: Map<PermitProcessDiscipline, { portalUrl: CitedFact<string>; recordType: CitedFact<string> }>; prerequisites: CitedFact<string>[]; problem: string;
} {
  const out = new Map<PermitProcessDiscipline, { portalUrl: CitedFact<string>; recordType: CitedFact<string> }>();
  const json = parseJsonLoose(text);
  if (!json) return { byDiscipline: out, prerequisites: [], problem: stopReason === "max_tokens" || stopReason === "pause_turn" ? "portal answer was cut off — not kept" : "portal lookup returned no readable answer" };
  for (const p of (Array.isArray(json.permits) ? json.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    if (!discipline) continue;
    out.set(discipline, { portalUrl: acceptPortal(p.portalUrl as RawFact, seenUrls, platformPages, entity), recordType: acceptRecordType(p.recordType as RawFact, seenUrls) });
  }
  return { byDiscipline: out, prerequisites: parsePrerequisites(json.prerequisites, seenUrls), problem: "" };
}

/** WHEN EVERY PERMIT'S CITED AGENCY AGREES and the top level found none, the top level is that
 *  agency, with the first permit's citation (Jefferson: both permits cited "Marion County", the
 *  top level came back null, and part two then asked the city). */
export function liftAgreedAgency(top: CitedFact<string>, permits: PermitProcessPermitAnswer[]): CitedFact<string> {
  if (top.value || !permits.length) return top;
  if (!permits.every((p) => p.issuingAgency.value)) return top;
  // "Agree" is the ONE identity predicate (lookup-close-6 MF7: a key-equality copy here split
  // "City of Venus" from "Town of Venus" and blocked the lift).
  const first = permits[0].issuingAgency.value as string;
  if (!permits.every((p) => sameAgencyName(p.issuingAgency.value, first))) return top;
  const { notFound: _nf, ...cited } = permits[0].issuingAgency;
  return { ...cited, origin: "lookup" };
}

/** WHO TO ASK for documents, fees and the portal: the top-level agency; else the per-permit cited
 *  agencies (one group per distinct agency — sameAgencyName — at most MAX_AGENCY_GROUPS; a permit
 *  with no cited agency, or beyond the cap, joins the largest group); else the AHJ itself. */
export const MAX_AGENCY_GROUPS = 2;
export function agenciesToAsk(ahj: string, top: CitedFact<string>, permits: Array<Pick<PermitProcessPermitAnswer, "discipline" | "issuingAgency">>, disciplines: PermitProcessDiscipline[]): Array<{ agency: string; disciplines: PermitProcessDiscipline[] }> {
  if (top.value) return [{ agency: top.value, disciplines }];
  const groups: Array<{ agency: string; disciplines: PermitProcessDiscipline[] }> = [];
  for (const p of permits) {
    if (!p.issuingAgency.value) continue;
    let g = groups.find((x) => sameAgencyName(x.agency, p.issuingAgency.value));
    if (!g) { g = { agency: p.issuingAgency.value, disciplines: [] }; groups.push(g); }
    g.disciplines.push(p.discipline);
  }
  if (!groups.length) return [{ agency: ahj, disciplines }];
  const ordered = [...groups].sort((a, b) => b.disciplines.length - a.disciplines.length);
  const kept = ordered.slice(0, MAX_AGENCY_GROUPS);
  const placed = new Set(kept.flatMap((g) => g.disciplines));
  for (const d of disciplines) if (!placed.has(d)) kept[0].disciplines.push(d);
  return kept;
}

/** A cited answer whose source is a page WE READ must quote words that are on that page
 *  (quoteOnPage: every ellipsis-separated segment, normalised). Otherwise it is the model's word. */
function onOurPage<T>(fact: CitedFact<T>, pageTexts: Map<string, string>, what: string): CitedFact<T> {
  if (!fact.value) return fact;
  const text = pageTexts.get(pageKey(fact.sourceUrl));
  if (text == null || quoteOnPage(fact.quote, text)) return fact;
  return { ...fact, value: null, notFound: `the quoted words are not on the ${what}'s source page as we read it ("${fact.quote.slice(0, 80)}") — not kept` };
}
/** One key per page: no fragment, no trailing slash, host lower-cased. */
export function pageKey(url: string): string {
  try { const u = new URL(str(url)); u.hash = ""; return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`; } catch { return str(url); }
}

/** A FEE'S SOURCE MUST BE THIS JOB'S CURRENT SCHEDULE (close F4): not a page the server now says is
 *  gone (404 / 410 — the schedule was replaced), not an archived / prior-year schedule, not another
 *  permit kind's (a trench / right-of-way schedule). */
function currentFeeSource(fee: CitedFact<PermitFeeAnswer>, gone: string[]): CitedFact<PermitFeeAnswer> {
  if (!fee.value) return fee;
  if (gone.includes(pageKey(fee.sourceUrl))) return { ...fee, value: null, notFound: `the cited schedule is no longer there (HTTP 404 when read) — a replaced schedule, not kept (${fee.sourceUrl})` };
  const why = staleOrOtherFeeSource("", fee.sourceUrl);
  return why ? { ...fee, value: null, notFound: `the cited source is ${why} — not this job's fee (${fee.sourceUrl})` } : fee;
}

export function parseDocsFeesPart(text: string, seenUrls: string[], stopReason: string | null, pageTexts: Map<string, string> = new Map(), gone: string[] = []): {
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
    out.set(discipline, { documents: onOurPage(documents, pageTexts, "required documents"), fee: tiedFee(onOurPage(currentFeeSource(fee, gone), pageTexts, "fee"), pageTexts) });
  }
  return { byDiscipline: out, problem: "" };
}
/** THE FEE TIE (lookup-close-4, D3): every (label, amount) pair the answer carries — each line, each
 *  tier — is printed together (agencyPageReader.feeLinePrintedTogether) on the page we read when we
 *  hold it, else within the quote (the model's "..." as a line break); and the total is one of those
 *  tied amounts or the sum of the tied lines — never a number borrowed from the next row. A TOTAL
 *  WITH NO LINE AND NO TIER HAS NO PAIR TO TIE and is not kept (lookup-close-5 MF3: the quote door
 *  no longer holds an amount to its line, so this is the ONE place the question is asked; no stored
 *  held-out fee is line-less — the prompt asks for each printed line). */
export function tiedFee(fee: CitedFact<PermitFeeAnswer>, pageTexts: Map<string, string>): CitedFact<PermitFeeAnswer> {
  if (!fee.value) return fee;
  const page = pageTexts.get(pageKey(fee.sourceUrl));
  const text = page ?? str(fee.quote).replace(/\.{3}|…/g, "\n");
  const where = page ? "on the fee's source page as we read it" : "in the quoted words";
  const tiers = ((fee.value as PermitFeeAnswer & { tiers?: Array<{ amountUsd: number; label: string }> }).tiers ?? []);
  const pairs = [...fee.value.lines.map((l) => ({ label: l.label, amountUsd: l.amountUsd })), ...tiers.map((t) => ({ label: t.label, amountUsd: t.amountUsd }))]
    .filter((p) => typeof p.amountUsd === "number" && Number.isFinite(p.amountUsd));
  if (!pairs.length) return { ...fee, value: null, notFound: `the total $${fee.value.amountUsd} comes with no printed line (label and amount) to tie it to ${where} — not kept` };
  const loose = pairs.find((p) => !feeLinePrintedTogether(p.label, p.amountUsd, text));
  if (loose) return { ...fee, value: null, notFound: `the amount $${loose.amountUsd} is not printed beside its label ("${str(loose.label).slice(0, 60)}") ${where} — another row's amount, not kept` };
  const total = fee.value.amountUsd;
  if (typeof total === "number" && Number.isFinite(total)) {
    const lineAmounts = fee.value.lines.map((l) => l.amountUsd).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const tied = pairs.some((p) => Math.abs(p.amountUsd - total) < 0.005) || (lineAmounts.length > 1 && Math.abs(lineAmounts.reduce((s, n) => s + n, 0) - total) < 0.01);
    if (!tied) return { ...fee, value: null, notFound: `the total $${total} is neither a printed line of this fee nor the sum of its lines — not kept` };
  }
  return fee;
}

export interface PermitProcessLookupRun {
  saved: boolean;
  reason: string;
  lookup: PermitProcessLookup | null;
  calls: Array<{ part: string; grounded: number; searches?: number; stopReason: string | null; error?: string; pagesRead: number; readPages?: boolean; agency?: string }>;
  /** The model's raw answers and the URLs its searches returned — for offline re-scoring only
   *  (never stored by the job). */
  raw?: { process: string; documentsFees: string; processUrls: string[]; documentsFeesUrls: string[]; portal?: string; portalUrls?: string[] };
  /** Every page the lookup read itself (agencyPageReader), in order, with what came of it. */
  reads?: Array<{ url: string; ok: boolean; reason: string; kind: string }>;
}

/**
 * THE BOUND (per lookup, worst case). Calls: process 1 (+1 retry on an abort) + portal ≤ 2 + documents/
 * fees ≤ 2 (+1 retry each on an abort, WITHOUT page reading) = 8. Searches: 8 (+8) + 2×4 + 2×5 (+2×5)
 * = 44. Page fetches (readPages): 2×3 + 2×3 = 12, each capped at DESIGN_LOOKUP_MAX_PAGE_TOKENS. Time:
 * the portal and documents/fees calls run CONCURRENTLY after the process part, so wall time ≤ 4 part
 * budgets (process + retry, documents/fees + retry) = 20 min at the 300 s default. Every call carries
 * its own abort; an aborted/ungrounded call keeps NOTHING (no search results → no value), so a
 * timeout never saves a guess.
 * OUR OWN READS (lookup-recall-2): at most 18 GETs per lookup (agencyPageReader budget) — ≤ 3 agency
 * pages, ≤ 4 portal verifications incl. one hop, ≤ 2 + 2 proposed-portal checks, ≤ 3 catalog reads,
 * ≤ 3 documents — each one try, ≥ 10 s apart per host, 20 s timeout, 15 MB cap; no model tokens except
 * the documents/fees excerpts (≤ 3 × 3,500 chars). They run between part one and parts two/three, so
 * they add ≈ (reads on the busiest host) × 10 s of wall time (≈ 1-2 min), and a portal resolved with
 * its catalog SKIPS the portal model call.
 */
const ABORTED = /abort|timeout|timed out|overloaded|5\d\d/i;
const PORTAL_SEARCHES = 4;
const PORTAL_FETCHES = 3;
const DOCS_SEARCHES = 5;
const DOCS_FETCHES = 3;
const partBudgetMs = () => Math.max(300000, Number(process.env.PERMIT_PROCESS_LOOKUP_TIMEOUT_MS) || 0);
const seenOf = (r: WebLookupResult) => [...r.resultUrls, ...(r.fetchedUrls ?? [])];

// ── OUR OWN READ OF THE AGENCY'S PAGES (lookup-recall-2) ─────────────────────────────────
/** What the lookup read ITSELF: the agency's pages (links included), the portal and its public
 *  catalog, the fee schedule / checklist, and the prerequisites / code editions quoted from them. */
export interface AgencyEvidence {
  agencyDomain: string;
  pages: ReadPage[];
  portal: PortalResolution | null;
  /** URLs we read whose own markers name a permit platform (the R3 self-citation door). */
  platformPages: string[];
  /** Those pages as read, by tenant key (a catalog read needs the entry page's module links). */
  platformReads: Map<string, ReadPage>;
  docs: Array<{ page: ReadPage; kind: "fees" | "checklist"; excerpt: string }>;
  prerequisites: CitedFact<string>[];
  codes: CitedFact<string[]> | null;
  /** Every URL we read successfully (a page the lookup read counts as seen). */
  seen: string[];
  /** pageKey(url) -> the text we read (for the quote-on-page door). */
  pageTexts: Map<string, string>;
  /** pageKey of every page we asked for that the server says is not there (404 / 410). */
  gone: string[];
  /** Every link on a page we read (page -> href), the resolved portal's included: a page we read
   *  linking exactly a URL attests it (the one portal door, kind (b)). */
  agencyLinks: Array<{ page: string; href: string }>;
}
// A document URL (a PDF, a DocumentCenter / WebLink / eDoc view) is permitPlatformCatalog.DOCUMENT_URL —
// ONE pattern (lookup-close-5: this file kept a narrower copy, DOC_URL).
/** Every sourceUrl the answer cites, the issuing agency's first. */
function citedSourceUrls(json: Record<string, unknown> | null): { all: string[]; agency: string } {
  const all: string[] = [];
  let agency = "";
  const walk = (v: unknown, key: string) => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.sourceUrl === "string" && /^https?:\/\//i.test(o.sourceUrl.trim())) {
      all.push(o.sourceUrl.trim());
      if (key === "issuingAgency" && !agency) agency = o.sourceUrl.trim();
    }
    for (const [k, x] of Object.entries(o)) if (k !== "sourceUrl") walk(x, k);
  };
  walk(json, "");
  return { all: [...new Set(all)], agency };
}
function proposedPortals(json: Record<string, unknown> | null): string[] {
  return [...new Set(((Array.isArray(json?.permits) ? json!.permits : []) as Array<Record<string, unknown>>)
    .map((p) => str((p?.portalUrl as Record<string, unknown> | undefined)?.value)).filter((u) => /^https?:\/\//i.test(u)))];
}
/** The same, per permit and with the raw fact (its quote's words are judged by the door too). */
function proposedPortalsByPermit(json: Record<string, unknown> | null): Array<{ discipline: PermitProcessDiscipline; raw: RawFact }> {
  const out: Array<{ discipline: PermitProcessDiscipline; raw: RawFact }> = [];
  for (const p of (Array.isArray(json?.permits) ? json!.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    const raw = p?.portalUrl as RawFact;
    if (discipline && /^https?:\/\//i.test(str(raw?.value))) out.push({ discipline, raw });
  }
  return out;
}
const MAX_AGENCY_PAGES = 3;
const MAX_DOCS = 3;

/**
 * Read the agency's own pages and what they link. POLITE (agencyPageReader: one try, >= 10 s per
 * host, back off on a refusal, never a login) and BOUNDED (the reader's budget; ≤ 3 agency pages,
 * ≤ 4 portal verifications incl. one hop, ≤ 2 proposed-portal checks, ≤ 3 catalog reads, ≤ 3 documents).
 */
export async function readAgencyEvidence(reader: PageReader, input: {
  ahj: string; state?: string; agencyNames: string[]; citedUrls: string[]; agencyCitation?: string; resultUrls: string[]; resultTitles?: Record<string, string>; proposedPortals: string[];
  /** The names whose jurisdiction TYPE a linked tenant must not contradict (close-3 MF2): the AHJ
   *  and the agency that issues its permits as a whole (top-level or lifted) — never one permit's
   *  cited agency. The AHJ alone when omitted. */
  typeNames?: string[];
}): Promise<AgencyEvidence> {
  const names = [input.ahj, ...input.agencyNames].filter(Boolean);
  const typeNames = [...new Set([input.ahj, ...(input.typeNames ?? [])].filter(Boolean))];
  const official = (u: string) => { const h = portalHostOf(u); return Boolean(h) && isOfficialAgencyHost(h, names, input.state); };
  const domOf = (u: string) => registrableDomain(portalHostOf(u));
  // THE AGENCY'S DOMAIN: where its cited agency answer lives; else the official domain the answer
  // cites most, preferring one that carries the AHJ's own name (a state agency's page is read only
  // when it IS the agency's domain — a state portal link must not stand in for a city's).
  let agencyDomain = input.agencyCitation && official(input.agencyCitation) ? domOf(input.agencyCitation) : "";
  if (!agencyDomain) {
    const counts = new Map<string, number>();
    const own = names.flatMap((n) => n.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 4 && !["city", "county", "town", "village", "unincorporated"].includes(w));
    for (const u of input.citedUrls.filter(official)) {
      const d = domOf(u);
      counts.set(d, (counts.get(d) ?? 0) + 1 + (own.some((w) => d.includes(w)) ? 10 : 0));
    }
    agencyDomain = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }
  const onAgency = (u: string) => Boolean(agencyDomain) && domOf(u) === agencyDomain && official(u);
  const pageUrls: string[] = [];
  const addPage = (u: string) => { if (pageUrls.length < MAX_AGENCY_PAGES && !pageUrls.some((x) => pageKey(x) === pageKey(u))) pageUrls.push(u); };
  for (const u of input.citedUrls) if (onAgency(u) && !DOCUMENT_URL.test(u)) addPage(u);
  if (pageUrls.length < 2) for (const u of input.resultUrls) if (onAgency(u) && !DOCUMENT_URL.test(u) && /build|permit|solar|inspect|develop/i.test(u)) addPage(u);
  const pages = await Promise.all(pageUrls.map((u) => reader.read(u)));
  const okPages = pages.filter((p) => p.ok && p.kind === "html");

  const portal = okPages.length ? await resolvePortalFromPages(reader, okPages, { names, typeNames }) : null;
  const platformPages: string[] = [];
  const platformReads = new Map<string, ReadPage>();
  const notePlatform = (pg: ReadPage) => { platformPages.push(pg.url, pg.finalUrl); platformReads.set(portalTenantKey(pg.url), pg); platformReads.set(portalTenantKey(pg.finalUrl), pg); };
  if (portal?.portalPage) notePlatform(portal.portalPage);
  // THE MODEL'S OWN PORTAL PROPOSALS: read (≤ 2) the ones on a vendor host or the agency's own
  // domain, so a platform page citing itself is attested by what we read (R3).
  for (const u of input.proposedPortals.filter((x) => (isPermitPlatformUrl(x) || onAgency(x) || official(x)) && !DOCUMENT_URL.test(x)).slice(0, 2)) {
    const pg = await reader.read(u);
    if (detectPlatform(pg)) notePlatform(pg);
  }

  // Documents: the fee schedule / checklist the agency's pages link, then the documents the answer
  // cites on official hosts; fee schedules first.
  const docLinks = documentLinks(okPages, names, input.state);
  // A search result on the agency's domain whose TITLE names its fee schedule / solar checklist (the
  // model saw it but its own fetch was refused — url_not_allowed / url_not_accessible).
  for (const [u, t] of Object.entries(input.resultTitles ?? {})) {
    const kind = onAgency(u) ? classifyDocument(t, u) : null;
    if (kind && !docLinks.some((d) => pageKey(d.href) === pageKey(u))) docLinks.push({ href: u, text: t, kind });
  }
  for (const u of input.citedUrls) {
    if (!DOCUMENT_URL.test(u) || !official(u) || docLinks.some((d) => pageKey(d.href) === pageKey(u))) continue;
    const kind = /fee/i.test(u) ? "fees" : "checklist";
    // A cited fee document that is archived / a prior year's / another permit kind's is not read as
    // this job's schedule (close F4).
    if (kind === "fees" && staleOrOtherFeeSource("", u)) continue;
    docLinks.push({ href: u, text: "", kind });
  }
  const picked = [...docLinks.filter((d) => d.kind === "fees").slice(0, 2), ...docLinks.filter((d) => d.kind === "checklist")].slice(0, MAX_DOCS);
  const docPages = await Promise.all(picked.map(async (d) => {
    let page = await reader.read(d.href);
    // A fee PAGE that prices nothing itself links its schedule: one hop to the linked document.
    if (d.kind === "fees" && page.ok && page.kind === "html" && !excerptFor(page, "fees")) {
      const next = page.links.find((l) => classifyDocument(l.text, l.href) === "fees" && DOCUMENT_URL.test(l.href));
      if (next) { const pdf = await reader.read(next.href); if (pdf.ok) page = pdf; }
    }
    return { page, kind: d.kind };
  }));
  const docs = docPages.filter((d) => d.page.ok && d.page.text).map((d) => ({ ...d, excerpt: excerptFor(d.page, d.kind) })).filter((d) => d.excerpt);

  const prerequisites: CitedFact<string>[] = [];
  // A fee schedule prices steps; its "plan review" / "registration" rows are not steps to take — the
  // agency pages and the solar checklist are where a prerequisite is stated.
  for (const pg of [...okPages, ...docs.filter((d) => d.kind === "checklist").map((d) => d.page)]) {
    for (const n of extractPrerequisites(pg)) if (!prerequisites.some((x) => x.quote === n.quote)) prerequisites.push({ value: n.value, sourceUrl: n.sourceUrl, quote: n.quote, origin: "lookup" });
  }
  let codes: CitedFact<string[]> | null = null;
  // The adopted editions are quoted from the agency's pages, then from the documents we read (a
  // town's solar-requirements PDF prints "Current Codes 2020 NEC" — close-2 item 4).
  for (const pg of [...okPages, ...docPages.map((d) => d.page).filter((p) => p.ok && p.text)]) {
    const c = extractCodeEditions(pg);
    if (c) { codes = { value: c.editions, sourceUrl: c.sourceUrl, quote: c.quote, origin: "lookup" }; break; }
  }
  const seen: string[] = [];
  const pageTexts = new Map<string, string>();
  // Every read the reader made (agency pages, hops, portal checks, documents) — the catalog reads
  // come later and are cited by their own URL.
  const allReads = [...pages, ...docPages.map((d) => d.page)];
  if (portal?.portalPage) allReads.push(portal.portalPage);
  const gone: string[] = [];
  for (const pg of allReads) {
    // A page the server says is NOT THERE (404 / 410) now: a fee cited to it is stale (close F4).
    if (!pg.ok && (pg.status === 404 || pg.status === 410)) gone.push(pageKey(pg.url));
    if (!pg.ok) continue;
    seen.push(pg.url, pg.finalUrl);
    pageTexts.set(pageKey(pg.url), pg.text);
    pageTexts.set(pageKey(pg.finalUrl), pg.text);
  }
  for (const u of platformPages) seen.push(u);
  const agencyLinks = okPages.flatMap((pg) => pg.links.map((l) => ({ page: pg.finalUrl, href: l.href })));
  // The resolver read the page that links the portal it resolved (a hop page is not in okPages).
  if (portal) agencyLinks.push({ page: portal.sourceUrl, href: portal.url });
  return { agencyDomain, pages, portal, platformPages: [...new Set(platformPages)], platformReads, docs, prerequisites: prerequisites.slice(0, 6), codes, seen: [...new Set(seen)], pageTexts, gone, agencyLinks };
}

/** THIS AHJ'S OWN KB EVIDENCE for the portal door: the portals its permit_utility_knowledge rows
 *  name (own), and among them the ones a PERSON verified (isVerifiedKnowledge — never confidence
 *  "mixed"). A Salesforce host is kept whatever its tenant (the D2b carve-out reads it); a utility
 *  host or an information page is nobody's portal. No other-entity claims: whose portal a host is
 *  by the KB's other rows is judged at the KB write door, not here. */
export async function lookupPortalEntity(db: AppDb, state: string, ahj: string): Promise<PortalEntity | null> {
  const name = str(ahj);
  if (!name) return null;
  const { isVerifiedKnowledge } = await import("./knowledgeBase");
  const key = normalizeAhjName(name);
  const rows = db.query<{ ahj: string; portal_url: string | null; portal_name: string | null; verified_at: string | null }>(
    "SELECT ahj, portal_url, portal_name, verified_at FROM permit_utility_knowledge WHERE ahj IS NOT NULL AND ahj != '' AND lower(state) = lower(?)", [str(state)],
  ).filter((r) => normalizeAhjName(str(r.ahj)) === key);
  const own: string[] = [];
  const verified: string[] = [];
  for (const r of rows) {
    for (const u of [str(r.portal_url), str(r.portal_name)]) {
      if (!portalHostOf(u) || isInformationalPageUrl(u)) continue;
      if (!trackSafeUrl("permit", u) && !salesforceTenantKind(u)) continue;
      own.push(u);
      if (isVerifiedKnowledge(r)) verified.push(u);
    }
  }
  return { scope: "ahj", state: str(state), name, ownPortals: [...new Set(own)], verifiedPortals: [...new Set(verified)], otherClaims: [] };
}

/** The portal's public catalog -> the record type for each permit of this job (chooseRecordType),
 *  every solar candidate kept with its condition. */
export function recordTypeFromCatalog(catalog: PortalCatalog | null, discipline: PermitProcessDiscipline, permitPath: string | undefined, modelValue: string | null): {
  recordType: CitedFact<string> | null; candidates: RecordTypeCandidate[]; question: string;
} {
  if (!catalog || !catalog.types.length) return { recordType: null, candidates: [], question: "" };
  const all = solarRecordTypeCandidates(catalog);
  const pool = all.filter((c) => c.discipline === null || c.discipline === discipline || discipline === "combo");
  if (!pool.length) return { recordType: null, candidates: [], question: "" };
  let { chosen, question } = chooseRecordType(pool, permitPath);
  // A CITED record type (the agency's own words) that names ONE candidate — by its label, or by the
  // path it names ("SolarAPP+", "prescriptive") — decides it (close F5).
  if (!chosen && modelValue) {
    const hit = candidateNamedBy(pool, modelValue);
    if (hit) { chosen = hit; question = ""; }
  }
  return {
    recordType: chosen ? { value: chosen.label, sourceUrl: chosen.sourceUrl, quote: chosen.quote, origin: "lookup" } : { value: null, sourceUrl: catalog.sourceUrl, quote: "", origin: "lookup", notFound: question },
    candidates: pool,
    question,
  };
}

/** The production reader: on when a model key is set (the lookup runs at all), page reading is not
 *  switched off (PERMIT_LOOKUP_PAGE_READ=off) and document downloads are allowed. A stubbed-model
 *  test (no key) never touches the network unless it passes its own reader. `maxReads`: the read
 *  budget (the form acquisition reads ONE forms page through the same switches). */
export function defaultLookupReader(maxReads = 18): PageReader | null {
  if (!process.env.ANTHROPIC_API_KEY || /^(off|0|false)$/i.test(str(process.env.PERMIT_LOOKUP_PAGE_READ)) || documentFetchDisabled()) return null;
  return createPageReader({ maxReads });
}

/**
 * Run the lookup for one AHJ and land it. `force` re-runs over a seeded row (never over a verified
 * one — the write path refuses). System facts (DC kW / AC kVA / path) only shape the fee question.
 * `reader`: the page reader (tests pass one over saved pages; null = no page reading).
 */
export async function runPermitProcessLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  input: { state: string; ahj: string; utility?: string; dcKw?: string | number; acKw?: string | number; permitPath?: string; force?: boolean; reader?: PageReader | null },
): Promise<PermitProcessLookupRun> {
  const calls: PermitProcessLookupRun["calls"] = [];
  const existing = getPermitProcessLookup(db, input.state, input.ahj);
  if (existing?.confidence === "verified") return { saved: false, reason: "a person verified this AHJ's process", lookup: existing, calls };
  // A seeded row whose part was NEVER ASKED (F-b: an aborted portal / documents-fees call) is
  // re-asked without `force` — the trigger's 24 h dedupe bounds how often.
  if (existing && !input.force && !lookupHasUnaskedPart(existing)) return { saved: false, reason: "already looked up (seeded)", lookup: existing, calls };
  if (!llm.webLookup) return { saved: false, reason: "no web lookup available (no model key)", lookup: existing, calls };
  const ask = llm.webLookup.bind(llm);
  const reader = input.reader === undefined ? defaultLookupReader() : input.reader;
  const entity = await lookupPortalEntity(db, input.state, input.ahj);
  const logCall = (part: string, r: WebLookupResult, extra: { readPages?: boolean; agency?: string } = {}) =>
    calls.push({ part, grounded: r.groundedSearches, searches: r.searches, stopReason: r.stopReason, error: r.error, pagesRead: r.pagesRead, ...extra });

  const where = `Jurisdiction: ${input.ahj}\nState: ${input.state}`;
  // Part one decides WHICH agency the later parts ask about, so an abort here is retried ONCE (an
  // abort is transient; an answer that ran and found nothing is not retried).
  const askProcess = () => ask({ label: "permitProcessLookup.process", system: PROCESS_LOOKUP_SYSTEM, user: where, maxTokens: 8000, maxSearches: 8, readPages: false, timeoutMs: partBudgetMs() });
  let p1 = await askProcess();
  logCall("process", p1, { readPages: false });
  if (p1.error && ABORTED.test(p1.error)) {
    p1 = await askProcess();
    logCall("process (retry)", p1, { readPages: false });
  }
  const ungrounded = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
  const grounded1 = p1.groundedSearches > 0;
  const first = grounded1 ? parseProcessPart(p1.text, seenOf(p1), p1.stopReason, [], entity) : null;

  // WHO ISSUES EACH PERMIT, decided ONCE from a parsed part one and read by every door below.
  //   publisherName — the agency whose pages our read reads: the top-level (or lifted) agency, else
  //   the AHJ itself. A permit is ISSUED BY THE PUBLISHER when it cites no agency or cites that one —
  //   sameAgencyName (close-5 MF4), which sees through a department suffix and a stray "/": "City of
  //   Charleston Permit Center /" is the City of Charleston. Only such a permit takes the portal the
  //   publisher's own page links (close F6, close-2 MF1: Santa Fe County's page vs the State's
  //   electrical permit — never assumed, WHATEVER DOMAIN the citation sits on: with no top agency a
  //   permit's cited OTHER agency is never the publisher, even when the county's own FAQ is where
  //   "electrical permits are issued by the State CID" is printed; the portal step asks that agency).
  //   THE TYPE SET IS THE ISSUER'S (close-3 MF2, close-4 D1c): for a publisher-issued permit the AHJ
  //   and the top agency — never one permit's cited agency, which would widen "City of Marion" to
  //   {city, county} the moment the electrical permit cites Marion County; for a permit another cited
  //   agency issues, that agency alone (its portal serves only its permit).
  const issuerOf = (permits: PermitProcessPermitAnswer[], top: CitedFact<string>) => {
    const lifted = liftAgreedAgency(top, permits);
    const publisherName = lifted.value ?? input.ahj;
    const cited = (d: PermitProcessDiscipline) => permits.find((p) => p.discipline === d)?.issuingAgency.value ?? null;
    const publisher = (d: PermitProcessDiscipline) => { const c = cited(d); return !c || sameAgencyName(c, publisherName); };
    const typeNamesFor = (d: PermitProcessDiscipline) => [...new Set(publisher(d) ? [input.ahj, lifted.value ?? ""] : [cited(d) ?? ""])].filter(Boolean);
    const namesFor = (d: PermitProcessDiscipline) => [...new Set([input.ahj, lifted.value ?? "", cited(d) ?? ""])].filter(Boolean);
    return { lifted, publisherName, cited, publisher, typeNamesFor, namesFor };
  };

  // OUR OWN READ of the agency's pages, the portal they link and its public catalog (grounded
  // answers only: an ungrounded part one names no page worth reading).
  let ev: AgencyEvidence | null = null;
  if (reader && first) {
    const p1json = parseJsonLoose(p1.text);
    const cited = citedSourceUrls(p1json);
    const agencyNames = [first.issuingAgency.value, ...first.permits.map((p) => p.issuingAgency.value)].filter((x): x is string => Boolean(x));
    const agencyCitation = first.issuingAgency.value ? first.issuingAgency.sourceUrl : first.permits.find((p) => p.issuingAgency.value)?.issuingAgency.sourceUrl;
    const pre = issuerOf(first.permits, first.issuingAgency);
    // THE MODEL'S PORTAL PROPOSALS WORTH READING (close-5 MF1): each raw part-one portal goes through
    // the ONE door now, with what is known before any read — a candidate refused OUTRIGHT (rule 5,
    // another module, the issuer's jurisdiction type: DENBYCOUNTY for the City of Denby's own
    // permit) by every permit citing it is not read at all; one merely unattested so far is read,
    // so a platform page citing itself is attested by what we read (R3).
    const worthReading = new Map<string, boolean>();
    for (const { discipline, raw: rawPortal } of proposedPortalsByPermit(p1json)) {
      const u = str(rawPortal?.value);
      const dec = acceptPortalForPermit(rawPortal, "process part", { seenUrls: seenOf(p1), names: pre.namesFor(discipline), typeNames: pre.typeNamesFor(discipline), entity });
      worthReading.set(u, (worthReading.get(u) ?? false) || !OUTRIGHT_REFUSALS.has(dec.code));
    }
    try {
      ev = await readAgencyEvidence(reader, { ahj: input.ahj, state: input.state, agencyNames, citedUrls: cited.all, agencyCitation, resultUrls: p1.resultUrls, resultTitles: p1.resultTitles, proposedPortals: [...worthReading.entries()].filter(([, ok]) => ok).map(([u]) => u), typeNames: [...new Set([input.ahj, pre.lifted.value ?? ""])].filter(Boolean) });
    } catch (err) {
      logger.warn("permit-process", `agency page read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const catalogs = new Map<string, Promise<PortalCatalog | null>>();
  const catalogFor = (url: string, portalPage?: ReadPage): Promise<PortalCatalog | null> => {
    if (!reader) return Promise.resolve(null);
    const key = portalTenantKey(url);
    if (!catalogs.has(key)) {
      const platform = platformOfUrl(url) ?? (portalPage ? detectPlatform(portalPage) : null);
      catalogs.set(key, platform === "energov" || platform === "accela"
        ? readPortalCatalog(reader, { url, platform, sourceUrl: url, quote: "", via: "vendor link", portalPage }).catch(() => null)
        : Promise.resolve(null));
    }
    return catalogs.get(key)!;
  };
  const platformPages = ev?.platformPages ?? [];
  const part1 = first
    ? (ev ? parseProcessPart(p1.text, [...seenOf(p1), ...ev.seen], p1.stopReason, platformPages, entity) : first)
    : { issuingAgency: ungrounded(p1.error ? `lookup failed: ${p1.error.slice(0, 120)}` : "no web search returned results — nothing kept from memory"), permitStructure: ungrounded("no grounded search"), permits: [] as PermitProcessPermitAnswer[], prerequisites: [] as CitedFact<string>[], problem: p1.error ?? "ungrounded" };

  // ASK THE AGENCY THAT ISSUES EACH PERMIT. Lift an agency every permit agrees on; then group.
  const issuer = issuerOf(part1.permits, part1.issuingAgency);
  const issuingAgency = issuer.lifted;
  const disciplines: PermitProcessDiscipline[] = part1.permits.length ? part1.permits.map((p) => p.discipline) : (part1.permitStructure.value === "combo" ? ["combo"] : ["structural", "electrical"]);
  const groups = agenciesToAsk(input.ahj, issuingAgency, part1.permits, disciplines);
  const byDiscipline = new Map(part1.permits.map((p) => [p.discipline, p] as const));
  const system = `System: ${str(input.dcKw) || "?"} kW DC, ${str(input.acKw) || "?"} kVA AC, permit path: ${str(input.permitPath) || "unknown"}`;

  // THE PORTAL RESOLVED FROM THE AGENCY'S OWN PAGE (our read attests it) outranks a model-cited one;
  // its public catalog names the record type in the PORTAL'S words. ONLY FOR THE PERMITS ITS
  // PUBLISHER ISSUES (issuerOf above).
  const detPortal: CitedFact<string> | null = ev?.portal ? { value: ev.portal.url, sourceUrl: ev.portal.sourceUrl, quote: ev.portal.quote, origin: "lookup" } : null;
  const issuedByPublisher = issuer.publisher;
  const platformReads = ev?.platformReads ?? new Map<string, ReadPage>();
  const ourSeen = ev?.seen ?? [];
  // THE ONE DOOR, TWICE: every candidate — ours from the agency's page, part one's cited, (later) the
  // portal step's — judged by acceptPortalForPermit against the jurisdiction that issues THIS permit;
  // the first accepted wins, else the most informative refusal. `portalOf` is the judgement BEFORE
  // the portal step (close-5 MF1: the catalog read and the "is a portal still needed" question used
  // to see part one's RAW cited portal, which had only passed the parse-time door — so a refused
  // county tenant's catalog was saved as the city's record type and its permit never re-asked);
  // `finalPortal` is the same judgement with the step's candidate and search results added.
  const doorContextFor = (d: PermitProcessDiscipline, extra: { seen: string[]; platformPages: string[] }): PortalDoorContext => ({
    seenUrls: [...seenOf(p1), ...ourSeen, ...extra.seen],
    platformPages: [...new Set([...platformPages, ...extra.platformPages])],
    agencyLinks: ev?.agencyLinks ?? [], names: issuer.namesFor(d), typeNames: issuer.typeNamesFor(d), entity,
  });
  const notDecided: PortalDecision = { fact: ungrounded("not found"), source: "process part", attestedBy: null, code: "none" };
  const judgePortal = (candidates: Array<{ raw: RawFact; source: PortalCandidateSource }>, ctx: PortalDoorContext) => {
    const decisions = candidates.map((c) => ({ ...acceptPortalForPermit(c.raw, c.source, ctx), claimed: str(c.raw?.value) }));
    const accepted = decisions.find((x) => x.fact.value);
    // Else: a refusal with a value (its reason names the door) > the portal step's not-found /
    // not-asked (it was asked last, of the issuing agency) > part one's not-found.
    const chosen = accepted ?? decisions.find((x) => x.claimed) ?? decisions.find((x) => x.source === "portal step") ?? decisions.find((x) => x.source === "process part") ?? decisions[0] ?? notDecided;
    return { decisions, accepted, chosen };
  };
  const baseCandidates = (d: PermitProcessDiscipline, partOne: CitedFact<string> | undefined): Array<{ raw: RawFact; source: PortalCandidateSource }> => {
    const out: Array<{ raw: RawFact; source: PortalCandidateSource }> = [];
    if (detPortal && issuedByPublisher(d)) out.push({ raw: { value: detPortal.value, sourceUrl: detPortal.sourceUrl, quote: detPortal.quote }, source: "agency page (our read)" });
    // A claim the PARSE-TIME door refused for want of evidence stays a candidate (its `claimed`), so
    // the final door can judge it with everything read since (portal-truth D3: a redirect we read).
    if (partOne) out.push({ raw: { value: partOne.value ?? (partOne.claimed || null), sourceUrl: partOne.sourceUrl, quote: partOne.quote, notFound: partOne.notFound }, source: "process part" });
    return out;
  };
  const preDecided = new Map<PermitProcessDiscipline, PortalDecision>();
  const portalOf = (d: PermitProcessDiscipline): CitedFact<string> => {
    if (!preDecided.has(d)) preDecided.set(d, judgePortal(baseCandidates(d, byDiscipline.get(d)?.portalUrl), doorContextFor(d, { seen: [], platformPages: [] })).chosen);
    return preDecided.get(d)!.fact;
  };
  const pageFor = (url: string) => platformReads.get(portalTenantKey(url)) ?? (ev?.portal && portalTenantKey(ev.portal.url) === portalTenantKey(url) ? ev.portal.portalPage : undefined);
  const recordFor = new Map<PermitProcessDiscipline, ReturnType<typeof recordTypeFromCatalog>>();
  const fillRecordTypes = async (ds: PermitProcessDiscipline[], portalUrlOf: (d: PermitProcessDiscipline) => string | null, modelRt: (d: PermitProcessDiscipline) => string | null) => {
    for (const d of ds) {
      const url = portalUrlOf(d);
      if (!url || recordFor.has(d)) continue;
      const cat = await catalogFor(url, pageFor(url));
      const r = recordTypeFromCatalog(cat, d, input.permitPath, modelRt(d));
      if (r.candidates.length) recordFor.set(d, r);
    }
  };
  // A CITED RECORD TYPE COUNTS ONLY BESIDE THE PORTAL IT BELONGS TO (close-6 MF1): the one predicate,
  // asked of part one's and the step's types wherever they steer a choice or answer "is a record type
  // still needed" — a type read off another tenant's page never names a candidate of the saved portal.
  const rtCtx = (d: PermitProcessDiscipline) => ({ names: issuer.namesFor(d), typeNames: issuer.typeNamesFor(d), state: input.state });
  const citedRt = (d: PermitProcessDiscipline, portalUrl: string | null, ...facts: Array<CitedFact<string> | undefined>): string | null => {
    for (const f of facts) if (f?.value && recordTypeBelongsToPortal(f, portalUrl, rtCtx(d))) return f.value;
    return null;
  };
  // THE CATALOG OF A PORTAL THE DOOR ACCEPTED (close-5 MF1): a refused tenant contributes nothing.
  await fillRecordTypes(disciplines, (d) => portalOf(d).value ?? null, (d) => citedRt(d, portalOf(d).value, byDiscipline.get(d)?.recordType));

  // Pages we read for documents / fees, handed to that question verbatim (compact excerpts) — the
  // model may cite them, and a quote cited to one must be ON it (parseDocsFeesPart's page door).
  const pageBlock = ev?.docs.length
    ? `\n\nPages already read for you (quote them exactly; cite the URL exactly as given). They may not cover everything — search for anything they do not state:\n${ev.docs.map((d, i) => `[${i + 1}] ${d.page.finalUrl} (${d.kind === "fees" ? "fee schedule" : "checklist / requirements"})\n${d.excerpt}`).join("\n\n")}`
    : "";

  // THE PORTAL IS ITS OWN GROUNDED STEP (reading the agency's pages), for the permits still without a
  // portal or a record type (none when our read resolved the portal and its catalog named the solar
  // types); documents/fees read pages too. All run concurrently.
  const tasks: Array<Promise<{ kind: "portal" | "docs"; agency: string; disciplines: PermitProcessDiscipline[]; r: WebLookupResult; first?: WebLookupResult }>> = [];
  for (const g of groups) {
    // "IS A PORTAL STILL NEEDED" IS THE ONE RECORD-TYPE QUESTION (close-6 MF1): a permit whose JUDGED
    // portal has a record type — from that portal's catalog, or a cited type that belongs to it — needs
    // no step; with no judged portal neither can hold, so the permit is asked (the old separate
    // "portal known?" half was redundant, and the close-5 skeptic's V1 showed it could drift alone).
    const needPortal = g.disciplines.filter((d) => !(recordFor.has(d) || citedRt(d, portalOf(d).value, byDiscipline.get(d)?.recordType)));
    const head = `Issuing agency: ${g.agency}\nFor permits in: ${input.ahj}, ${input.state}`;
    if (needPortal.length) {
      tasks.push(ask({ label: "permitProcessLookup.portal", system: PORTAL_LOOKUP_SYSTEM, user: `${head}\nPermits: ${needPortal.join(", ")}`, maxTokens: 6000, maxSearches: PORTAL_SEARCHES, readPages: true, maxFetches: PORTAL_FETCHES, timeoutMs: partBudgetMs() })
        .then((r) => ({ kind: "portal" as const, agency: g.agency, disciplines: needPortal, r })));
    }
    // Reading fee-schedule PDFs can outrun the part budget (the recall eval: 3 of 7 aborted at 300 s);
    // an ABORTED page-reading call is retried once without page reading — the lighter question that
    // finished before — so reading pages never costs the answer the lookup used to get.
    const askDocs = (readPages: boolean) => ask({ label: "permitProcessLookup.documentsFees", system: DOCS_FEES_LOOKUP_SYSTEM, user: `${head}\nPermits: ${g.disciplines.join(", ")}\n${system}${pageBlock}`, maxTokens: 8000, maxSearches: DOCS_SEARCHES, readPages, ...(readPages ? { maxFetches: DOCS_FETCHES } : {}), timeoutMs: partBudgetMs() });
    tasks.push(askDocs(true).then(async (firstTry) => {
      if (!(firstTry.error && ABORTED.test(firstTry.error))) return { kind: "docs" as const, agency: g.agency, disciplines: g.disciplines, r: firstTry };
      return { kind: "docs" as const, agency: g.agency, disciplines: g.disciplines, r: await askDocs(false), first: firstTry };
    }));
  }
  const answers = await Promise.all(tasks);

  // Keyed by (agency, discipline): each group's answer fills only the permits asked of that agency.
  const portalFor = new Map<PermitProcessDiscipline, { portalUrl: CitedFact<string>; recordType: CitedFact<string> }>();
  const docsFor = new Map<PermitProcessDiscipline, { documents: CitedFact<string[]>; fee: CitedFact<PermitFeeAnswer> }>();
  const problems: string[] = [part1.problem];
  const prerequisites = [...part1.prerequisites];
  const raw = { process: p1.text, documentsFees: "", processUrls: p1.resultUrls, documentsFeesUrls: [] as string[], portal: "", portalUrls: [] as string[] };
  const pageTexts = ev?.pageTexts ?? new Map<string, string>();
  const gone = [...(ev?.gone ?? [])];
  let groundedParts = grounded1 ? 1 : 0;
  for (const a of answers) {
    if (a.first) logCall("documentsFees", a.first, { readPages: true, agency: a.agency });
    logCall(a.kind === "portal" ? "portal" : a.first ? "documentsFees (retry, no page reading)" : "documentsFees", a.r, { readPages: !a.first, agency: a.agency });
    // GROUNDED = the web search returned results, OR (documents/fees) the pages WE read were handed to
    // the question: an answer may rest on them alone (measured: with the fee schedule in hand the model
    // ran no search, and "no search" read as model memory and discarded the whole answer). Every value
    // is still cited to a page the search returned or we read, and a quote cited to our page must be ON it.
    const grounded = a.r.groundedSearches > 0 || (a.kind === "docs" && Boolean(pageBlock) && !a.r.error && Boolean(a.r.text));
    if (grounded && !a.r.error) groundedParts++;
    if (a.kind === "portal") {
      raw.portal += (raw.portal ? "\n" : "") + a.r.text;
      raw.portalUrls.push(...seenOf(a.r));
      // The portal step's proposals: read (≤ 2) so a platform page citing itself is attested (R3).
      const pagesNow = [...platformPages];
      if (reader && grounded) {
        for (const u of proposedPortals(parseJsonLoose(a.r.text)).filter((x) => !pagesNow.includes(x) && (isPermitPlatformUrl(x) || isOfficialAgencyHost(portalHostOf(x), [input.ahj, g0(groups)], input.state))).slice(0, 2)) {
          const pg = await reader.read(u);
          if (detectPlatform(pg)) { pagesNow.push(pg.url, pg.finalUrl); ourSeen.push(pg.url, pg.finalUrl); platformReads.set(portalTenantKey(pg.url), pg); platformReads.set(portalTenantKey(pg.finalUrl), pg); }
        }
      }
      const pp = grounded ? parsePortalPart(a.r.text, [...seenOf(a.r), ...ourSeen], a.r.stopReason, pagesNow, entity) : { byDiscipline: new Map(), prerequisites: [], problem: a.r.error ?? "portal lookup ungrounded" };
      if (pp.problem) problems.push(pp.problem);
      prerequisites.push(...pp.prerequisites);
      for (const d of a.disciplines) {
        // A single combo answer covers each asked discipline only when that is all it answered.
        const hit = pp.byDiscipline.get(d) ?? (pp.byDiscipline.size === 1 && pp.byDiscipline.has("combo") ? pp.byDiscipline.get("combo") : undefined);
        if (hit) portalFor.set(d, hit);
        // AN ABORTED STEP WAS NOT ASKED (F-b): the row says so, and is re-asked (never "not found").
        else if (a.r.error) portalFor.set(d, { portalUrl: notAsked("portal", a.r.error), recordType: notAsked("record type", a.r.error) });
      }
    } else {
      raw.documentsFees += (raw.documentsFees ? "\n" : "") + a.r.text;
      raw.documentsFeesUrls.push(...seenOf(a.r));
      // A CITED FEE SCHEDULE WE HAVE NOT READ: one polite read (≤ 2 per answer) to learn whether it is
      // still there — a schedule that 404s now was replaced (close F4: a FY25-26 PDF cited in FY26-27).
      if (reader && grounded) {
        const feeUrls = [...new Set(((parseJsonLoose(a.r.text)?.permits ?? []) as Array<Record<string, unknown>>)
          .map((p) => p?.fee as Record<string, unknown> | undefined).filter((f) => f?.value != null)
          .map((f) => str(f?.sourceUrl)).filter((u) => /^https?:\/\//i.test(u)))]
          .filter((u) => !pageTexts.has(pageKey(u)) && !gone.includes(pageKey(u))).slice(0, 2);
        for (const u of feeUrls) {
          const pg = await reader.read(u);
          if (!pg.ok && (pg.status === 404 || pg.status === 410)) gone.push(pageKey(u));
        }
      }
      const df = grounded ? parseDocsFeesPart(a.r.text, [...seenOf(a.r), ...ourSeen], a.r.stopReason, pageTexts, gone) : { byDiscipline: new Map(), problem: a.r.error ?? "ungrounded" };
      if (df.problem) problems.push(df.problem);
      for (const d of a.disciplines) {
        const hit = df.byDiscipline.get(d);
        if (hit) docsFor.set(d, hit);
        // AN ABORTED PART WAS NOT ASKED (F-b): never an all-not-found answer that reads "looked up,
        // nothing found" and blocks the re-queue — the row says "not asked" and is re-asked.
        else if (a.r.error) docsFor.set(d, { documents: notAsked("documents", a.r.error), fee: notAsked("fee", a.r.error) });
        else if (!docsFor.has(d)) docsFor.set(d, { documents: ungrounded(df.problem || "not found"), fee: ungrounded(df.problem || "not found") });
      }
    }
  }

  const basePermits: PermitProcessPermitAnswer[] = part1.permits.length ? part1.permits : disciplines.map((d) => ({
    discipline: d, label: d as string,
    issuingAgency: ungrounded("not found"), portalUrl: ungrounded("not found"), recordType: ungrounded("not found"),
    documents: ungrounded("not found"), fee: ungrounded("not found"),
  }));
  // THE PORTAL, THROUGH THE ONE DOOR (D1): every candidate — ours from the agency's page, part one's
  // cited, the portal step's — in that precedence, each judged by acceptPortalForPermit against the
  // jurisdiction that issues THIS permit; the first accepted wins, else the most informative refusal.
  const portalNotes: string[] = [];
  const decided = new Map<PermitProcessDiscipline, PortalDecision>();
  const finalCtx = (d: PermitProcessDiscipline) => doorContextFor(d, { seen: raw.portalUrls, platformPages: [...platformReads.values()].flatMap((pg) => [pg.url, pg.finalUrl]) });
  const finalCandidates = (p: PermitProcessPermitAnswer) => {
    const candidates = baseCandidates(p.discipline, p.portalUrl);
    const step = portalFor.get(p.discipline)?.portalUrl;
    if (step) candidates.push({ raw: { value: step.value ?? (step.claimed || null), sourceUrl: step.sourceUrl, quote: step.quote, notFound: step.notFound }, source: "portal step" });
    return candidates;
  };
  // A NAMED PORTAL THAT REDIRECTS TO ITS OFFICIAL HOST (portal-truth D3). Corvallis's own page said
  // "Apply online at www.corvallispermits.com"; that host lands on the city's own Accela tenant
  // (aca-prod.accela.com/CORVALLIS) and was never a search result, so the door dropped it as "never
  // returned by the search" — and staging fell to the statewide portal. Each candidate the door
  // refused for want of attestation alone is now READ ONCE, politely, through the page reader (its
  // one try, its per-host gap, its budget, never a login). When the read lands on ANOTHER host that
  // names this jurisdiction (its tenant, its official domain, or the landing page's own title /
  // opening words), the candidate is judged AS THE LANDING URL — which must pass the whole door on
  // its own (rule 5, the vendor's root, another module, the issuer's jurisdiction type) — and is
  // kept WITH that evidence: the URL the source named, the landing, and the hops (CitedFact.redirect).
  // A landing that names neither the AHJ nor its agency (another city's tenant, a vendor's site) is
  // not kept, and the reason is added to the refusal.
  const redirectFor = new Map<string, { finalUrl: string; chain: string[]; status: number }>();
  const redirectRefusal = new Map<string, string>();
  if (reader) {
    for (const p of basePermits) {
      const d = p.discipline;
      const ctx = finalCtx(d);
      for (const c of finalCandidates(p)) {
        const claimed = str(c.raw?.value);
        if (!/^https?:\/\//i.test(claimed) || redirectFor.has(claimed) || redirectRefusal.has(claimed)) continue;
        if (acceptPortalForPermit(c.raw, c.source, ctx).code !== "unattested") continue;
        const pg = await reader.read(claimed);
        const landing = str(pg.finalUrl) || claimed;
        const hops = pg.redirects?.length ? pg.redirects : landing !== claimed ? [claimed, landing] : [claimed];
        if (portalHostOf(landing) === portalHostOf(claimed)) {
          // No redirect: a page WE opened attests its host only as a platform page (R3's door).
          if (pg.ok && detectPlatform(pg)) { ourSeen.push(pg.url, pg.finalUrl); platformReads.set(portalTenantKey(pg.finalUrl), pg); }
          else redirectRefusal.set(claimed, pg.ok ? `our one read of ${claimed} found no permit portal there` : `our one read of ${claimed} did not succeed (${str(pg.reason).slice(0, 100)})`);
          continue;
        }
        if (!pg.ok) {
          redirectRefusal.set(claimed, `${claimed} redirects to ${landing}, which our one read could not read (${str(pg.reason).slice(0, 100)})`);
          continue;
        }
        const names = issuer.namesFor(d);
        if (!landingNamesJurisdiction(landing, pg, names, input.state)) {
          redirectRefusal.set(claimed, `${claimed} redirects to ${landing}, which names neither ${names.join(" nor ")} (its tenant, domain or page) — not kept`);
          continue;
        }
        // The LANDING is what our read attests — never the named host itself (it only redirects).
        ourSeen.push(landing);
        if (detectPlatform(pg)) platformReads.set(portalTenantKey(landing), pg);
        redirectFor.set(claimed, { finalUrl: landing, chain: hops, status: pg.status });
      }
    }
  }
  const finalPortal = (p: PermitProcessPermitAnswer): CitedFact<string> => {
    const d = p.discipline;
    if (!decided.has(d)) {
      const ctx = finalCtx(d);
      // A redirected claim is judged as its landing URL (the citing page's words stay its quote).
      const candidates = finalCandidates(p).map((c) => {
        const r = redirectFor.get(str(c.raw?.value));
        return r ? { ...c, raw: { ...(c.raw as Record<string, unknown>), value: r.finalUrl } } : c;
      });
      const { decisions, accepted, chosen } = judgePortal(candidates, ctx);
      const redirectedFrom = (x: { claimed: string }) => [...redirectFor.entries()].find(([, r]) => r.finalUrl === x.claimed)?.[0] ?? "";
      let final: PortalDecision = chosen;
      if (accepted && redirectedFrom(accepted)) {
        const from = redirectedFrom(accepted);
        const r = redirectFor.get(from)!;
        final = { ...accepted, fact: { ...accepted.fact, redirect: { from, finalUrl: r.finalUrl, chain: r.chain, status: r.status } } };
      } else if (!final.fact.value) {
        const claim = str(final.fact.claimed) || str((final as { claimed?: string }).claimed);
        const why = redirectRefusal.get(claim);
        if (why) final = { ...final, fact: { ...final.fact, notFound: `${str(final.fact.notFound)}; ${why}`.replace(/^; /, "") } };
      }
      decided.set(d, final);
      for (const x of decisions) {
        const from = redirectedFrom(x);
        if (x === accepted) portalNotes.push(`Portal (${d}): ${x.fact.value} — from the ${x.source}${from ? `, named as ${from}, which redirects there (${(redirectFor.get(from)?.chain ?? []).join(" → ")})` : ""}; attested by ${x.attestedBy}; jurisdiction type judged against ${(ctx.typeNames ?? []).join(" / ") || "(none)"}`);
        else if (x.claimed && !x.fact.value) portalNotes.push(`Portal refused (${d}): ${from ? `${from} → ${x.claimed}` : x.claimed} — from the ${x.source}: ${x.fact.notFound}${redirectRefusal.has(x.claimed) ? `; ${redirectRefusal.get(x.claimed)}` : ""}`);
      }
    }
    return decided.get(d)!.fact;
  };
  // A portal that came from the model: its catalog too (when its platform is readable).
  const finalPortalOf = (d: PermitProcessDiscipline) => finalPortal(basePermits.find((x) => x.discipline === d)!).value ?? null;
  await fillRecordTypes(basePermits.map((p) => p.discipline), finalPortalOf, (d) => citedRt(d, finalPortalOf(d), byDiscipline.get(d)?.recordType, portalFor.get(d)?.recordType));
  const questions: string[] = [];
  const permits: PermitProcessPermitAnswer[] = basePermits.map((p) => {
    const pf = portalFor.get(p.discipline);
    const df = docsFor.get(p.discipline);
    const portalUrl = finalPortal(p);
    const rc = recordFor.get(p.discipline);
    // EVERY RECORD-TYPE SOURCE THROUGH THE ONE PREDICATE (close-6 MF1): the model's cited type (part
    // one's, else the step's) and the catalog's answer are each kept only beside the portal they
    // belong to — with no portal saved there is no record type; a county tenant's type beside the
    // city's portal (or beside a refused county portal) is not the city's.
    const belongs = (rt: CitedFact<string> | null) => recordTypeForPortal(rt, portalUrl.value, rtCtx(p.discipline));
    const modelRecordType = belongs(p.recordType.value || !pf ? p.recordType : pf.recordType) as CitedFact<string>;
    // THE ?? FALLTHROUGH (close F5): the catalog's answer is an object even when it chose nothing, so
    // a CITED record type (from whichever step) that names one candidate decides it here too.
    const namedByModel = rc && !rc.recordType?.value ? candidateNamedBy(rc.candidates, modelRecordType.value) : null;
    const catalogRecordType: CitedFact<string> | null = belongs(namedByModel ? { value: namedByModel.label, sourceUrl: namedByModel.sourceUrl, quote: namedByModel.quote, origin: "lookup" } : rc?.recordType ?? null);
    if (rc?.question && !namedByModel && !catalogRecordType?.value && !questions.includes(rc.question)) questions.push(rc.question);
    return {
      ...p,
      portalUrl,
      // The PORTAL'S OWN label (its public catalog) outranks the agency page's words; with several
      // solar types and no deciding plan path or cited type, recordType is null and the candidates
      // carry the choice.
      recordType: catalogRecordType ?? modelRecordType,
      ...(rc?.candidates.length ? { recordTypeCandidates: rc.candidates.map((c) => ({ label: c.label, condition: c.condition, sourceUrl: c.sourceUrl, quote: c.quote })) } : {}),
      ...(portalUrl.value ? { portalPlatform: (ev?.portal && decided.get(p.discipline)?.source === "agency page (our read)" ? ev.portal.platform : platformOfUrl(portalUrl.value)) ?? undefined } : {}),
      documents: df?.documents ?? ungrounded("not found"),
      fee: df?.fee ?? ungrounded("not found"),
    };
  });
  prerequisites.push(...(ev?.prerequisites ?? []));
  const uniquePrereqs = prerequisites.filter((x, i) => prerequisites.findIndex((y) => str(y.value).toLowerCase() === str(x.value).toLowerCase() || (Boolean(x.quote) && y.quote === x.quote)) === i);
  const notes = [
    ...problems.filter(Boolean),
    ...(issuingAgency !== part1.issuingAgency ? [`Issuing agency lifted from the permits' agreeing cited agencies (${issuingAgency.value}).`] : []),
    ...(ev?.portal ? [`Portal resolved from the agency's own page (${ev.portal.via}): ${ev.portal.quote} — ${ev.portal.sourceUrl}`] : []),
    ...portalNotes,
    ...questions.map((q) => `Operator question: ${q}`),
    ...uniquePrereqs.map((x) => `Prerequisite: ${x.value} — ${x.sourceUrl}`),
  ];
  // A LOOKUP THAT NEVER RAN IS NOT A RESULT (close-2 item 6): when EVERY call errored (an abort, a
  // timeout, a credit/billing refusal, a 5xx), nothing is written — an all-not-found row would read
  // as "looked up, nothing found" and block the re-queue for 24 h — and the job fails with the named
  // error, so the queue retries it and ensurePermitProcessLookedUp re-queues on the next trigger. A
  // lookup that RAN and found nothing (calls that returned, however empty) is still saved.
  if (calls.length && calls.every((c) => c.error)) {
    throw new Error(`permit-process lookup for ${input.ahj} (${input.state}) did not run: every call errored — ${str(calls[0].error).slice(0, 200)}`);
  }
  // NOT SAVED WITHOUT A GROUNDED PART (close-3 F1). Part one decides which agency the later parts
  // ask about; when it errored (twice, on an abort — or once, on a refusal) the other parts were
  // asked blind, of the AHJ, with no page read, and their "{}" is not a lookup that ran: an errored
  // run, thrown and re-queued, never an all-not-found row that would block the re-queue. Likewise a
  // run in which NO part was grounded (no web search returned results and no page we read backed
  // an answer) never ran in any sense that could be saved. A run that RAN and found nothing (a
  // grounded part, however empty its answer) is still saved.
  if (p1.error) {
    throw new Error(`permit-process lookup for ${input.ahj} (${input.state}) did not run: the process part errored — ${str(p1.error).slice(0, 200)}`);
  }
  if (groundedParts === 0) {
    throw new Error(`permit-process lookup for ${input.ahj} (${input.state}) did not run: no part was grounded (no web search returned results, no page was read) — nothing kept from memory`);
  }
  // A RE-RUN NEVER FORGETS A CITED ANSWER. Over an existing seeded row, a value this run could not
  // establish (an aborted part, a search that came up empty) keeps the earlier cited answer.
  // The earlier row's portal goes through the ONE door with THIS run's issuer (mergeWithEarlier).
  const merged = mergeWithEarlier(existing, { issuingAgency, permitStructure: part1.permitStructure, permits },
    (d, earlierPortal) => acceptPortalForPermit({ value: earlierPortal.value, sourceUrl: earlierPortal.sourceUrl, quote: earlierPortal.quote }, "process part", doorContextFor(d, { seen: [], platformPages: [] })),
    (d, earlierRecordType, portalUrl) => recordTypeBelongsToPortal(earlierRecordType, portalUrl, rtCtx(d)));
  const res = savePermitProcessLookup(db, {
    state: input.state, ahj: input.ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: merged.issuingAgency, permitStructure: merged.permitStructure, permits: merged.permits, notes,
    prerequisites: uniquePrereqs.length ? uniquePrereqs : existing?.prerequisites,
    ...(ev?.codes ? { codes: ev.codes } : existing?.codes ? { codes: existing.codes } : {}),
    ...(reader ? { pagesRead: reader.log.map((l) => ({ url: l.url, ok: l.ok, reason: l.reason.slice(0, 160) })) } : {}),
  });
  if (res.saved && res.lookup) {
    try { applyLookupFees(db, res.lookup); } catch (err) { logger.warn("permit-process", `fee landing failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { saved: res.saved, reason: res.reason, lookup: res.lookup, calls, raw, ...(reader ? { reads: [...reader.log] } : {}) };
}
const g0 = (groups: Array<{ agency: string }>) => groups[0]?.agency ?? "";

// ── NOT ASKED is not NOT FOUND (F-b) ───────────────────────────────────────────────────────
/** The fixed prefix a part that ABORTED leaves on every answer it never gave; a lookup row carrying
 *  one is re-asked (ensurePermitProcessLookedUp / runPermitProcessLookup over a seeded row). */
export const NOT_ASKED = "not asked";
const notAsked = (what: string, error: string): CitedFact<never> => ({ value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: `${NOT_ASKED} — the ${what} lookup did not run (${str(error).slice(0, 120)})` });
export const isUnaskedFact = (f: Pick<CitedFact<unknown>, "value" | "notFound"> | null | undefined): boolean => Boolean(f && f.value == null && new RegExp(`^${NOT_ASKED}\\b`).test(str(f.notFound)));
export function lookupHasUnaskedPart(lookup: Pick<PermitProcessLookup, "permits"> | null | undefined): boolean {
  return Boolean(lookup?.permits.some((p) => isUnaskedFact(p.documents) || isUnaskedFact(p.fee) || isUnaskedFact(p.portalUrl)));
}

function keep<T>(now: CitedFact<T>, before: CitedFact<T> | undefined): CitedFact<T> {
  return now.value == null && before && before.value != null ? before : now;
}
/** What a re-run carries from the earlier row (lookup-close-5, the merge sibling of MF1). "Never
 *  forgets" means a value THIS run could not establish; it never means a value this run's door
 *  refuses, nor one another issuer's permit held:
 *   - ANOTHER ISSUER: this run names the permit's agency and the earlier row named a different one
 *     (sameAgencyName) — the earlier permit's portal, record type, documents and fee were that other
 *     agency's, so nothing of it is carried (a city portal never sits beside the county's name).
 *   - THE DOOR, ONCE MORE: the earlier portal is judged by acceptPortalForPermit with THIS run's
 *     issuer (`judgePortal`); an OUTRIGHT refusal (rule 5, another module, the issuer's jurisdiction
 *     type — a row an older door saved) is not carried and its reason is the saved notFound. Attestation
 *     is not re-asked (it was earned when the value was saved; this run's search may simply not
 *     return that host again).
 *   - A RECORD TYPE IS ITS PORTAL'S: the earlier record type is carried only when it belongs to the
 *     portal the merged row saves (`belongs`: the ONE record-type predicate, recordTypeBelongsToPortal
 *     — lookup-close-6 MF1: "or the earlier row had none" carried a type cited to another tenant's
 *     page beside this run's own portal) — never beside another portal, never with none. */
export function mergeWithEarlier(
  earlier: PermitProcessLookup | null,
  now: { issuingAgency: CitedFact<string>; permitStructure: CitedFact<"separate" | "combo">; permits: PermitProcessPermitAnswer[] },
  judgePortal: (d: PermitProcessDiscipline, earlierPortal: CitedFact<string>) => PortalDecision,
  belongs: (d: PermitProcessDiscipline, earlierRecordType: CitedFact<string>, portalUrl: string | null) => boolean,
): typeof now {
  if (!earlier) return now;
  const noType = (why: string): CitedFact<string> => ({ value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: why });
  const permits = now.permits.map((p) => {
    const b = earlier.permits.find((e) => e.discipline === p.discipline);
    if (!b) return p;
    if (p.issuingAgency.value && b.issuingAgency.value && !sameAgencyName(p.issuingAgency.value, b.issuingAgency.value)) return p;
    let portalUrl = keep(p.portalUrl, b.portalUrl);
    if (portalUrl === b.portalUrl && b.portalUrl.value) {
      const dec = judgePortal(p.discipline, b.portalUrl);
      if (OUTRIGHT_REFUSALS.has(dec.code)) portalUrl = { ...p.portalUrl, notFound: `the earlier row's ${dec.fact.notFound ?? "portal is refused"}` };
    }
    const carryType = !p.recordType.value && Boolean(b.recordType.value) && belongs(p.discipline, b.recordType, portalUrl.value);
    return {
      ...p, issuingAgency: keep(p.issuingAgency, b.issuingAgency), portalUrl,
      recordType: carryType ? b.recordType : p.recordType, documents: keep(p.documents, b.documents), fee: keep(p.fee, b.fee),
    };
  });
  // A permit only the earlier row lists is carried too — through the same doors (its portal and the
  // record type in that portal's words are dropped on an outright refusal with this run's issuer; a
  // record type that does not belong to its portal is dropped alone).
  for (const b of earlier.permits) {
    if (permits.some((p) => p.discipline === b.discipline)) continue;
    const dec = b.portalUrl.value ? judgePortal(b.discipline, b.portalUrl) : null;
    if (dec && OUTRIGHT_REFUSALS.has(dec.code)) {
      const gone = noType(`the earlier row's ${dec.fact.notFound ?? "portal is refused"}`);
      const { recordTypeCandidates: _dropped, ...rest } = b;
      permits.push({ ...rest, portalUrl: gone, recordType: { ...gone, notFound: "the earlier row's record type was its refused portal's" } });
    } else if (b.recordType.value && !belongs(b.discipline, b.recordType, b.portalUrl.value ?? null)) {
      const { recordTypeCandidates: _dropped, ...rest } = b;
      permits.push({ ...rest, recordType: noType(b.portalUrl.value ? "the earlier row's record type is not its portal's tenant's — not carried" : "the earlier row's record type had no portal — not carried") });
    } else permits.push(b);
  }
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
    // THE AHJ ITSELF, under a department suffix or a stray "/" (close-5 MF4: "City of Charleston
    // Permit Center /"), is not another authority: no delegation row, its own fee.
    const delegates = Boolean(agencyName) && !sameAgencyName(agencyName, lookup.ahj);
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
    const baseLines = fee.value.lines.filter((l) => !SURCHARGE_WORDS.test(l.label ?? "") && typeof l.amountUsd === "number");
    const baseLine = baseLines.length === 1 ? baseLines[0] : undefined;
    // A FLAT bracket needs a stated total (supportsAmount: printed, or the sum of printed lines) and a
    // fee that is not priced by valuation or a rate — never the first row of a table (close MF1).
    // With a cited surcharge the evaluator adds it, so the bracket is the ONE printed base line; a
    // total (which may already include the surcharge) would count it twice.
    const flatUsd = surcharge ? (baseLine?.amountUsd ?? null) : fee.value.amountUsd;
    if (!tiers.length && (flatUsd == null || RATED_FEE.test(`${fee.value.basis} ${fee.quote}`))) {
      out.push({ discipline: permit.discipline, saved: false, reason: flatUsd == null ? "no stated total for this permit — not landed as a flat fee" : "priced by valuation or a rate — not a flat fee" });
      continue;
    }
    const brackets = tiers.length
      ? tiers.map((t, i) => ({ minKw: printedMinKva(t.label) ?? (i === 0 ? 0 : tiers[i - 1].maxKva), maxKw: t.maxKva, feeUsd: t.amountUsd, label: t.label || `up to ${t.maxKva} kVA` }))
      : [{
        feeUsd: flatUsd as number,
        label: (surcharge && baseLine ? baseLine.label : "") || fee.value.lines.find((l) => l.amountUsd === flatUsd)?.label || fee.value.basis || `${permit.label} fee`,
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
  // A row whose portal / documents-fees part was NEVER ASKED (an aborted call, F-b) is re-asked —
  // bounded by the 24 h dedupe below, which counts the run that wrote it.
  const existing = getPermitProcessLookup(db, project.state, ahj);
  if (existing && !(existing.confidence === "seeded" && lookupHasUnaskedPart(existing))) return false;
  try {
    const { findAhjProcessProfile } = await import("./processProfiles");
    if (findAhjProcessProfile(project as never)) return false;
    const jobQueue = await import("./jobQueue");
    if (!jobQueue.jobWorkerRunning()) return false;
    const key = `${str(project.state).toLowerCase()}|${normalizeAhjName(ahj)}`;
    // The 24 h dedupe applies to a lookup that is pending / running or one that RAN (done); a job
    // that FAILED (every call errored — close-2 item 6) is re-queued on the next trigger.
    const recent = db.get<{ id: string }>(
      "SELECT id FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ? AND (status IN ('pending','running') OR (status = 'done' AND created_at > ?)) LIMIT 1",
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
