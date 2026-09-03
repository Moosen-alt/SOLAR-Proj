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
  // "New <qualifier> Application" — the utility/interconnection phrasing. Ameren Illinois
  // offers "New Interconnection Application" (verified live), and a fixed
  // "new (permit|building) application" list would miss every vendor's own noun. Up to two
  // words between, so this stays a button label rather than a sentence.
  /\bnew\s+(?:[a-z-]+\s+){0,2}application\b/i,
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
  // A PRE-application is a different, usually paid, product — an optional engineering study
  // that does not file anything. Ameren Illinois lists "New Pre-Application" right beside
  // the real "New Interconnection Application", so the broadened new-application pattern
  // above must not swallow it.
  /\bpre-?application\b/i,
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
    let candidates: Array<{ label: string; href: string; index: number; fromText: boolean }> = [];
    try {
      candidates = await (scope as Frame).evaluate(() => {
        const vis = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        // THE VISIBLE TEXT IS OFTEN NOT THE NAME. Newer portals put the entry on a floating
        // action button whose content is "+" or an icon-font ligature, with the real name in
        // aria-label or a hover tooltip (title) — ComEd's interconnection portal is exactly
        // this: a purple "+" that only says "New Application" once you hover it. Reading
        // textContent alone made that button unfindable. So: use the visible text when it
        // actually says something, otherwise fall back to the accessible name and then the
        // tooltip. Order matters — a normal button's visible text still wins, because that
        // is what a person reads.
        const meaningful = (t: string): boolean => t.length >= 3 && !/^[+\-–—·•*]+$/.test(t) && !/^[a-z][a-z0-9_]{1,24}$/.test(t);
        return (Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button]")) as HTMLElement[])
          .filter(vis)
          .map((el, index) => {
            const own = ((el as HTMLInputElement).value || el.textContent || "").replace(/\s+/g, " ").trim();
            const aria = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const title = (el.getAttribute("title") || el.getAttribute("data-tooltip") || "").replace(/\s+/g, " ").trim();
            const useOwn = meaningful(own);
            return {
              label: useOwn ? own : (aria || title || own),
              fromText: useOwn,           // how the label was derived decides how we re-find it
              href: el.getAttribute("href") || "",
              index,
            };
          })
          .filter((c) => c.label);
      });
    } catch { continue; } // cross-origin frame
    for (const c of candidates) {
      if (!matchesEntryLabel(c.label)) continue;
      const rank = entryRank(c.label);
      if (best && rank >= best.rank) continue;
      // Re-locate the way the label was DERIVED. A label taken from aria-label or a tooltip
      // is not on the page as text, so locating it by text finds nothing — which is how an
      // icon/FAB entry stayed unclickable even once it was correctly identified.
      const byText = (scope as Frame).getByText(c.label, { exact: true }).first();
      const loc = c.fromText
        ? byText
        : (scope as Frame).locator(`[aria-label="${c.label.replace(/"/g, '\\"')}"], [title="${c.label.replace(/"/g, '\\"')}"]`).first();
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
// Collapsed navigation. Mobile-first portals hide the whole menu — application entry
// included — behind a hamburger toggle, so a logged-in home can legitimately offer nothing
// but "Open Navigation Menu" (measured live on Momentum). Opening it is safe: a toggle
// reveals links, it never submits or mutates anything.
// Deliberately NARROW: it must name itself a menu/navigation toggle. A generic
// "[aria-controls][aria-expanded=false]" also matches every accordion on the page, and
// clicking one on Accela mutated the home enough to break the module walk that had just
// worked — an over-eager opener costs more than a missed menu.
const NAV_TOGGLE_SELECTORS = [
  "button[aria-label*='navigation menu' i]",
  "button[aria-label*='main menu' i]",
  "button[aria-label*='open menu' i]",
  "button[aria-label*='toggle navigation' i]",
  ".navbar-toggler",
  "button.hamburger, .hamburger-menu",
  "[class*='menu-toggle'], [id*='menu-toggle']",
];
async function openCollapsedNav(page: Page): Promise<boolean> {
  // Only when the page is genuinely SPARSE. A collapsed menu means almost nothing is on
  // screen; a portal home that already shows a full navigation has no menu to open, and
  // clicking a toggle there only risks covering the very tabs the module walk needs.
  try {
    const visibleLinks = await page.evaluate(() => {
      const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return (Array.from(document.querySelectorAll("a, button, [role=button]")) as HTMLElement[])
        .filter(vis).filter((e) => (e.textContent || "").trim()).length;
    });
    if (visibleLinks > 12) return false;
  } catch { return false; }

  for (const sel of NAV_TOGGLE_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0 || !(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 5000 });
      await page.waitForTimeout?.(1200);
      return true;
    } catch { /* try the next toggle shape */ }
  }
  return false;
}

