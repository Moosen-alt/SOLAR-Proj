// "THIS PORTAL DOES NOT SERVE THIS ADDRESS" — ONE predicate (portal-truth D5).
//
// A real filing (City of Corvallis OR, 2026-09-28) was auto-learned on Oregon ePermitting, where
// Corvallis files no building permits. The portal SAID so — "No Building services were returned
// for this address" — and the learner recorded four more pages, saved a recipe keyed to Corvallis
// on that host, and the next stage could have reused it. A portal telling us the address or the
// jurisdiction is not served there is the most authoritative "wrong portal" signal there is: the
// run stops with the portal's own words, and nothing learned there is kept under that AHJ.
//
// Read on a page's VISIBLE text, by the learner (autoLearnAdapter), the replay (recipeAdapter) and
// the backend's outcome handling (autoLearn / the replay result), so every door asks the same
// question. ANSWER-SHAPED ONLY: each pattern ties the refusal to THIS address / location /
// parcel, or names the jurisdiction as not participating. "No records were returned for this
// search", "No permits found for this record", "Your search returned no results", a maintenance
// notice ("Online services are not available") and a landing page's general "for addresses
// outside our jurisdiction, contact the county" are not refusals of this address.

const NOT_SERVED_PATTERNS: RegExp[] = [
  // Accela Citizen Access, after the address search: "No Building services were returned for this address."
  /\bno\s+(?:[a-z][a-z&/-]*\s+){0,4}services?\s+(?:were|was|are|is)\s+(?:returned|available|offered|found)\s+for\s+(?:this|the\s+(?:selected|entered|given))\s+(?:address|location|parcel|property|site)\b/i,
  // "The address you entered is outside the City's jurisdiction", "This parcel is not within our service area".
  /\b(?:this|the)\s+(?:address|location|parcel|property|site)(?:\s+(?:you\s+(?:have\s+)?(?:entered|selected|provided)|provided|selected|entered))?\s+(?:is|lies|falls|was)\s+(?:not\s+(?:with)?in|outside(?:\s+of)?)\s+(?:the|our|this|its)\s+(?:[a-z']+\s+){0,3}(?:jurisdiction|service\s+area|city\s+limits)\b/i,
  // "Corvallis is not a participating jurisdiction", "This jurisdiction does not participate in Oregon ePermitting".
  /\bnot\s+a\s+participating\s+(?:jurisdiction|agency|municipality|city|county|community)\b/i,
  // …only about THIS system — never a rebate / battery program ("The city does not participate in
  // the Wattsmart Battery program" is a program answer on a utility page, not a refusal).
  /\b(?:jurisdiction|agency|municipality|city|county)\s+(?:is|does)\s+not\s+participat(?:e|ing)\s+(?:in|with|on)\s+(?:this|the|our)?\s*(?:[a-z-]+\s+){0,3}(?:portal|system|site|e-?\s?permitting)\b/i,
  // "The county does not issue building permits for this address."
  /\bdoes\s+not\s+(?:issue|process|accept)\s+(?:[a-z]+\s+){0,2}(?:permits?|applications?)\s+for\s+this\s+(?:address|location|parcel|property|site)\b/i,
  // "This address is not served by this agency."
  /\b(?:this|the)\s+(?:address|location|parcel|property|site)\s+is\s+not\s+(?:served|covered)\s+by\b/i,
];

/** The flag_reason prefix a recipe carries when the portal refused the AHJ's address: the stage's
 *  resolvers never lend its URL, its host is never the AHJ's "own portal", and the statewide
 *  fallback is withheld on it (statewideEvidence). */
export const NOT_SERVED_FLAG_PREFIX = "not served here:";

/** The portal's own words when a page says this address / jurisdiction is not served there, else
 *  null. `text` is the page's VISIBLE text (innerText), never its source. */
export function portalSaysNotServed(text: string | null | undefined): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  if (!t) return null;
  for (const re of NOT_SERVED_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    // The portal's words from the match to the end of its sentence — never the text BEFORE it
    // (a results grid there can carry an address).
    const endDot = t.indexOf(".", m.index + m[0].length);
    const end = Math.min(t.length, endDot >= 0 ? endDot + 1 : m.index + m[0].length, m.index + m[0].length + 120);
    return t.slice(m.index, end).trim().slice(0, 240);
  }
  return null;
}

/** The "not served" words an adapter result carries — its own field, or a step's data — else null.
 *  Read from the structured field the learner / replay set, never sniffed from a message. */
export function notServedInResult(result: unknown): string | null {
  const r = result as { notServed?: unknown; data?: { notServed?: unknown }; steps?: Array<{ data?: { notServed?: unknown } }> } | null | undefined;
  if (!r || typeof r !== "object") return null;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return pick(r.notServed) ?? pick(r.data?.notServed) ?? (Array.isArray(r.steps) ? r.steps.map((st) => pick(st?.data?.notServed)).find(Boolean) ?? null : null);
}
