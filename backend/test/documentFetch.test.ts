// A LADDER THAT CLIMBS ONE RUNG TOO EAGERLY COSTS TWO SECONDS A FETCH; ONE THAT REFUSES TO
// CLIMB COSTS THE DOCUMENT.
//
// fetchPublicDocument exists because coosbayor.gov returns 403 to every programmatic client
// and 200 to a real window. Everything worth testing about it is the DECISION: when to spend
// a browser, when a refusal is final, and when climbing would mean solving a puzzle we are
// not allowed to solve. So this test drives the whole module against a LOCAL http server and
// an INJECTED launcher — no public network, no Chromium. The launcher counts its own calls,
// which is how "a plain 200 never launches a browser" is asserted: not by timing, but by the
// module never having asked.
//
// What it cannot cover, and what must therefore be right by construction, is inside the real
// launcher: the __name shim and the base64 chunking across the page.evaluate boundary. Those
// have no fake.
//
// Browser-free. Run: tsx backend/test/documentFetch.test.ts
import assert from "node:assert/strict";
import http from "node:http";
import type { DocumentBrowserLauncher, DocumentBrowserSession } from "../src/documentFetch";

// The kill switch must not be inherited from the shell, or every escalation check below
// would pass vacuously.
delete process.env.DOCUMENT_FETCH_BROWSER;

const { fetchPublicDocument, findDocumentLinks } = await import("../src/documentFetch");

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   - ${label}`); })
    .catch((err: unknown) => {
      failures++;
      console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
    });

// ---------------------------------------------------------------------------
// The jurisdiction, locally: a real PDF, an Akamai-shaped wall, a CAPTCHA, a stated
// no-robots policy, a document search page, and a plain 404.
// ---------------------------------------------------------------------------
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0xfe, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);

const LISTING_HTML = `<!doctype html><html><body>
  <h1>Find a Document</h1>
  <a href="/home/showpublisheddocument/570/639239531899170000">Fee Schedule - Resolution 26-30</a>
  <a href="/home/showpublisheddocument/999/111222">Dog Licence Application</a>
  <a href="https://mirror.example.gov/fee-schedule.pdf">Fee Schedule (mirror copy)</a>
  <a href="#top">Back to top</a>
  <a href="mailto:clerk@example.gov">Email the clerk</a>
</body></html>`;

const seenPaths: string[] = [];
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  seenPaths.push(url);
  if (url === "/fee.pdf") {
    res.writeHead(200, { "content-type": "application/pdf", server: "nginx" });
    res.end(Buffer.from(PDF_BYTES));
    return;
  }
  if (url === "/walled.pdf" || url === "/still-walled.pdf" || url === "/broken-window.pdf" || url === "/no-display.pdf") {
    // Verbatim Akamai shape: a 403 with a body that explains nothing and names no account.
    res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
    res.end("<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Access Denied. You don't have permission to access \"/walled.pdf\" on this server.<P>Reference #18.7a2c1e.1757000000.9f3b21</BODY></HTML>");
    return;
  }
  if (url === "/walled-listing") {
    res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
    res.end("<html><body>Access Denied<p>Reference #18.aabbcc</p></body></html>");
    return;
  }
  if (url === "/captcha.pdf") {
    res.writeHead(403, { "content-type": "text/html", server: "cloudflare" });
    res.end('<html><body><h1>Verify you are human</h1><div class="cf-turnstile" data-sitekey="x"></div></body></html>');
    return;
  }
  if (url === "/norobots.pdf") {
    res.writeHead(403, { "content-type": "text/html", server: "Apache" });
    res.end("<html><body><h2>Automated access to this site is prohibited.</h2><p>Please contact the City Recorder for copies of public records.</p></body></html>");
    return;
  }
  if (url === "/find-a-document") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LISTING_HTML);
    return;
  }
  if (url === "/find-a-document-cms") {
    // THE SAME PAGE, ON A REAL CMS. /home/showpublisheddocument is CivicPlus — the platform
    // Coos Bay itself runs — and those sites load reCAPTCHA for their own contact and search
    // widgets and print a terms-of-use line in the footer. Both are ordinary furniture on a
    // page that is handing us the document.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LISTING_HTML.replace(
      "</body>",
      '<script src="https://www.google.com/recaptcha/api.js"></script>'
      + "<footer>Use of automated tools to access this site is prohibited without written consent.</footer></body>",
    ));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// The injected browser. Counts everything, so the test can assert not just what came back
// but whether a window was ever opened, in what order it was driven, and that it was closed.
// ---------------------------------------------------------------------------
interface FakeState {
  launches: number;
  closes: number;
  visited: string[];
  fetched: string[];
}
function makeLauncher(cfg: {
  onLaunch?: () => void;
  visit?: (url: string) => { status: number | null; html: string; url?: string };
  fetchInPage?: (url: string) => { status: number; contentType: string; bytes: Uint8Array; url?: string };
}): { launcher: DocumentBrowserLauncher; state: FakeState } {
  const state: FakeState = { launches: 0, closes: 0, visited: [], fetched: [] };
  const launcher: DocumentBrowserLauncher = async (): Promise<DocumentBrowserSession> => {
    state.launches++;
    if (cfg.onLaunch) cfg.onLaunch();
    return {
      async visit(url: string) {
        state.visited.push(url);
        return cfg.visit ? cfg.visit(url) : { status: 200, html: "<html><body>warm</body></html>", url };
      },
      async fetchInPage(url: string) {
        state.fetched.push(url);
        if (!cfg.fetchInPage) throw new Error("the page refused to hand back a body");
        return cfg.fetchInPage(url);
      },
      async close() { state.closes++; },
    };
  };
  return { launcher, state };
}

const grants = (): ReturnType<typeof makeLauncher> => makeLauncher({
  fetchInPage: () => ({ status: 200, contentType: "application/pdf", bytes: PDF_BYTES }),
});

// ---------------------------------------------------------------------------
// Rung one: the cheap one, and the one that must stay cheap.
// ---------------------------------------------------------------------------
await check("a plain 200 comes back via http and NEVER launches a browser", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/fee.pdf`, { launcher });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.via, "http");
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/pdf/);
  assert.deepEqual(Array.from(res.bytes || []), Array.from(PDF_BYTES));
  assert.equal(state.launches, 0, "a browser was launched for a document that was handed over freely");
  assert.ok(res.reason.length > 0, "reason must never be silent, even on success");
});

