// THE MASK IS PROVEN ON THE PIXELS, AND THE PORTAL NEVER NOTICES IT.
//
// scripts/lib/piiMask.ts hides a run's known values in the RENDERING of a recorded portal run.
// Two things have to be true of it, and each is checked in a direction it can fail:
//
//   HIDDEN — OCR over the recorded frames (step screenshots and, when ffmpeg is present, the
//            .webm sampled at 2 fps) finds NONE of the run's PII strings, full or partial,
//            digits or spaced. The UNMASKED control run, same driver, MUST show them — on the
//            review page (values echoed as text), in a select's chosen option text (County),
//            and in the account list on the dashboard (APP-100231, a value we do not know and
//            box by region) — or the check could not fail. And masked frames must still OCR to
//            the page's own labels, or "0 hits" is a frame the instrument could not read.
//   HARMLESS — the replica's recorded POST state (every value it committed, every POST it
//            saw, the pages it rendered, whether review was walked) is byte-identical masked
//            and unmasked; the review page's innerText is identical (the layer adds no text);
//            and the masked run scores all-correct on the replica's own scoreboard.
//   GEOMETRY — independently of OCR, every control and every CHARACTER of text that carries a
//            raw value sits under an overlay box at each step (a platform-independent check
//            that runs even where no OCR engine exists — and the only instrument for a value
//            the OCR engine cannot read: en-US OCR reads "Иван" as Latin look-alikes and
//            piiHitsInText then finds nothing, so "0 hits" there is blindness, not proof).
//
// Section 0b, THE CORNER PAGE (own 127.0.0.1 server, geometry only, ~5s): what the replica
// never renders — a Cyrillic, a CJK and accented names (in text and in an input), a phone and
// an account split across inline elements, a listbox <select size=4> whose option text carries
// a value, a node appended AFTER load (boxed after ONE animation frame with no scan() call:
// the MutationObserver, not the 250ms interval), and MUST-EXCLUDEs: a bare "4680" line, "Иван"
// inside "Иванов", "Desmond" inside "Desmondia", a listbox with no value are NOT boxed.
//   npx tsx scripts/demoMaskReplica.dom.smoke.ts --corner-only     (kill-test loop, seconds)
//
// Sections 1-4 drive the wizard with the primitives the replay engine uses (fill + Tab to
// commit, selectOption, setInputFiles, a typed date dismissed with Escape, click Next), so the
// masked/unmasked comparison is exact. Section 6 then runs THE RECORDER ITSELF —
// demo-record-portal.ts --real-run --i-am-present --headed, the command the runbook gives —
// against the replica from a scratch database seeded through the product's own writers (the
// supervising electrician a CYRILLIC name, which OCR cannot read), with the real
// RecipeAdapter replaying a hand-written PowerClerk-shaped recipe to review, OCRs every frame
// of the video it kept, and reads the recorder's own review-stop mask audit (geometry,
// in-page, independent of the matcher) — which must find rects carrying a value and none
// outside a box. (A headed Chromium window opens for ~90s during it.)
//
// Also pinned (section 5): the recorder refuses, from its CLI and before any database is read,
// a --real-run without --i-am-present, with PORTAL_ALLOW_FINAL_SUBMIT set, headless, or --no-mask.
//
//   npx tsx scripts/demoMaskReplica.dom.smoke.ts            (real Chromium + Windows OCR; ~4 minutes)
//   npx tsx scripts/run-dom-smokes.ts --only demoMaskReplica --concurrency 1
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { buildWizard, type DocKey } from "../portal-bot/src/replica/fixtures/wizards";
import { PROJECT_A, PROJECT_B, aOnlyLiterals } from "../portal-bot/src/replica/fixtures/syntheticProjects";
import { startSyntheticReplica, type ReplicaState } from "../portal-bot/src/replica/syntheticServer";
import { scoreRun } from "../portal-bot/src/replica/benchScore";
import { isLoopbackHost } from "./demo-portal/network";
import { PII_MASK_LAYER_ID, piiMaskInitScript, piiMaskShapesFor, piiMaskValues, piiRawSourceStrings, type PiiMaskAudit } from "./lib/piiMask";
import { ffmpegAvailable, ocrBlindValues, ocrFrames, ocrUnavailableReason, piiHitsInText, sampleVideoFrames } from "./lib/ocrFrames";
import { realRunRefusals } from "./lib/realRunGuard";

const SKIP_EXIT_CODE = 3;
const CORNER_ONLY = process.argv.includes("--corner-only");
let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  checks++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "demo-mask-smoke-"));
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const DOCS: Record<DocKey, string> = { plan_set: "B-plan-set.pdf", sld: "B-one-line.pdf", site_plan: "B-site-plan.pdf" };
const A_ONLY = aOnlyLiterals(PROJECT_A, PROJECT_B);

