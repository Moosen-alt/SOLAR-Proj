// WHERE THE SERVER LISTENS — the one bind decision server.ts makes (hard rule 6, issue #82).
//
// The default used to be 0.0.0.0. The owner's production install ran with AUTH_ENABLED unset
// and no SERVER_HOST on a Public-profile network, and unauthenticated GET /api/projects answered
// 200 to the LAN: every project's homeowner data plus the approve/credential endpoints. The only
// guard was a warning in a log nobody read. So exposure is now opt-in, twice over:
//
//   - no SERVER_HOST → 127.0.0.1, auth on or off. A hosted install (Fly, Docker, a VM behind
//     Caddy) sets SERVER_HOST on purpose.
//   - auth OFF and a non-loopback SERVER_HOST → refuse to start, unless
//     ALLOW_UNAUTHENTICATED_NETWORK=1 is ALSO set. Then it starts, with the exposure warning.
//
// Pure (reads only the env it is handed) so the decision is pinned by backend/test/listenHost.test.ts
// without opening a socket.

export type ListenHostDecision =
  | { ok: true; host: string; warning?: string }
  | { ok: false; refusal: string };

export const DEFAULT_LISTEN_HOST = "127.0.0.1";

/** EXACT loopback names only — not startsWith("127.") (that passes "127.evil.example") and not
 *  the whole 127/8: a wider allowance only widens what a no-login server would accept.
 *  Exported for scripts/ops/preflight.ts, which reports this same decision. */
export function isLoopbackListenHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

export function resolveListenHost(env: Record<string, string | undefined>): ListenHostDecision {
  const host = String(env.SERVER_HOST ?? "").trim() || DEFAULT_LISTEN_HOST;
  // Read AUTH_ENABLED exactly the way auth.ts does, so the two can never disagree about
  // whether a login is required.
  const authOn = String(env.AUTH_ENABLED || "").toLowerCase() === "true";
  if (authOn || isLoopbackListenHost(host)) return { ok: true, host };
  if (String(env.ALLOW_UNAUTHENTICATED_NETWORK ?? "").trim() !== "1") {
    return {
      ok: false,
      refusal:
        `Refusing to start: SERVER_HOST=${host} would let any machine that can reach this port read every customer's data ` +
        `and use the approve and credential endpoints without a login, because AUTH_ENABLED is off. ` +
        `Either set AUTH_ENABLED=true (with ADMIN_EMAIL/ADMIN_PASSWORD), or remove SERVER_HOST so the server listens on ` +
        `this machine only (127.0.0.1). If you really mean to serve it to the network without a login, also set ` +
        `ALLOW_UNAUTHENTICATED_NETWORK=1.`,
    };
  }
  return {
    ok: true,
    host,
    warning:
      `AUTH_ENABLED is off and the server listens on ${host} (ALLOW_UNAUTHENTICATED_NETWORK=1) — anyone who can reach this port ` +
      `has full access to customer data and the approve/credential endpoints. Set AUTH_ENABLED=true (with ADMIN_EMAIL/ADMIN_PASSWORD) ` +
      `before exposing it beyond localhost.`,
  };
}
