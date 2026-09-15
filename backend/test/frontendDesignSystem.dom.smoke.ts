// THE DESIGN SYSTEM HAS NO ERROR CHANNEL — SO THIS IS IT.
//
// Two whole classes of frontend regression in this repo fail SILENTLY. Nothing throws, no test
// goes red, the page just quietly renders wrong, and the operator is the error channel:
//
//   1. A CUSTOM PROPERTY THAT DOES NOT RESOLVE. `background: var(--tint-pass)` with --tint-pass
//      undefined does not error — it computes to `unset`, i.e. TRANSPARENT. This is not
//      hypothetical: it happened while this file was being written. A comment line reading
//
//          Dark mode already redefined --tint-*<slash>--edge-* below; ...
//
//      closed its own comment at the `*` `/` inside "--tint-*/--edge-*". The parser then read the
//      rest of the comment as declarations and swallowed everything up to the next `;` — which
//      was the end of the `--tint-pass:` line. Result: --tint-pass computed to "", and every
//      passing check row, PASS badge, positive chip, handoff banner, "track" stage tag and
//      submit-gate check painted transparent. The stylesheet parsed. Nothing complained.
//      styles.css already documented SEVEN tokens that had been dangling the same way.
//
//   2. A NAV EDIT THAT BREAKS dashboard.js. The router binds EVERY `.page-tab` to
//      `navigate("#/" + tab.dataset.page)` and highlights by `dataset.page`, and it dismisses the
//      header menu with `document.querySelector(".topbar-more")` — SINGULAR. So a nav link that
//      borrows `class="page-tab"` routes to `#/undefined` and follows its href as well, and a
//      second <details class="topbar-more"> never closes. Both are markup-only mistakes that no
//      typecheck and no unit test can see.
//
// This smoke is self-contained on purpose: it reads the REAL frontend/styles.css and the REAL
// frontend/dashboard.html off disk, so it is testing the shipped files and not a copy — but it
// needs no server, no database and no credentials, which is what lets it live in the dom-smoke
// suite and run on every verify.
//
//   npx tsx backend/test/frontendDesignSystem.dom.smoke.ts
//
// Each section ends with a KILL TEST that re-introduces the exact defect and asserts the check
// goes red. Without those, a green run proves only that the check ran.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRONTEND = path.join(REPO_ROOT, "frontend");
const CSS_PATH = path.join(FRONTEND, "styles.css");
const HTML_PATH = path.join(FRONTEND, "dashboard.html");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  }
};

const css = fs.readFileSync(CSS_PATH, "utf8");
const html = fs.readFileSync(HTML_PATH, "utf8");

/**
 * Names DECLARED on a rule of this stylesheet, matched as `  --name:` at a two-space indent.
 * Deliberately not a match on every `--name` in the file: that would also pick up the ones
 * mentioned inside var() calls and inside prose comments, and a token that is only ever READ is
 * a different (also real, but separately handled) problem from one that is declared and lost.
 */
const declaredTokens = Array.from(
  new Set(Array.from(css.matchAll(/^ {2}(--[a-z0-9-]+)\s*:/gim)).map((m) => m[1])),
).sort();

/** Status classes that MUST paint a real fill. A transparent one is the silent failure. */
const MUST_PAINT = [
  "check-row present", "check-row missing", "check-row needs_review", "check-row external",
  "item pass", "item info", "item warning", "item blocker",
  "badge badge-pass", "badge badge-fail", "badge badge-warning", "badge badge-info",
  "chip", "chip positive", "chip warning", "chip danger", "chip neutral",
  "card-hairline", "recommended-action", "band band--dark", "band band--green", "band band--muted",
];

/** The six pipeline stages. They are an IDENTITY vocabulary, not a pass/warn/fail one. */
const STAGE_TAGS = ["stage-intake", "stage-qc", "stage-build", "stage-submit", "stage-track", "stage-closeout"];

const TRANSPARENT = "rgba(0, 0, 0, 0)";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// The esbuild keepNames transform tsx applies wraps nameable functions as __name(fn), and a raw
// page has no such global — so any helper declared inside page.evaluate throws ReferenceError,
// which a .catch() would quietly turn into "found nothing". Same shim every other dom smoke uses.
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// =================================================================================================
// 1) EVERY DECLARED TOKEN RESOLVES
// =================================================================================================
console.log("\n[1] every custom property declared in styles.css resolves to a value");
const cssPage = await ctx.newPage();
await cssPage.setContent("<html><body></body></html>");
await cssPage.addStyleTag({ content: css });