// The run's known values — from the same source shape the recorder builds from a project row.
const MASK_VALUES = piiMaskValues({
  project: {
    homeownerName: `${PROJECT_B.ownerFirst} ${PROJECT_B.ownerLast}`,
    projectAddress: `${PROJECT_B.street}, ${PROJECT_B.city}, ${PROJECT_B.state} ${PROJECT_B.zip}`,
    city: PROJECT_B.city, state: PROJECT_B.state, zip: PROJECT_B.zip,
    accountNumber: PROJECT_B.accountNumber, meterNumber: PROJECT_B.meterNumber,
    parserSnapshot: { homeownerEmail: PROJECT_B.ownerEmail, homeownerPhone: PROJECT_B.ownerPhone, county: PROJECT_B.county, moduleModel: PROJECT_B.moduleModel },
  },
  credential: { username: PROJECT_B.portalUsername },
  installer: {
    company: PROJECT_B.installer.company, contactName: `${PROJECT_B.installer.contactFirst} ${PROJECT_B.installer.contactLast}`,
    email: PROJECT_B.installer.email, phone: PROJECT_B.installer.phone, license: PROJECT_B.installer.license,
  },
  extra: [PROJECT_B.installer.electricianName, PROJECT_B.county],
});
/** Raw values the GEOMETRY check searches for — the test's own simple list, not the masker's. */
const RAW_VALUES = [
  PROJECT_B.ownerFirst, PROJECT_B.ownerLast, PROJECT_B.ownerEmail, PROJECT_B.ownerPhone, PROJECT_B.street, PROJECT_B.city,
  PROJECT_B.zip, PROJECT_B.county, PROJECT_B.accountNumber, PROJECT_B.meterNumber, PROJECT_B.installer.company,
  PROJECT_B.installer.contactLast, PROJECT_B.installer.email, PROJECT_B.installer.phone, PROJECT_B.installer.electricianName, PROJECT_B.portalUsername,
];
/** The account-list row on the replica's dashboard: another application, a value we do not know. */
const ACCOUNT_LIST_VALUE = "APP-100231";
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------------------------
console.log("\n0. PURE: the value list and the guard, in both directions");
{
  check("the known-value list carries the full name, the last name alone, the street line and '<number> <street>'",
    [`${PROJECT_B.ownerFirst} ${PROJECT_B.ownerLast}`, PROJECT_B.ownerLast, PROJECT_B.street, `${PROJECT_B.streetNumber} ${PROJECT_B.streetNameCore}`].every((v) => MASK_VALUES.includes(v)),
    `count=${MASK_VALUES.length}`);
  check("MUST-EXCLUDE: the state code (2 chars), the street number alone (3 digits) and a stop word are NOT values",
    !MASK_VALUES.includes(PROJECT_B.state) && !MASK_VALUES.includes(PROJECT_B.streetNumber) && !MASK_VALUES.some((v) => /^(ave|energy|llc)$/i.test(v)), MASK_VALUES.filter((v) => v.length <= 3).join("|"));
  check("MUST-EXCLUDE: an equipment model name in the snapshot is not a value", !MASK_VALUES.includes(PROJECT_B.moduleModel));
  check("the email's local part is a value (the account number would match spaced: alnum matching)", MASK_VALUES.includes(PROJECT_B.ownerEmail.split("@")[0]));
  const hits = piiHitsInText(`Account 8802 4680 13 · phone (541) 555-0163 · YARROWBY, Desmond`, MASK_VALUES);
  check("piiHitsInText finds a spaced account number, a bracketed phone and an upper-cased last name", ["8802468013", "541-555-0163", "Yarrowby", "Desmond"].every((v) => hits.includes(v)), hits.join("|"));
  check("MUST-EXCLUDE: piiHitsInText does not read 'Desmondia' as the first name (word boundary)", !piiHitsInText("Desmondia Ltd", MASK_VALUES).includes("Desmond"));

  const base = { realRun: true, iAmPresent: true, env: {} as Record<string, string | undefined>, runApproval: null, headed: true, maskOn: true, targetHosts: ["powerclerk.example"] };
  check("guard MUST-PASS: --real-run --i-am-present, env unset, headed, masked, no approval", realRunRefusals(base).length === 0, realRunRefusals(base).join("; "));
  check("guard refuses without --i-am-present", realRunRefusals({ ...base, iAmPresent: false }).some((r) => /--i-am-present/.test(r)));
  check("guard refuses PORTAL_ALLOW_FINAL_SUBMIT set to anything, even '0'", realRunRefusals({ ...base, env: { PORTAL_ALLOW_FINAL_SUBMIT: "0" } }).some((r) => /PORTAL_ALLOW_FINAL_SUBMIT/.test(r)));
  check("guard refuses a run approval", realRunRefusals({ ...base, runApproval: { approver: "x", runId: "y" } }).some((r) => /approval/.test(r)));
  check("guard refuses headless and refuses --no-mask", realRunRefusals({ ...base, headed: false }).some((r) => /--headed/.test(r)) && realRunRefusals({ ...base, maskOn: false }).some((r) => /masking/.test(r)));
  check("guard refuses an invalid recipe shape (a flagged final submit that is not last)", realRunRefusals({ ...base, recipeSteps: [{ action: "click", isFinalSubmit: true }, { action: "goto" }] }).some((r) => /shape/.test(r)));
  check("guard MUST-EXCLUDE: without --real-run a non-loopback host is refused; a loopback host is not",
    realRunRefusals({ ...base, realRun: false }).length === 1 && realRunRefusals({ ...base, realRun: false, targetHosts: ["127.0.0.1"] }).length === 0);
}

// ---------------------------------------------------------------------------------------------
// The driver: one PowerClerk-shaped wizard walk, project B, stop at review.
// ---------------------------------------------------------------------------------------------
interface RunResult {
  state: ReplicaState;
  shots: Record<string, string>;
  video: string;
  reviewText: string;
  bodyText: string;
  uncovered: string[];
  layerText: string | null;
  boxesPerStep: Record<string, number>;
}

/** Independent of the masker: every control and every CHARACTER of text that carries a RAW
 *  value (plain case-insensitive substring, per text node) must sit under an overlay box. A
 *  listbox (size>1 / multiple) paints every option, so every option counts. Returns
 *  descriptors (element ids / "text@tag#id") — never the values. Per-character rects, so a
 *  bare accented edge character ("Jos|é", "|Ñ|u") shows up. */
