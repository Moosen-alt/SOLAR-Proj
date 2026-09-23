// ---------------------------------------------------------------------------
// A NODE-SIDE OFFLINE TRAP for demo seeding scripts.
//
// Installed before any backend module is imported. Every outbound attempt to a host that is
// not EXACTLY loopback (isLoopbackHost: 127.0.0.1, ::1, localhost) throws — or, for a promise
// API, rejects — and is recorded in `attempts`, so the caller can refuse to report success.
//
// WHAT IT COVERS, precisely:
//   · net.Socket.prototype.connect — the floor under every TCP client in this process:
//     net.connect/createConnection, http/https agents, tls.connect, and undici (global fetch).
//     A pipe / unix-socket path (tsx's own IPC channel, a Windows named pipe) is local and passes.
//   · tls.connect / tls.createConnection, http(s).request / .get, and `new http.ClientRequest`,
//     each checked at the call too, so the attempt is named by the API that made it.
//   · dns.lookup / resolve / resolve4 / resolve6 / resolveAny and their dns.promises forms.
//   · globalThis.fetch (rejects).
//   · syncBuiltinESMExports() afterwards, so `import { request } from "node:http"` hits the trap.
// WHAT IT DOES NOT COVER: UDP (dgram), child processes (a spawned curl is its own process), and
// native addons that open sockets themselves. None of these scripts' code paths use them; the
// claim is limited to the list above.
// ---------------------------------------------------------------------------
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { isLoopbackHost } from "./network";

export interface OfflineTrap {
  /** One entry per refused attempt: "<api> <host>". */
  attempts: string[];
}

let installed: OfflineTrap | null = null;

function hostOfRequestArgs(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") { try { return new URL(first).hostname; } catch { return first; } }
  if (first instanceof URL) return first.hostname;
  if (first && typeof first === "object") {
    const o = first as { hostname?: string | null; host?: string | null };
    const raw = String(o.hostname || o.host || "localhost");
    // "host" may carry a port ("127.0.0.1:4270", "[::1]:4270"); a bare IPv6 literal has no brackets.
    return /^\[.*\]:\d+$/.test(raw) ? raw.replace(/:\d+$/, "") : raw.split(":").length === 2 ? raw.replace(/:\d+$/, "") : raw;
  }
  return "localhost";
}

/** What a Socket.connect / net.connect call is aimed at. Handles (options), (port, host?),
 *  (path) and the normalized [options, cb] array net.connect hands Socket.prototype.connect. */
function connectTarget(args: unknown[]): { pipe: boolean; host: string } {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    const o = first as { path?: string; host?: string | null };
    if (o.path) return { pipe: true, host: "" };
    return { pipe: false, host: String(o.host || "localhost") };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { pipe: true, host: "" };
  return { pipe: false, host: typeof args[1] === "string" && args[1] ? args[1] : "localhost" };
}

export function installOfflineTrap(tag: string): OfflineTrap {
  if (installed) return installed;
  const trap: OfflineTrap = { attempts: [] };
  const refuse = (kind: string, host: string): never => {
    trap.attempts.push(`${kind} ${host}`);
    throw new Error(`[${tag} network trap] outbound ${kind} to ${host} refused — this run is offline.`);
  };

  // TCP floor.
  const socketProto = net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown };
  const realSocketConnect = socketProto.connect;
  socketProto.connect = function (this: unknown, ...args: unknown[]) {
    const t = connectTarget(args);
    if (!t.pipe && !isLoopbackHost(t.host)) refuse("net.Socket.connect", t.host);
    return realSocketConnect.apply(this, args);
  };
  for (const [mod, name] of [[net, "net"], [tls, "tls"]] as Array<[unknown, string]>) {
    const m = mod as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ["connect", "createConnection"]) {
      const real = m[fn];
      if (typeof real !== "function") continue;
      m[fn] = (...args: unknown[]) => {
        const t = connectTarget(args);
        if (!t.pipe && !isLoopbackHost(t.host)) refuse(`${name}.${fn}`, t.host);
        return real.apply(mod, args);
      };
    }
  }

  // HTTP(S).
  for (const [name, mod] of [["http", http], ["https", https]] as const) {
    const m = mod as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ["request", "get"]) {
      const real = m[fn];
      m[fn] = (...args: unknown[]) => {
        const host = hostOfRequestArgs(args);
        if (!isLoopbackHost(host)) refuse(`${name}.${fn}`, host);
        return real.apply(mod, args);
      };
    }
  }
  {
    const RealClientRequest = http.ClientRequest;
    (http as unknown as { ClientRequest: unknown }).ClientRequest = new Proxy(RealClientRequest, {
      construct(target, args, newTarget) {
        const host = hostOfRequestArgs(args);
        if (!isLoopbackHost(host)) refuse("http.ClientRequest", host);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
  }

  // DNS.
  {
    const d = dns as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
      const real = d[fn];
      if (typeof real !== "function") continue;
      d[fn] = (...args: unknown[]) => {
        if (!isLoopbackHost(String(args[0]))) refuse(`dns.${fn}`, String(args[0]));
        return real.apply(dns, args);
      };
    }
    const p = dns.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
      const real = p[fn];
      if (typeof real !== "function") continue;
      // A promise API must REJECT, not throw: callers write `.catch(...)`.
      p[fn] = (...args: unknown[]) => {
        if (!isLoopbackHost(String(args[0]))) {
          try { refuse(`dns.promises.${fn}`, String(args[0])); } catch (err) { return Promise.reject(err); }
        }
        return real.apply(dns.promises, args);
      };
    }
  }

  // fetch.
  if (typeof globalThis.fetch === "function") {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? "");
      let host = "";
      try { host = new URL(url).hostname; } catch { host = url; }
      if (!isLoopbackHost(host)) refuse("fetch", host);
      return realFetch(input as never, init as never);
    }) as typeof fetch;
  }

  syncBuiltinESMExports();
  installed = trap;
  return trap;
}
