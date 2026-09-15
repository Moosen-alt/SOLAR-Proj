// THE MARKUP IS A CONTRACT WITH THE SCRIPT, AND NOTHING WAS CHECKING IT.
//
// parser.html is one 250KB file: ~500 lines of markup followed by 4,300 lines of script that
// reaches into it by id, 161 times. Three of those reaches are UNGUARDED and run at load:
//
//     $('parseBtn').addEventListener('click', ...)
//     $('resetBtn').addEventListener('click', resetAll)
//     $('downloadJsonBtn').addEventListener('click', ...)
//
// Delete or rename one id in the markup and `$(id)` returns null, the listener line throws, the
// rest of the top-level script never runs, and EVERY control on the page is dead — with nothing
// on screen to say so. The page still renders perfectly. That is the failure mode a design pass
// is most likely to cause and least likely to notice, and it is why this file exists.
//
// It also pins the three CLASS MODIFIERS the script toggles by name. Renaming `.progress-wrap`
// to something prettier while leaving `wrap.classList.add('active')` in the script produces a
// parse run with no visible progress and no error anywhere.
//
//   MUST PASS — every id the parser's inline script addresses resolves in the live DOM.
//   MUST PASS — every id review.js addresses resolves in review.html's live DOM.
//   MUST PASS — every page in the intake/tools set loads with zero uncaught page errors.
//   MUST PASS — `active`, `indeterminate` and the scope-card `red/yellow/green` modifiers each
//               still CHANGE a rendered style; a class with no rule left is a silent no-op.
//   MUST PASS — every page links the shared stylesheet, so none of them can drift back to a
//               private palette the way parser.html had.
//
// Runs headless with a throwaway static server; no backend, no database, no network (external
// CDN scripts are aborted at the route level so the run is hermetic and fast — the parser's own
// `if (window.pdfjsLib)` guard is what makes that safe).
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/pageContract.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
// playwright is a devDependency of the repo root, same as every other dom smoke.
const { chromium } = require("playwright");

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------------------------------------
// The ids a page's script actually reaches for.
//
// Deliberately a source scan and not a hand-maintained list: a hand list is exactly the drift
// this suite keeps paying for. Every accessor the two files use is covered —
// $('x'), getElementById('x'/"x"), setVal('x', …), getVal('x').
//
// NOT covered here, because it is not id-based: closest() / matches(). Both scripts use one
// (`e.target.closest('button')` in parser.html, `closest("button[data-mode]")` in
// form-filler.html) and both select by TAG and ATTRIBUTE — which is exactly why renaming this
// page's CSS classes was safe. A class-based closest('.some-class') would slip past every check
// in this file, so the delegated copy button is clicked for real at the end of the class
// section; extend THAT if a class-based selector is ever introduced.
// ---------------------------------------------------------------------------------------------
const ACCESSOR = /(?:\$|getElementById|setVal|getVal)\(\s*(['"])([A-Za-z0-9_]+)\1/g;

const idsAddressedBy = (source: string): string[] => {
  const out = new Set<string>();
  for (const m of source.matchAll(ACCESSOR)) out.add(m[2]);
  return [...out].sort();
};

/**
 * Ids a script names for an element that is NOT in the markup, each with the reason a human
 * needs in order to agree. Listed rather than quietly filtered, the same way
 * scripts/run-dom-smokes.ts lists its exclusions: a suppression you cannot see is
 * indistinguishable from a check that stopped running.
 *
 * An entry here is only safe while the id is reached through a GUARDED accessor. `setVal`/
 * `getVal` both do `const el = $(id); if (el) …`, so a dangling id is a no-op. `$('x').foo` is
 * not guarded and would throw — so each entry is also asserted to have no direct dereference
 * anywhere in its source. That assertion is what stops this list from becoming a place to hide
 * a real break.
 */
const KNOWN_DANGLING = new Map<string, string>([
  ["criticalWarnings", "pre-existing: the 'critical warnings' textarea was removed from the page " +
    "before this design pass; the one write left is setVal(), which no-ops on a missing element"],
]);

/** `$('id').something` or `$('id')!.something` — an unguarded dereference that WOULD throw. */
const dereferencedDirectly = (source: string, id: string): boolean =>
  new RegExp(`\\$\\(\\s*(['"])${id}\\1\\s*\\)\\s*[.\\[]`).test(source);

const read = (rel: string): string => fs.readFileSync(path.join(FRONTEND, rel), "utf8");

// The inline <script> of an HTML page, so the markup's own `id="..."` attributes are not
// mistaken for accessors.
const inlineScriptOf = (html: string): string => {
  const open = html.indexOf("<script>");
  return open < 0 ? "" : html.slice(open);
};

// ---------------------------------------------------------------------------------------------
// A throwaway server: real files from frontend/, and an empty JSON object for any /api/ call so
// the pages' load-time fetches resolve instead of hanging.
// ---------------------------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * The EMPTY form of each envelope these pages fetch at load, matching what backend/src/server.ts
 * actually returns. An earlier draft answered every /api/ call with `{}` and review.js threw on
 * `workTypes.map` — a failure invented by the stub, not by the page. A stub that hands the
 * script a shape the server never produces reports defects that do not exist, which is how a
 * suite teaches people to ignore it.
 */
const API_STUBS: Array<[RegExp, string]> = [
  [/^\/api\/review\/work-types$/, '{"workTypes":[]}'],
  [/^\/api\/review\/submissions$/, '{"submissions":[]}'],
  [/^\/api\/code-profiles$/, '{"profiles":[]}'],
  [/^\/api\/code-profiles\/resolve/, '{"profile":null}'],
  [/^\/api\/projects/, '{"projects":[]}'],
  [/^\/api\/clients/, '{"clients":[]}'],
];

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const hit = API_STUBS.find(([re]) => re.test(url.pathname));
      if (!hit) {
        // Not a 200-with-nonsense: an unstubbed endpoint answers the way the real server
        // answers an unknown one, so the page takes its own error path instead of a fake one.
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not stubbed"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(hit[1]);
      return;
    }
    // "/parser" -> parser.html, mirroring the express routes in backend/src/server.ts.
    const name = url.pathname === "/" ? "dashboard.html" : url.pathname.replace(/^\/+/, "");
    const candidates = [name, `${name}.html`];
    for (const c of candidates) {
      const file = path.join(FRONTEND, c);
      // Never serve outside frontend/, even in a test.
      if (!file.startsWith(FRONTEND)) break;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(fs.readFileSync(file));
        return;
      }
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// Pages that make up the intake path and the standalone tools. Every one of them must boot.
const PAGES = [
  { route: "/parser", file: "parser.html" },
  { route: "/review", file: "review.html" },
  { route: "/new-project", file: "new-project.html" },
  { route: "/fill-form", file: "fill-form.html" },
  { route: "/form-filler", file: "form-filler.html" },
  { route: "/credentials", file: "credentials.html" },
];

async function main(): Promise<void> {
  const { base, close } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  try {
    // -----------------------------------------------------------------------------------------
    console.log("\nEVERY PAGE BOOTS, AND EVERY PAGE SHARES THE ONE STYLESHEET");
    // -----------------------------------------------------------------------------------------
    for (const p of PAGES) {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      // Hermetic: the five CDN libraries are not part of this contract, and a slow or absent
      // CDN must not decide whether the suite is green.
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(`${base}${p.route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(600);

      check(errors.length === 0, `${p.file} loads with no uncaught error`, errors.join(" | "));

      const linksShared = await page.evaluate(() =>
        Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) =>
          (l as HTMLLinkElement).getAttribute("href") === "/styles.css"));
      check(linksShared, `${p.file} links /styles.css`, "a page with a private palette is how parser.html drifted");

      // The typeface is half of what makes these read as one product with the marketing
      // site, and losing it is silent: the page renders in Segoe UI and nothing complains.
      // backend/test/frontendDesignSystem.dom.smoke.ts checks that styles.css DECLARES the
      // vendored face; this checks that the page actually GETS it — the failure where a
      // page's own body rule shadows --font-sans, or the .woff2 stops being served.
      const font = await page.evaluate(async () => {
        await (document as Document & { fonts: FontFaceSet }).fonts.ready;
        return {
          family: getComputedStyle(document.body).fontFamily,
          loaded: (document as Document & { fonts: FontFaceSet }).fonts.check('600 16px "Manrope"'),
        };
      });
      check(/Manrope/i.test(font.family) && font.loaded,
        `${p.file} actually renders in Manrope`, `body font-family = ${font.family}, face loaded = ${font.loaded}`);
      await page.close();
    }

    // -----------------------------------------------------------------------------------------
    console.log("\nTHE ID CONTRACT — every id the script reaches for exists in the markup");
    // -----------------------------------------------------------------------------------------
    // `floor` is the count measured the day this smoke was written, minus a little slack. It is
    // the DENOMINATOR: without it, a regex that silently stopped matching would report "all 0
    // addressed ids resolve" and read as green.
    const parserSource = inlineScriptOf(read("parser.html"));
    const reviewSource = read("review.js");
    const contracts = [
      { route: "/parser", label: "parser.html inline script", source: parserSource, floor: 120, ids: idsAddressedBy(parserSource) },
      { route: "/review", label: "review.js", source: reviewSource, floor: 34, ids: idsAddressedBy(reviewSource) },
    ];

    for (const c of contracts) {
      const page = await ctx.newPage();
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(`${base}${c.route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(600);

      const missingAll: string[] = await page.evaluate(
        (ids: string[]) => ids.filter((id) => !document.getElementById(id)),
        c.ids,
      );
      const missing = missingAll.filter((id) => !KNOWN_DANGLING.has(id));
      const excused = missingAll.filter((id) => KNOWN_DANGLING.has(id));

      check(c.ids.length >= c.floor, `${c.label}: found ${c.ids.length} addressed ids to check (floor ${c.floor})`,
        "the accessor scan matched far fewer ids than it did when this was written, so the " +
        "result below proves much less than it appears to");
      check(missing.length === 0, `${c.label}: all ${c.ids.length} addressed ids resolve`,
        missing.length ? `MISSING FROM MARKUP: ${missing.join(", ")}` : "");

      // An excused id is only excused while nothing dereferences it directly.
      for (const id of excused) {
        console.log(`  note  ${c.label}: '${id}' absent by known exception — ${KNOWN_DANGLING.get(id)}`);
        check(!dereferencedDirectly(c.source, id), `${c.label}: '${id}' is never dereferenced unguarded`,
          "it is on the known-dangling list but the source now does $('id').something, which throws");
      }
      await page.close();
    }

    // -----------------------------------------------------------------------------------------
    console.log("\nTHE CLASS CONTRACT — the modifiers the script toggles still change something");
    // -----------------------------------------------------------------------------------------
    {
      const page = await ctx.newPage();
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(`${base}/parser`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(600);

      // setProgress() calls wrap.classList.add('active') — if the rule went away, a parse run
      // shows no progress at all and throws nothing.
      const progress = await page.evaluate(() => {
        const wrap = document.getElementById("progressWrap")!;
        const bar = document.getElementById("progressBar")!;
        const before = getComputedStyle(wrap).display;
        wrap.classList.add("active");
        const after = getComputedStyle(wrap).display;
        const barBefore = getComputedStyle(bar).animationName;
        bar.classList.add("indeterminate");
        const barAfter = getComputedStyle(bar).animationName;
        return { before, after, barBefore, barAfter };
      });
      check(progress.before === "none" && progress.after !== "none",
        "progress wrap: .active reveals it", `display ${progress.before} -> ${progress.after}`);
      check(progress.barAfter !== progress.barBefore && progress.barAfter !== "none",
        "progress bar: .indeterminate starts the animation", `animation ${progress.barBefore} -> ${progress.barAfter}`);

      // updateElectricalScopeUi() adds red|yellow|green to the scope cards. The panel is
      // display:none by design (this service does not do the electrical work), so the card is
      // measured on a clone that is visible — the RULE is what is under test, not the panel.
      const scope = await page.evaluate(() => {
        const card = document.getElementById("electricalScopeTypeCard")!.cloneNode(true) as HTMLElement;
        document.body.appendChild(card);
        const base_ = getComputedStyle(card).borderLeftColor;
        const seen: Record<string, string> = {};
        for (const mode of ["red", "yellow", "green"]) {
          card.classList.remove("red", "yellow", "green");
          card.classList.add(mode);
          seen[mode] = getComputedStyle(card).borderLeftColor;
        }
        card.remove();
        return { base_, seen };
      });
      for (const mode of ["red", "yellow", "green"]) {
        check(scope.seen[mode] !== scope.base_,
          `scope card: .${mode} changes the card`, `still ${scope.seen[mode]}`);
      }

      // THE DELEGATED HANDLER, exercised rather than reasoned about. The copy buttons are
      // reached by `document.addEventListener('click', e => e.target.closest('button'))` and
      // keyed by `data-copy`. Neither is an id, so the id contract above says nothing about
      // them: wrap one in a <span>, or drop data-copy while restyling, and every copy button on
      // the page goes quiet with no error. Clicking one and watching the label is the only
      // check that covers it. (writeText is not awaited by the handler, so the label flips even
      // where the headless clipboard is unavailable — the label IS the observable contract.)
      const copy = await page.evaluate(`(() => {
        const btn = document.querySelector('[data-copy]');
        if (!btn) return { found: false, before: '', after: '' };
        const before = btn.textContent;
        btn.closest('details').open = true;
        btn.click();
        return { found: true, before, after: btn.textContent };
      })()`) as { found: boolean; before: string; after: string };
      check(copy.found, "a [data-copy] button still exists in the markup");
      check(copy.found && copy.after === "Copied",
        "copy button: the delegated click handler still reaches it",
        `label went "${copy.before}" -> "${copy.after}" (expected "Copied")`);
      await page.close();
    }
  } finally {
    await browser.close();
    await close();
  }

  console.log("");
  if (failures.length) {
    console.log(`PAGE CONTRACT: ${failures.length} FAILURE(S)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PAGE CONTRACT: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
