// Portal-AGNOSTIC "where do I start an application?" finder.
//
// After login, every permit portal has one control that begins a NEW application, and every
// vendor names it differently: Accela "Create an Application", Tyler EnerGov "Apply",
// OpenGov "Apply for a permit", SmartGov "Apply Online", Citizenserve "Apply for a Permit",
// BS&A "Apply for a Permit". The learn loop previously found this only via an LLM planner
// call (or, for Accela, a hardcoded pass), so an unknown portal burned tokens — and could
// wander — on a step that is deterministic.
//
// THE DANGEROUS PART IS WHAT IT MUST NOT CLICK. A logged-in portal home is full of controls
// that lead into the OPERATOR'S REAL FILINGS: "Resume Application", "Pay Fees Due",
// "Search Applications", "Renew", "Upload Documents", "My Records". Clicking one of those
// operates on a live submitted permit belonging to a real customer. Exclusions are therefore
// checked FIRST and win over any positive match.

import type { Page, Frame, Locator } from "playwright";

export interface ApplicationEntryMatch {
  /** The visible label of the control we would click. */
  label: string;
  /** How it was matched, for diagnostics/telemetry. */
  via: "text" | "href";
  /** The href when the control is a link (absolute or portal-relative). */
  href?: string;
}

// Controls that begin a NEW application. Ordered most-specific → most-generic so the
// diagnostic label is the meaningful one when several match.
const ENTRY_PATTERNS: RegExp[] = [
  /\bcreate an application\b/i,                        // Accela ACA
  /\bapply for (a |an )?(new )?(permit|license|application)\b/i, // OpenGov / SmartGov / Citizenserve / BS&A
  /\bstart (a |an )?(new )?(application|permit)\b/i,
  /\bnew (permit |building )?application\b/i,
  /\bsubmit (a |an )?(new )?(application|permit)\b/i,
  /\bapply online\b/i,                                  // SmartGov
  /\bcreate (a |an )?(new )?(permit|record|case)\b/i,
  /\bpermit application\b/i,
  /^\s*apply\s*(here|now|online)?\s*$/i,                 // EnerGov's bare "Apply" tile; Momentum's "Apply Here"
];

// NEVER click these, even when they also match a pattern above. These lead into the
// operator's real, already-filed records — or into payment.
const EXCLUDE_PATTERNS: RegExp[] = [
  /\bresume\b/i,                 // "Resume Application" — an existing draft/filing
  /\bpay\b|\bfees? due\b|\bpayment\b|\bcart\b|\bcheckout\b/i,
  /\bsearch\b|\blook ?up\b/i,    // "Search Applications"
  /\brenew\b/i,
  /\bmy (records|permits|applications|account)\b/i,
  /\bview\b|\bstatus\b|\btrack\b/i,
  /\bupload\b|\battach\b/i,
  /\binspection\b/i,
  /\bschedule\b/i,
  /\bcancel\b|\bwithdraw\b|\bdelete\b/i,
  /\bexisting\b|\bdraft\b/i,
  /\bregister\b|\bsign ?up\b|\bcreate an account\b/i, // account creation, not an application
];

export function isExcludedEntryLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  return EXCLUDE_PATTERNS.some((re) => re.test(text));
}

export function matchesEntryLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 60) return false;      // a paragraph is not a button
  if (isExcludedEntryLabel(text)) return false;
  return ENTRY_PATTERNS.some((re) => re.test(text));
}

// Rank a match so the most specific label wins when a page offers several.
function entryRank(label: string): number {
  const text = label.replace(/\s+/g, " ").trim();
  const i = ENTRY_PATTERNS.findIndex((re) => re.test(text));
  return i < 0 ? ENTRY_PATTERNS.length : i;
}

/**
 * Find the control that starts a NEW application, searching the main document and every
 * same-origin frame. Returns the best candidate WITHOUT clicking it (callers decide), or
 * null when the page offers none. Never returns an excluded control.
 */
