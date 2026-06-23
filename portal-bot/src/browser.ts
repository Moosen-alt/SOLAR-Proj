/**
 * Shared Playwright launcher for portal adapters.
 *
 * Supports two session modes:
 *  - userDataDir: a PERSISTENT browser profile. Cookies and localStorage are
 *    stored on disk exactly like a normal Chrome profile, so a login performed
 *    once stays valid across runs. This is the most reliable mode for portals
 *    with finicky sessions (PowerClerk, Accela).
 *  - storageStatePath: a one-shot storage-state JSON snapshot (legacy mode).
 *
 * Only one process can use a given userDataDir at a time, so always close the
 * login browser before starting a run.
 */

import type { Page, BrowserContext, Browser } from "playwright";

export interface OpenedPortal {
  page: Page;
  context: BrowserContext;
  // Present only in the non-persistent (browser.launch) mode. In persistent-context
  // mode the context IS the browser, so this is undefined.
  browser?: Browser;
}

// Chromium flags for stability in server/container environments.
// --disable-dev-shm-usage prevents OOM crashes when /dev/shm is small (common in Docker).
// --no-sandbox / --disable-setuid-sandbox required for non-privileged container users.
// Background-throttling flags keep JS timers and animations responsive even when headless.
const CHROMIUM_ARGS = [
  "--start-maximized",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-extensions",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=TranslateUI",
  "--disable-ipc-flooding-protection",
];

// Resolve the headless setting honestly:
//   - explicit opts.headless wins;
//   - PORTAL_HEADLESS=false forces a visible window (local debugging / recording);
//   - otherwise default to headless true (production/cloud has no display).
export function resolveHeadless(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (process.env.PORTAL_HEADLESS === "false") return false;
  return true;
}

export async function openPortal(opts: {
  userDataDir?: string;
  storageStatePath?: string;
  headless?: boolean;
  /** Milliseconds between each action — useful for debugging; 0 in production. */
  slowMo?: number;
}): Promise<OpenedPortal> {
  const { chromium } = await import("playwright");

  const headless = resolveHeadless(opts.headless);
  const slowMo = opts.slowMo ?? 0;

  if (opts.userDataDir) {
    const context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless,
      slowMo,
      viewport: null,
      args: CHROMIUM_ARGS,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    // Persistent context owns its own browser process; closing the context closes it.
    return { page, context };
  }

  const browser = await chromium.launch({ headless, slowMo, args: CHROMIUM_ARGS });
  const context = opts.storageStatePath
    ? await browser.newContext({ storageState: opts.storageStatePath })
    : await browser.newContext();
  const page = await context.newPage();
  return { page, context, browser };
}

// Always-safe teardown: closes the context (persistent or not) and the owning
// browser if there is a separate one. Swallows errors so cleanup never masks the
// real run result, and is idempotent (safe to call from a finally even if open
// partially failed).
export async function closePortal(opened: OpenedPortal | null | undefined): Promise<void> {
  if (!opened) return;
  try {
    if (opened.context && typeof opened.context.close === "function") {
      await opened.context.close();
    }
  } catch {
    // ignore — best-effort teardown
  }
  try {
    if (opened.browser && typeof opened.browser.close === "function") {
      await opened.browser.close();
    }
  } catch {
    // ignore — best-effort teardown
  }
}
