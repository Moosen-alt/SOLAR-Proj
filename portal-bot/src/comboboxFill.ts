// ---------------------------------------------------------------------------
// General custom-combobox fill.
//
// Many portals (PGE PowerClerk's "Please select..." widgets, select2, chosen,
// ui-select, ExtJS comboboxes) render a dropdown as a styled <div>, NOT a native
// <select>. Playwright's selectOption() only works on real <select> elements, so
// those widgets silently stay empty — the exact failure seen on PowerClerk's
// Energy Source / Schedule / Prime Mover / inverter-model fields.
//
// This helper drives the universal open -> type -> pick interaction:
//   1. click the widget to open it,
//   2. type the value into whatever search box appears,
//   3. click the option whose text matches the value,
//   4. fall back to Enter to accept the typed value.
//
// It is only ever called AS A FALLBACK after a native selectOption() throws (or
// for an element explicitly detected as a custom combobox), so it can never
// regress a real <select>. Every step is best-effort and swallows its own errors
// so a stuck widget fails soft rather than throwing.
// ---------------------------------------------------------------------------

// Loose typing: adapters hold the Playwright Page/Locator as `any` (tsx context),
// so we accept the same here rather than importing the full types.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";

/** The last Enter this module declined to press, and why (a form whose default button files or
 *  pays). Diagnostic only; "" when none. */
export let lastComboboxEnterRefusal = "";

const SEARCH_BOX_SELECTORS = [
  'input[role="combobox"]',
  'input[type="search"]',
  ".select2-search__field",
  ".chosen-search input",
  '[role="listbox"] input',
  'input[aria-autocomplete="list"]',
].join(", ");

const OPTION_SELECTORS = [
  '[role="option"]',
  '[role="listbox"] li',
  "li.select2-results__option",
  ".chosen-results li",
  ".dropdown-item",
  ".dropdown-menu li",
  ".dropdown-menu a",
  ".ui-select-choices-row",
  ".x-combo-list-item",
  'ul[class*="menu"] li',
  'ul[class*="option"] li',
  '[class*="-option"]:not(input):not(button)',
  '[class*="option-"]:not(input):not(button)',
  // TELERIK / KENDO. Predates ARIA, renders its popup into a body-level animation
  // container, and names nothing "menu", "option" or "listbox" — so none of the rules above
  // could see it. It is the dropdown of choice across government portals: Miami's iBuild
  // stops the walk on a Telerik "Job Category" whose options live in exactly this list.
  "ul.t-list > li",
  ".t-animation-container li",
  "ul.k-list > li",
  ".k-animation-container li",
  ".k-list-item",
].join(", ");

// INSIDE A POPUP, A BARE <li> IS AN OPTION. Not page-wide — a page is full of list items —
// but optionScope can resolve to the LIST ITSELF (Telerik's ul.t-list is both the popup
// container and the list), and then every "ul… > li" rule above matches nothing. Miami's
// Job Category was read correctly, offered to the planner correctly, answered correctly
// with "STAND-ALONE" — and the click found no rows to click.
const SCOPED_OPTION_SELECTORS = `${OPTION_SELECTORS}, li, [role="option"]`;

/** Option rows within a scope: wider when that scope is a popup, unchanged page-wide. */
function optionRowsIn(scope: any, page: any): any {
  return scope.locator(scope === page ? OPTION_SELECTORS : SCOPED_OPTION_SELECTORS);
}

// Popup containers a custom combobox renders its options into. Many widgets portal
// the popup to <body>, so a strictly loc-rooted lookup misses — instead prefer the
// most recently opened VISIBLE listbox/menu container and fall back to page-global.
const POPUP_SELECTOR_LIST = [
  '[role="listbox"]',
  ".select2-results",
  ".chosen-results",
  ".dropdown-menu",
  ".x-combo-list",
  'ul[class*="menu"]',
  'ul[class*="option"]',
  ".t-animation-container",
  ".k-animation-container",
  "ul.t-list",
  "ul.k-list",
];
const POPUP_SELECTORS = POPUP_SELECTOR_LIST.join(", ");
// The same list, restricted to popups that were NOT on screen before we opened this widget.
const FRESH_POPUP_SELECTORS = POPUP_SELECTOR_LIST.map((sel) => `${sel}:not([data-al-prepopup])`).join(", ");