export async function findApplicationEntry(page: Page): Promise<{ locator: Locator; match: ApplicationEntryMatch } | null> {
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  let best: { locator: Locator; match: ApplicationEntryMatch; rank: number } | null = null;

  for (const scope of scopes) {
    let candidates: Array<{ label: string; href: string; index: number }> = [];
    try {
      candidates = await (scope as Frame).evaluate(() => {
        const vis = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return (Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button]")) as HTMLElement[])
          .filter(vis)
          .map((el, index) => ({
            label: ((el as HTMLInputElement).value || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
            href: el.getAttribute("href") || "",
            index,
          }))
          .filter((c) => c.label);
      });
    } catch { continue; } // cross-origin frame
    for (const c of candidates) {
      if (!matchesEntryLabel(c.label)) continue;
      const rank = entryRank(c.label);
      if (best && rank >= best.rank) continue;
      // Re-locate by exact visible text within this scope — stable across the evaluate boundary.
      const loc = (scope as Frame).getByText(c.label, { exact: true }).first();
      best = { locator: loc as Locator, match: { label: c.label, via: c.href ? "href" : "text", href: c.href || undefined }, rank };
    }
  }
  return best ? { locator: best.locator, match: best.match } : null;
}

// MODULE tabs that a portal files applications under. On Accela the logged-in home offers
// only "Home | Permits | Licensing | Planning and Zoning …" — "Create an Application" lives
// one hop inside the module (verified live on Anne Arundel County). Ordered so a solar
// permit lands in the building/permits module, never in Licensing or Enforcement.
const MODULE_PATTERNS: RegExp[] = [
  /^\s*permits?\s*$/i,
  /^\s*building\s*(permits?|department)?\s*$/i,
  /^\s*(building )?safety\s*$/i,
  /^\s*development\s*$/i,
  /^\s*planning( and zoning)?\s*$/i,
];
export function matchesModuleLabel(label: string): boolean {
  const text = (label || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 40 || isExcludedEntryLabel(text)) return false;
  return MODULE_PATTERNS.some((re) => re.test(text));
}

/**
 * Find the application entry, following ONE module hop when the landing page doesn't offer
 * it directly. Returns the match plus whether a hop was needed; the page is left wherever
 * the search ended (a module home is a harmless read-only listing page).
 * Bounded to `maxModules` hops so a portal that never offers an entry can't be walked
 * indefinitely, and module candidates are exclusion-filtered like everything else.
 */
export async function findApplicationEntryDeep(
  page: Page,
  opts: { maxModules?: number } = {},
): Promise<{ match: ApplicationEntryMatch; viaModule?: string } | null> {
  const direct = await findApplicationEntry(page);
  if (direct) return { match: direct.match };

  const maxModules = opts.maxModules ?? 3;
  let moduleLabels: string[] = [];
  try {
    moduleLabels = await page.evaluate(() => {
      const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return (Array.from(document.querySelectorAll("a, button, [role=button], [role=tab]")) as HTMLElement[])
        .filter(vis)
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    });
  } catch { return null; }

  const seen = new Set<string>();
  const modules = moduleLabels.filter((l) => matchesModuleLabel(l) && !seen.has(l) && seen.add(l)).slice(0, maxModules);
  const home = typeof page.url === "function" ? page.url() : "";
  for (const label of modules) {
    try {
      await page.getByText(label, { exact: true }).first().click({ timeout: 8000 });
      await page.waitForLoadState?.("networkidle", { timeout: 12000 }).catch(() => null);
      await page.waitForTimeout?.(1200);
    } catch { continue; }
    const found = await findApplicationEntry(page);
    if (found) return { match: found.match, viaModule: label };
    // Nothing here — go back and try the next module.
    try { await page.goto(home, { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForTimeout?.(1000); } catch { break; }
  }
  return null;
}

/**
 * Click into the application flow. Returns where it landed. Does NOT fill or submit
 * anything — starting an application is a navigation, and the caller (learn loop / probe)
 * takes it from there.
 */
export async function enterApplicationFlow(
  page: Page,
): Promise<{ ok: boolean; message: string; url: string; label?: string }> {
  const found = await findApplicationEntry(page);
  if (!found) {
    return { ok: false, message: "No 'start an application' control found on this page.", url: typeof page.url === "function" ? page.url() : "" };
  }
  const before = typeof page.url === "function" ? page.url() : "";
  try {
    await found.locator.click({ timeout: 10000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout?.(1500);
  } catch (err) {
    return { ok: false, message: `Found "${found.match.label}" but the click failed: ${err instanceof Error ? err.message : String(err)}`, url: before, label: found.match.label };
  }
  const after = typeof page.url === "function" ? page.url() : "";
  return {
    ok: true,
    message: `Entered the application flow via "${found.match.label}".`,
    url: after,
    label: found.match.label,
  };
}
