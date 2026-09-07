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
  /** Releases this run's hold on the persistent profile. Set only in persistent mode;
   *  closePortal calls it. Idempotent. */
  releaseProfile?: () => void;
}

// ── One run at a time per portal profile ────────────────────────────────────────────────
// A Chromium persistent profile is a single-holder OS lock, and the profile path is keyed
// by (client, portal) — never by run. While jobs drained serially that could not collide;
// with JOB_CONCURRENCY > 1 two runs for the same client and portal would race, and the
// loser dies at launch with an error that blames a dead run and tells the operator to kill
// Chrome — advice that, mid-flight, would kill a live submission.
//
// So runs QUEUE on the profile instead of failing: different portals still run in parallel
// (which is where the concurrency actually is — a team files across many AHJs at once),
// while two runs on the SAME login serialise, which is what the portal expects anyway.
//
// In-process only, deliberately: it protects the supported topology (one server process,
// see docs/SCALE_DEPLOYMENT.md). A second process needs a real cross-process lock, and the
// launch error below remains the backstop for that case.
// How long a run waits for a busy profile before giving up. A live portal run routinely
// takes minutes (LLM planning + page loads), so this is generous; PORTAL_PROFILE_WAIT_MS
// tunes it. Timing out is the safe outcome — the job is retried, nothing collides.
const PROFILE_WAIT_MS = Math.max(1000, Number(process.env.PORTAL_PROFILE_WAIT_MS ?? 15 * 60 * 1000));

const profileQueues = new Map<string, Promise<void>>();

/** Wait for the profile to be free, then hold it until the returned release() is called.
 *  Waits are bounded: a leaked hold must not wedge a queue forever. */
async function acquireProfile(dir: string, waitMs: number): Promise<() => void> {
  const key = dir.toLowerCase();
  const prior = profileQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    let done = false;
    release = () => { if (!done) { done = true; resolve(); } };
  });
  // Queue behind whoever holds it now; the chain is what serialises runs.
  profileQueues.set(key, prior.then(() => held).catch(() => held));
  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([
    prior.then(() => "free" as const).catch(() => "free" as const),
    new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), waitMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (waited === "timeout") {
    // Do NOT launch anyway — that is the collision this exists to prevent. Release our own
    // slot so the queue keeps moving, and let the caller retry the job.
    release();
    throw new Error(
      `Timed out after ${Math.round(waitMs / 1000)}s waiting for the portal profile to free up: ${dir}\n`
      + "  Another run for this client and portal is still going. This run was not started; retry it once that finishes.",
    );
  }
  return release;
}