type Probe = { empty: string[]; paints: Record<string, string>; stages: Record<string, string> };
const readAll = async (page: any): Promise<Probe> =>
  page.evaluate(
    ([names, paintClasses, stages]: [string[], string[], string[]]) => {
      const cs = getComputedStyle(document.documentElement);
      const empty = names.filter((n) => !cs.getPropertyValue(n).trim());
      const measure = (cls: string): string => {
        const d = document.createElement("div");
        d.className = cls;
        d.textContent = "probe";
        document.body.appendChild(d);
        const bg = getComputedStyle(d).backgroundColor;
        d.remove();
        return bg;
      };
      const paints: Record<string, string> = {};
      for (const c of paintClasses) paints[c] = measure(c);
      const stageBg: Record<string, string> = {};
      for (const s of stages) stageBg[s] = measure(`stage-tag ${s}`);
      return { empty, paints, stageBg };
    },
    [declaredTokens, MUST_PAINT, STAGE_TAGS],
  ).then((r: any) => ({ empty: r.empty, paints: r.paints, stages: r.stageBg }));

const base = await readAll(cssPage);
check(
  `all ${declaredTokens.length} declared custom properties resolve`,
  base.empty.length === 0,
  `unresolvable: ${base.empty.join(", ")} — a var() reading one of these paints TRANSPARENT, silently`,
);

// =================================================================================================
// 2) EVERY STATUS SURFACE PAINTS
// =================================================================================================
console.log("\n[2] every status / component surface paints a real fill");
const unpainted = Object.entries(base.paints).filter(([, bg]) => bg === TRANSPARENT).map(([c]) => c);
check(
  `${MUST_PAINT.length} status and component classes all paint`,
  unpainted.length === 0,
  `transparent: ${unpainted.join(", ")}`,
);

// =================================================================================================
// 3) SIX STAGES, SIX COLOURS
// =================================================================================================
// A sweep that replaced the old pastel literals with the four-value status family collapsed
// intake+QC to one blue, build+submit to one amber and track+closeout to one green — halving a
// distinction the operator reads the board by. Six classes, six distinct fills, pinned.
console.log("\n[3] the six pipeline stage tags are six DISTINCT colours");
const stageValues = STAGE_TAGS.map((s) => base.stages[s]);
check(
  "stage-intake / qc / build / submit / track / closeout are six different fills",
  new Set(stageValues).size === STAGE_TAGS.length,
  STAGE_TAGS.map((s, i) => `${s}=${stageValues[i]}`).join("  "),
);

// =================================================================================================
// 3b) THE SAME THREE GUARANTEES UNDER <html data-theme="dark">
// =================================================================================================
// Dark is opt-in and not shipped on, which is exactly why it rots unwatched — and a theme must
// never change HOW MANY THINGS the operator can tell apart. The dark block used to give
// stage-track and stage-closeout one shared rule, i.e. the same six-into-three collapse check [3]
// exists to prevent, present in one theme and absent in the other.
console.log("\n[3b] the same guarantees hold with data-theme=\"dark\"");
const darkPage = await ctx.newPage();
await darkPage.setContent('<html data-theme="dark"><body></body></html>');
await darkPage.addStyleTag({ content: css });
const dark = await readAll(darkPage);
check("all declared custom properties resolve in dark too", dark.empty.length === 0, `unresolvable: ${dark.empty.join(", ")}`);
const darkUnpainted = Object.entries(dark.paints).filter(([, bg]) => bg === TRANSPARENT).map(([c]) => c);
check("every status / component class paints in dark too", darkUnpainted.length === 0, `transparent: ${darkUnpainted.join(", ")}`);
check(
  "the six stage tags are still six distinct fills in dark",
  new Set(STAGE_TAGS.map((s) => dark.stages[s])).size === STAGE_TAGS.length,
  STAGE_TAGS.map((s) => `${s}=${dark.stages[s]}`).join("  "),
);
await darkPage.close();