// A POPUP THAT WAS ALREADY ON SCREEN IS NOT THE ONE WE JUST OPENED.
//
// "The last visible popup" is a heuristic, and on Miami it reads the SITE NAVIGATION: its
// top menu is <ul id="Menu" class="t-widget t-reset t-header t-menu">, which matches
// ul[class*="menu"] above, is permanently visible, and answers "what does this dropdown
// offer?" with "Start Application, Building Permit Application, Contractor…". Two of three
// dropdowns read on Miami's Contact Information page came back with the nav menu — and a
// FILL scoped that way clicks a nav item and navigates out of a half-filled form.
//
// Callers that know the moment they opened a widget stamp what was already there first;
// after that, only an UNSTAMPED popup can be the one that just appeared. Unstamped pages
// behave exactly as before, so every existing path is unaffected.
export async function markExistingPopups(page: any): Promise<void> {
  await page.evaluate((sel: string) => {
    document.querySelectorAll("[data-al-prepopup]").forEach((n) => n.removeAttribute("data-al-prepopup"));
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      if (r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none") {
        el.setAttribute("data-al-prepopup", "1");
      }
    }
  }, POPUP_SELECTORS).catch(() => null);
}

/** Is a popup open that was NOT on screen when markExistingPopups last ran? The plain
 *  "any popup visible" question cannot answer "did the widget close", because a permanently
 *  visible site menu matches the popup list: the reader's own close-check read Miami's nav
 *  as a still-open dropdown and clicked the widget back open. */
async function freshPopupVisible(page: any): Promise<boolean> {
  return (await page.locator(FRESH_POPUP_SELECTORS).locator("visible=true").count().catch(() => 0)) > 0;
}

export async function clearPopupMarks(page: any): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("[data-al-prepopup]").forEach((n) => n.removeAttribute("data-al-prepopup"));
  }).catch(() => null);
}

