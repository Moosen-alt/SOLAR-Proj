// THE DEMO SEEDING TRAP REFUSES WHAT ITS HEADER SAYS IT REFUSES — AND ONLY EXACT LOOPBACK PASSES.
//
// scripts/demo-later-stages.ts claims nothing leaves the machine. Its first trap patched the
// module-level net/http/https/dns/fetch entry points and allowed any host starting "127." —
// so "127.evil.example" passed, and tls.connect, `new http.ClientRequest` and a direct
// `new net.Socket().connect()` were never looked at. The trap now lives in
// scripts/demo-portal/offlineTrap.ts; this drives that module, not a copy.
//
//   MUST REFUSE — each API the header names, aimed at a non-loopback host: throws (or rejects)
//                 AND is counted. Includes the near-misses the old predicate waved through:
//                 127.1.2.3, "127.evil.example", "localhost.evil.example", ::ffff:127.0.0.1.
//   MUST PASS   — a real loopback server on 127.0.0.1 is reachable by http.get, net.connect and
//                 fetch, so the trap does not break the local fixture/IPC these scripts need.
//   GATES       — offlineGatesProblem refuses a code tree lacking either marker and accepts the
//                 repo's own backend/src (which demo-later-stages imports).
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import dns from "node:dns";
import { request as namedRequest } from "node:http";
import { installOfflineTrap } from "../../scripts/demo-portal/offlineTrap";
import { isLoopbackHost } from "../../scripts/demo-portal/network";
import { offlineGatesProblem } from "../../scripts/demo-portal/guards";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. the predicate ------------------------------------------------------------------
for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"]) check(`1. loopback: ${h}`, isLoopbackHost(h));
for (const h of ["127.1.2.3", "127.evil.example", "localhost.evil.example", "::ffff:127.0.0.1", "0.0.0.0", "", "example.invalid", "10.0.0.1"]) {
  check(`1. NOT loopback: ${JSON.stringify(h)}`, !isLoopbackHost(h));
}

// ---- 2. a loopback server, started BEFORE the trap so its listen is not in question ---------
const server = http.createServer((_req, res) => { res.end("ok"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as net.AddressInfo).port;

const trap = installOfflineTrap("offline-trap-test");

// ---- 3. every named API refuses a non-loopback host, and is counted ------------------------
const refusesSync = (label: string, fn: () => unknown): void => {
  const before = trap.attempts.length;
  let threw = false;
  try {
    const r = fn();
    // A socket that did not throw must not be left connecting.
    (r as { destroy?: () => void } | undefined)?.destroy?.();
  } catch { threw = true; }
  check(`3. refuses ${label}`, threw && trap.attempts.length > before, `threw=${threw} counted=${trap.attempts.length - before}`);
};
refusesSync("new net.Socket().connect(443, host)", () => new net.Socket().connect(443, "example.invalid"));
refusesSync("net.Socket().connect({ host }) at 127.1.2.3 (not exact loopback)", () => new net.Socket().connect({ host: "127.1.2.3", port: 9 }));
refusesSync("net.connect to 127.evil.example", () => net.connect(80, "127.evil.example"));
refusesSync("net.createConnection({ host: ::ffff:127.0.0.1 })", () => net.createConnection({ host: "::ffff:127.0.0.1", port: 9 }));
refusesSync("tls.connect({ host })", () => tls.connect({ host: "example.invalid", port: 443 }));
refusesSync("new http.ClientRequest(url)", () => new http.ClientRequest("http://example.invalid/"));
// IP LITERALS need no DNS, so the DNS layer cannot be what stops them — these prove the socket,
// tls and ClientRequest layers themselves. 192.0.2.1 is TEST-NET-1 (RFC 5737): unroutable, so
// even an untrapped attempt goes nowhere.
refusesSync("new net.Socket().connect(443, <IP literal>)", () => new net.Socket().connect(443, "192.0.2.1"));
refusesSync("tls.connect({ host: <IP literal> })", () => tls.connect({ host: "192.0.2.1", port: 443 }));
refusesSync("new http.ClientRequest(<IP literal url>)", () => new http.ClientRequest("http://192.0.2.1/"));
refusesSync("http.request(url)", () => http.request("http://example.invalid/"));
refusesSync("named ESM import { request } from node:http", () => namedRequest("http://example.invalid/"));
refusesSync("dns.lookup", () => dns.lookup("example.invalid", () => {}));
{
  const before = trap.attempts.length;
  const rejected = await dns.promises.lookup("example.invalid").then(() => false, () => true);
  check("3. refuses dns.promises.lookup (rejects, counted)", rejected && trap.attempts.length > before);
}
{
  const before = trap.attempts.length;
  const rejected = await fetch("http://example.invalid/").then(() => false, () => true);
  check("3. refuses fetch (rejects, counted)", rejected && trap.attempts.length > before);
}

// ---- 4. loopback still works -------------------------------------------------------------
{
  const before = trap.attempts.length;
  const body = await new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(b)); }).on("error", reject);
  }).catch((e) => `error: ${(e as Error).message}`);
  check("4. http.get to 127.0.0.1 passes", body === "ok", body);
  const connected = await new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  check("4. net.connect to 127.0.0.1 passes", connected);
  const fetched = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch((e) => `error: ${(e as Error).message}`);
  check("4. fetch to 127.0.0.1 passes", fetched === "ok", fetched);
  check("4. and none of that was counted as an outbound attempt", trap.attempts.length === before, trap.attempts.slice(before).join("; "));
}
server.close();

// ---- 5. the offline-gates check --------------------------------------------------------------
{
  check("5a. the repo's backend/src carries both offline gates", offlineGatesProblem(process.cwd()) === null, String(offlineGatesProblem(process.cwd())));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offline-gates-"));
  fs.mkdirSync(path.join(tmp, "backend", "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "backend", "src", "autopilot.ts"), "if (portalAutomationDisabled()) {}\n");
  fs.writeFileSync(path.join(tmp, "backend", "src", "ahjForms.ts"), "// an older build: no fetch gate\n");
  const p1 = offlineGatesProblem(tmp);
  check("5b. a tree missing documentFetchDisabled is refused, naming it", Boolean(p1 && /documentFetchDisabled/.test(p1)), String(p1));
  fs.writeFileSync(path.join(tmp, "backend", "src", "ahjForms.ts"), "if (documentFetchDisabled()) {}\n");
  fs.writeFileSync(path.join(tmp, "backend", "src", "autopilot.ts"), "// an older build: no portal gate\n");
  const p2 = offlineGatesProblem(tmp);
  check("5c. a tree missing portalAutomationDisabled is refused, naming it", Boolean(p2 && /portalAutomationDisabled/.test(p2)), String(p2));
  fs.writeFileSync(path.join(tmp, "backend", "src", "autopilot.ts"), "if (portalAutomationDisabled()) {}\n");
  check("5d. with both markers present it passes", offlineGatesProblem(tmp) === null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\ndemoOfflineTrap: ${failures} FAILED` : "\ndemoOfflineTrap: all checks passed");
process.exit(failures ? 1 : 0);