function uncoveredInPage(raw: string[], layerId: string): string[] {
  const layer = document.getElementById(layerId);
  const boxes = layer ? Array.from(layer.children).map((c) => c.getBoundingClientRect()) : [];
  const covered = (r: DOMRect): boolean => {
    const pts: Array<[number, number]> = [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
    return pts.every(([x, y]) => boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom));
  };
  const out: string[] = [];
  const onScreen = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    const e = el as HTMLInputElement | HTMLSelectElement;
    if (e.type === "hidden" || e.type === "file" || e.type === "checkbox") continue;
    let shown = "";
    if (e.tagName === "SELECT") {
      const s = e as HTMLSelectElement;
      const listbox = s.multiple || s.size > 1;
      shown = (listbox ? Array.from(s.options) : Array.from(s.selectedOptions)).map((o) => o.textContent || "").join("\n");
    } else shown = e.value;
    if (!raw.some((v) => shown.toLowerCase().includes(v.toLowerCase()))) continue;
    const r = e.getBoundingClientRect();
    if (onScreen(r) && !covered(r)) out.push(`field#${e.id || e.name}`);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest("script,style,option") || (layer && layer.contains(p))) continue;
    const text = n.nodeValue || "";
    const lower = text.toLowerCase();
    for (const v of raw) {
      const lv = v.toLowerCase();
      let at = lower.indexOf(lv);
      while (at >= 0) {
        for (let i = at; i < at + v.length; i++) {
          if (!/[\p{L}\p{N}]/u.test(text[i])) continue; // a bare bracket or hyphen reveals nothing
          const range = document.createRange();
          range.setStart(n, i); range.setEnd(n, i + 1);
          for (const r of Array.from(range.getClientRects())) {
            if (!onScreen(r) || covered(r)) continue;
            const d = `text@${p.tagName.toLowerCase()}#${p.id || p.className || "?"}`;
            if (!out.includes(d)) out.push(d);
          }
        }
        at = lower.indexOf(lv, at + 1);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
console.log("\n0b. THE CORNER PAGE: Unicode names, split nodes, a listbox, a late node — geometry, no OCR");
{
  const V = {
    cyrillic: "Иван Петров", cjk: "山田太郎", jose: "José Ñañez", zoe: "Zoë Müller-Ålesund", company: "Ñu Solar Ltd",
    account: "8802 4680 13", phone: "(541) 555-0163", ascii: "Quimbyfield", desmond: "Desmond Yarrowby",
    ivan: "Ivan Petrov", zoeAscii: "Zoe Mullerson",
  };
  const values = piiMaskValues({
    project: { homeownerName: V.zoe, accountNumber: V.account, parserSnapshot: { homeownerPhone: V.phone, ubAccountHolderName: V.jose, electricalSupervisorName: V.cyrillic, installerContactName: V.cjk } },
    installer: { company: V.company },
    extra: [V.ascii, V.desmond, V.ivan, V.zoeAscii],
  });
  check("MUST-INCLUDE: Cyrillic, CJK and accented names are values, with their tokens (Иван Петров / Иван / Петров / 山田太郎 / Zoë / José / Ñañez)",
    ["Иван Петров", "Иван", "Петров", "山田太郎", "Zoë", "José", "Ñañez", "Zoë Müller-Ålesund", "Ñu Solar Ltd"].every((v) => values.includes(v)), values.filter((v) => /[^\x00-\x7f]/.test(v)).join("|"));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Corner</title>
<style>body{font:16px Arial;margin:20px} .row{margin:8px 0}</style></head>
<body><h1>Customer Information</h1>
<div class="row" id="r-cyr">Account holder: ${esc(V.cyrillic)}</div>
<div class="row" id="r-cjk">Contact: ${esc(V.cjk)}</div>
<div class="row" id="r-cjk2">Contact (honorific): ${esc(V.cjk)}様</div>
<div class="row" id="r-jose">Holder: ${esc(V.jose)}</div>
<div class="row" id="r-zoe">Name: ${esc(V.zoe)}</div>
<div class="row" id="r-nu">Company: ${esc(V.company)}</div>
<div class="row" id="r-split-phone">Phone: (541) <span id="sp1">555-0163</span></div>
<div class="row" id="r-split-acct">Account: 8802 <b id="sp2">4680</b> 13</div>
<div class="row" id="r-ref">Ref: 4680</div>
<div class="row" id="r-ivanov">Street: Иванов prospekt</div>
<div class="row" id="r-desmondia">Firm: Desmondia Ltd</div>
<div class="row" id="r-glue-label"><label>Owner</label><span id="g1">${esc(V.desmond)}</span></div>
<div class="row" id="r-glue-br">${esc(V.ivan)}<br>Electrician</div>
<div class="row" id="r-glue-block"><span style="display:block">Name</span><span style="display:block" id="g3">${esc(V.zoeAscii)}</span></div>
<div class="row" id="r-glue-br2">Holder<br>${esc(V.ascii)}<br>Account</div>
<div class="row" id="r-glue-margin"><b style="margin-right:12px">Contact</b><span id="g5">${esc(V.ivan)}</span></div>
<div class="row"><label for="lb">Existing customers</label><br><select id="lb" size="4"><option value="">-- none --</option><option value="c1">Customer: ${esc(V.zoe)}</option><option value="c2">Customer: ${esc(V.ascii)} Holdings</option><option value="c3">Other</option></select>
<select id="lb2" size="3"><option>Alpha</option><option>Beta</option><option>Gamma</option></select></div>
<div class="row"><label for="cyr-in">Electrician</label> <input id="cyr-in" type="text" value="${esc(V.cyrillic)}"></div>
</body></html>`;
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Geometry RAW: the values, plus the split fragments (each lives in its own text node) and
  // the MUST-EXCLUDE probes ("Иван", "Desmond" — found by raw substring inside the longer words).
  const RAW = [V.cyrillic, V.cjk, V.jose, V.zoe, V.company, "555-0163", "4680", V.ascii, "Иван", "Desmond", V.desmond, V.ivan, V.zoeAscii];
  const AUDIT_RAW = [V.cyrillic, V.cjk, V.jose, V.zoe, V.company, V.account, V.phone, V.ascii, V.desmond, V.ivan, V.zoeAscii];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
    await ctx.addInitScript({ content: piiMaskInitScript({ values, shapes: piiMaskShapesFor("powerclerk"), extraSelectors: [] }) });
    await ctx.addInitScript({ content: `globalThis.__uncov = ${uncoveredInPage.toString()};` });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(500);
    const uncovered = await page.evaluate(([raw, id]) => (globalThis as unknown as { __uncov: (r: string[], id: string) => string[] }).__uncov(raw as string[], id as string), [RAW, PII_MASK_LAYER_ID]);
    const leaks = uncovered.filter((u) => !/#(r-ref|r-ivanov|r-desmondia)$/.test(u));
    check("GEOMETRY: every character of the Cyrillic, CJK (bare and with an honorific) and accented names, in text and in the input, sits under a box",
      !leaks.some((u) => /r-cyr|r-cjk|r-jose|r-zoe|r-nu|cyr-in/.test(u)), leaks.join("; "));
    check("GEOMETRY: a phone and an account split across inline elements are boxed in every node ((541) <span>555-0163</span>; 8802 <b>4680</b> 13)",
      !leaks.some((u) => /r-split|sp1|sp2/.test(u)), leaks.join("; "));
    // N1: the line-box run puts a separator between text nodes, so an element edge is a word
    // boundary. Flattened with NONE, "Owner"+"Desmond" read as one word and the name was bare.
    const glued = await page.evaluate(() => ["r-glue-label", "r-glue-br", "r-glue-block", "r-glue-br2", "r-glue-margin"]
      .map((id) => { const r = document.getElementById(id)!.getBoundingClientRect(); return r.height > 0 && r.bottom <= innerHeight; }));
    check("GEOMETRY (N1): a name glued to a neighbour element's text is boxed — <label>Owner</label><span>name, name<br>next line, display:block spans, a margin-separated <b> — every element edge is a word boundary",
      glued.every(Boolean) && !leaks.some((u) => /r-glue|#g[135]$/.test(u)), `on screen=${glued.join(",")} ${leaks.join("; ")}`);
    check("GEOMETRY: a listbox whose option text carries a value is boxed whole", !leaks.some((u) => /field#lb$/.test(u)), leaks.join("; "));
    check("no other rect carrying a raw value is uncovered", leaks.length === 0, leaks.join("; "));
    check("MUST-EXCLUDE: a bare '4680' line, 'Иван' inside 'Иванов' and 'Desmond' inside 'Desmondia' are NOT boxed (no digit partials; cased-letter word boundary)",
      ["text@div#r-ref", "text@div#r-ivanov", "text@div#r-desmondia"].every((d) => uncovered.includes(d)), uncovered.join("; "));
    const lb2 = await page.evaluate((id) => {
      const layer = document.getElementById(id);
      const boxes = layer ? Array.from(layer.children).map((c) => c.getBoundingClientRect()) : [];
      const r = document.getElementById("lb2")!.getBoundingClientRect();
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      return boxes.some((b) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
    }, PII_MASK_LAYER_ID);
    check("MUST-EXCLUDE: a listbox with no value in any option is not boxed", !lb2);
    // The independent in-page audit agrees — and is independent: it counts 'Desmond' inside
    // 'Desmondia' as an uncovered rect, which the matcher's boundary rule deliberately leaves bare.
    const audit = await page.evaluate((raw) => (globalThis as unknown as { __piiMask: { audit: (v: string[]) => PiiMaskAudit } }).__piiMask.audit(raw), AUDIT_RAW);
    check(`the in-page audit finds the values' rects (${audit.rectsChecked}) and none outside a box`, audit.rectsChecked >= 40 && audit.uncovered === 0, JSON.stringify(audit));
    const auditDesmond = await page.evaluate((raw) => (globalThis as unknown as { __piiMask: { audit: (v: string[]) => PiiMaskAudit } }).__piiMask.audit(raw), ["Desmond"]);
    check("MUST-EXCLUDE: the audit is raw-substring, not the matcher — it reports 'Desmond' inside 'Desmondia' as uncovered", auditDesmond.uncovered > 0 && auditDesmond.where.includes("div#r-desmondia"), JSON.stringify(auditDesmond));
    const maskedText = await page.evaluate(() => document.body.innerText); // before the late row below
    // THE MUTATION OBSERVER: a value-bearing node appended after load is boxed after ONE animation
    // frame with NO scan() call (the observer's microtask queues the redraw; the 250ms interval
    // could not have run).
    const mo = await page.evaluate(async () => {
      const api = (globalThis as unknown as { __piiMask: { boxes(): unknown[] } }).__piiMask;
      const before = api.boxes().length;
      const p = document.createElement("p"); p.id = "late"; p.textContent = "Late row: Quimbyfield 8802 4680 13"; document.body.appendChild(p);
      await Promise.resolve(); // the observer's notification microtask runs before this one resumes
      await new Promise((r) => requestAnimationFrame(r));
      const afterOneFrame = api.boxes().length;
      return { before, afterOneFrame };
    });
    check(`MUTATION OBSERVER: a node appended after load is boxed after ONE animation frame, no scan() (${mo.before} -> ${mo.afterOneFrame})`, mo.afterOneFrame > mo.before, JSON.stringify(mo));
    const lateAudit = await page.evaluate((raw) => (globalThis as unknown as { __piiMask: { audit: (v: string[]) => PiiMaskAudit } }).__piiMask.audit(raw), [V.ascii, V.account]);
    check("...and the late row's value characters are all under a box", lateAudit.uncovered === 0 && lateAudit.rectsChecked > 0, JSON.stringify(lateAudit));
    await ctx.close();
    // Unmasked control: no layer, same text.
    const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
    const page2 = await ctx2.newPage();
    await page2.goto(`${base}/`);
    const unmaskedText = await page2.evaluate(() => document.body.innerText);
    const layer2 = await page2.evaluate((id) => !!document.getElementById(id), PII_MASK_LAYER_ID);
    check("HARMLESS: body.innerText is identical with and without the mask layer, and the unmasked page has no layer",
      maskedText === unmaskedText && maskedText.length > 100 && !layer2, `masked=${maskedText.length}B unmasked=${unmaskedText.length}B`);
    await ctx2.close();
  } finally {
    await browser.close();
    server.close();
  }
  if (CORNER_ONLY) {
    console.log(`\n${checks - failures}/${checks} corner check(s) passed (--corner-only: sections 1-6 not run).`);
    process.exit(failures ? 1 : 0);
  }
}

async function walkWizard(label: string, masked: boolean): Promise<RunResult> {
  const w = buildWizard("powerclerk", "base");
  const replica = await startSyntheticReplica({ wizard: w, credential: { username: PROJECT_B.portalUsername, password: PROJECT_B.portalPassword } });
  const host = new URL(replica.base).hostname;
  if (!isLoopbackHost(host)) throw new Error(`refusing: the replica is not on a loopback host (${host})`);
  const browser = await chromium.launch();
  const dir = path.join(work, label);
  fs.mkdirSync(dir, { recursive: true });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: path.join(dir, "video"), size: { width: 1440, height: 900 } } });
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
  if (masked) await context.addInitScript({ content: piiMaskInitScript({ values: MASK_VALUES, shapes: piiMaskShapesFor("powerclerk"), extraSelectors: [] }) });
  const page: Page = await context.newPage();
  const shots: Record<string, string> = {};
  const uncovered: string[] = [];
  const boxesPerStep: Record<string, number> = {};
  let layerText: string | null = null;
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(350);
    if (masked) {
      const r = await page.evaluate(([raw, id]) => {
        const api = (globalThis as unknown as Record<string, { scan(): number } | undefined>).__piiMask;
        const n = api ? api.scan() : -1;
        const layer = document.getElementById(id as string);
        return { n, text: layer ? layer.textContent || "" : null, uncovered: (globalThis as unknown as { __uncov: (r: string[], id: string) => string[] }).__uncov(raw as string[], id as string) };
      }, [RAW_VALUES, PII_MASK_LAYER_ID]);
      boxesPerStep[name] = r.n;
      for (const u of r.uncovered) uncovered.push(`${name}: ${u}`);
      layerText = (layerText ?? "") + (r.text ?? "");
    }
    const p = path.join(dir, `${name}.png`);
    await page.screenshot({ path: p });
    shots[name] = p;
  };
  // The independent geometry check is installed as a page function (not through the masker).
  await context.addInitScript({ content: `globalThis.__uncov = ${uncoveredInPage.toString()};` });
  const d = w.delays;
  const commit = async (id: string, value: string, settle = d.autosave + 100): Promise<void> => {
    await page.locator(`#${id}`).fill(value);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(settle);
  };
  const choose = async (id: string, value: string): Promise<void> => {
    await page.locator(`#${id}`).selectOption(value);
    await page.waitForTimeout(d.autosave + 100);
  };
  const future = new Date(Date.now() + 60 * 86400000);
  const futureStr = `${String(future.getMonth() + 1).padStart(2, "0")}/${String(future.getDate()).padStart(2, "0")}/${future.getFullYear()}`;
  const slug = (re: RegExp) => `${replica.base}/${w.pages.find((p) => re.test(p.heading))!.slug}`;

  try {
    await page.goto(replica.entryUrl);
    await page.fill("#UserName", PROJECT_B.portalUsername);
    await page.fill("#Password", PROJECT_B.portalPassword);
    await Promise.all([page.waitForURL(/Dashboard/), page.click("#btnSignIn")]);
    await shot("01-dashboard");
    await Promise.all([page.waitForURL(/customer-information/), page.click("#btnNewProject")]);
    await commit("pcInputBase10", PROJECT_B.ownerFirst);
    await commit("pcInputBase11", PROJECT_B.ownerLast);
    await commit("pcInputBase12", PROJECT_B.ownerEmail);
    await commit("pcInputBase13", PROJECT_B.ownerPhone);
    await commit("pcInputBase14", PROJECT_B.street);
    await commit("pcInputBase15", PROJECT_B.city);
    await choose("pcInputBase16", PROJECT_B.state);
    await commit("pcInputBase17", PROJECT_B.zip);
    await page.waitForSelector(`#pcInputBase18 option[value="${PROJECT_B.county}"]`, { state: "attached", timeout: d.lateOptions + 5000 });
    await choose("pcInputBase18", PROJECT_B.county);
    await commit("pcInputBase19", PROJECT_B.accountNumber);
    await commit("pcInputBase20", PROJECT_B.meterNumber);
    await shot("02-customer");
    await Promise.all([page.waitForURL(/installer-information/), page.click("#btnNext")]);
    const settle = d.autosave + d.rerender + 250;
    await commit("pcInputBase30", `${PROJECT_B.installer.contactFirst} ${PROJECT_B.installer.contactLast}`, settle);
    await commit("pcInputBase31", PROJECT_B.installer.company, settle);
    await commit("pcInputBase32", PROJECT_B.installer.email, settle);
    await commit("pcInputBase33", PROJECT_B.installer.phone, settle);
    await commit("pcInputBase40", PROJECT_B.installer.electricianName, settle);
    await commit("pcInputBase41", PROJECT_B.installer.company, settle);
    await commit("pcInputBase42", PROJECT_B.installer.email, settle);
    await commit("pcInputBase43", PROJECT_B.installer.phone, settle);
    await shot("03-installer");
    await Promise.all([page.waitForURL(/system-specifications/), page.click("#btnNext")]);
    await choose("pcInputBase50", "REC");
    await page.waitForSelector('#pcInputBase51 option[value="REC-400"]', { state: "attached", timeout: d.cascade + 5000 });
    await choose("pcInputBase51", "REC-400");
    await commit("pcInputBase52", PROJECT_B.moduleQty);
    await choose("pcInputBase60", "ENP");
    await page.waitForSelector('#pcInputBase61 option[value="ENP-IQ8M"]', { state: "attached", timeout: d.cascade + 5000 });
    await choose("pcInputBase61", "ENP-IQ8M");
    await commit("pcInputBase62", PROJECT_B.inverterQty);
    await page.locator("#pcInputBase70").fill(futureStr);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(d.autosave + 100);
    await shot("04-specs");
    await Promise.all([page.waitForURL(/attachments/), page.click("#btnNext")]);
    await page.locator("#pcInputBase80").setInputFiles({ name: DOCS.sld, mimeType: "application/pdf", buffer: PDF });
    await page.locator("#pcInputBase81").setInputFiles({ name: DOCS.site_plan, mimeType: "application/pdf", buffer: PDF });
    for (let i = 0; i < 40 && !(replica.state.values["doc.sld"] && replica.state.values["doc.sitePlan"]); i++) await page.waitForTimeout(100);
    await shot("05-attachments");
    await Promise.all([page.waitForURL(/review-and-submit/), page.click("#btnNext")]);
    await page.waitForSelector(".review-summary");
    await page.locator("#pcInputBase90").check();
    await page.waitForTimeout(d.autosave + 200);
    await shot("06-review");
    await page.waitForTimeout(800);
  } finally {
    // nothing here clicks Submit or Pay
  }
  const reviewText = await page.locator(".review-summary").innerText().catch(() => "");
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (!masked) {
    const layer = await page.evaluate((id) => !!document.getElementById(id), PII_MASK_LAYER_ID);
    if (layer) uncovered.push("unmasked run has a mask layer");
  }
  check(`${label}: the wizard was WALKED to review (the portal's own Next accepted the last page)`, replica.state.reviewReached && replica.state.reviewVia === "walked", `reached=${replica.state.reviewReached} via=${replica.state.reviewVia} errors=${replica.state.validationErrors.join("|")}`);
  check(`${label}: nothing was filed or paid`, replica.state.submitPosts.length === 0 && replica.state.payPosts.length === 0);
  const video = page.video();
  await context.close();
  const videoPath = video ? await video.path() : "";
  await browser.close();
  await replica.close();
  void slug;
  return { state: replica.state, shots, video: videoPath, reviewText, bodyText, uncovered, layerText, boxesPerStep };
}

