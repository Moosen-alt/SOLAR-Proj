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
// It never touches a control any of whose names (text, aria-label, title, value) create, start,
// submit, pay, delete, withdraw, cancel or sign out; a search box is never one inside a sign-in form;
// and it reads no page on any host but the one it signed in to. When it finds nothing it says WHY (a
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

/** The host a URL loads from ("" for about:blank, data:, chrome-error:...). */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.host.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Every candidate's label and visibility in ONE in-page pass (a locator call per element can wait
 *  out Playwright's 30 s default when the page re-renders under it). Arrow callbacks only.
 *  `label` is what a person reads; `guard` is EVERY name the control carries (its text, aria-label,
 *  title, value, image alt): NEVER_TOUCH is tested against `guard`, so an icon-only "Submit" whose
 *  words live only in its aria-label is still refused. `hrefHost` is where a plain link goes. */
async function labelsOf(page: Page, selector: string): Promise<Array<{ i: number; label: string; guard: string; hrefHost: string; visible: boolean; disabled: boolean }>> {
  return page.locator(selector).evaluateAll((els: Element[]) => els.slice(0, 300).map((el, i) => {
    const h = el as HTMLElement;
    const r = h.getBoundingClientRect();
    const style = window.getComputedStyle(h);
    const label = ((h.innerText || h.getAttribute("aria-label") || "") as string).replace(/\s+/g, " ").trim();
    const guard = [h.innerText, h.getAttribute("aria-label"), h.getAttribute("title"), (h as HTMLInputElement).value,
      ...Array.from(h.querySelectorAll("img[alt]")).map((img) => img.getAttribute("alt"))]
      .filter((s) => typeof s === "string" && s).join(" ").replace(/\s+/g, " ").trim();
    let hrefHost = "";
    const href = (h as HTMLAnchorElement).href;
    if (typeof href === "string" && /^https?:/i.test(href)) {
      try { hrefHost = new URL(href).host.toLowerCase(); } catch { hrefHost = ""; }
    }
    return {
      i,
      label,
      guard,
      hrefHost,
      visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      disabled: h.hasAttribute("disabled") || h.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(h.className || ""),
    };
  })).catch(() => []);
}

/** Click the first visible link/tab whose whole label names a filings list and that stays on this
 *  portal. A list link to another host is never followed (rule 5: a NEM read must not open a city's
 *  permit portal, nor a permit read a utility's); `offHost` names the first one refused. */
