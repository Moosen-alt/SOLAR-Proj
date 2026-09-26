// THE AHJ'S OWN PV PLACEMENT RULES — fire setbacks, access pathways, placement guidelines and local
// PV amendments — looked up from the AHJ's own pages and stored on its code profile.
//
// New-AHJ e2e (2026-09-26): no AHJ of seven had a setback rule on file (fireSetbacks: [] everywhere),
// and the ONE real AHJ correction in the corpus was one: Waltham Fire Prevention moved an access path
// that sat on the side of the roof where the electrical service comes in. The rule behind it is a
// public Waltham checklist item ("Three-foot access path should, if possible, be clear of incoming
// electrical service"). Scottsdale's placement guideline (3 ft from the ridge, two paths per slope)
// is public too. Knowing the rule is the only route to catching that correction.
//
// Only what a cited page SAYS lands: every rule is the page's own sentence, its URL must be one the
// lookup's searches returned or a page it opened, and the page must be an official source for this
// jurisdiction. Nothing here decides compliance — the reviewer shows the rule as a callout ("AHJ rule
// on file: … confirm on the roof plan"), never a check mark.
import type { LLMProvider, WebLookupResult } from "../../shared/src/types";
import { isOfficialCodeSource } from "./llm";
import { fetchPublicDocument } from "./documentFetch";
import { extractPdfTextItems } from "./pdfTables";

export type PlacementRuleKind = "fire_setback" | "access_pathway" | "placement" | "local_amendment";

export interface PlacementRule {
  kind: PlacementRuleKind;
  /** The page's own sentence, verbatim. */
  rule: string;
  sourceUrl: string;
  /** The document's own item/section label when it has one ("Item 11", "Section 5.2"). */
  section?: string;
}

export const PLACEMENT_LOOKUP_SYSTEM = `You look up ONE building jurisdiction's OWN rules for where rooftop solar panels may go: fire-department setbacks and access pathways (from the ridge, eaves, hips, valleys; how many paths per roof slope; clearance around vents or the electrical service), PV placement guidelines, and any LOCAL amendment to the code sections on rooftop PV (IRC R324 / IFC 1205 / NEC 690) that the jurisdiction or its fire department publishes.

SEARCH the jurisdiction's own site and its fire department's site: solar permit checklists, residential PV submittal guidelines, fire prevention solar requirements, local code amendments. OPEN the page or PDF that states the rule before quoting it.

RULES
- Quote each rule EXACTLY as the page prints it — one sentence or list item per rule. Never paraphrase, never merge two rules, never add a number the page does not print.
- Only this jurisdiction's own pages (city/county/fire district .gov or its official site). A model code book, a state-wide summary, a solar blog or another city's page is NOT this jurisdiction's rule — leave it out.
- If the jurisdiction publishes nothing beyond the adopted model code, return an empty list. An honest empty list is a correct answer.

Return ONLY JSON:
{"rules":[{"kind":"fire_setback|access_pathway|placement|local_amendment","rule":"<verbatim sentence>","section":"<item/section label or empty>","sourceUrl":"<the page or PDF that prints it>"}]}`;

const KINDS: PlacementRuleKind[] = ["fire_setback", "access_pathway", "placement", "local_amendment"];

