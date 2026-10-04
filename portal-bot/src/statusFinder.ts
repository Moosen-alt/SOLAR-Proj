// FIND ONE FILING'S STATUS ON A SIGNED-IN PORTAL (issue #161). Read-only.
//
// A recipe's status read used to reload the recipe's portalUrl after signing in, then scan that one
// page. For a portal whose recorded entry IS its login page (every PowerClerk recipe ends in
// /MvcAccount/Login) the reload lands back on the login screen, the scan reads a login wall, and the
// filing's status is never read. Live, PacifiCorp 2026-10-04: signed in to "Program Home", sent back
// to "Login". And a filing is rarely on the landing page anyway: that account's "Projects" list holds
// about 150 projects, 13 to a page, with no search box.
//
// So this looks, in order:
//   1. the page the sign-in left the browser on;
//   2. the portal's own list link ("Projects", "My Applications", "Records", ...), chosen by its words;
//   3. that list's own SEARCH box, given the application number (owner, 2026-10-04: "you can look up
//      the projects by number"); PowerClerk's box is known only by the "Search All Columns" selector
//      and magnifier beside it;
//   4. only when the list cannot be searched, its further pages: a numeric page <select> or a "Next"
//      control, up to maxPages, inside a time budget.
// It never touches a control whose words create, start, submit, pay, delete, withdraw, cancel or sign
// out, and a search box is never one inside a sign-in form. When it finds nothing it says WHY (a
// login page, a search with no match, how many pages it read), so the monitor can log a reason
// instead of "no portal URL/recipe".
import type { Page } from "playwright";
import { loginFormPresent } from "./adapters/loginFlow";
import { redactStatusText } from "./safeAction";
import { installSettleProbe, waitForSettled } from "./settle";

export type StatusFind = { text: string | null; reason: string; pagesScanned: number };

/** A list of filings, by the words on its link. Exact-ish: "Projects", "My Applications", "All Records". */
export const LIST_LINK = /^(?:my\s+|all\s+)?(?:projects?|applications?|submissions?|requests?|records?|permits?|cases?)(?:\s+list)?$/i;
/** Words that make a control unsafe to touch on a read-only pass, whatever else it says. */
export const NEVER_TOUCH = /\b(?:new|create|start|begin|apply|submit|pay|payment|checkout|delete|remove|withdraw|cancel|sign\s*out|log\s*out|logout)\b/i;
const NEXT_CONTROL = /^(?:next|next\s+page|›|»|>)$/i;

const norm = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

// THE SHARED SETTLE (settle.ts), not "networkidle". A portal that keeps a long-poll or analytics
// beacon open never goes network-idle, so every networkidle wait burned its whole timeout: live on
// PowerClerk the walk of a 12-page list ran past ten minutes with the window sitting still.
// waitForSettled ends after 300 ms without DOM mutation or a young request.
async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => null);
  await installSettleProbe(page).catch(() => null);
  await waitForSettled(page, { timeoutMs: ms }).catch(() => null);
}

async function bodyText(page: Page): Promise<string> {
  return String(await page.locator("body").innerText().catch(() => ""));
}

/** The redacted snippet around the first application number on the page, or null when none is. */
async function scanFor(page: Page, applicationNumbers: string[]): Promise<string | null> {
  const body = await bodyText(page);
  for (const num of applicationNumbers) {
    if (!num) continue;
    const idx = body.indexOf(num);
    if (idx === -1) continue;
    const snippet = redactStatusText(body.slice(Math.max(0, idx - 80), idx + 320));
    if (snippet) return snippet;
  }
  return null;
}

/** Every candidate's label and visibility in ONE in-page pass (a locator call per element can wait
 *  out Playwright's 30 s default when the page re-renders under it). Arrow callbacks only. */
async function labelsOf(page: Page, selector: string): Promise<Array<{ i: number; label: string; visible: boolean; disabled: boolean }>> {
  return page.locator(selector).evaluateAll((els: Element[]) => els.slice(0, 300).map((el, i) => {
    const h = el as HTMLElement;
    const r = h.getBoundingClientRect();
    const style = window.getComputedStyle(h);
    return {
      i,
      label: ((h.innerText || h.getAttribute("aria-label") || "") as string).replace(/\s+/g, " ").trim(),
      visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      disabled: h.hasAttribute("disabled") || h.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(h.className || ""),
    };
  })).catch(() => []);
}

/** Click the first visible link/tab whose whole label names a filings list. Returns its label. */
async function openListLink(page: Page, settleMs: number): Promise<string | null> {
  const selector = "a, [role='link'], [role='tab']";
  const pick = (await labelsOf(page, selector)).find((c) => c.visible && c.label && c.label.length <= 40 && LIST_LINK.test(c.label) && !NEVER_TOUCH.test(c.label));
  if (!pick) return null;
  await page.locator(selector).nth(pick.i).click({ timeout: 10_000 }).catch(() => null);
  await settle(page, settleMs);
  return pick.label;
}

