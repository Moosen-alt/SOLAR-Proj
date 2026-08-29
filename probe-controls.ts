// Find out what the re-anchor scan actually sees on a real PowerClerk page.
// The previous version reported "15 controls, 0 of interest" on all 12 iterations, which
// means it never left the first page — so this one reports WHERE IT IS before anything else,
// and screenshots each step. Reuses the authenticated profile; creates no new draft.
import "dotenv/config";
import path from "node:path";
import { openPortal, closePortal } from "./portal-bot/src/browser";
// The portal raises a "What's new?" popover that swallows every click. The first run of
// this probe sat behind it for all 14 steps — "Got it" was in the button list every time.
import { dismissPageModals, clearPageOverlays } from "./portal-bot/src/adapters/autoLearnAdapter";

const START = process.argv[2]
  || "https://pacificorpnetmetering.powerclerk.com/MvcProjects/EditProject?ProgramId=F33TFT5SRWAM&FormId=CWU8JM77M6CK&ProjectId=QS6TY7QARSY7";
const WANT = /description of service|meter mounted|opting in|wattsmart|account number|meter number/i;

const userDataDir = path.join(process.cwd(), "portal-profiles", "tml-international-llc", "powerclerk_pacificorp_nem_portal");
const opened = await openPortal({ userDataDir, headless: false });
const page = opened.page;
await page.goto(START, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await dismissPageModals(page);
await clearPageOverlays(page);

const shots = path.join(process.cwd(), "data", "screenshots");
for (let i = 0; i < 14; i++) {
  const info = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[];
    const rows = controls.map((el) => {
      const id = el.getAttribute("id") || "";
      const r = el.getBoundingClientRect();
      const forLbl = id ? (document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null) : null;
      const wrap = el.closest("label") as HTMLElement | null;
      const src = forLbl || wrap;
      return {
        tag: (el.tagName || "").toLowerCase(),
        type: el.getAttribute("type") || "",
        id,
        inner: ((src ? src.innerText : "") || "").trim().replace(/\s+/g, " ").slice(0, 44),
        text: ((src ? src.textContent : el.getAttribute("aria-label")) || "").trim().replace(/\s+/g, " ").slice(0, 44),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    // Every button/link the page offers, so a failed advance is explainable.
    const buttons = Array.from(document.querySelectorAll("button, a, [role=button], input[type=submit]"))
      .map((b) => ((b as HTMLElement).innerText || b.getAttribute("value") || "").trim().replace(/\s+/g, " "))
      .filter((t) => t && t.length < 40).slice(0, 16);
    return { url: location.href, title: document.title, rows, buttons };
  });

  const hits = info.rows.filter((r) => WANT.test(r.text) || WANT.test(r.inner));
  console.log(`\n--- step ${i} ---`);
  console.log(`url    ${info.url.slice(0, 118)}`);
  console.log(`title  ${info.title}`);
  console.log(`controls ${info.rows.length}, of interest ${hits.length}`);
  console.log(`buttons  ${JSON.stringify(info.buttons).slice(0, 200)}`);
  if (i === 0 || hits.length) {
    console.log("  first controls on this page:");
    for (const r of info.rows.slice(0, 10)) {
      console.log(`    <${r.tag}${r.type ? " type=" + r.type : ""}> id=${(r.id || "(none)").padEnd(20)} ${r.w}x${r.h}  text=${JSON.stringify(r.text)}`);
    }
  }
  await page.screenshot({ path: path.join(shots, `probe-step${String(i).padStart(2, "0")}.png`), fullPage: false }).catch(() => null);

  if (hits.length) {
    console.log("\n=== TARGET PAGE FOUND ===");
    for (const r of hits) {
      const vis = (r.w > 0 || r.h > 0) ? "VISIBLE" : "HIDDEN ";
      console.log(`  <${r.tag}> id=${r.id.padEnd(20)} ${String(r.w + "x" + r.h).padEnd(8)} ${vis}`);
      console.log(`      innerText  = ${JSON.stringify(r.inner)}`);
      console.log(`      textContent= ${JSON.stringify(r.text)}`);
    }
    const zero = info.rows.filter((r) => r.w === 0 && r.h === 0).length;
    const emptyInner = info.rows.filter((r) => !r.inner && r.text).length;
    console.log(`\nVERDICT: ${zero}/${info.rows.length} controls have ZERO SIZE (the scan's visibility filter drops these);`);
    console.log(`         ${emptyInner}/${info.rows.length} have EMPTY innerText but non-empty textContent (the scan reads innerText).`);
    break;
  }

  // Advance. Try the wizard's own Next, then the numbered step tabs.
  await dismissPageModals(page).catch(() => null);
  const next = page.getByRole("button", { name: /^Next$/i }).first();
  const n = await next.count().catch(() => 0);
  if (n) {
    await next.click({ timeout: 8000 }).catch((e: unknown) => console.log("  next click failed: " + String(e).slice(0, 90)));
  } else {
    console.log("  no Next button — trying the step tabs");
    const tab = page.locator(`text=/^${i + 2}$/`).first();
    if (!(await tab.count().catch(() => 0))) { console.log("  no tab either; stopping"); break; }
    await tab.click({ timeout: 8000 }).catch(() => null);
  }
  await page.waitForTimeout(3500);
}

console.log("\nscreenshots: data/screenshots/probe-step*.png");
await closePortal(opened);