// =================================================================================================
// 4) MANROPE IS VENDORED, NOT FETCHED
// =================================================================================================
console.log("\n[4] Manrope is served from frontend/vendor, and every page gets it");
const faceUrls = Array.from(css.matchAll(/@font-face[\s\S]*?src:\s*url\("([^"]+)"\)/g)).map((m) => m[1]);
check("styles.css declares at least one @font-face for the brand typeface", faceUrls.length > 0);
for (const u of faceUrls) {
  const onDisk = path.join(FRONTEND, u.replace(/^\//, ""));
  check(`${u} exists on disk (no CDN dependency)`, fs.existsSync(onDisk), `looked for ${onDisk}`);
}
check(
  "no page in frontend/ still pulls the typeface from fonts.googleapis.com in a way styles.css " +
    "cannot reach — login.html in particular",
  !fs.readFileSync(path.join(FRONTEND, "login.html"), "utf8").includes("fonts.googleapis.com"),
);

// =================================================================================================
// 5) THE STICKY OFFSET IS A TOKEN, NOT A REPEATED LITERAL
// =================================================================================================
// .step-actions sticks directly beneath the sticky header. That offset used to be the literal
// "61px" written into one rule and restated in three comments, so any header change left a gap or
// an overlap that only a screenshot would reveal.
console.log("\n[5] .step-actions' sticky offset tracks the header height token");
const offsets = await cssPage.evaluate(() => {
  const el = document.createElement("div");
  el.className = "step-actions";
  document.body.appendChild(el);
  const top = getComputedStyle(el).top;
  el.remove();
  return { top, token: getComputedStyle(document.documentElement).getPropertyValue("--topbar-h").trim() };
});
check(
  "top === var(--topbar-h)",
  offsets.top === offsets.token && offsets.token !== "",
  `top=${offsets.top} --topbar-h=${offsets.token}`,
);

// =================================================================================================
// 6) THE NAV CONTRACT WITH dashboard.js
// =================================================================================================
console.log("\n[6] dashboard.html's header keeps the contract dashboard.js relies on");
const navPage = await ctx.newPage();
await navPage.setContent(html, { waitUntil: "domcontentloaded" });

const VALID_PAGES = ["dashboard", "projects", "team"]; // "project" is deep-link only, not a tab
const REQUIRED_IDS = [
  "serviceStatus", "refreshBtn", "notifBadgeBtn", "notifBadge",
  "runPermitMonitorBtn", "runNemMonitorBtn",
  "openCustomersBtn", "openClientsBtn", "openUsersBtn", "openKpiBtn", "openKnowledgeBtn",
  "startHereGuide", "listPageTitle", "projectCount", "listFilters",
  "pageList", "pageProject", "projectBoard", "projectTableWrap", "pageTeam",
];

const readNav = async (page: any): Promise<any> =>
  page.evaluate((ids: string[]) => ({
    tabPages: Array.from(document.querySelectorAll(".page-tab")).map((t) => (t as HTMLElement).dataset.page ?? null),
    pageLinksBorrowingTabClass: Array.from(document.querySelectorAll(".page-link"))
      .filter((l) => l.classList.contains("page-tab") || (l as HTMLElement).dataset.page !== undefined)
      .map((l) => (l.textContent || "").trim()),
    topbarMoreCount: document.querySelectorAll(".topbar-more").length,
    headerNavCount: document.querySelectorAll("header.topbar nav").length,
    missingIds: ids.filter((i) => !document.getElementById(i)),
    projectCountParent: document.getElementById("projectCount")?.parentElement?.tagName ?? null,
    notifInlineHidden: (document.getElementById("notifBadgeBtn") as HTMLElement | null)?.style.display === "none",
    reviewLinksInHeader: Array.from(document.querySelectorAll('header.topbar a[href="/review"]')).length,
  }), REQUIRED_IDS);

const nav = await readNav(navPage);
check(
  "every .page-tab carries a data-page the router knows",
  nav.tabPages.length > 0 && nav.tabPages.every((p: string | null) => p !== null && VALID_PAGES.includes(p)),
  `tab data-page values: ${JSON.stringify(nav.tabPages)}`,
);
check(
  "no .page-link borrows .page-tab or a data-page (it would route to #/undefined AND follow href)",
  nav.pageLinksBorrowingTabClass.length === 0,
  `offenders: ${nav.pageLinksBorrowingTabClass.join(", ")}`,
);
check(
  "exactly ONE <details class=topbar-more> — dashboard.js dismisses by querySelector, singular",
  nav.topbarMoreCount === 1,
  `found ${nav.topbarMoreCount}`,
);
check("ONE navigation in the header, not three stacked rows", nav.headerNavCount === 1, `found ${nav.headerNavCount}`);
check("every id dashboard.js binds still exists", nav.missingIds.length === 0, `missing: ${nav.missingIds.join(", ")}`);
check(
  "#projectCount still has a parent element (showPage hides projectCount.parentElement on Team)",
  nav.projectCountParent !== null,
  `parent=${nav.projectCountParent}`,
);
check(
  "the notification bell keeps its INLINE display:none (bumpNotifBadge reveals it with style.display='')",
  nav.notifInlineHidden === true,
);
check(
  'the plan review gate is not a top-level destination — no header link to "/review"',
  nav.reviewLinksInHeader === 0,
  `found ${nav.reviewLinksInHeader}`,
);

// =================================================================================================
// 7) KILL TESTS — re-introduce each defect and require the check to go red
// =================================================================================================
console.log("\n[7] kill tests: put each defect back and confirm the checks above catch it");

// 7a. The comment that closes itself. This is the literal shape of the real bug.
const brokenCss = css.replace(
  "  --tint-pass:",
  "  /* a comment mentioning --tint-*/--edge-* families */\n  --tint-pass:",
);
const killPage = await ctx.newPage();
await killPage.setContent("<html><body></body></html>");
await killPage.addStyleTag({ content: brokenCss });
const killed = await readAll(killPage);
check(
  "with the self-closing comment restored, --tint-pass is unresolvable again",
  killed.empty.includes("--tint-pass"),
  `empty=${JSON.stringify(killed.empty)} — if this is green, check [1] proves nothing`,
);
check(
  "...and the passing check row really does paint transparent, which is the invisible symptom",
  killed.paints["check-row present"] === TRANSPARENT,
  `check-row present bg=${killed.paints["check-row present"]} — if this is not transparent, check [2] proves nothing`,
);
await killPage.close();

// 7b. Stage tags collapsed onto the shared status tints — the sweep's regression.
const collapsedCss = `${css}\n.stage-tag.stage-intake, .stage-tag.stage-qc { background: var(--tint-info); }\n.stage-tag.stage-build, .stage-tag.stage-submit { background: var(--tint-warn); }\n.stage-tag.stage-track, .stage-tag.stage-closeout { background: var(--tint-pass); }\n`;
const killStage = await ctx.newPage();
await killStage.setContent("<html><body></body></html>");
await killStage.addStyleTag({ content: collapsedCss });
const killedStage = await readAll(killStage);
check(
  "with the six stage hues collapsed onto three status tints, check [3] goes red",
  new Set(STAGE_TAGS.map((s) => killedStage.stages[s])).size < STAGE_TAGS.length,
  "if this is green, check [3] proves nothing",
);
await killStage.close();

// 7c. A nav link that borrows .page-tab, and a second topbar menu.
const brokenHtml = html
  .replace('<a class="page-link" href="/parser">', '<a class="page-link page-tab" href="/parser">')
  .replace("</header>", '<details class="topbar-more"><summary>x</summary><div class="topbar-more-menu"></div></details></header>');
const killNav = await ctx.newPage();
await killNav.setContent(brokenHtml, { waitUntil: "domcontentloaded" });
const killedNav = await readNav(killNav);
check(
  "with Parser borrowing .page-tab, the data-page check goes red",
  !(killedNav.tabPages.every((p: string | null) => p !== null && VALID_PAGES.includes(p))),
  `tabPages=${JSON.stringify(killedNav.tabPages)} — if green, the nav check proves nothing`,
);
check(
  "...and the .page-link check names it",
  killedNav.pageLinksBorrowingTabClass.length > 0,
  `offenders=${JSON.stringify(killedNav.pageLinksBorrowingTabClass)}`,
);
check(
  "with a second .topbar-more in the header, the singular-menu check goes red",
  killedNav.topbarMoreCount !== 1,
  `count=${killedNav.topbarMoreCount}`,
);
await killNav.close();

// 7d. A /review link back in the header.
const reviewHtml = html.replace("</header>", '<a href="/review">Plan review</a></header>');
const killReview = await ctx.newPage();
await killReview.setContent(reviewHtml, { waitUntil: "domcontentloaded" });
const killedReview = await readNav(killReview);
check(
  "with a /review link back in the header, the top-level-destination check goes red",
  killedReview.reviewLinksInHeader > 0,
  `count=${killedReview.reviewLinksInHeader}`,
);
await killReview.close();

await browser.close();
console.log(
  failures === 0
    ? "\nfrontendDesignSystem.dom.smoke: PASS"
    : `\nfrontendDesignSystem.dom.smoke: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
