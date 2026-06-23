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

  // 1. Open the widget.
  await loc.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout?.(150).catch(() => {});

  // 2. Type into the search box if one appeared.
  try {
    const search = page.locator(SEARCH_BOX_SELECTORS).first();
    if (await search.count().catch(() => 0)) {
      await search.fill(v).catch(() => {});
      await page.waitForTimeout?.(250).catch(() => {});
    }
  } catch { /* no search box — some widgets filter inline */ }

  // 3a. Prefer an ARIA option matching the value (substring, case-insensitive).
  try {
    const opt = page.getByRole("option", { name: new RegExp(escapeRegExp(v), "i") }).first();
    if (await opt.count().catch(() => 0)) {
      await opt.click({ timeout: 5000 });
      return true;
    }
  } catch { /* fall through */ }

  // 3b. Otherwise click the first visible list row containing the value text.
  try {
    const row = page.locator(OPTION_SELECTORS).filter({ hasText: new RegExp(escapeRegExp(v), "i") }).first();
    if (await row.count().catch(() => 0)) {
      await row.click({ timeout: 5000 });
      return true;
    }
  } catch { /* fall through */ }

  // 4. Last resort: accept the typed value with Enter (covers free-text comboboxes).
  await page.keyboard?.press("Enter").catch(() => {});
  return false;
}