// Scope for option/search-box lookups: the popup that appeared since markExistingPopups ran
// when there is one, else the last visible popup container, else the page. Best-effort.
async function optionScope(page: any): Promise<any> {
  try {
    const fresh = page.locator(FRESH_POPUP_SELECTORS).locator("visible=true");
    const fn = await fresh.count().catch(() => 0);
    if (fn > 0) return fresh.nth(fn - 1);
    // NOTHING APPEARED, AND THE CALLER KNOWS WHEN IT ASKED. The old fallback — "the last
    // visible popup" — then returns whatever else is on screen, which on Miami is the site
    // navigation: a widget that opened nothing was reported as offering "Start Application,
    // Manage Application, Contractor". When a caller has stamped what was already there,
    // "no fresh popup" is a complete answer and the fallback must not run. Callers that
    // never stamp keep the old behaviour exactly.
    if ((await page.locator("[data-al-prepopup]").count().catch(() => 0)) > 0) return page;
    const popups = page.locator(POPUP_SELECTORS).locator("visible=true");
    const n = await popups.count().catch(() => 0);
    if (n > 0) return popups.nth(n - 1);
  } catch { /* fall through to page-global */ }
  return page;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Collapse whitespace + lowercase so "SEG  Solar" and "seg solar" compare equal.
function norm(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Poll until at least one option row is rendered (async option lists load AFTER the
// search keystrokes settle — a fixed sleep races them, leaving count()===0 so the
// matcher falls through and either picks nothing or, worse, a stale row). Returns when
// options appear or the budget elapses; never throws.
async function waitForOptions(page: any, budgetMs = 2500, ownScope?: any): Promise<void> {
  const step = 100;
  for (let waited = 0; waited < budgetMs; waited += step) {
    const scope = ownScope ?? await optionScope(page);
    // Count only VISIBLE option rows. A closed combobox leaves its <li role="option">s in
    // the DOM (hidden), and while a dependent/cascading list is still loading its own popup
    // is empty (0-height) so optionScope falls back to page-global — a plain count() then
    // sees the PRIOR combobox's stale hidden rows and returns early, so the cascade's real
    // (visible) options are never waited for and never picked (mirrors bestOptionMatch,
    // which already skips invisible rows).
    const rows = optionRowsIn(scope, page);
    const total = Math.min(await rows.count().catch(() => 0), 12);
    let anyVisible = false;
    for (let i = 0; i < total; i++) {
      if (await rows.nth(i).isVisible().catch(() => false)) { anyVisible = true; break; }
    }
    if (anyVisible) return;
    await page.waitForTimeout?.(step).catch(() => {});
  }
}

// Click a located option, scrolling it into view first (virtualized/long lists render
// the row off-screen so a blind click misses). Returns true if the click went through.
async function clickOption(loc: any): Promise<boolean> {
  try {
    await loc.scrollIntoViewIfNeeded?.({ timeout: 1000 }).catch(() => {});
    await loc.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// From the live option rows pick the BEST text match for `value`, preferring an exact
// (normalized) hit over a substring hit so "430" never selects "4300" and "SEG Solar"
// never selects "SEG Solar Industrial". Returns the matching locator or null.
async function bestOptionMatch(page: any, value: string, ownScope?: any): Promise<any | null> {
  const want = norm(value);
  if (!want) return null;
  // DIGIT-SIGNATURE fallback: certified equipment lists respell model names with minor
  // letter variance (live PGE: plan-set "ZXM7-UHLD108-440/N" vs certified
  // "ZXM7-UHLDD108-440/N" — one extra D defeats plain contains). The digit groups
  // (7, 108, 440) plus the leading alpha token are series-defining: require ALL digit
  // groups AND the alpha prefix, which uniquely separates UHLDD108-440 from the six
  // other 440W options. Only meaningful when the value carries ≥2 digit groups (never
  // fires for "Schedule 7"-style values).
  const wantDigits = Array.from(new Set(want.match(/\d+/g) ?? []));
  const wantAlpha = (want.match(/[a-z]{2,}/i)?.[0] ?? "").toLowerCase();
  const digitSigApplies = wantDigits.length >= 2 && wantAlpha.length >= 2;
  const scope = ownScope ?? await optionScope(page);
  const rows = optionRowsIn(scope, page);
  // ONE in-page pass over ALL rows. The old per-row isVisible()/textContent() loop was
  // capped at 40 rows for latency — but certified equipment lists run to hundreds
  // (live PGE: 225 Znshine models sorted by wattage), so the right option sat far past
  // the cap and could never match. evaluateAll reads every row in a single round-trip.
  const texts: Array<string | null> = await rows.evaluateAll((els: Element[]) =>
    els.slice(0, 2000).map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      const vis = r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      return vis ? ((el.textContent || "").replace(/\s+/g, " ").trim()) : null;
    })).catch(() => []);
  let containsIdx = -1;
  let digitSigIdx = -1;
  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i];
    if (raw == null) continue;
    const text = norm(raw);
    if (!text || /^(please\s+)?select\.{0,3}$/.test(text)) continue;
    if (text === want) return rows.nth(i); // exact wins immediately
    if (containsIdx < 0 && (text.includes(want) || want.includes(text))) containsIdx = i;
    if (digitSigIdx < 0 && digitSigApplies && text.includes(wantAlpha)
        && wantDigits.every((d) => new RegExp(`(^|\\D)${d}(\\D|$)`).test(text))) {
      digitSigIdx = i;
    }
  }
  if (containsIdx >= 0) return rows.nth(containsIdx);
  if (digitSigIdx >= 0) return rows.nth(digitSigIdx);
  return null;
}

/**
 * WHAT DOES THIS DROPDOWN OFFER? Opens a closed custom dropdown, reads its options, and
 * closes it again.
 *
 * A widget that renders its list only on click gives the planner NOTHING to choose from:
 * Miami's Job Category is a Telerik dropdown whose options do not exist in the DOM until it
 * is opened, so the planner proposed a value out of thin air, nothing matched, the fill was
 * silently dropped and the portal said "Please select mandatory Job Category" three visits
 * running. The definitions printed beside it on that page are prose, not the option list.
 *
 * Deliberately a SEPARATE, smaller open than fillCustomCombobox's. That path is tuned
 * against several live portals and carries an already-open toggle check, a search box, and a
 * match cascade; duplicating twenty lines of opener here is cheaper than the risk of
 * refactoring it, and this one has a different contract — it must always leave the widget
 * CLOSED and change nothing.
 */
export async function readClosedComboboxOptions(page: any, loc: any): Promise<string[]> {
  if (!loc) return [];
  try {
    // Whatever is on screen now is not the popup we are about to open.
    await markExistingPopups(page);
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 4000 }).catch(() => null);
    } else {
      // The real clickable is the widget's visible face; the input behind it has no box.
      await loc.evaluate((el: Element) => {
        const isVis = (n: Element) => {
          const r = n.getBoundingClientRect();
          const st = getComputedStyle(n as HTMLElement);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        };
        let root: Element = el;
        for (let k = 0; k < 5 && root.parentElement; k++) {
          root = root.parentElement;
          const cands = Array.from(root.querySelectorAll<HTMLElement>("*"))
            .filter((n) => n !== el && n.getAttribute("role") !== "listbox" && n.getAttribute("role") !== "option" && isVis(n));
          if (!cands.length) continue;
          const preferred = cands.find((n) => /form-select|\bselect\b|display|toggle|control|dropdown|-wrap/i.test(n.className || "") || n.getAttribute("role") === "button");
          (preferred || cands[0]).click();
          return;
        }
        (el as HTMLElement).click();
      }).catch(() => null);
    }
    // CASCADES POPULATE AFTER THE CLICK, AND NOT ON A SCHEDULE. A flat 700ms wait read
    // Miami's Job Sub-Category as exactly one option ("BUILDING ROOFING") when the city's
    // own instructions say the list carries an ELECTRICAL path — the read raced the cascade,
    // and a partial list is worse than none because it tells the planner the right answer is
    // not on the menu. Poll until two consecutive reads agree; a static list exits on its
    // second read, a cascade gets up to ~4s to finish arriving.
    //
    // Scoped to the popup, a bare <li> IS an option — and it has to be allowed, because
    // optionScope can resolve to the LIST ITSELF (Telerik's ul.t-list is both a popup
    // container and the list), where "ul.t-list > li" then matches nothing at all.
    let texts: string[] = [];
    let prevCount = -1;
    for (let waited = 0; waited <= 4000; waited += 500) {
      await page.waitForTimeout?.(waited === 0 ? 700 : 500).catch(() => null);
      const scope = await optionScope(page);
      if (scope === page) { texts = []; break; }
      texts = await optionRowsIn(scope, page).allInnerTexts().catch(() => [] as string[]);
      if (texts.length > 0 && texts.length === prevCount) break;
      prevCount = texts.length;
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of texts) {
      const t = (raw || "").replace(/\s+/g, " ").trim();
      // Placeholders are not choices, and a paragraph is not an option.
      if (!t || t.length > 90 || /^(please\s+)?select\b|^choose\b|^--/i.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 40) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    // ALWAYS LEAVE IT SHUT. An open popup covers the controls the walk clicks next, and this
    // pass exists to inform the planner, not to change the page. Escape first; a widget that
    // ignores it closes on a second click of its own face, which is what a person does.
    await page.keyboard?.press("Escape").catch(() => null);
    await page.waitForTimeout?.(150).catch(() => null);
    if (await freshPopupVisible(page)) {
      await loc.evaluate((el: Element) => {
        const isVis = (n: Element) => {
          const r = n.getBoundingClientRect();
          const st = getComputedStyle(n as HTMLElement);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        };
        let root: Element = el;
        for (let k = 0; k < 5 && root.parentElement; k++) {
          root = root.parentElement;
          const face = Array.from(root.querySelectorAll<HTMLElement>("*"))
            .filter((n) => n !== el && isVis(n))
            .find((n) => /-wrap|display|toggle|dropdown/i.test(n.className || ""));
          if (face) { face.click(); return; }
        }
      }).catch(() => null);
      await page.waitForTimeout?.(150).catch(() => null);
    }
    await clearPopupMarks(page);
  }
}

