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

  // 3c. Trailing-token looser match: "Schedule 7" → look for an option containing just "7"
  //     as a word boundary (catches "7 - Residential Net Metering" style labels).
  try {
    const lastToken = v.split(/\s+/).pop() ?? v;
    if (lastToken !== v && lastToken.length >= 1) {
      const row = page.locator(OPTION_SELECTORS).filter({ hasText: new RegExp(`\\b${escapeRegExp(lastToken)}\\b`, "i") }).first();
      if (await row.count().catch(() => 0)) {
        await row.click({ timeout: 5000 });
        return true;
      }
    }
  } catch { /* fall through */ }

  // 3d. Visible-text fallback: scan all visible elements for one whose trimmed text matches.
  try {
    const allVisible = page.locator("li, [role='option'], .dropdown-item, [class*='-option']").filter({ hasText: new RegExp(escapeRegExp(v), "i") });
    const cnt = await allVisible.count().catch(() => 0);
    for (let i = 0; i < Math.min(cnt, 8); i++) {
      const el = allVisible.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 5000 });
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