// ── Orphaned-browser reaper ─────────────────────────────────────────────────────────────
// When a run is killed (deploy, OOM, Ctrl-C, crash) the Node process dies but ITS BROWSER
// DOES NOT. The orphan keeps holding the profile's OS lock, and every future run for that
// client+portal fails to launch until a human finds and kills it. That happened twice in one
// session of live testing, and on an unattended server nobody is watching to do it.
//
// Only safe to call at STARTUP, which is exactly when it is needed: no run of ours is in
// flight, so any browser still holding one of our profiles is by definition an orphan.
//
// NOTE THE PROCESS NAME. Playwright's headless Chromium is "chrome-headless-shell", not
// "chrome" — a reaper matching only chrome.exe silently misses every headless orphan (which
// is how the first one here was missed).
export async function reapOrphanedProfileBrowsers(profilesRoot: string): Promise<number> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const needle = profilesRoot.replace(/[\\/]+$/, "");
  if (!needle) return 0;
  // NEVER KILL A BROWSER YOUNGER THAN THIS PROCESS. An orphan is by definition something a
  // PREVIOUS run left behind, so it must predate us. Without this the reaper is a live
  // hazard rather than a cleanup: its process scan takes seconds (a PowerShell cold start
  // alone is ~1s), and in that window this process can launch a real portal browser and
  // then SIGKILL it — killing a live submission on a government portal and escalating it
  // to a human for nothing. It also protects the outgoing instance during an overlapping
  // restart, whose browsers are older than us but still finishing their runs… which is why
  // the caller must ALSO await this before starting the job worker.
  const ourStartMs = Date.now() - Math.round(process.uptime() * 1000);
  const pids: string[] = [];
  try {
    if (process.platform === "win32") {
      // CIM gives the full command line (where the profile path lives) and the creation
      // time. Matching is done in JS on the returned rows rather than inside a -like
      // pattern, because a path containing PowerShell wildcard characters ([ ] * ?) would
      // silently match nothing and turn the whole reaper into a no-op.
      const { stdout } = await run("powershell", [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'chrome*' } | "
        + "ForEach-Object { \"$($_.ProcessId)`t$($_.CreationDate.ToFileTimeUtc())`t$($_.CommandLine)\" }",
      ], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      for (const line of stdout.split("\n")) {
        const [pid, fileTime, ...rest] = line.split("\t");
        const cmd = rest.join("\t");
        if (!/^\d+$/.test(pid ?? "") || !cmd.includes(needle)) continue;
        // Windows FILETIME (100ns ticks since 1601) → epoch ms.
        const createdMs = Number(fileTime) > 0 ? Number(BigInt(fileTime) / 10000n) - 11644473600000 : 0;
        if (createdMs && createdMs >= ourStartMs) continue; // younger than us: not an orphan
        pids.push(pid);
      }
    } else {
      // etimes = seconds the process has been alive, so the same "must predate us" rule
      // applies without needing absolute clocks.
      const { stdout } = await run("ps", ["-eo", "pid=,etimes=,args="], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      for (const line of stdout.split("\n")) {
        if (!line.includes(needle)) continue;
        if (!/chrome|chromium|headless_shell|chrome-headless-shell/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[0];
        const ageSec = Number(parts[1]);
        if (!/^\d+$/.test(pid)) continue;
        if (Number.isFinite(ageSec) && ageSec * 1000 < Date.now() - ourStartMs) continue; // younger than us
        pids.push(pid);
      }
    }
  } catch {
    return 0; // listing failed — never let cleanup break startup
  }
  let killed = 0;
  for (const pid of pids) {
    try { process.kill(Number(pid), "SIGKILL"); killed += 1; } catch { /* already gone */ }
  }
  return killed;
}

// Chromium flags for stability in server/container environments.
// --disable-dev-shm-usage prevents OOM crashes when /dev/shm is small (common in Docker).
// --no-sandbox / --disable-setuid-sandbox required for non-privileged container users.
// Background-throttling flags keep JS timers and animations responsive even when headless.
const CHROMIUM_ARGS = [
  // A DESKTOP WINDOW, EXPLICITLY. `--start-maximized` does nothing headless — there is no
  // window manager to maximize against — so with `viewport: null` every headless run drove
  // portals at Chromium's default 800x600. A phone-shaped window.
  //
  // Government portals are responsive, and at 800px wide they collapse their navigation into
  // a hamburger. Both Coos Bay recipes died on their first step, a 30s timeout looking for
  // Accela's "Apply" link, and the failure screenshot is 800px wide with the entire nav bar
  // folded away behind a ☰. The control was present and unreachable — the same "present but
  // shut" family as the concealed fields, arriving through layout instead of CSS.
  //
  // This also silently biased the LEARN side: anything a portal hides below 800px was never
  // seen, so recipes could be recorded around controls that a desktop operator would have
  // used. 1600x1000 is an ordinary desktop, wide enough that no mainstream responsive
  // breakpoint collapses, without pretending to be an ultra-wide.
  "--window-size=1600,1000",
  "--start-maximized",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-extensions",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  // TranslateUI plus the address/password "save?" bubbles: Chrome's own save-address popup
  // paints over PowerClerk's equipment selects mid-fill (operator screenshot: the "Save
  // address?" bubble on top of the inverter dropdown while its model went unfilled).
  "--disable-features=TranslateUI,AutofillAddressProfileSavePrompt,AutofillServerCommunication",
  "--disable-save-password-bubble",
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
  // bypass: loopback addresses + any user-supplied comma-separated hosts should
  // NEVER route through the proxy — this lets local fixture servers and
  // localhost dev portals work correctly even when HTTPS_PROXY is set.
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const proxyBypassExtra = process.env.PORTAL_PROXY_BYPASS || "";
  const proxyBypass = ["127.0.0.1", "localhost", "[::1]", proxyBypassExtra].filter(Boolean).join(",");
  const proxyOpts = httpsProxy ? { server: httpsProxy, bypass: proxyBypass } : undefined;

  if (opts.userDataDir) {
    // A PROFILE STILL HELD BY A DEAD RUN. Chromium refuses a persistent profile that
    // another instance has open, and Playwright reports it as "Opening in existing browser
    // session." buried under a 30-line launch dump — which reads like a launch failure
    // rather than the one-line problem it is. The usual cause is a run that was killed:
    // the node process goes, its browser does not, and the profile stays locked until
    // something clears it. Three runs were lost to this in one session.
    //
    // Deliberately NOT auto-killing: a library that hunts down and terminates browser
    // processes could take out a run that legitimately owns the profile. Name the problem
    // and the remedy; let the caller decide.
    // Queue behind any run already holding this profile (see acquireProfile).
    const releaseProfile = await acquireProfile(opts.userDataDir, PROFILE_WAIT_MS);
    const context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless,
      slowMo,
      viewport: null,
      args: CHROMIUM_ARGS,
      ignoreHTTPSErrors,
      proxy: proxyOpts,
    }).catch((err: unknown) => {
      releaseProfile(); // never hold the profile for a launch that failed
      const msg = err instanceof Error ? err.message : String(err);
      if (/existing browser session|already in use|ProcessSingleton/i.test(msg)) {
        throw new Error(
          `Portal profile is still locked by a previous run: ${opts.userDataDir}
`
          + "  A killed run leaves its browser alive and holding the profile. Close that browser, "
          + "or end the chrome processes whose command line contains this directory, then retry.",
        );
      }
      throw err;
    });
    // RELEASE WHEN THE BROWSER ACTUALLY GOES, whatever closes it. closePortal is not the
    // only way a context ends: a human can close the window of a run deliberately left open
    // at review, the browser can be OOM-killed, or it can crash. Every one of those used to
    // leave the queue holding a profile nobody was using, and because the hold is only
    // released by closePortal — which needs an `opened` the caller may never have received —
    // the wedge lasted for the life of the process, failing every later run for that client
    // and portal. Hooking the context's own close event covers all of them; release is
    // idempotent, so closePortal calling it too is harmless.
    try {
      context.on("close", () => { releaseProfile(); });
    } catch { /* a stub context in tests has no event emitter */ }

    try {
      await context.addInitScript({ content: NAME_SHIM });
      const page = context.pages()[0] ?? (await context.newPage());
      // Persistent context owns its own browser process; closing the context closes it.
      return { page, context, releaseProfile };
    } catch (err) {
      // Setup failed AFTER a successful launch. The caller gets an exception and therefore
      // never receives (or closes) this handle, so tear it down here — otherwise both the
      // profile hold and the Chromium process leak, and the leaked process keeps the OS
      // profile lock even after this Node process exits.
      try { await context.close(); } catch { /* best effort */ }
      releaseProfile();
      throw err;
    }
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
  // Hand the profile to whoever is queued behind us. LAST, and outside the try/catch above,
  // so a teardown error can never strand the queue.
  try { opened.releaseProfile?.(); } catch { /* release is idempotent */ }
}