function normUrl(u: string): string {
  return String(u || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** Pure: the lookup's answer as the rules that may be stored (grounded, official, verbatim-shaped). */
export function parsePlacementLookup(result: Pick<WebLookupResult, "text" | "groundedSearches" | "resultUrls" | "fetchedUrls">, jurisdiction: { ahj: string; state: string }): { rules: PlacementRule[]; dropped: string[] } {
  const dropped: string[] = [];
  if (!result.groundedSearches) return { rules: [], dropped: ["no web search returned results — nothing is stored from model memory"] };
  let parsed: unknown;
  try {
    const m = String(result.text || "").match(/```(?:json)?\s*([\s\S]*?)```/) ?? String(result.text || "").match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(m ? m[1] : String(result.text || ""));
  } catch {
    return { rules: [], dropped: ["the answer did not parse"] };
  }
  const seen = new Set([...(result.resultUrls ?? []), ...(result.fetchedUrls ?? [])].map(normUrl));
  const raw = Array.isArray((parsed as { rules?: unknown })?.rules) ? (parsed as { rules: unknown[] }).rules : [];
  const out: PlacementRule[] = [];
  const texts = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = KINDS.includes(String(o.kind) as PlacementRuleKind) ? (String(o.kind) as PlacementRuleKind) : null;
    const rule = String(o.rule ?? "").replace(/\s+/g, " ").trim();
    const sourceUrl = String(o.sourceUrl ?? "").trim();
    const section = String(o.section ?? "").trim().slice(0, 80);
    if (!kind || rule.length < 15 || rule.length > 500) { dropped.push(`malformed rule: ${rule.slice(0, 60)}`); continue; }
    if (!sourceUrl || !seen.has(normUrl(sourceUrl))) { dropped.push(`uncited (the URL was not a page the lookup found or opened): ${sourceUrl || "(none)"}`); continue; }
    if (!isOfficialCodeSource(sourceUrl, jurisdiction)) { dropped.push(`not an official source for ${jurisdiction.ahj}: ${sourceUrl}`); continue; }
    const key = rule.toLowerCase();
    if (texts.has(key)) continue;
    texts.add(key);
    out.push({ kind, rule, sourceUrl, ...(section ? { section } : {}) });
  }
  return { rules: out.slice(0, 12), dropped };
}

/** One web-grounded lookup (transport only: the provider's webLookup), parsed. */
export async function researchPlacementRules(
  llm: Pick<LLMProvider, "webLookup">,
  jurisdiction: { ahj: string; state: string },
): Promise<{ rules: PlacementRule[]; dropped: string[]; webGrounded: boolean; error?: string }> {
  if (!llm.webLookup) return { rules: [], dropped: [], webGrounded: false, error: "no web lookup available (no model key)" };
  const result = await llm.webLookup({
    label: "pvPlacementRules",
    system: PLACEMENT_LOOKUP_SYSTEM,
    user: `Jurisdiction: ${jurisdiction.ahj}\nState: ${jurisdiction.state}\n`
      + `Searches that find these pages: "${jurisdiction.ahj} fire department solar PV checklist", "${jurisdiction.ahj} residential solar submittal requirements", "${jurisdiction.ahj} solar access pathway ridge setback".`,
    // Live, 2026-09-26: a 3000-token answer was cut off on Scottsdale, and a 180 s budget aborted a
    // second Scottsdale pass. A background job can afford both.
    maxTokens: 6000,
    maxSearches: 5,
    readPages: true,
    maxFetches: 3,
    timeoutMs: 240_000,
  });
  if (result.error) return { rules: [], dropped: [], webGrounded: false, error: result.error };
  const parsed = parsePlacementLookup(result, jurisdiction);
  const checked = await verifyPlacementQuotes(parsed.rules);
  return { rules: checked.rules, dropped: [...parsed.dropped, ...checked.dropped], webGrounded: result.groundedSearches > 0 };
}

/** The text of one page, for the quote check: "" when it could not be retrieved. */
export type PlacementPageReader = (url: string) => Promise<{ ok: boolean; text: string; status: number }>;

async function readPageText(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  // Plain HTTP only — a background job never opens a browser window for this.
  const doc = await fetchPublicDocument(url, { allowBrowser: false, timeoutMs: 20_000, maxBytes: 12 * 1024 * 1024 });
  if (!doc.ok) return { ok: false, text: "", status: doc.status };
  if (/pdf/i.test(doc.contentType) && doc.bytes) {
    try {
      const items = await extractPdfTextItems(doc.bytes, { maxPages: 40 });
      return { ok: true, text: items.map((i) => i.str ?? "").join(" "), status: doc.status };
    } catch { return { ok: false, text: "", status: doc.status }; }
  }
  return { ok: true, text: String(doc.text ?? "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "), status: doc.status };
}

let pageReaderForTests: PlacementPageReader | null = null;
/** Test seam: read pages without the network. null restores the real reader. */
export function setPlacementPageReaderForTests(fn: PlacementPageReader | null): void {
  pageReaderForTests = fn;
}

/** Letters, digits and % only, entities and typographic quotes/primes folded — so a quote survives
 *  the page's line breaks, &nbsp; and curly marks, and nothing else. */
export function foldForQuote(value: string): string {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;|&#34;|&rdquo;|&ldquo;|&#8221;|&#8220;/gi, "\"")
    .replace(/&#39;|&rsquo;|&lsquo;|&#8217;|&#8216;/gi, "'")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, "");
}

/**
 * EVERY STORED RULE IS ON THE PAGE WE RETRIEVED. The lookup's own page reads are not returned to us,
 * and a live pass (2026-09-26) cited a Waltham URL that answers a plain client with the city's 404
 * page — the rules it quoted could not be shown to be Waltham's. So each cited page is fetched
 * (plain HTTP, no browser) and a rule is kept only when its folded text appears in the page's.
 * A page we cannot retrieve keeps nothing: an unverifiable rule is an unknown, not a rule.
 */
export async function verifyPlacementQuotes(rules: PlacementRule[]): Promise<{ rules: PlacementRule[]; dropped: string[] }> {
  const reader = pageReaderForTests ?? readPageText;
  const pages = new Map<string, { ok: boolean; text: string; status: number }>();
  const kept: PlacementRule[] = [];
  const dropped: string[] = [];
  for (const r of rules) {
    if (!pages.has(r.sourceUrl)) {
      let page = { ok: false, text: "", status: 0 };
      try { page = await reader(r.sourceUrl); } catch { /* unreadable */ }
      pages.set(r.sourceUrl, { ...page, text: foldForQuote(page.text) });
    }
    const page = pages.get(r.sourceUrl)!;
    if (!page.ok) { dropped.push(`page not retrievable (status ${page.status}) — "${r.rule.slice(0, 60)}" not stored: ${r.sourceUrl}`); continue; }
    const needle = foldForQuote(r.rule);
    if (needle.length < 12 || !page.text.includes(needle)) { dropped.push(`quote not found on the page we retrieved — "${r.rule.slice(0, 60)}": ${r.sourceUrl}`); continue; }
    kept.push(r);
  }
  return { rules: kept, dropped };
}
