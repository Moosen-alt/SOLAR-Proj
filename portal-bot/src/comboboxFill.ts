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
  "li.select2-results__option",
  ".chosen-results li",
  ".dropdown-item",
  ".ui-select-choices-row",
  ".x-combo-list-item",
  // Broader generic patterns so an UNKNOWN portal's styled-div dropdown still resolves:
  // any open listbox/menu list item, or an element whose class names it an option/item.
  '[role="listbox"] li',
  ".dropdown-menu li",
  ".dropdown-menu a",
  'ul[class*="menu"] li',
  'ul[class*="option"] li',
  '[class*="-option"]',
  '[class*="option-"]',
  '[class*="-item"]:not(li):not(button)',
].join(", ");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fill a custom (non-native-<select>) combobox. Returns true if an option was
 * clicked, false if it fell through to Enter / could not resolve.
 */
export async function fillCustomCombobox(page: any, loc: any, value: string): Promise<boolean> {
  const v = (value ?? "").trim();
  if (!v) return false;

  // 1. Open the widget. Give the dropdown a beat longer to render its list — PowerClerk's
  //    Vue dropdowns and ExtJS combos populate options asynchronously after the click.
  await loc.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout?.(300).catch(() => {});

  // 2. Type into the search box if one appeared.
  let typed = false;
  try {
    const search = page.locator(SEARCH_BOX_SELECTORS).first();
    if (await search.count().catch(() => 0)) {
      await search.fill(v).catch(() => {});
      typed = true;
      await page.waitForTimeout?.(350).catch(() => {});
    }
  } catch { /* no search box — some widgets filter inline */ }

  // Build candidate match patterns, most-specific first: the exact value, then a looser
  // match on a trailing identifier (e.g. value "Schedule 7" also matches an option rendered
  // as "7 - Residential Net Metering"). This makes label/option-text mismatches resolve.
  const patterns: RegExp[] = [new RegExp(escapeRegExp(v), "i")];
  const trailingToken = v.match(/(\d+[A-Za-z]?)\s*$/)?.[1];
  if (trailingToken) patterns.push(new RegExp(`\\b${escapeRegExp(trailingToken)}\\b`, "i"));

  for (const pat of patterns) {
    // 3a. Prefer an ARIA option matching the pattern.
    try {
      const opt = page.getByRole("option", { name: pat }).first();
      if (await opt.count().catch(() => 0)) {
        await opt.click({ timeout: 5000 });
        return true;
      }
    } catch { /* fall through */ }

    // 3b. Otherwise click the first visible list row (known + generic selectors) matching it.
    try {
      const row = page.locator(OPTION_SELECTORS).filter({ hasText: pat }).first();
      if (await row.count().catch(() => 0) && await row.isVisible().catch(() => false)) {
        await row.click({ timeout: 5000 });
        return true;
      }
    } catch { /* fall through */ }
  }

  // 3c. Generic visible-text fallback for unknown widgets that use none of the known classes:
  //     click the smallest visible clickable element whose text contains the value, scoped to
  //     an open popup/menu container so we never click body copy that merely repeats the text.
  try {
    const menuScope = page.locator('[role="listbox"], [class*="menu"]:visible, [class*="dropdown"]:visible, [class*="open"]').first();
    const scope = (await menuScope.count().catch(() => 0)) ? menuScope : page;
    const hit = scope.locator(`:is(li, a, div, span)`).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(v)}\\s*$`, "i") }).first();
    if (await hit.count().catch(() => 0) && await hit.isVisible().catch(() => false)) {
      await hit.click({ timeout: 5000 });
      return true;
    }
  } catch { /* fall through */ }

  // 4. Last resort: accept the typed value with Enter (covers free-text comboboxes).
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
    .catch(async () => { await fillCustomCombobox(page, loc, value); });
}
