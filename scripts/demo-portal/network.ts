// ---------------------------------------------------------------------------
// LOOPBACK-ONLY BROWSER TRAFFIC for the Act 4 recording.
//
// One function, used by the recorder and by its abort-branch proof, so the proof exercises
// the code that actually guards the recording rather than a copy of it.
// ---------------------------------------------------------------------------
import type { BrowserContext } from "playwright";

/** EXACT loopback: 127.0.0.1, ::1 (bracketed or not) and localhost — nothing else.
 *  Not `startsWith("127.")` (that passes "127.evil.example") and not the whole 127/8 either:
 *  every fixture these scripts talk to binds 127.0.0.1, so a wider allowance only widens what
 *  a trap would wave through. An empty host is NOT loopback here — a caller whose API
 *  defaults a missing host to localhost must say "localhost" itself, so a host this code
 *  failed to parse can never read as local. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

export interface RouteCounters {
  loopback: number;
  aborted: number;
  abortedHosts: string[];
}

/** Route every request the context makes: loopback (and data:/blob:/about:) continues,
 *  anything else is aborted and counted. */
export async function installLoopbackOnlyRoute(context: BrowserContext): Promise<RouteCounters> {
  const counters: RouteCounters = { loopback: 0, aborted: 0, abortedHosts: [] };
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    let host = "";
    try { host = new URL(url).hostname; } catch { /* data: etc */ }
    if (/^(data|blob|about):/i.test(url) || isLoopbackHost(host)) {
      counters.loopback++;
      await route.continue();
      return;
    }
    counters.aborted++;
    counters.abortedHosts.push(host || url.slice(0, 60));
    await route.abort("blockedbyclient");
  });
  return counters;
}
