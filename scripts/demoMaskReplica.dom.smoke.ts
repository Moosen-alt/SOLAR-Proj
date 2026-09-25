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
//   GEOMETRY — independently of OCR, every control and text range that carries a raw value
//            sits under an overlay box at each step (a platform-independent check that runs
//            even where no OCR engine exists).
//
// The driver uses the primitives the replay engine uses (fill + Tab to commit, selectOption,
// setInputFiles, a typed date dismissed with Escape, click Next). The real RecipeAdapter is
// NOT driven here: no recipe in the repo replays the PowerClerk replica to review through it
// yet (bench 2026-09-24: 14/28 fields, review not reached) — that is an open item, not a claim.
//
// Also pinned: the recorder's real-run guard refuses, from its CLI and before any database is
// read, a --real-run without --i-am-present, with PORTAL_ALLOW_FINAL_SUBMIT set, or headless.
//
//   npx tsx scripts/demoMaskReplica.dom.smoke.ts            (real Chromium; ~2-3 minutes)
//   npx tsx scripts/run-dom-smokes.ts --only demoMaskReplica --concurrency 1
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { buildWizard, type DocKey } from "../portal-bot/src/replica/fixtures/wizards";
import { PROJECT_A, PROJECT_B, aOnlyLiterals } from "../portal-bot/src/replica/fixtures/syntheticProjects";
import { startSyntheticReplica, type ReplicaState } from "../portal-bot/src/replica/syntheticServer";
import { scoreRun } from "../portal-bot/src/replica/benchScore";
import { isLoopbackHost } from "./demo-portal/network";
import { PII_MASK_LAYER_ID, piiMaskInitScript, piiMaskShapesFor, piiMaskValues } from "./lib/piiMask";
import { ffmpegAvailable, ocrFrames, ocrUnavailableReason, piiHitsInText, sampleVideoFrames } from "./lib/ocrFrames";
import { realRunRefusals } from "./lib/realRunGuard";

const SKIP_EXIT_CODE = 3;
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

/** Independent of the masker: every control and text range that carries a RAW value must sit
 *  under an overlay box. Returns descriptors (element ids / "text") — never the values. */
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
    const shown = e.tagName === "SELECT" ? ((e as HTMLSelectElement).selectedOptions[0]?.textContent || "") : e.value;
    if (!raw.some((v) => shown.toLowerCase().includes(v.toLowerCase()))) continue;
    const r = e.getBoundingClientRect();
    if (onScreen(r) && !covered(r)) out.push(`field#${e.id || e.name}`);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest("script,style,option") || (layer && layer.contains(p))) continue;
    const text = n.nodeValue || "";
    for (const v of raw) {
      let at = text.toLowerCase().indexOf(v.toLowerCase());
      while (at >= 0) {
        const range = document.createRange();
        range.setStart(n, at); range.setEnd(n, at + v.length);
        for (const r of Array.from(range.getClientRects())) if (onScreen(r) && !covered(r)) out.push(`text@${p.tagName.toLowerCase()}#${p.id || p.className || "?"}`);
        at = text.toLowerCase().indexOf(v.toLowerCase(), at + 1);
      }
    }
  }
  return out;
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
  check(`MASKED: 0 PII hits over ${mText.size} frame(s) x ${STRINGS.length} string(s) — got ${mHits}`, mHits === 0, `frames with hits: ${mHitFrames.slice(0, 10).join(", ")}`);
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
  console.log(`  OCR denominators: masked ${mText.size} frames / ${STRINGS.length} strings / ${mHits} hits; unmasked ${uText.size} frames / ${STRINGS.length} strings / ${uHits} hits`);
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

console.log(`\n${checks - failures}/${checks} mask check(s) passed. Artifacts: ${work}`);
if (failures) { console.error(`${failures} demo-mask check(s) FAILED.`); process.exit(1); }
if (!ocrRan) { console.log(`SMOKE SKIPPED - OCR is not available here (${ocrReason}); the pixel check did not run (geometry and POST-identity checks passed).`); process.exit(SKIP_EXIT_CODE); }
console.log("All demo-mask checks passed (real Chromium + Windows OCR).");
process.exit(0);
