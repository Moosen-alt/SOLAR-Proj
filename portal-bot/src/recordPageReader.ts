// READ A FILED RECORD'S PAGE THE WAY A PERSON SEES IT — after its script has loaded.
//
// An Accela record detail page (CapDetail.aspx) fills its Fees section by script: the one Coos
// Bay capture on file reads "Print/View Summary Fees Loading...". A plain HTTP fetch sees that
// placeholder forever, so the permit monitor's fee reader (backend/src/portalFeeReadings.ts)
// falls back to this: open the record's own public URL in a headless browser, wait for the
// placeholder to go, and hand back the page text.
//
// SAFETY — READ-ONLY BY CONSTRUCTION. It navigates to ONE url and reads innerText. It never
// clicks, never types, never submits and never pays (hard rule 1): there is no locator here
// that could reach a "Pay Fees" link, because there is no click at all. A fresh, ephemeral
// browser context — no profile, no stored session, no credential — because a public record
// page needs none, and a profile would contend with staging runs for the same lock.
// PORTAL_AUTOMATION_DISABLED stops it like every other portal door.

import { chromium } from "playwright";
import { portalAutomationDisabled } from "./browser";

/** The placeholder the page shows until its Fees section loads. */
export const FEES_LOADING = /Print\/View Summary Fees\s*Loading/i;

export async function readRecordPageInBrowser(
  url: string,
  opts: { timeoutMs?: number; headless?: boolean } = {},
): Promise<string | null> {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  if (portalAutomationDisabled()) return null;
  const timeoutMs = Math.max(2000, Math.min(opts.timeoutMs ?? 20_000, 60_000));
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 15_000) }).catch(() => null);
    // Wait for the script-loaded Fees section to replace its placeholder. A page that never
    // had the placeholder is returned as soon as it is idle; a page whose fees never load is
    // returned WITH the placeholder, and the parser reports "not_loaded" — never a number.
    const deadline = Date.now() + timeoutMs;
    let text = "";
    for (;;) {
      text = String(await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""));
      if (!FEES_LOADING.test(text) || Date.now() >= deadline) break;
      await page.waitForTimeout(400);
    }
    return text ? text.slice(0, 60_000) : null;
  } catch {
    return null;
  } finally {
    await browser.close().catch(() => null);
  }
}