/** A page <select>: every option a whole number, starting at 1 and counting up (1,2,3...). */
async function pageSelectSize(page: Page): Promise<{ index: number; pages: number } | null> {
  const found = await page.locator("select").evaluateAll((sels: Element[]) => {
    for (let i = 0; i < sels.length; i++) {
      const opts = Array.from((sels[i] as HTMLSelectElement).options).map((o) => (o.textContent || "").trim());
      if (opts.length < 2) continue;
      if (opts.every((t, k) => t === String(k + 1))) return { index: i, pages: opts.length };
    }
    return null;
  }).catch(() => null);
  return found;
}

/** A LIST'S OWN SEARCH BOX: a visible text input that says it searches (placeholder / aria-label /
 *  name / id / title), or sits beside a control that does. PowerClerk's has no such words of its own:
 *  the box sits between a "Search All Columns" selector and a magnifier button (owner's screenshot,
 *  2026-10-04: 651 projects, 13 to a page). An input in a form with a password box is never one. */
async function searchBoxIndex(page: Page): Promise<number | null> {
  return page.locator("input").evaluateAll((els: Element[]) => {
    let best: { i: number; own: boolean } | null = null;
    els.forEach((el, i) => {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (!["text", "search", ""].includes(type)) return;
      const r = input.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || input.disabled || input.readOnly) return;
      if (input.form && input.form.querySelector("input[type='password']")) return;
      const own = [input.placeholder, input.getAttribute("aria-label"), input.name, input.id, input.title].join(" ");
      if (/search|filter|find/i.test(own)) { if (!best || !best.own) best = { i, own: true }; return; }
      let node: HTMLElement | null = input.parentElement;
      for (let up = 0; up < 3 && node; up++, node = node.parentElement) {
        const near = Array.from(node.querySelectorAll("button, select, [role='button'], a, label, i, span"))
          .map((c) => [(c as HTMLElement).innerText, c.getAttribute("aria-label"), c.getAttribute("title"), c.getAttribute("class")].join(" ")).join(" ");
        if (/search/i.test(near)) { if (!best) best = { i, own: false }; return; }
      }
    });
    return best ? (best as { i: number }).i : null;
  }).catch(() => null);
}

