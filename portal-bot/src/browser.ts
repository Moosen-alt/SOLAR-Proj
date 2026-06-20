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

export interface OpenedPortal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}

export async function openPortal(opts: {
  userDataDir?: string;
  storageStatePath?: string;
  headless?: boolean;
}): Promise<OpenedPortal> {
  const { chromium } = await import("playwright");

  if (opts.userDataDir) {
    const context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless: opts.headless ?? false,
      viewport: null,
      args: ["--start-maximized"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return { page, context };
  }

  const browser = await chromium.launch({ headless: opts.headless ?? false });
  const context = opts.storageStatePath
    ? await browser.newContext({ storageState: opts.storageStatePath })
    : await browser.newContext();
  const page = await context.newPage();
  return { page, context };
}