/**
 * Fill a custom (non-native-<select>) combobox. Returns true if an option was
 * clicked, false if it fell through to Enter / could not resolve.
 */
export async function fillCustomCombobox(page: any, loc: any, value: string): Promise<boolean> {
  const v = (value ?? "").trim();
  if (!v) return false;

  // OWN-POPUP SCOPE: an ARIA combobox names its listbox via aria-controls/aria-owns.
  // Prefer THAT container for the search box, option wait, and option matching — the
  // "last visible popup" heuristic reads a sibling widget's lingering popper when several
  // comboboxes coexist (live PGE: the array-model matcher scanned the inverter-model list).
  let ownPopup: any = null;
  try {
    const controlsId = (await loc.getAttribute("aria-controls").catch(() => null))
      || (await loc.getAttribute("aria-owns").catch(() => null));
    if (controlsId && /^[A-Za-z][\w-]*$/.test(controlsId)) {
      const cand = page.locator(`#${controlsId}`);
      if (await cand.count().catch(() => 0)) ownPopup = cand;
    }
  } catch { /* fall back to the heuristic scope */ }
  const scopeOf = async () => (ownPopup && await ownPopup.isVisible().catch(() => false)) ? ownPopup : await optionScope(page);

  // 1. Open the widget. The trigger may be a visually-hidden input[role="combobox"]
  //    (PowerClerk's Vue filtered-select) whose real clickable is a visible sibling display —
  //    Playwright can't click a hidden element, so when loc isn't visible, fall back to an
  //    in-page click on the nearest visible opener within the widget, plus a focus (some
  //    widgets open on focus for keyboard a11y).
  //    ALREADY-OPEN CHECK FIRST: the open click is a TOGGLE on these widgets (and Escape
  //    does not close the popper), so clicking an already-expanded combobox closes it and
  //    every matcher below then runs against nothing (verified live on PGE PowerClerk).
  // Trust aria-expanded only when a popup is actually on screen — the attribute can be
  // STALE (left "true" after an interrupted interaction), and skipping the open-click on
  // a stale flag leaves every matcher staring at a closed widget.
  // The filter box this widget owns, if it has one — the only box Enter may ever commit.
  let widgetSearch: any = null;
  const ariaOpen = (await loc.getAttribute("aria-expanded").catch(() => null)) === "true";
  const popupVisible = async () => {
    if (ownPopup && await ownPopup.isVisible().catch(() => false)) return true;
    return (await optionScope(page)) !== page;
  };
  const alreadyOpen = ariaOpen && await popupVisible();
  // Same rule as the reader: a popup already on screen is not this widget's. Skipped when
  // the widget is ALREADY open, since its own popup would then be stamped as pre-existing.
  if (!alreadyOpen) await markExistingPopups(page);
  // ALREADY OPEN MEANS WE CANNOT STAMP — this widget's popup is on screen and would be
  // marked as pre-existing. Clear whatever a previous fill left instead, so optionScope is
  // not left in the "a caller stamped, so refuse the fallback" mode on a page nobody stamped.
  else await clearPopupMarks(page);
  let openedWidget = alreadyOpen;
  if (!openedWidget && await loc.isVisible().catch(() => false)) {
    try { await loc.click({ timeout: 5000 }); openedWidget = true; } catch { /* fall through */ }
  }
  if (!openedWidget) {
    await loc.evaluate((el: Element) => {
      const isVis = (n: Element) => {
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n as HTMLElement);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      // Walk up a few levels and click the widget's visible opener — prefer a select-like
      // display/toggle over any visible node, so the popup's own options aren't clicked.
      let root: Element = el;
      for (let k = 0; k < 5 && root.parentElement; k++) {
        root = root.parentElement;
        const cands = Array.from(root.querySelectorAll<HTMLElement>("*")).filter((n) => n !== el && n.getAttribute("role") !== "listbox" && n.getAttribute("role") !== "option" && isVis(n));
        if (!cands.length) continue;
        const preferred = cands.find((n) => /form-select|\bselect\b|display|toggle|control|dropdown/i.test(n.className || "") || n.getAttribute("role") === "button");
        (preferred || cands[0]).click();
        return;
      }
      (el as HTMLElement).click();
    }).catch(() => {});
    await loc.focus().catch(() => {});
  }
  await page.waitForTimeout?.(300).catch(() => {});

  // 2. Type into the search box if one appeared, then WAIT for the (async) option list to
  //    actually render before matching — a fixed sleep raced the XHR that populates it.
  try {
    // Prefer a search box inside the opened popup; fall back to page-global for
    // widgets that render the search input outside the listbox container.
    const scope = await optionScope(page);
    let search = scope === page ? null : scope.locator(SEARCH_BOX_SELECTORS).first();
    if (!search || !(await search.count().catch(() => 0))) {
      // The popup's filter box may carry none of the known attributes (PGE PowerClerk's
      // popper renders a bare <input> with a magnifier icon) — any visible input inside
      // the POPUP is the search box. The widget's own container is the last resort — never
      // the page; see below.
      search = scope === page ? null : scope.locator("input:visible").first();
    }
    if (!search || !(await search.count().catch(() => 0))) {
      // A FILTER BOX THAT BELONGS TO THIS WIDGET IS INSIDE THIS WIDGET.
      //
      // This used to fall back to the whole page. Miami's iBuild carries a global site
      // search on every page — <input id="acGlobalSearch" role="combobox"
      // aria-autocomplete="list"> — which matches SEARCH_BOX_SELECTORS exactly, so the
      // answer to "Job Category" was typed into the site search instead. Typing into a
      // control outside the widget is never right; not typing at all is, because these
      // widgets render their full list on open and the matcher resolves without a filter.
      const widgetRoot = loc.locator(
        "xpath=ancestor-or-self::*[contains(@class,'dropdown') or contains(@class,'combobox')"
        + " or contains(@class,'t-widget') or contains(@class,'k-widget') or contains(@class,'select2')"
        + " or contains(@class,'chosen')][1]",
      );
      const inWidget = (await widgetRoot.count().catch(() => 0))
        ? widgetRoot.locator(SEARCH_BOX_SELECTORS).first()
        : null;
      search = inWidget && (await inWidget.count().catch(() => 0)) ? inWidget : null;
    }
    // Whatever we settled on, it is now scoped to the popup or the widget — never the page.
    // Enter may only ever commit a box this widget owns.
    widgetSearch = search && (await search.count().catch(() => 0)) ? search : null;
    if (await search.count().catch(() => 0)) {
      // Only type into an EDITABLE search box, with a SHORT timeout. PowerClerk's Vue
      // filtered-select exposes a READONLY input[role="combobox"] as its only combobox
      // input — fill() on it retries against the DEFAULT 30s timeout before throwing, so a
      // page of these stalls for minutes. isEditable() is false for readonly/disabled, and
      // the 2s cap keeps a genuinely-editable-but-slow box from hanging; the widget already
      // renders its full option list on open, so bestOptionMatch resolves without the typed
      // filter when it's skipped.
      if (await search.isEditable().catch(() => false)) {
        await search.fill(v, { timeout: 2000 }).catch(() => {});
        // FILTER-EMPTIED-THE-LIST RECOVERY: when the value's spelling differs slightly
        // from the certified option text (live PGE: plan-set "UHLD108" vs certified
        // "UHLDD108"), the typed filter matches NOTHING and every matcher below stares
        // at an empty list. Clear the search so the FULL list renders again — the
        // digit-signature pass in bestOptionMatch can discriminate from the full list.
        await page.waitForTimeout?.(700).catch(() => {});
        const filteredScope = (ownPopup && await ownPopup.isVisible().catch(() => false)) ? ownPopup : await optionScope(page);
        const filteredRows = optionRowsIn(filteredScope, page);
        let anyLeft = false;
        const nRows = Math.min(await filteredRows.count().catch(() => 0), 8);
        for (let i = 0; i < nRows; i++) {
          if (await filteredRows.nth(i).isVisible().catch(() => false)) { anyLeft = true; break; }
        }
        if (!anyLeft) {
          await search.fill("", { timeout: 2000 }).catch(() => {});
        }
      }
    }
  } catch { /* no search box — some widgets filter inline */ }
  await waitForOptions(page, 2500, (ownPopup && await ownPopup.isVisible().catch(() => false)) ? ownPopup : undefined);

  // 3a. BEST normalized match across the live option rows — exact (whitespace/case-
  //     insensitive) preferred over substring so we never pick a near-neighbour like
  //     "4300" for "430" or a longer model that merely contains the typed token.
  try {
    const best = await bestOptionMatch(page, v, (ownPopup && await ownPopup.isVisible().catch(() => false)) ? ownPopup : undefined);
    if (best && (await best.count().catch(() => 0)) && (await clickOption(best))) {
      return true;
    }
  } catch { /* fall through */ }

  // 3a'. FILTERED-LIST MISS RECOVERY: when the typed filter matched nothing usable (the
  //      popper may render only a "no results" placeholder row — which defeats a naive
  //      row-count check), CLEAR the search so the full list renders, and run the best
  //      match once more — the digit-signature pass discriminates from the full list
  //      (live PGE: plan-set "UHLD108" vs certified "UHLDD108" filters to zero hits).
  try {
    const sScope = await scopeOf();
    const searchBox = sScope === page ? page.locator(SEARCH_BOX_SELECTORS).first() : sScope.locator("input:visible").first();
    const typedNow = String(await searchBox.inputValue().catch(() => "")).trim();
    if (typedNow && await searchBox.isEditable().catch(() => false)) {
      await searchBox.fill("", { timeout: 2000 }).catch(() => {});
      await waitForOptions(page, 2500, (ownPopup && await ownPopup.isVisible().catch(() => false)) ? ownPopup : undefined);
      const best2 = await bestOptionMatch(page, v, (ownPopup && await ownPopup.isVisible().catch(() => false)) ? ownPopup : undefined);
      if (best2 && (await best2.count().catch(() => 0)) && (await clickOption(best2))) {
        return true;
      }
    }
  } catch { /* fall through */ }

  // 3b. ARIA option matching the value (substring, case-insensitive).
  try {
    const opt = page.getByRole("option", { name: new RegExp(escapeRegExp(v), "i") }).first();
    if (await opt.count().catch(() => 0) && (await clickOption(opt))) {
      return true;
    }
  } catch { /* fall through */ }

  // 3c. Otherwise click the first visible list row containing the value text.
  try {
    const row = optionRowsIn(await scopeOf(), page).filter({ hasText: new RegExp(escapeRegExp(v), "i") }).first();
    if (await row.count().catch(() => 0) && (await clickOption(row))) {
      return true;
    }
  } catch { /* fall through */ }

  // 3d. Trailing-token looser match: "Schedule 7" → look for an option containing just "7"
  //     as a word boundary (catches "7 - Residential Net Metering" style labels).
  //     DIGIT-BEARING TOKENS ONLY: a word token like "PV-Tech" (from "Znshine PV-Tech")
  //     matches unrelated options ("Solar Long PV-Tech (Cambodia)" — seen live on PGE) and
  //     silently selects the WRONG manufacturer. Schedule/size tokens carry digits; brand
  //     words don't.
  try {
    const lastToken = v.split(/\s+/).pop() ?? v;
    if (lastToken !== v && lastToken.length >= 1 && /\d/.test(lastToken)) {
      const row = optionRowsIn(await optionScope(page), page).filter({ hasText: new RegExp(`\\b${escapeRegExp(lastToken)}\\b`, "i") }).first();
      if (await row.count().catch(() => 0) && (await clickOption(row))) {
        return true;
      }
    }
  } catch { /* fall through */ }

  // 3e. Visible-text fallback: scan all visible elements for one whose trimmed text matches.
  try {
    const allVisible = page.locator("li, [role='option'], .dropdown-item, [class*='-option']").filter({ hasText: new RegExp(escapeRegExp(v), "i") });
    const cnt = await allVisible.count().catch(() => 0);
    for (let i = 0; i < Math.min(cnt, 8); i++) {
      const el = allVisible.nth(i);
      if (await el.isVisible().catch(() => false) && (await clickOption(el))) {
        return true;
      }
    }
  } catch { /* fall through */ }

  // 4. Last resort: accept the typed value with Enter (covers free-text comboboxes).
  // Only press Enter when we actually typed something — otherwise we'd accept whatever
  // the widget already had selected. NEVER press Enter while visible option rows exist:
  // on a list-only combobox Enter commits the HIGHLIGHTED row (typically the first),
  // silently selecting an arbitrary wrong option (live PGE: "AblyTek" instead of
  // "Znshine PV-Tech"). Options rendered + none matched = fail soft, don't guess.
  try {
    const rows = optionRowsIn(await scopeOf(), page);
    const total = Math.min(await rows.count().catch(() => 0), 8);
    for (let i = 0; i < total; i++) {
      if (await rows.nth(i).isVisible().catch(() => false)) return false; // options exist — no blind Enter
    }
  } catch { /* fall through to the free-text path */ }
  // THE SAME INVARIANT, ONE BRANCH LATER. This read was page-global too, and a page-global
  // read is how a failed fill ends by firing the PORTAL'S OWN SITE SEARCH: find text in
  // #acGlobalSearch — which the portal may pre-fill, and which nothing here should be
  // touching — and press Enter, navigating the walk out of a half-filled form. Enter is only
  // ever for a box this widget owns.
  const typed = widgetSearch ? await widgetSearch.inputValue().catch(() => "") : "";
  // ENTER IN A BOX INSIDE A FORM IS THAT FORM'S DEFAULT BUTTON (hard rule 1). A widget whose
  // search box sits in a form whose default button files or pays must not press Enter in it —
  // the same shared in-page question replay's gate asks. Unreadable -> no Enter.
  if (typed) {
    if (typeof page.evaluate === "function") await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const refusal: string = typeof widgetSearch?.evaluate === "function"
      ? String(await widgetSearch.evaluate((el: Element, g: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ps = (globalThis as any)[g];
        return ps && typeof ps.enterRefusalInPage === "function" ? ps.enterRefusalInPage(el) : "the page's safety predicates are not installed";
      }, PORTAL_SAFETY_GLOBAL).catch(() => "the box could not be read") ?? "")
      : "the box could not be read";
    if (refusal) { lastComboboxEnterRefusal = refusal; return false; }
    await page.keyboard?.press("Enter").catch(() => {});
  }
  return false;
}