const stateKey = (s: ReplicaState): string => JSON.stringify({
  values: s.values,
  posts: s.posts.map((p) => ({ route: p.route, kind: p.kind, fields: p.fields })),
  pagesSeen: s.pagesSeen, reviewReached: s.reviewReached, reviewVia: s.reviewVia, validationErrors: s.validationErrors, loggedIn: s.loggedIn,
});

// ---------------------------------------------------------------------------------------------
console.log("\n1. TWO RUNS: masked and unmasked, same driver, project B, stop at review");
const masked = await walkWizard("masked", true);
const unmasked = await walkWizard("unmasked", false);

console.log("\n2. HARMLESS: the portal saw the same run either way");
{
  const mk = stateKey(masked.state);
  const uk = stateKey(unmasked.state);
  check("the replica's recorded POST state is byte-identical masked vs unmasked (values, posts, pages, review)", mk === uk, `masked ${mk.length}B vs unmasked ${uk.length}B; first difference at ${[...mk].findIndex((c, i) => c !== uk[i])}`);
  check("the review page's innerText is identical (the layer adds no text)", masked.reviewText === unmasked.reviewText && masked.reviewText.length > 50, `masked=${masked.reviewText.length}B unmasked=${unmasked.reviewText.length}B`);
  check("document.body.innerText is identical on the review page", masked.bodyText === unmasked.bodyText, `masked=${masked.bodyText.length}B unmasked=${unmasked.bodyText.length}B`);
  check("the mask layer holds no text at all", masked.layerText === "", JSON.stringify((masked.layerText ?? "null").slice(0, 40)));
  const score = scoreRun(buildWizard("powerclerk", "base"), masked.state, PROJECT_B, DOCS, A_ONLY);
  check(`the masked run scores all-correct on the replica's scoreboard (${score.fieldsCorrect}/${score.fieldsExpected})`, score.allCorrect, JSON.stringify(score.fields.filter((f) => f.verdict !== "correct")));
}

