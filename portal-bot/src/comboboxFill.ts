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
].join(", ");

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
async function waitForOptions(page: any, budgetMs = 2500): Promise<void> {
  const step = 100;
  for (let waited = 0; waited < budgetMs; waited += step) {
    const n = await page.locator(OPTION_SELECTORS).count().catch(() => 0);
    if (n > 0) return;
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
async function bestOptionMatch(page: any, value: string): Promise<any | null> {
  const want = norm(value);
  if (!want) return null;
  const rows = page.locator(OPTION_SELECTORS);
  const count = Math.min(await rows.count().catch(() => 0), 40);
  let exact: any = null;
  let contains: any = null;
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = norm(String((await row.textContent().catch(() => "")) ?? ""));
    if (!text || /^(please\s+)?select\.{0,3}$/.test(text)) continue;
    if (text === want) return row; // exact wins immediately
    if (!exact && (text.includes(want) || want.includes(text))) contains = contains ?? row;
  }
  return exact ?? contains;
}

/**
 * Fill a custom (non-native-<select>) combobox. Returns true if an option was
 * clicked, false if it fell through to Enter / could not resolve.
 */
export async function fillCustomCombobox(page: any, loc: any, value: string): Promise<boolean> {
  const v = (value ?? "").trim();
  if (!v) return false;

  // 1. Open the widget.
  await loc.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout?.(300).catch(() => {});

  // 2. Type into the search box if one appeared, then WAIT for the (async) option list to
  //    actually render before matching — a fixed sleep raced the XHR that populates it.
  try {
    const search = page.locator(SEARCH_BOX_SELECTORS).first();
    if (await search.count().catch(() => 0)) {
      await search.fill(v).catch(() => {});
    }
  } catch { /* no search box — some widgets filter inline */ }
  await waitForOptions(page);

  // 3a. BEST normalized match across the live option rows — exact (whitespace/case-
  //     insensitive) preferred over substring so we never pick a near-neighbour like
  //     "4300" for "430" or a longer model that merely contains the typed token.
  try {
    const best = await bestOptionMatch(page, v);
    if (best && (await best.count().catch(() => 0)) && (await clickOption(best))) {
      return true;
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
    const row = page.locator(OPTION_SELECTORS).filter({ hasText: new RegExp(escapeRegExp(v), "i") }).first();
    if (await row.count().catch(() => 0) && (await clickOption(row))) {
      return true;
    }
  } catch { /* fall through */ }

  // 3d. Trailing-token looser match: "Schedule 7" → look for an option containing just "7"
  //     as a word boundary (catches "7 - Residential Net Metering" style labels).
  try {
    const lastToken = v.split(/\s+/).pop() ?? v;
    if (lastToken !== v && lastToken.length >= 1) {
      const row = page.locator(OPTION_SELECTORS).filter({ hasText: new RegExp(`\\b${escapeRegExp(lastToken)}\\b`, "i") }).first();
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
  // the widget already had selected.
  const typed = await page.locator(SEARCH_BOX_SELECTORS).first().inputValue().catch(() => "");
  if (typed) await page.keyboard?.press("Enter").catch(() => {});
  return false;
}

/**
 * Select a value on a dropdown that may be a native <select> OR a custom div widget.
 * Three-step cascade: native selectOption(value) → selectOption({ label }) → the
 * custom-combobox open/type/pick fallback. Shared by every adapter's select path.
 */
export async function selectWithFallback(page: any, loc: any, value: string): Promise<void> {
  await loc.selectOption(value)
    .catch(async () => loc.selectOption({ label: value }))
    // NATIVE PARTIAL MATCH: selectOption(value)/{label} require an EXACT option text/value.
    // Portals routinely list "Schedule 7 - Residential Net Metering" while the bound value is
    // just "Schedule 7", so both exact attempts miss and the value is silently dropped. Before
    // falling to the combobox path, scan the real <select> options for a case-insensitive
    // contains-match (either direction) and select by that option's value. No-op (throws) for
    // non-<select> custom widgets so the combobox fallback still runs. Shared by learn + replay.
    .catch(async () => {
      const matchedValue = await loc.evaluate((el: Element, want: string) => {
        if ((el.tagName || "").toLowerCase() !== "select") return "";
        const norm = (s: string) => (s || "").trim().toLowerCase();
        const w = norm(want);
        if (!w) return "";
        for (const o of Array.from((el as HTMLSelectElement).options)) {
          const t = norm(o.textContent || "");
          if (!t || /^(please\s+)?select\.{0,3}$/i.test(t)) continue;
          if (t === w || t.includes(w) || w.includes(t)) return o.value;
        }
        return "";
      }, value).catch(() => "");
      if (matchedValue) return loc.selectOption(matchedValue);
      throw new Error("no native option match");
    })
    .catch(async () => { await fillCustomCombobox(page, loc, value); });
}