/** The search button beside the box (by its label, title or icon class), for a box Enter does not run. */
async function searchButtonNear(page: Page, inputIndex: number) {
  const idx = await page.locator("input").nth(inputIndex).evaluate((input: Element) => {
    let node: HTMLElement | null = input.parentElement;
    for (let up = 0; up < 3 && node; up++, node = node.parentElement) {
      const buttons = Array.from(node.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button'], a"));
      const hit = buttons.find((b) => /search/i.test([(b as HTMLElement).innerText, b.getAttribute("aria-label"), b.getAttribute("title"), b.getAttribute("class"), (b as HTMLInputElement).value, b.innerHTML].join(" ")));
      if (hit) return Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button'], a")).indexOf(hit);
    }
    return -1;
  }).catch(() => -1);
  return idx >= 0 ? page.locator("button, [role='button'], input[type='submit'], input[type='button'], a").nth(idx) : null;
}

/** The visible, enabled "Next" control, if the list has one. */
async function nextControl(page: Page) {
  const selector = "a, button, [role='button']";
  const pick = (await labelsOf(page, selector)).find((c) => {
    const label = norm(c.label);
    if (!NEXT_CONTROL.test(label) && !/^next\b/i.test(label)) return false;
    if (NEVER_TOUCH.test(label)) return false;
    return c.visible && !c.disabled;
  });
  return pick ? page.locator(selector).nth(pick.i) : null;
}

/**
 * Find this filing's status on the portal the browser is signed in to. Read-only navigation only.
 * `text` is the redacted snippet around the application number; `reason` always says what happened.
 */
export async function findFilingStatus(
  page: Page,
  applicationNumbers: string[],
  opts: { maxPages?: number; settleMs?: number; budgetMs?: number; onProgress?: (message: string) => void } = {},
): Promise<StatusFind> {
  const maxPages = Math.max(1, opts.maxPages ?? 25);
  const settleMs = opts.settleMs ?? 10_000;
  // A status read must never stall the monitor's sweep (targets are read one after another).
  const deadline = Date.now() + (opts.budgetMs ?? 180_000);
  const overBudget = () => Date.now() > deadline;
  const progress = (m: string) => { try { opts.onProgress?.(m); } catch { /* progress never breaks a read */ } };
  const nums = applicationNumbers.map((n) => String(n ?? "").trim()).filter(Boolean);
  if (!nums.length) return { text: null, reason: "no application number to look for", pagesScanned: 0 };
  progress("looking on the signed-in page");

  if (await loginFormPresent(page).catch(() => false)) {
    return { text: null, reason: "the portal is showing its sign-in page (the session is not signed in)", pagesScanned: 0 };
  }
  // 1. Where the sign-in left us.
  let pagesScanned = 1;
  const here = await scanFor(page, nums);
  if (here) return { text: here, reason: "found on the signed-in landing page", pagesScanned };

  // 2. The portal's own list of filings.
  const listLabel = await openListLink(page, settleMs);
  if (!listLabel) {
    return { text: null, reason: "the application number is not on the signed-in landing page, and the page has no projects/applications list link", pagesScanned };
  }
  progress(`opened "${listLabel}"`);
  if (await loginFormPresent(page).catch(() => false)) {
    return { text: null, reason: `opening "${listLabel}" led to the portal's sign-in page`, pagesScanned };
  }
  pagesScanned++;
  const first = await scanFor(page, nums);
  if (first) return { text: first, reason: `found on "${listLabel}"`, pagesScanned };
  const outOfTime = () => ({ text: null, reason: `stopped after ${Math.round((opts.budgetMs ?? 180_000) / 1000)}s on "${listLabel}" — read ${pagesScanned - 1} list page(s)`, pagesScanned });

  // 3. The list's own search box: type the number, read the row. A search is a query, not a filing:
  //    nothing about the application is sent, and the box is never inside a sign-in form.
  const box = await searchBoxIndex(page);
  if (box !== null) {
    for (const num of nums.slice(0, 2)) {
      if (overBudget()) return outOfTime();
      progress(`searching "${listLabel}" for the application number`);
      const before = await bodyText(page);
      const input = page.locator("input").nth(box);
      await input.fill(num, { timeout: 5_000 }).catch(() => null);
      await input.press("Enter", { timeout: 5_000 }).catch(() => null);
      await settle(page, settleMs);
      let after = await bodyText(page);
      if (after === before) {
        const button = await searchButtonNear(page, box);
        if (button && !NEVER_TOUCH.test(norm(await button.innerText().catch(() => "")))) {
          await button.click({ timeout: 5_000 }).catch(() => null);
          await settle(page, settleMs);
          after = await bodyText(page);
        }
      }
      pagesScanned++;
      const hit = await scanFor(page, nums);
      if (hit) return { text: hit, reason: `found by searching "${listLabel}" for the application number`, pagesScanned };
      if (after !== before) {
        // The search ran and the list changed: try the next number, else say so (no page walk over a
        // filtered list).
        if (num === nums.slice(0, 2)[nums.slice(0, 2).length - 1]) {
          return { text: null, reason: `searched "${listLabel}" for the application number — no matching row`, pagesScanned };
        }
        continue;
      }
      break; // the box did nothing: walk the pages instead
    }
  }

  // 4. The list's further pages: a numeric page <select>, else a "Next" control.
  const select = await pageSelectSize(page);
  if (select) {
    const last = Math.min(select.pages, maxPages);
    for (let p = 2; p <= last; p++) {
      if (overBudget()) return outOfTime();
      progress(`reading "${listLabel}" page ${p} of ${select.pages}`);
      await page.locator("select").nth(select.index).selectOption({ label: String(p) }, { timeout: settleMs }).catch(() => null);
      await settle(page, settleMs);
      pagesScanned++;
      const hit = await scanFor(page, nums);
      if (hit) return { text: hit, reason: `found on "${listLabel}", page ${p} of ${select.pages}`, pagesScanned };
    }
    const capped = select.pages > maxPages ? ` (stopped at ${maxPages} of ${select.pages})` : "";
    return { text: null, reason: `the application number is not on "${listLabel}" — read ${last} list page(s)${capped}`, pagesScanned };
  }
  let previous = await bodyText(page);
  for (let p = 2; p <= maxPages; p++) {
    if (overBudget()) return outOfTime();
    const next = await nextControl(page);
    if (!next) break;
    progress(`reading "${listLabel}" page ${p}`);
    await next.click({ timeout: 10_000 }).catch(() => null);
    await settle(page, settleMs);
    const now = await bodyText(page);
    if (now === previous) break; // the control did nothing: the list has ended
    previous = now;
    pagesScanned++;
    const hit = await scanFor(page, nums);
    if (hit) return { text: hit, reason: `found on "${listLabel}", page ${p}`, pagesScanned };
  }
  return { text: null, reason: `the application number is not on "${listLabel}" — read ${pagesScanned - 1} list page(s)`, pagesScanned };
}