console.log("\n3. GEOMETRY: every raw value on screen sits under a box, at every step of the masked run");
{
  const steps = Object.keys(masked.boxesPerStep);
  const withPii = ["01-dashboard", "02-customer", "03-installer", "06-review"];
  check(`boxes were drawn at every step that shows a value (${steps.map((s) => `${s}:${masked.boxesPerStep[s]}`).join(", ")})`, steps.length === 6 && withPii.every((s) => masked.boxesPerStep[s] > 0));
  check("MUST-EXCLUDE: the equipment page, which shows no value, draws no box (masking is selective, not a blanket)", masked.boxesPerStep["04-specs"] === 0 && masked.boxesPerStep["05-attachments"] === 0);
  check("no control or text range carrying a raw value is left uncovered", masked.uncovered.length === 0, masked.uncovered.slice(0, 12).join("; "));
  check("MUST-EXCLUDE: the unmasked run has no mask layer", unmasked.uncovered.length === 0, unmasked.uncovered.join("; "));
}

console.log("\n4. HIDDEN: OCR over the frames");
const ocrReason = ocrUnavailableReason();
let ocrRan = false;
if (ocrReason) {
  console.log(`  (OCR not available on this machine: ${ocrReason})`);
} else {
  ocrRan = true;
  const haveFfmpeg = ffmpegAvailable();
  // The masked video is sampled densely (8 fps): a value that flashed for one frame between
  // a page's first paint and its first scan would hide from a 2 fps sample. The unmasked
  // control only has to show hits, so 2 fps is enough there.
  const frames = (r: RunResult, label: string, fps: number): string[] => {
    const list = Object.values(r.shots);
    if (haveFfmpeg && r.video && fs.existsSync(r.video)) list.push(...sampleVideoFrames(r.video, path.join(work, label, "frames"), fps));
    return list;
  };
  const mFrames = frames(masked, "masked", 8);
  const uFrames = frames(unmasked, "unmasked", 2);
  console.log(`  frames: masked ${mFrames.length} (${Object.keys(masked.shots).length} step shots${haveFfmpeg ? ` + ${mFrames.length - Object.keys(masked.shots).length} video frames at 8 fps` : ", no ffmpeg"}), unmasked ${uFrames.length}${haveFfmpeg ? " (video at 2 fps)" : ""}`);
  const mText = ocrFrames(mFrames);
  const uText = ocrFrames(uFrames);
  const STRINGS = [...MASK_VALUES, ACCOUNT_LIST_VALUE];
  check(`OCR read every frame it was given (masked ${mText.size}/${mFrames.length}, unmasked ${uText.size}/${uFrames.length})`, mText.size === mFrames.length && uText.size === uFrames.length);

  // The instrument saw the masked frames: labels survive.
  // The review shot is scrolled to its terms box (the heading is above the fold), so its
  // label is the terms text beside the checkbox.
  const LABELS: Record<string, string> = { "02-customer": "Customer Information", "03-installer": "Installer Information", "06-review": "Terms and Conditions" };
  const labelSeen = Object.entries(LABELS).map(([shotName, lbl]) => [shotName, norm(mText.get(path.resolve(masked.shots[shotName])) ?? "").includes(norm(lbl))] as const);
  check(`masked step frames still OCR to their page labels (${labelSeen.map(([s, ok]) => `${s}:${ok ? "seen" : "MISSING"}`).join(", ")})`, labelSeen.every(([, ok]) => ok));
  const videoLabelFrames = [...mText.entries()].filter(([f, t]) => /frame-\d+\.png$/.test(f) && Object.values(LABELS).some((l) => norm(t).includes(norm(l)))).length;
  if (haveFfmpeg) check(`masked VIDEO frames OCR to page labels too (${videoLabelFrames} frame(s))`, videoLabelFrames > 0);

  // Masked: zero hits, every string, every frame.
  let mHits = 0;
  const mHitFrames: string[] = [];
  for (const [f, t] of mText) {
    const h = piiHitsInText(t, STRINGS);
    if (h.length) { mHits += h.length; mHitFrames.push(`${path.basename(f)}(${h.length})`); }
  }
  const blind = ocrBlindValues(STRINGS);
  check(`MASKED: 0 PII hits over ${mText.size} frame(s) x ${STRINGS.length - blind.length} OCR-readable string(s) — got ${mHits} (${blind.length} non-Latin string(s) are OCR-blind: geometry covers those)`, mHits === 0, `frames with hits: ${mHitFrames.slice(0, 10).join(", ")}`);
  const mAccount = [...mText.values()].filter((t) => norm(t).includes(norm(ACCOUNT_LIST_VALUE))).length;
  check("MASKED MUST-EXCLUDE: the account list's other application is on no frame", mAccount === 0, `${mAccount} frame(s)`);

  // Unmasked control: hits, and in each category the mask exists for.
  let uHits = 0;
  const uStringsHit = new Set<string>();
  for (const t of uText.values()) for (const h of piiHitsInText(t, STRINGS)) { uHits++; uStringsHit.add(h); }
  check(`UNMASKED control: > 0 PII hits over ${uText.size} frame(s) — got ${uHits} (${uStringsHit.size}/${STRINGS.length} strings seen at least once)`, uHits > 0 && uStringsHit.size >= 5);
  const uReview = piiHitsInText(uText.get(path.resolve(unmasked.shots["06-review"])) ?? "", MASK_VALUES);
  check(`UNMASKED MUST-EXCLUDE: values are readable on the review page (${uReview.length} hit(s))`, uReview.length >= 3);
  const uCounty = norm(uText.get(path.resolve(unmasked.shots["02-customer"])) ?? "").includes(norm(PROJECT_B.county));
  check("UNMASKED MUST-EXCLUDE: the County select's chosen option text is readable", uCounty);
  const uAccount = norm(uText.get(path.resolve(unmasked.shots["01-dashboard"])) ?? "").includes(norm(ACCOUNT_LIST_VALUE));
  check("UNMASKED MUST-EXCLUDE: the account list's other application is readable on the dashboard", uAccount);
  const mCounty = norm(mText.get(path.resolve(masked.shots["02-customer"])) ?? "").includes(norm(PROJECT_B.county));
  check("MASKED: the County select's chosen option text is NOT readable", !mCounty);
  console.log(`  OCR denominators: masked ${mText.size} frames / ${STRINGS.length} strings (${blind.length} OCR-blind) / ${mHits} hits; unmasked ${uText.size} frames / ${STRINGS.length} strings / ${uHits} hits`);
}