export async function findApplicationEntryDeep(
  page: Page,
  opts: { maxModules?: number } = {},
): Promise<{ match: ApplicationEntryMatch; viaModule?: string } | null> {
  // SETTLE FIRST. Called straight after a login, the page is often still mid-redirect: a
  // transitional page has almost no links, which reads as "sparse home with a collapsed
  // menu" and sends the whole search down the wrong path. Wait for the real page.
  await page.waitForLoadState?.("networkidle", { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout?.(1200);

  // The page we return to between module hops — never a login URL. Navigating a logged-in
  // session back to Login.aspx yields a blank/redirect page and the search dead-ends there.
  const current = typeof page.url === "function" ? page.url() : "";
  const home = /login|sign-?in|logon/i.test(current) ? "" : current;

  const direct = await findApplicationEntry(page);
  if (direct) return { match: direct.match };

  // Nothing visible — the menu may simply be collapsed. Open it and look again before
  // walking modules. If that reveals nothing, RELOAD the home first: a toggle click can
  // leave an open drawer covering the module tabs, and a stale overlay silently breaks the
  // module walk below (observed on Accela, where the walk had just succeeded).
  if (await openCollapsedNav(page)) {
    const afterNav = await findApplicationEntry(page);
    if (afterNav) return { match: afterNav.match, viaModule: "navigation menu" };
    if (home) {
      try { await page.goto(home, { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForTimeout?.(1200); } catch { /* keep going with the page as-is */ }
    }
  }

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
  for (const label of modules) {
    try {
      await page.getByText(label, { exact: true }).first().click({ timeout: 8000 });
      await page.waitForLoadState?.("networkidle", { timeout: 12000 }).catch(() => null);
      await page.waitForTimeout?.(1200);
    } catch { continue; }
    const found = await findApplicationEntry(page);
    if (found) return { match: found.match, viaModule: label };
    // Nothing here — go back and try the next module. With no safe home to return to, stop
    // rather than wander: module tabs usually persist, but a blind retry is not worth it.
    if (!home) break;
    try { await page.goto(home, { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForTimeout?.(1000); } catch { break; }
  }
  return null;
}

/**
 * Click into the application flow. Returns where it landed. Does NOT fill or submit
 * anything — starting an application is a navigation, and the caller (learn loop / probe)
 * takes it from there.
 */
/** Whitespace-collapsed, case-insensitive form used to compare entry labels across passes. */
export function normalizeEntryLabel(label: string): string {
  return String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function enterApplicationFlow(
  page: Page,
  opts: {
    /**
     * Labels already clicked this run. A portal whose entry opens a DRAWER IN PLACE still
     * looks like a dashboard afterwards, so this pass finds the same control again and
     * clicks it — which TOGGLES the drawer shut (or resets it), throwing away the form that
     * was already open, and records the click a second time so every future replay resets
     * the drawer too. Checked BEFORE the click, not after: the previous guard ran on the
     * result and the damage was already done.
     */
    skipLabels?: Iterable<string>;
  } = {},
): Promise<{ ok: boolean; message: string; url: string; label?: string; viaModule?: string; alreadyClicked?: boolean }> {
  // DEEP by design. Accela's logged-in home offers only module tabs — the entry is one hop
  // inside Permits — so a shallow look finds nothing and the caller falls through to the LLM
  // planner, which is exactly the path that drifted into the records module on a live run.
  const deep = await findApplicationEntryDeep(page);
  if (!deep) {
    return { ok: false, message: "No 'start an application' control found on this page.", url: typeof page.url === "function" ? page.url() : "" };
  }
  // findApplicationEntryDeep leaves the page wherever the entry was found; re-resolve the
  // control there so the click targets what it actually located.
  const found = await findApplicationEntry(page);
  if (!found) {
    return { ok: false, message: `Found "${deep.match.label}" but it was gone when the click was attempted.`, url: typeof page.url === "function" ? page.url() : "", label: deep.match.label };
  }
  const before = typeof page.url === "function" ? page.url() : "";
  const skip = new Set(Array.from(opts.skipLabels ?? [], normalizeEntryLabel));
  if (skip.has(normalizeEntryLabel(found.match.label))) {
    return {
      ok: false,
      alreadyClicked: true,
      message: `Already entered the application flow via "${found.match.label}" — not clicking it again.`,
      url: before,
      label: found.match.label,
    };
  }
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
    message: `Entered the application flow via "${found.match.label}"${deep.viaModule ? ` (one hop through "${deep.viaModule}")` : ""}.`,
    url: after,
    label: found.match.label,
    viaModule: deep.viaModule,
  };
}
