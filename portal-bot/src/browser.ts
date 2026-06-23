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

// CRITICAL: the backend + portal-bot run under tsx, whose esbuild transpile wraps every
// named function with a `__name(fn, "name")` helper call (esbuild "keepNames"). When a
// such a function is serialized and run INSIDE the browser via page.$$eval / page.evaluate,
// `__name` is undefined there → ReferenceError → the adapter's `.catch(() => [])` swallows
// it and silently returns an EMPTY result. That makes every page look like it has no
// fields, so auto-learn can never navigate/fill/advance. Shimming `__name` to an identity
// function in the page (on every navigation, before page scripts run) makes those
// serialized functions work. Harmless in a non-tsx/build environment (the shim is a no-op
// the wrapped code never needs). Applied to the whole context so EVERY adapter benefits.
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";

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
  /** Tolerate invalid HTTPS certificates. OFF by default — turning it on disables TLS
   *  trust checking, which is a MITM risk in production. It exists ONLY so the bot can run
   *  inside a sandbox/CI whose egress goes through a TLS-intercepting proxy with an
   *  untrusted CA. Enable per-call or via PORTAL_IGNORE_HTTPS_ERRORS=true; never in prod. */
  ignoreHTTPSErrors?: boolean;
}): Promise<OpenedPortal> {
  const { chromium } = await import("playwright");

  const headless = resolveHeadless(opts.headless);
  const slowMo = opts.slowMo ?? 0;
  const ignoreHTTPSErrors = opts.ignoreHTTPSErrors ?? process.env.PORTAL_IGNORE_HTTPS_ERRORS === "true";

  // Route Playwright's Chromium through the same egress proxy that Node/curl use.
  // Chromium does NOT inherit HTTPS_PROXY from the environment — it must be wired
  // explicitly. When running under the agent proxy (e.g. Claude Code remote), all
  // outbound HTTPS goes through a TLS-intercepting local proxy; the proxy's CA cert
  // is pre-installed in the system NSS store and NODE_EXTRA_CA_CERTS, so Chromium
  // trusts it automatically when the proxy server is set correctly.
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const proxyOpts = httpsProxy ? { server: httpsProxy } : undefined;

  if (opts.userDataDir) {
    const context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless,
      slowMo,
      viewport: null,
      args: CHROMIUM_ARGS,
      ignoreHTTPSErrors,
      proxy: proxyOpts,
    });
    await context.addInitScript({ content: NAME_SHIM });
    const page = context.pages()[0] ?? (await context.newPage());
    // Persistent context owns its own browser process; closing the context closes it.
    return { page, context };
  }

  const browser = await chromium.launch({ headless, slowMo, args: CHROMIUM_ARGS, proxy: proxyOpts });
  const context = opts.storageStatePath
    ? await browser.newContext({ storageState: opts.storageStatePath, ignoreHTTPSErrors, proxy: proxyOpts })
    : await browser.newContext({ ignoreHTTPSErrors, proxy: proxyOpts });
  await context.addInitScript({ content: NAME_SHIM });
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