// ---------------------------------------------------------------------------------------------
console.log("\n5. THE RECORDER'S CLI refuses a real run before any database is read");
{
  const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const RECORDER = path.join(REPO, "scripts", "demo-record-portal.ts");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "demo-mask-cli-"));
  const run = (args: string[], env: Record<string, string> = {}): { status: number | null; out: string } => {
    const e = { ...process.env, ...env } as Record<string, string>;
    delete e.PORTAL_ALLOW_FINAL_SUBMIT;
    Object.assign(e, env);
    const r = spawnSync(process.execPath, [TSX_CLI, RECORDER, ...args], { cwd: empty, encoding: "utf8", timeout: 120_000, env: e });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const a = run(["--real-run", "--out", "x.webm", "--project", "p", "--headed"]);
  check("--real-run without --i-am-present: exit 2, names the flag, and no database was looked for", a.status === 2 && /--i-am-present/.test(a.out) && !/No database at/.test(a.out), a.out.slice(-300));
  const b = run(["--real-run", "--i-am-present", "--headed", "--out", "x.webm", "--project", "p"], { PORTAL_ALLOW_FINAL_SUBMIT: "1" });
  check("--real-run with PORTAL_ALLOW_FINAL_SUBMIT=1: exit 2 naming the variable", b.status === 2 && /PORTAL_ALLOW_FINAL_SUBMIT/.test(b.out), b.out.slice(-300));
  const c = run(["--real-run", "--i-am-present", "--out", "x.webm", "--project", "p"]);
  check("--real-run headless: exit 2 naming --headed", c.status === 2 && /--headed/.test(c.out), c.out.slice(-300));
  const dd = run(["--real-run", "--i-am-present", "--headed", "--no-mask", "--out", "x.webm", "--project", "p"]);
  check("--real-run --no-mask: exit 2 (masking is forced on for a real portal)", dd.status === 2 && /masking/.test(dd.out), dd.out.slice(-300));
  try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* temp */ }
}

