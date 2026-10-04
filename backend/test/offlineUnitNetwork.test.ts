// UNIT TESTS ARE OFFLINE (#125). _isolate.ts refuses every request that would leave the machine,
// serves the public Oregon BCD 440-5952 blank from its fixture, and lets loopback through.
//
// Before it, staging's form acquisition downloaded the 5952 from www.oregon.gov live, and seven
// suites that stage an Oregon prescriptive job (trackCardRecipe A5, portalTruth, splitIssuer…)
// went red on unrelated PRs whenever the site was slow or blocked the runner.
//
// KILLS: no guard in _isolate -> O1 FAILS (the request goes out); the 5952 not served -> O2 FAILS
// (and those seven suites fail offline); loopback refused -> O3 FAILS (every server-booting suite).
//
//   npx tsx backend/test/offlineUnitNetwork.test.ts
import { REPO } from "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

await check("(O1) a request to a public host is refused, as an outage refuses it — never sent", async () => {
  for (const url of ["https://www.oregon.gov/bcd/Formslibrary/0000.pdf", "https://www.portland.gov/ppd/documents/electrical-renewable-energy-permit-application/download", new URL("https://example.com/")]) {
    await assert.rejects(() => fetch(url), (err: Error) => err instanceof TypeError && /unit tests are offline/.test(err.message), `not refused: ${String(url)}`);
  }
  await assert.rejects(() => fetch(new Request("https://example.com/x")), /unit tests are offline/, "a Request object slipped past");
});

await check("(O2) the public 5952 blank staging needs is served from its committed fixture, for its real URL", async () => {
  const res = await fetch("https://www.oregon.gov/bcd/Formslibrary/5952.pdf");
  assert.equal(res.ok, true);
  assert.match(res.headers.get("content-type") ?? "", /pdf/);
  const got = Buffer.from(await res.arrayBuffer());
  assert.ok(got.equals(fs.readFileSync(path.join(REPO, "backend/test/fixtures/bcd-5952-2024.pdf"))), "served bytes are not the fixture");
});

await check("(O3) MUST-PASS: loopback still reaches the real fetch (suites that boot the server)", async () => {
  const server = http.createServer((_req, res) => { res.end("pong"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "pong");
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "pong");
  } finally { server.close(); }
});

if (failures) { console.error(`\n${failures} offline-unit-network test(s) failed.`); process.exit(1); }
console.log("\nAll offline-unit-network tests passed.");
process.exit(0);
