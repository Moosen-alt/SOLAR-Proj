// A NO-LOGIN PAGE WHOSE API NEEDS A LOGIN IS A BLANK PAGE.
//
// server.ts serves three tokenized, no-login HTML pages BEFORE the auth gate (`/intake`,
// `/credentials`, `/status`), and requireAuth then carves out the API each one calls. The
// carve-outs are hand-enumerated, one `if` per path, and `/credentials` never got one:
//
//   app.get("/credentials", …)                    <- line 244, BEFORE the gate. Page loads.
//   app.use(requireAuth(db))                      <- line 247
//   app.post("/api/public/credential-request/…")  <- line ~760, AFTER it. Every fetch 401s.
//
// A customer opens the link we sent, sees the form render, types their portal password into it,
// presses save, and gets an error — having already typed the secret. Masked today only because
// AUTH_ENABLED defaults to false, which means it has never been true in the one configuration a
// client-facing page is actually for.
//
// So this is written as an INVARIANT over the list, not a check for that one path: every public
// page declared below must have BOTH halves open, and adding a fourth page without its API
// carve-out fails here rather than in front of a customer.
//
//   MUST OPEN    — both halves of every public surface, with AUTH_ENABLED=true.
//   MUST GATE    — everything else. A carve-out that opens /api/projects is worse than the bug.
//
//   npx tsx backend/test/publicSurfaceAuth.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-surface-auth-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTH_ENABLED = "true";   // the whole point — the default (false) proves nothing
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const { requireAuth } = await import("../src/auth");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Every no-login surface, as a PAIR. The page is useless without its API and vice versa, so they
// are asserted together — that pairing is what the enumerated `if`s failed to keep.
const PUBLIC_SURFACES = [
  { name: "client intake", page: "/intake", api: "/api/intake/some-token" },
  { name: "portal credential drop box", page: "/credentials", api: "/api/public/credential-request/some-token" },
  { name: "project status", page: "/status", api: "/api/public/status/some-token" },
];

// Anything a logged-out visitor must NOT reach. A carve-out written as a loose prefix is how a
// fix for the above turns into a tenancy hole.
const MUST_STAY_GATED = [
  "/api/projects", "/api/projects/abc", "/api/clients", "/api/customers/abc/communications",
  "/api/portal-credentials", "/api/orgs/abc/users", "/dashboard.html", "/api/public",
];

const gate = requireAuth(db);
/** Run the middleware with no session and report whether it let the request through. */
function allowsAnonymous(p: string): boolean {
  let passed = false;
  const req = { path: p, cookies: {}, headers: {}, get: () => undefined, method: "GET" } as never;
  const res = {
    status() { return this; }, json() { return this; }, redirect() { return this; },
    clearCookie() { return this; }, sendFile() { return this; },
  } as never;
  gate(req, res, () => { passed = true; });
  return passed;
}

check("AUTH_ENABLED really is on, or none of this proves anything", () => {
  // The bug hid behind the default for its whole life. If this assert ever fails, every check
  // below is vacuously green.
  assert.equal(allowsAnonymous("/api/projects"), false,
    "a logged-out request reached /api/projects — AUTH_ENABLED is not actually on in this test");
});

for (const s of PUBLIC_SURFACES) {
  check(`${s.name}: the PAGE opens without a login`, () => {
    assert.equal(allowsAnonymous(s.page), true, `${s.page} redirects a logged-out visitor to /login`);
  });
  check(`${s.name}: ...and so does its API — both halves, or the page is blank`, () => {
    assert.equal(allowsAnonymous(s.api), true,
      `${s.page} renders but ${s.api} returns 401, so the visitor sees a form that cannot save`);
  });
}

check("MUST GATE: everything else still needs a session", () => {
  const leaked = MUST_STAY_GATED.filter((p) => allowsAnonymous(p));
  assert.deepEqual(leaked, [], `a carve-out is too broad and opened: ${JSON.stringify(leaked)}`);
});

check("MUST GATE: the /api/public prefix is NOT open as a blanket", () => {
  // entitlements.ts has an ALWAYS_OPEN_API_PREFIXES list containing "/api/public/", and the
  // comment at server.ts:743 claims the credential routes are exempt "BY THE SAME RULE the
  // intake link uses" — but that blanket rule lives in the ENTITLEMENT gate, not this one.
  // Two gates, one of which has the blanket, is exactly how the asymmetry went unnoticed.
  assert.equal(allowsAnonymous("/api/public/anything-at-all"), false,
    "requireAuth has been given a blanket /api/public/ rule — each public API must be named");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\npublicSurfaceAuth: all checks passed."
  : `\npublicSurfaceAuth: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