// ---------------------------------------------------------------------------------------------
console.log("\n6. THE RECORDER'S --real-run, END TO END on the replica: real writers, real adapter, real verdict");
// The command the runbook gives, run for real against the synthetic PowerClerk replica: a
// scratch database seeded through the product's own writers (client, project B, a stored
// credential, a complete utility recipe, two documents), the recorder spawned with
// --real-run --i-am-present --headed, the RecipeAdapter replaying to review, the video kept
// by the real-run verdict — and every frame of it OCR'd for project B's values.
{
  const e2eRoot = fs.mkdtempSync(path.join(os.tmpdir(), "demo-mask-realrun-"));
  const env = {
    AUTOPILOT_DB_PATH: path.join(e2eRoot, "prod-copy.sqlite"), PROJECT_DOCS_DIR: path.join(e2eRoot, "project-documents"), BACKUP_DIR: path.join(e2eRoot, "backups"),
    AUTOPILOT_LOG_FILE: "", SEED_TEST_INSTALLER: "false", AUTOPILOT_AUTO_START: "0", AUTO_STAGE_STEPS: "0", BACKGROUND_WORKERS: "off", CLIENT_NOTIFICATIONS: "off",
    SESSION_ENCRYPTION_KEY: "smoke-only-key-not-a-secret",
  };
  Object.assign(process.env, env);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  const { openDatabase } = await import("../backend/src/db");
  const { createClient } = await import("../backend/src/clients");
  const { createProject } = await import("../backend/src/repository");
  const { createPortalCredential } = await import("../backend/src/portalCredentials");
  const { startPortalRecording, savePortalRecipeSteps } = await import("../backend/src/portalRecipes");
  const { saveProjectDocument } = await import("../backend/src/projectDocuments");
  type RecipeStep = import("../shared/src/types").RecipeStep;

  const w = buildWizard("powerclerk", "base");
  const replica = await startSyntheticReplica({ wizard: w, credential: { username: PROJECT_B.portalUsername, password: PROJECT_B.portalPassword } });
  if (!isLoopbackHost(new URL(replica.base).hostname)) throw new Error("refusing: the replica is not on a loopback host");
  const B = PROJECT_B;
  // The supervising electrician gets a CYRILLIC name: a value the en-US OCR cannot read, so the
  // recorder's own in-page audit (geometry) is the instrument that must see it boxed.
  const E2E_ELECTRICIAN = "Иван Петров";
  const db = await openDatabase();
  const client = createClient(db, { companyName: B.installer.company, ccbLicenseNumber: "318822" });
  const project = createProject(db, {
    clientId: client.id, owner: `${B.ownerFirst} ${B.ownerLast}`, street: B.street, city: B.city, state: B.state, zip: B.zip,
    ahj: B.ahj, utility: B.utility, dcKw: B.dcKw, acKw: B.acKw, account: B.accountNumber, meter: B.meterNumber,
    homeownerEmail: B.ownerEmail, homeownerPhone: B.ownerPhone, county: B.county,
    installerCompanyName: B.installer.company, installerContactName: `${B.installer.contactFirst} ${B.installer.contactLast}`,
    installerEmail: B.installer.email, installerPhone: B.installer.phone, electricalSupervisorName: E2E_ELECTRICIAN,
    moduleMake: B.moduleMake, moduleModel: B.moduleModel, moduleQty: B.moduleQty, inverterMake: B.inverterMake, inverterModel: B.inverterModel, inverterQty: B.inverterQty,
  } as never, undefined, { learningExcluded: true }).project;
  createPortalCredential(db, client.id, { portalType: "powerclerk", portalUrl: replica.entryUrl, username: B.portalUsername, password: B.portalPassword });
  saveProjectDocument(db, project.id, { docType: "sld", filename: DOCS.sld, contentType: "application/pdf", buffer: PDF });
  // Distinct bytes per document: the store attaches a byte-identical upload under a second doc
  // type ONCE (e333d62), so a site plan with the SLD's bytes would be dropped and the replica's
  // attachments page would refuse to advance — a fixture artefact, not the mask.
  saveProjectDocument(db, project.id, { docType: "site_plan", filename: DOCS.site_plan, contentType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from("% site plan")]) });
  const fill = (css: string, label: string, field: string, learn = "LEARN-TIME-VALUE"): RecipeStep => ({ action: "fill", phase: "fill", selector: { css, fallbacks: [{ label }] }, field, value: learn, note: label });
  const choose = (css: string, label: string, field: string, learn = ""): RecipeStep => ({ action: "select", phase: "fill", selector: { css, fallbacks: [{ label }] }, field, value: learn, note: label });
  const next = (): RecipeStep => ({ action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#btnNext" }] }, note: "advance: Next" });
  const future = new Date(Date.now() + 60 * 86400000);
  const futureStr = `${String(future.getMonth() + 1).padStart(2, "0")}/${String(future.getDate()).padStart(2, "0")}/${future.getFullYear()}`;
  const steps: RecipeStep[] = [
    { action: "goto", phase: "open", value: `${replica.base}/Dashboard`, note: "entry url" },
    { action: "click", phase: "open", selector: { role: "link", name: "Start a New Application", exact: true, fallbacks: [{ css: "#btnNewProject" }] }, note: "advance: Start a New Application" },
    fill("#pcInputBase10", "First Name", "homeownerFirstName", "LEARN-TIME-FIRST"),
    fill("#pcInputBase11", "Last Name", "homeownerLastName", "LEARN-TIME-LAST"),
    fill("#pcInputBase12", "Email", "homeownerEmail", "learn-time@example.invalid"),
    fill("#pcInputBase13", "Phone", "homeownerPhone", "(000) 000-0000"),
    fill("#pcInputBase14", "Service Address", "street", "1 Learn-Time Street"),
    fill("#pcInputBase15", "City", "city", "Learntown"),
    choose("#pcInputBase16", "State", "state", "WA"),
    fill("#pcInputBase17", "Zip Code", "zip", "00000"),
    choose("#pcInputBase18", "County", "county", "Lindow"),
    { action: "fill", phase: "fill", selector: { css: "#pcInputBase19", fallbacks: [{ label: "Utility Account Number" }] }, field: "accountNumber", sensitive: true, optional: true, note: `SENSITIVE — bound to project field "accountNumber" (no value stored). Utility Account Number` },
    { action: "fill", phase: "fill", selector: { css: "#pcInputBase20", fallbacks: [{ label: "Meter Number" }] }, field: "meterNumber", sensitive: true, optional: true, note: `SENSITIVE — bound to project field "meterNumber" (no value stored). Meter Number` },
    next(),
    fill("#pcInputBase30", "Name", "installerContactName", "Learn Person"),
    fill("#pcInputBase31", "Company", "installerCompanyName", "Learn Co"),
    fill("#pcInputBase32", "Email", "installerEmail", "learn@example.invalid"),
    fill("#pcInputBase33", "Phone", "installerPhone", "(000) 000-0001"),
    fill("#pcInputBase40", "Name", "electricalSupervisorName", "Learn Electrician"),
    fill("#pcInputBase41", "Company", "installerCompanyName", "Learn Co"),
    fill("#pcInputBase42", "Email", "installerEmail", "learn@example.invalid"),
    fill("#pcInputBase43", "Phone", "installerPhone", "(000) 000-0001"),
    next(),
    choose("#pcInputBase50", "Manufacturer", "moduleMake", "HQC"),
    choose("#pcInputBase51", "Model", "moduleModel", "HQC-400"),
    fill("#pcInputBase52", "Quantity", "moduleQty", "1"),
    choose("#pcInputBase60", "Manufacturer", "inverterMake", "APS"),
    choose("#pcInputBase61", "Model", "inverterModel", "APS-DS3L"),
    fill("#pcInputBase62", "Quantity", "inverterQty", "1"),
    { action: "fill", phase: "fill", selector: { css: "#pcInputBase70", fallbacks: [{ label: "Estimated In-Service Date" }] }, value: futureStr, note: "Estimated In-Service Date" },
    next(),
    { action: "upload", phase: "upload", selector: { css: "#pcInputBase80" }, docType: "sld", note: "upload sld: One-Line Diagram" },
    { action: "upload", phase: "upload", selector: { css: "#pcInputBase81" }, docType: "site_plan", note: "upload site_plan: Site Plan" },
    next(),
    { action: "check", phase: "review", selector: { css: "#pcInputBase90", fallbacks: [{ label: "Click to Accept Terms and Conditions" }] }, note: "Click to Accept Terms and Conditions" },
    { action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." },
    // The recorder's own shape for the human's submit: no selector, optional, flagged.
    { action: "click", phase: "review", selector: {}, optional: true, isFinalSubmit: true, note: `BLOCKED — human clicked a submit/pay-like control ("Submit") here; not replayable.` },
  ];
  const rec = startPortalRecording(db, { scopeType: "utility", state: B.state, utility: B.utility, portalPlatform: "powerclerk", portalUrl: replica.entryUrl, createdBy: "demoMaskReplica smoke" });
  savePortalRecipeSteps(db, rec.id, steps, { status: "complete", notes: "smoke recipe for the synthetic replica" });
  await new Promise((r) => setTimeout(r, 2500)); // the background PDF text extraction finishes before the handle closes
  db.close();

  const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const RECORDER = path.join(REPO, "scripts", "demo-record-portal.ts");
  const out = path.join(e2eRoot, "real.webm");
  const shotsDir = path.join(e2eRoot, "shots");
  // spawn, not spawnSync: the replica lives in THIS process and must keep serving.
  const r = await new Promise<{ status: number | null; text: string }>((resolve) => {
    const childEnv = { ...process.env, AUTOPILOT_DB_PATH: "", REPLAY_RUN_DIR: path.join(e2eRoot, "replay-runs") } as Record<string, string>;
    delete childEnv.PORTAL_ALLOW_FINAL_SUBMIT;
    const child = spawn(process.execPath, [TSX_CLI, RECORDER, "--real-run", "--i-am-present", "--headed", "--db", env.AUTOPILOT_DB_PATH, "--project", project.id, "--out", out, "--shots", shotsDir, "--login-wait", "30", "--slowmo", "0"],
      { cwd: e2eRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => { text += String(d); });
    child.stderr.on("data", (d) => { text += String(d); });
    const timer = setTimeout(() => child.kill(), 480_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, text }); });
  });
  fs.writeFileSync(path.join(e2eRoot, "recorder.log"), r.text, "utf8");
  const jsonStart = r.text.indexOf("{\n  \"mode\"");
  let report: Record<string, unknown> = {};
  try { report = jsonStart >= 0 ? JSON.parse(r.text.slice(jsonStart, r.text.indexOf("\n}\n", jsonStart) + 2)) : {}; } catch { report = {}; }
  const tail = r.text.split("\n").filter((l) => /demo-record\]|error/i.test(l)).slice(-6).join(" | ").slice(0, 600);
  check("the recorder exited 0 and KEPT the video by the real-run verdict", r.status === 0 && report.kept === true, `status=${r.status} refused=${JSON.stringify(report.refusedBecause)} ${tail}`);
  check(`the run was masked with the project's values (mode=${report.mode}, masked=${report.masked}, ${report.maskValueCount} values)`, report.mode === "real" && report.masked === true && Number(report.maskValueCount) >= 15);
  check(`the stored credential logged in and the RecipeAdapter replayed to the review page (login=${report.login}, executed=${report.executed}, ${report.finalUrlPath})`, report.login === "logged_in" && report.replayOk === true && /review/.test(String(report.finalUrlPath)));
  check("the flagged final submit had no target and was skipped; zero submit/pay POSTs; finalSubmitClicked false from every source",
    report.finalSubmitStepHasNoTarget === true && report.submitOrPayRequestsAborted === 0 && JSON.stringify(report.finalSubmitClickedSources) === "[false,false,false]", JSON.stringify([report.finalSubmitStepHasNoTarget, report.submitOrPayRequestsAborted, report.finalSubmitClickedSources]));
  check("the replica WALKED to review with nothing filed or paid, and holds every value the adapter committed", replica.state.reviewReached && replica.state.reviewVia === "walked" && replica.state.submitPosts.length === 0 && replica.state.payPosts.length === 0 && Object.keys(replica.state.values).length >= 26,
    `reached=${replica.state.reviewReached} via=${replica.state.reviewVia} values=${Object.keys(replica.state.values).length} errors=${replica.state.validationErrors.join("|")}`);
  // Hard rule 2's two values, bound by NAME (sensitive steps, no literal stored): they must have
  // REACHED the portal in this run, or the 0 OCR hits on them below would prove nothing.
  check("the SENSITIVE account and meter steps replayed from the project row (the portal holds both; nothing skipped)",
    replica.state.values["cust.account"] === B.accountNumber && replica.state.values["cust.meter"] === B.meterNumber && Array.isArray(report.skipped) && (report.skipped as unknown[]).length === 0,
    `account=${replica.state.values["cust.account"] ? "held" : "EMPTY"} meter=${replica.state.values["cust.meter"] ? "held" : "EMPTY"} skipped=${JSON.stringify(report.skipped)}`);
  check("the Cyrillic electrician REACHED the portal (the replica holds it), or its coverage below would prove nothing",
    replica.state.values["elec.name"] === E2E_ELECTRICIAN, `elec.name=${replica.state.values["elec.name"] ? "held (different)" : "EMPTY"}`);
  const audit = (report.maskAudit ?? null) as PiiMaskAudit | null;
  check(`REAL-RUN MASK AUDIT (geometry, in-page, at the review stop): rects carrying a value found and none outside a box (${audit ? `${audit.rectsChecked} rects, ${audit.uncovered} uncovered` : "NOT MEASURED"})`,
    !!audit && audit.rectsChecked >= 20 && audit.uncovered === 0, `${JSON.stringify(audit)} note=${report.maskAuditNote}`);
  // N3: the audit must not be fed ONLY the matcher's own output (a value the list builder
  // drops would then never be looked for — under an ASCII-only matcher the Cyrillic electrician
  // left the list AND the audit, and this section stayed green). The recorder audits the list
  // PLUS the raw source strings; the Cyrillic electrician is one of those whatever the matcher does.
  check(`the review-stop audit looked for the mask's list AND the raw source strings (${audit?.valuesChecked} checked = ${report.maskAuditValueCount} audited >= ${report.maskValueCount} masked), and the raw strings carry the Cyrillic electrician`,
    !!audit && audit.valuesChecked === Number(report.maskAuditValueCount) && Number(report.maskAuditValueCount) >= Number(report.maskValueCount) &&
    piiRawSourceStrings({ project: { parserSnapshot: { electricalSupervisorName: E2E_ELECTRICIAN } } }).includes(E2E_ELECTRICIAN));
  const hostsSeen = Object.keys((report.browserHostsSeen as Record<string, number>) ?? {});
  check("the only host the browser touched is the replica's (loopback)", hostsSeen.length === 1 && isLoopbackHost(hostsSeen[0]) && Number(report.nodeNetworkAttempts ? (report.nodeNetworkAttempts as unknown[]).length : 0) === 0, hostsSeen.join(","));
  check("the video and the step shots exist", fs.existsSync(out) && fs.existsSync(shotsDir) && fs.readdirSync(shotsDir).length >= 5, `video=${fs.existsSync(out)} shots=${fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).length : 0}`);
  if (!ocrReason && fs.existsSync(out)) {
    const e2eFrames = [...(fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).map((f) => path.join(shotsDir, f)) : [])];
    if (ffmpegAvailable()) e2eFrames.push(...sampleVideoFrames(out, path.join(e2eRoot, "frames"), 8));
    const text = ocrFrames(e2eFrames);
    // The recorder derives the values from the PROJECT ROW; the check uses the smoke's own
    // list (built from PROJECT_B), plus the dashboard's other application.
    const STRINGS = [...MASK_VALUES, ACCOUNT_LIST_VALUE];
    let hits = 0;
    const hitFrames: string[] = [];
    let labelFrames = 0;
    for (const [f, t] of text) {
      const h = piiHitsInText(t, STRINGS);
      if (h.length) { hits += h.length; hitFrames.push(`${path.basename(f)}(${h.length})`); }
      if (/customer information|installer information|terms and conditions|my projects|sign in/i.test(t)) labelFrames++;
    }
    check(`REAL-RUN RECORDING: 0 PII hits over ${text.size} frame(s) x ${STRINGS.length} OCR-readable string(s) — got ${hits} (the Cyrillic electrician is OCR-blind: the audit above covers it)`, text.size === e2eFrames.length && hits === 0, `frames with hits: ${hitFrames.slice(0, 8).join(", ")}`);
    check(`REAL-RUN RECORDING: the frames still read as the portal's pages (${labelFrames} of ${text.size} carry a page label)`, labelFrames > text.size / 2);
    console.log(`  OCR denominators (recorder path): ${text.size} frames / ${STRINGS.length} strings (+1 OCR-blind, audited by geometry) / ${hits} hits`);
  }
  await replica.close();
  console.log(`  real-run artifacts: ${e2eRoot}`);
}

console.log(`\n${checks - failures}/${checks} mask check(s) passed. Artifacts: ${work}`);
if (failures) { console.error(`${failures} demo-mask check(s) FAILED.`); process.exit(1); }
if (!ocrRan) { console.log(`SMOKE SKIPPED - OCR is not available here (${ocrReason}); the pixel check did not run (geometry and POST-identity checks passed).`); process.exit(SKIP_EXIT_CODE); }
console.log("All demo-mask checks passed (real Chromium + Windows OCR).");
process.exit(0);
