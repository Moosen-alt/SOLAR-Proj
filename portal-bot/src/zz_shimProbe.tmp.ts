/**
 * Adversarial probe for the NAME_SHIM finding.
 *
 * A) Through the REAL openPortal launcher (shim installed context-wide):
 *    exercise the real selectWithFallback partial-match pass (comboboxFill.ts:~409 `norm`)
 *    and the real fillCustomCombobox hidden-opener pass (~215 `isVis`).
 * B) Through a raw chromium.launch() with NO shim: same calls.
 *
 * If A passes and B fails, the finding's premise is confirmed: the sites are
 * latent-only because the shim neutralizes them.
 */
import { openPortal, closePortal } from "./browser";
import { selectWithFallback } from "./comboboxFill";

const NATIVE_HTML = `<html><body>
  <select id="sched">
    <option value="">Please select...</option>
    <option value="S7">Schedule 7 - Residential Net Metering</option>
    <option value="S8">Schedule 8 - Commercial</option>
  </select>
</body></html>`;

// A custom (non-select) widget whose trigger is display:none, so fillCustomCombobox
// must fall to the loc.evaluate hidden-opener walk that contains `isVis`.
const CUSTOM_HTML = `<html><body>
  <div id="wrap" class="form-select-wrap">
    <div id="display" class="form-select display" style="width:200px;height:24px;border:1px solid">Choose…</div>
    <input id="hiddenTrigger" role="combobox" style="display:none" />
  </div>
  <script>
    document.getElementById('display').addEventListener('click', function () {
      window.__openerClicked = true;
    });
  </script>
</body></html>`;

async function runNativePartial(page: any): Promise<{ ok: boolean; value: string; err: string }> {
  await page.setContent(NATIVE_HTML);
  const loc = page.locator("#sched");
  let err = "";
  let ok = false;
  try {
    ok = await selectWithFallback(page, loc, "Schedule 7");
  } catch (e) { err = String(e); }
  const value = await page.locator("#sched").inputValue().catch(() => "<unreadable>");
  return { ok, value, err };
}

// Direct replication of the exact :409 in-page callback, run through loc.evaluate,
// to see the raw ReferenceError rather than the swallowed .catch(() => "").
async function runRawNormCallback(page: any): Promise<string> {
  await page.setContent(NATIVE_HTML);
  const loc = page.locator("#sched");
  try {
    const v = await loc.evaluate((el: Element, want: string) => {
      if ((el.tagName || "").toLowerCase() !== "select") return "";
      const norm = (s: string) => (s || "").trim().toLowerCase();
      const w = norm(want);
      if (!w) return "";
      const options = Array.from((el as HTMLSelectElement).options).filter((o) => {
        const t = norm(o.textContent || "");
        return t && !/^(please\s+)?select\.{0,3}$/i.test(t);
      });
      for (const o of options) if (norm(o.textContent || "") === w) return o.value;
      for (const o of options) {
        const t = norm(o.textContent || "");
        if (t.includes(w) || w.includes(t)) return o.value;
      }
      return "";
    }, "Schedule 7");
    return `OK:${v}`;
  } catch (e) {
    return `THREW: ${String(e).split("\n")[0]}`;
  }
}

// Direct replication of the exact :215 hidden-opener in-page callback.
async function runRawIsVisCallback(page: any): Promise<string> {
  await page.setContent(CUSTOM_HTML);
  const loc = page.locator("#hiddenTrigger");
  try {
    await loc.evaluate((el: Element) => {
      const isVis = (n: Element) => {
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n as HTMLElement);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      let root: Element = el;
      for (let k = 0; k < 5 && root.parentElement; k++) {
        root = root.parentElement;
        const cands = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
          (n) => n !== el && n.getAttribute("role") !== "listbox" && n.getAttribute("role") !== "option" && isVis(n),
        );
        if (!cands.length) continue;
        const preferred = cands.find(
          (n) => /form-select|\bselect\b|display|toggle|control|dropdown/i.test(n.className || "") || n.getAttribute("role") === "button",
        );
        (preferred || cands[0]).click();
        return;
      }
    });
    const clicked = await loc.page().evaluate(() => (window as any).__openerClicked === true).catch(() => false);
    return `OK: openerClicked=${clicked}`;
  } catch (e) {
    return `THREW: ${String(e).split("\n")[0]}`;
  }
}

async function main() {
  console.log("=== A) through the REAL openPortal launcher (ephemeral mode, shim installed) ===");
  const opened = await openPortal({ headless: true });
  const shimPresent = await opened.page.evaluate(() => typeof (globalThis as any).__name);
  console.log(`  typeof globalThis.__name on a fresh page: ${shimPresent}`);
  console.log(`  raw :409 norm callback  -> ${await runRawNormCallback(opened.page)}`);
  console.log(`  raw :215 isVis callback -> ${await runRawIsVisCallback(opened.page)}`);
  const a = await runNativePartial(opened.page);
  console.log(`  real selectWithFallback('Schedule 7') -> returned=${a.ok} selectValue=${JSON.stringify(a.value)} err=${a.err}`);
  await closePortal(opened);

  console.log("\n=== B) raw chromium.launch(), NO shim ===");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const shimB = await page.evaluate(() => typeof (globalThis as any).__name);
  console.log(`  typeof globalThis.__name on a fresh page: ${shimB}`);
  console.log(`  raw :409 norm callback  -> ${await runRawNormCallback(page)}`);
  console.log(`  raw :215 isVis callback -> ${await runRawIsVisCallback(page)}`);
  const b = await runNativePartial(page);
  console.log(`  real selectWithFallback('Schedule 7') -> returned=${b.ok} selectValue=${JSON.stringify(b.value)} err=${b.err}`);
  await browser.close();

  console.log("\n=== C) does openPortal's shim survive a real navigation + SPA re-render? ===");
  const opened2 = await openPortal({ headless: true });
  await opened2.page.goto("data:text/html,<html><body><div id=x>hi</div></body></html>");
  const afterNav = await opened2.page.evaluate(() => typeof (globalThis as any).__name);
  console.log(`  after goto(data:) typeof __name = ${afterNav}`);
  console.log(`  raw :409 after nav -> ${await runRawNormCallback(opened2.page)}`);
  await closePortal(opened2);
}

main().then(() => process.exit(0)).catch((e) => { console.error("PROBE FAILED", e); process.exit(1); });