await check("a 404 is a dead end, not a bot wall — no browser is spent on it", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/missing.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(res.via, "http");
  assert.equal(res.status, 404);
  assert.match(res.reason, /404/);
  assert.equal(state.launches, 0);
});

await check("a dead host reports the network error and does not escalate", async () => {
  const { launcher, state } = grants();
  // Port 1 on loopback: refused immediately, no DNS, no public network.
  const res = await fetchPublicDocument("http://127.0.0.1:1/fee.pdf", { launcher, timeoutMs: 3_000 });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 0, "a real window cannot fix a host that is not answering");
  assert.match(res.reason, /No usable response/i);
});

// ---------------------------------------------------------------------------
// Rung two: the escalation this module exists for.
// ---------------------------------------------------------------------------
await check("a 403 wall escalates to a window, warms the ORIGIN first, and returns the bytes", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/walled.pdf`, { launcher });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.via, "browser");
  assert.equal(res.status, 200);
  assert.equal(state.launches, 1, "exactly one window");
  assert.equal(state.closes, 1, "the window must always be closed");
  assert.deepEqual(state.visited, [base], "the ORIGIN is warmed before the document is asked for — that is where the WAF cookie comes from");
  assert.deepEqual(state.fetched, [`${base}/walled.pdf`]);
  // Bytes must survive intact: a 0x00 / 0xFF pair is what a text round-trip would mangle.
  assert.deepEqual(Array.from(res.bytes || []), Array.from(PDF_BYTES));
  assert.match(res.reason, /403/, "the reason should still name what forced the escalation");
  assert.match(res.reason, /AkamaiGHost/, "the reason should name the server that refused us");
});

await check("the window is closed even when the in-page retrieval throws", async () => {
  const { launcher, state } = makeLauncher({}); // no fetchInPage → throws
  const res = await fetchPublicDocument(`${base}/broken-window.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 1, "a finally that does not run leaks a Chromium per failed fetch");
  assert.match(res.reason, /in-page retrieval failed/i);
});

await check("a browser that cannot start is reported as such, not as the site blocking us", async () => {
  const { launcher, state } = makeLauncher({ onLaunch: () => { throw new Error("Missing X server or $DISPLAY"); } });
  const res = await fetchPublicDocument(`${base}/no-display.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 0, "there was no session to close");
  assert.match(res.reason, /could not start/i);
  assert.match(res.reason, /DISPLAY/);
});

await check("a wall that survives the window ends the ladder — there is no rung above a real browser", async () => {
  const { launcher, state } = makeLauncher({
    fetchInPage: () => ({ status: 403, contentType: "text/html", bytes: new TextEncoder().encode("Access Denied. Reference #18.ff") }),
  });
  const res = await fetchPublicDocument(`${base}/still-walled.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 1, "one escalation, not a loop");
  assert.equal(state.closes, 1);
  assert.match(res.reason, /refused too/i);
});

