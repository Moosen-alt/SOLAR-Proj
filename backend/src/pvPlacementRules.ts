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
    user: `Jurisdiction: ${jurisdiction.ahj}\nState: ${jurisdiction.state}`,
    maxTokens: 3000,
    maxSearches: 4,
    readPages: true,
    maxFetches: 3,
  });
  if (result.error) return { rules: [], dropped: [], webGrounded: false, error: result.error };
  const parsed = parsePlacementLookup(result, jurisdiction);
  return { ...parsed, webGrounded: result.groundedSearches > 0 };
}