async function openListLink(page: Page, settleMs: number, host: string): Promise<{ label: string | null; offHost: string | null }> {
  const selector = "a, [role='link'], [role='tab']";
  const lists = (await labelsOf(page, selector)).filter((c) => c.visible && c.label && c.label.length <= 40 && LIST_LINK.test(c.label) && !NEVER_TOUCH.test(c.guard));
  const pick = lists.find((c) => !c.hrefHost || c.hrefHost === host);
  if (!pick) return { label: null, offHost: lists[0]?.hrefHost ?? null };
  await page.locator(selector).nth(pick.i).click({ timeout: 10_000 }).catch(() => null);
  await settle(page, settleMs);
  return { label: pick.label, offHost: null };
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

/** The search button beside the box (by its label, title or icon class), for a box Enter does not run.
 *  Found by "search" anywhere on it, icon markup included; REFUSED by NEVER_TOUCH over every name it
 *  carries (text, aria-label, title, value, image alt), so an icon-only button labelled "Submit
 *  application" is never the one clicked, however its icon is drawn. */
async function searchButtonNear(page: Page, inputIndex: number) {
  const selector = "button, [role='button'], input[type='submit'], input[type='button'], a";
  const candidates = await page.locator("input").nth(inputIndex).evaluate((input: Element, sel: string) => {
    const all = Array.from(document.querySelectorAll(sel));
    let node: HTMLElement | null = input.parentElement;
    for (let up = 0; up < 3 && node; up++, node = node.parentElement) {
      const hits = Array.from(node.querySelectorAll(sel)).filter((b) => /search/i.test([(b as HTMLElement).innerText, b.getAttribute("aria-label"), b.getAttribute("title"), b.getAttribute("class"), (b as HTMLInputElement).value, b.innerHTML].join(" ")));
      if (hits.length) {
        return hits.map((b) => ({
          index: all.indexOf(b),
          guard: [(b as HTMLElement).innerText, b.getAttribute("aria-label"), b.getAttribute("title"), (b as HTMLInputElement).value,
            ...Array.from(b.querySelectorAll("img[alt]")).map((img) => img.getAttribute("alt"))]
            .filter((s) => typeof s === "string" && s).join(" ").replace(/\s+/g, " ").trim(),
        }));
      }
    }
    return [] as Array<{ index: number; guard: string }>;
  }, selector).catch(() => [] as Array<{ index: number; guard: string }>);
  const pick = candidates.find((c) => c.index >= 0 && !NEVER_TOUCH.test(c.guard));
  return pick ? page.locator(selector).nth(pick.index) : null;
}

/** The visible, enabled "Next" control that stays on this portal, if the list has one. */
async function nextControl(page: Page, host: string) {
  const selector = "a, button, [role='button']";
  const pick = (await labelsOf(page, selector)).find((c) => {
    const label = norm(c.label);
    if (!NEXT_CONTROL.test(label) && !/^next\b/i.test(label)) return false;
    if (NEVER_TOUCH.test(c.guard)) return false;
    if (c.hrefHost && c.hrefHost !== host) return false;
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

  // THE SIGNED-IN PORTAL'S HOST. Nothing below reads a page on any other host (rule 5): a link that
  // plainly goes elsewhere is never followed, and a click that lands elsewhere anyway (script-driven
  // navigation, a search form posting off-site) ends the read with that reason, unread.
  const host = hostOf(page.url());
  if (!host) return { text: null, reason: "the browser is not on a portal page", pagesScanned: 0 };
  let pagesScanned = 0;
  const leftPortal = (step: string): StatusFind | null => {
    const now = hostOf(page.url());
    return now === host ? null : { text: null, reason: `${step} left the signed-in portal (${host}) for ${now || "a non-web page"}; a status read reads only the portal it signed in to`, pagesScanned };
  };

  if (await loginFormPresent(page).catch(() => false)) {
    return { text: null, reason: "the portal is showing its sign-in page (the session is not signed in)", pagesScanned };
  }
  // 1. Where the sign-in left us.
  pagesScanned = 1;
  const here = await scanFor(page, nums);
  if (here) return { text: here, reason: "found on the signed-in landing page", pagesScanned };

  // 2. The portal's own list of filings.
  const list = await openListLink(page, settleMs, host);
  const listLabel = list.label;
  if (!listLabel) {
    return {
      text: null,
      reason: list.offHost
        ? `the application number is not on the signed-in landing page, and its only projects/applications list link goes to another host (${list.offHost}); a status read never follows it`
        : "the application number is not on the signed-in landing page, and the page has no projects/applications list link",
      pagesScanned,
    };
  }
  const offList = leftPortal(`opening "${listLabel}"`);
  if (offList) return offList;
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
      const offEnter = leftPortal(`searching "${listLabel}"`);
      if (offEnter) return offEnter;
      let after = await bodyText(page);
      if (after === before) {
        const button = await searchButtonNear(page, box);
        if (button) {
          await button.click({ timeout: 5_000 }).catch(() => null);
          await settle(page, settleMs);
          const offButton = leftPortal(`searching "${listLabel}"`);
          if (offButton) return offButton;
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
      const off = leftPortal(`turning "${listLabel}" to page ${p}`);
      if (off) return off;
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
    const next = await nextControl(page, host);
    if (!next) break;
    progress(`reading "${listLabel}" page ${p}`);
    await next.click({ timeout: 10_000 }).catch(() => null);
    await settle(page, settleMs);
    const off = leftPortal(`turning "${listLabel}" to page ${p}`);
    if (off) return off;
    const now = await bodyText(page);
    if (now === previous) break; // the control did nothing: the list has ended
    previous = now;
    pagesScanned++;
    const hit = await scanFor(page, nums);
    if (hit) return { text: hit, reason: `found on "${listLabel}", page ${p}`, pagesScanned };
  }
  return { text: null, reason: `the application number is not on "${listLabel}" — read ${pagesScanned - 1} list page(s)`, pagesScanned };
}