// ---------------------------------------------------------------------------
// The two refusals we do NOT climb. These are the constraints, not conveniences.
// ---------------------------------------------------------------------------
await check("a CAPTCHA ends it: ok:false, named, and no window is opened at the puzzle", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/captcha.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 0, "escalating INTO a CAPTCHA is the first step toward solving one");
  assert.match(res.reason, /challenge/i);
  assert.match(res.reason, /never solves CAPTCHAs/i);
});

await check("a stated no-robots refusal is honoured, not routed around", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/norobots.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 0, "a headed window here would be a way around a decision, not around a misdetection");
  assert.match(res.reason, /refuses automated clients/i);
  assert.match(res.reason, /stated policy/i);
});

await check("no credential ever goes out: a user:pass@ URL is refused before anything is sent", async () => {
  const before = seenPaths.length;
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`http://operator:hunter2@127.0.0.1:${port}/fee.pdf`, { launcher });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 0);
  assert.equal(seenPaths.length, before, "the request must never leave the process");
  assert.match(res.reason, /never authenticates/i);
});

await check("a non-http scheme is refused", async () => {
  const res = await fetchPublicDocument("file:///C:/Users/isobl/secrets.txt", {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /only speaks http/i);
});

await check("the browser rung can be switched off, and says so", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/walled.pdf`, { launcher, allowBrowser: false });
  assert.equal(res.ok, false);
  assert.equal(state.launches, 0);
  assert.match(res.reason, /switched off/i);
});

// ---------------------------------------------------------------------------
// findDocumentLinks — what turns a document search into a fee schedule.
// ---------------------------------------------------------------------------
await check("findDocumentLinks filters, resolves relative hrefs absolutely, and drops junk", async () => {
  const { launcher, state } = grants();
  const links = await findDocumentLinks(`${base}/find-a-document`, { launcher }, (l) => /fee schedule/i.test(l.text));
  assert.equal(state.launches, 0, "the listing answered on rung one");
  assert.equal(links.length, 2, JSON.stringify(links));
  assert.equal(links[0].text, "Fee Schedule - Resolution 26-30");
  assert.equal(links[0].href, `${base}/home/showpublisheddocument/570/639239531899170000`);
  assert.equal(links[1].href, "https://mirror.example.gov/fee-schedule.pdf");
  assert.ok(!links.some((l) => /Dog Licence/i.test(l.text)), "the predicate must actually exclude");
});

await check("findDocumentLinks never returns anchors, mailto or javascript links", async () => {
  const { launcher } = grants();
  const links = await findDocumentLinks(`${base}/find-a-document`, { launcher });
  assert.equal(links.length, 3, JSON.stringify(links));
  assert.ok(!links.some((l) => /^mailto:|#top/.test(l.href)), JSON.stringify(links));
});

// A FILTER LIST FAILS BOTH WAYS. Every check above proves the classifier REFUSES the right
// pages; this one proves it lets the right pages through. A reCAPTCHA widget in the page
// furniture is not a wall in front of the page, and reading it as one would refuse the exact
// document search this module was built to read — with a reason ("challenge page") the
// researcher would then honestly pass on as fact.
await check("a widget on the page is not a wall in front of it", async () => {
  const { launcher, state } = grants();
  const res = await fetchPublicDocument(`${base}/find-a-document-cms`, { launcher });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.via, "http");
  assert.equal(state.launches, 0);
  const links = await findDocumentLinks(`${base}/find-a-document-cms`, { launcher }, (l) => /fee schedule/i.test(l.text));
  assert.equal(links.length, 2, JSON.stringify(links));
  assert.equal(links[0].href, `${base}/home/showpublisheddocument/570/639239531899170000`);
});

await check("a walled listing escalates too, and the links come from the RENDERED page", async () => {
  const { launcher, state } = makeLauncher({
    // A page the WAF let through only in a real window — and whose listing is written by
    // script, so the rendered DOM is the only place the anchor exists.
    visit: (url) => ({ status: 200, html: LISTING_HTML, url }),
  });
  const links = await findDocumentLinks(`${base}/walled-listing`, { launcher }, (l) => /fee schedule/i.test(l.text));
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 1);
  assert.equal(state.fetched.length, 0, "rendered mode reads the page, it does not re-fetch the bytes");
  assert.equal(links.length, 2, JSON.stringify(links));
  assert.equal(links[0].href, `${base}/home/showpublisheddocument/570/639239531899170000`);
});

await check("findDocumentLinks returns nothing rather than throwing when the page never arrives", async () => {
  const { launcher } = grants();
  const links = await findDocumentLinks(`${base}/captcha.pdf`, { launcher });
  assert.deepEqual(links, []);
});

await new Promise<void>((resolve) => server.close(() => resolve()));

if (failures) { console.error(`\n${failures} document-fetch check(s) FAILED.`); process.exit(1); }
console.log("\nAll document-fetch checks passed.");
process.exit(0);
