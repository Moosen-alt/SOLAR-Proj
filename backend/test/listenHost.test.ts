// THE SERVER LISTENS ON LOOPBACK UNLESS SOMEONE ASKED FOR MORE — AND NEVER SERVES THE NETWORK
// WITHOUT A LOGIN UNLESS ASKED TWICE. (Hard rule 6, issue #82.)
//
// The owner's production install ran with AUTH_ENABLED unset and no SERVER_HOST. server.ts
// defaulted the bind to 0.0.0.0, so every project's homeowner data and the approve/credential
// endpoints answered 200 to anything on a Public-profile network. The only guard was a log line.
// resolveListenHost is now the one bind decision server.ts makes; this pins it:
//
//   default                                 → 127.0.0.1 (auth on or off)
//   SERVER_HOST set                         → honoured exactly
//   auth OFF + non-loopback host            → REFUSED, with a plain-words reason
//   auth OFF + non-loopback + opt-in (=1)   → allowed, with the exposure warning
//   auth ON  + 0.0.0.0                      → allowed (hosted installs set it on purpose)
import assert from "node:assert/strict";
import { resolveListenHost } from "../src/listenHost";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`ok   - ${label}`); }
  catch (e) { failures++; console.log(`FAIL - ${label}\n       ${e instanceof Error ? e.message : String(e)}`); }
};

check("default (auth off, no SERVER_HOST) binds 127.0.0.1", () => {
  const r = resolveListenHost({});
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.host, "127.0.0.1");
  assert.equal(r.ok && r.warning, undefined);
});

check("default with auth on still binds 127.0.0.1 — exposure is opt-in for everyone", () => {
  const r = resolveListenHost({ AUTH_ENABLED: "true" });
  assert.deepEqual(r, { ok: true, host: "127.0.0.1" });
});

check("blank / whitespace SERVER_HOST counts as unset", () => {
  for (const v of ["", "   "]) assert.deepEqual(resolveListenHost({ SERVER_HOST: v }), { ok: true, host: "127.0.0.1" });
});

check("an explicit loopback SERVER_HOST is honoured with auth off", () => {
  for (const h of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
    const r = resolveListenHost({ SERVER_HOST: h, AUTH_ENABLED: "false" });
    assert.deepEqual(r, { ok: true, host: h }, h);
  }
});

check("auth off + SERVER_HOST=0.0.0.0 is REFUSED, naming both ways out", () => {
  const r = resolveListenHost({ SERVER_HOST: "0.0.0.0" });
  assert.equal(r.ok, false);
  const msg = !r.ok ? r.refusal : "";
  assert.match(msg, /0\.0\.0\.0/);
  assert.match(msg, /AUTH_ENABLED=true/);
  assert.match(msg, /ALLOW_UNAUTHENTICATED_NETWORK=1/);
  assert.match(msg, /without a login/i);
});

check("auth off refuses every non-loopback host, including near-misses", () => {
  for (const h of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "127.0.0.2", "127.evil.example", "localhost.evil.example", "[::1]x"]) {
    assert.equal(resolveListenHost({ SERVER_HOST: h, AUTH_ENABLED: "false" }).ok, false, h);
  }
});

check("the opt-in must be exactly 1 — 'true', 'yes', '0' do not count", () => {
  for (const v of ["true", "yes", "0", "", " "]) {
    assert.equal(resolveListenHost({ SERVER_HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED_NETWORK: v }).ok, false, JSON.stringify(v));
  }
});

check("auth off + 0.0.0.0 + ALLOW_UNAUTHENTICATED_NETWORK=1 is allowed, with the exposure warning", () => {
  const r = resolveListenHost({ SERVER_HOST: "0.0.0.0", ALLOW_UNAUTHENTICATED_NETWORK: "1" });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.host, "0.0.0.0");
  assert.match((r.ok && r.warning) || "", /anyone who can reach this port/);
});

check("auth on + SERVER_HOST=0.0.0.0 is allowed with no warning (Fly / Docker / VM installs)", () => {
  for (const auth of ["true", "TRUE", "True"]) {
    assert.deepEqual(resolveListenHost({ SERVER_HOST: "0.0.0.0", AUTH_ENABLED: auth }), { ok: true, host: "0.0.0.0" }, auth);
  }
});

check("AUTH_ENABLED reads the way auth.ts reads it: only 'true' is on", () => {
  for (const auth of ["1", "yes", "on", "false", ""]) {
    assert.equal(resolveListenHost({ SERVER_HOST: "0.0.0.0", AUTH_ENABLED: auth }).ok, false, auth);
  }
});

check("SERVER_HOST is trimmed before it is used", () => {
  assert.deepEqual(resolveListenHost({ SERVER_HOST: "  0.0.0.0 ", AUTH_ENABLED: "true" }), { ok: true, host: "0.0.0.0" });
});

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nlistenHost: all checks passed");