/**
 * Select a value on a dropdown that may be a native <select> OR a custom div widget.
 * Three-step cascade: native selectOption(value) → selectOption({ label }) → the
 * custom-combobox open/type/pick fallback. Shared by every adapter's select path.
 * Returns true when a native selectOption succeeded, the partial-match scan selected
 * something, or fillCustomCombobox reported a click — false when NOTHING was selected,
 * so callers can surface the miss instead of silently continuing.
 */
export async function selectWithFallback(page: any, loc: any, value: string): Promise<boolean> {
  // Only a real <select> can take selectOption. Running it on a styled-div widget or a
  // (readonly, visually-hidden) input[role="combobox"] — PowerClerk's Vue filtered-select —
  // stalls the full actionability timeout TWICE before the combobox path even runs (the
  // element can never become an actionable <select>). Detect the tag and, for a NON-select,
  // skip straight to the combobox path. When the locator can't be evaluated (a fake/test
  // locator with no .evaluate), tag is unknown — attempt the native path anyway, preserving
  // the historical try-selectOption-then-combobox behavior so a real <select> isn't skipped.
  const tag: string | null = typeof loc.evaluate === "function"
    ? await loc.evaluate((el: Element) => (el.tagName || "").toLowerCase()).catch(() => null)
    : null;
  if (tag !== null && tag !== "select") return fillCustomCombobox(page, loc, value);
  // Short timeouts on the native attempts: a HIDDEN native <select> behind a styled
  // widget can never pass actionability, so the default timeout would stall twice
  // before the combobox path even runs.
  try { await loc.selectOption(value, { timeout: 5000 }); return true; } catch { /* try label */ }
  try { await loc.selectOption({ label: value }, { timeout: 5000 }); return true; } catch { /* try partial */ }
  // NATIVE PARTIAL MATCH: selectOption(value)/{label} require an EXACT option text/value.
  // Portals routinely list "Schedule 7 - Residential Net Metering" while the bound value is
  // just "Schedule 7", so both exact attempts miss and the value is silently dropped. Before
  // falling to the combobox path, scan the real <select> options in TWO passes — exact
  // normalized match first, then case-insensitive contains (either direction) — so "430"
  // never picks a first-in-DOM "4300" when an exact "430" option exists (mirrors
  // bestOptionMatch). No-op ("") for non-<select> custom widgets so the combobox fallback
  // still runs. Shared by learn + replay.
  const matchedValue = await loc.evaluate((el: Element, want: string) => {
    if ((el.tagName || "").toLowerCase() !== "select") return "";
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const w = norm(want);
    if (!w) return "";
    const options = Array.from((el as HTMLSelectElement).options).filter((o) => {
      const t = norm(o.textContent || "");
      return t && !/^(please\s+)?select\.{0,3}$/i.test(t);
    });
    for (const o of options) {
      if (norm(o.textContent || "") === w) return o.value; // exact wins
    }
    for (const o of options) {
      const t = norm(o.textContent || "");
      if (t.includes(w) || w.includes(t)) return o.value;
    }
    return "";
  }, value).catch(() => "");
  if (matchedValue) {
    try { await loc.selectOption(matchedValue, { timeout: 5000 }); return true; } catch { /* combobox */ }
  }
  return fillCustomCombobox(page, loc, value);
}
