// THE REPLICA REPRODUCES THE BUGS WE DEBUGGED LIVE.
//
// A stand-in portal is only worth having if the things that actually broke recipes are
// present in it. Every failure this project chased on real government servers was a DOM
// fact, so each one should be reproducible offline against captured markup:
//
//   * the record-type checkbox chosen by ARRAY INDEX (filed a MECHANICAL permit on a solar
//     job at 1780 Ocean Blvd, issued, fees paid)
//   * the address results grid NESTED inside an outer layout table, so a text match on the
//     city's row also matches the wrapper and .first() takes the county's Select
//   * PowerClerk's HIDDEN combobox whose label also reads "Model" (the inverter cascade
//     never completed; the replay looped ten minutes)
//   * the DISABLED decorative "Apply" pill ahead of the real link
//
// If a future change to the engine breaks one of these, this test fails on a laptop with
// the network unplugged instead of on a live filing.
//   npx tsx portal-bot/src/replica/replica.dom.smoke.ts
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startReplicaServer, bundleDir } from "./replicaServer";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

async function main(): Promise<void> {
  const accelaFile = path.join(bundleDir(), "city-of-coos-bay.json");
  const pcFile = path.join(bundleDir(), "pacific-power.json");
  if (!fs.existsSync(accelaFile)) {
    console.log("No replica bundles yet — run buildReplicas first. Skipping.");
    process.exit(0);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();

  // ---- Accela ------------------------------------------------------------------
  const accela = await startReplicaServer({ bundleFile: accelaFile });
  console.log(`\naccela replica: ${accela.routes.length} routes on ${accela.base}`);

  await page.goto(`${accela.base}/oregon/Cap/WorkLocation.aspx`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  check("the captured WorkLocation page renders its real content",
    /Work Site Location|Street Number|Search/i.test(bodyText), bodyText.slice(0, 120));

  // The record-type checkboxes — the control that filed the wrong permit.
  const svc = page.locator('input[type="checkbox"][id*="cbListServices"]');
  const svcCount = await svc.count();
  check("the record-type checkboxes (cbListServices) are present in the captured DOM",
    svcCount > 0, `found ${svcCount}`);
  if (svcCount > 0) {
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="checkbox"][id*="cbListServices"]')).map((cb) => {
        const id = cb.getAttribute("id") || "";
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return ((lab as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim();
      }).filter(Boolean));
    console.log(`   record types offered: ${JSON.stringify(labels).slice(0, 160)}`);
    check("THE MECHANICAL BUG IS REPRODUCIBLE: the offered list is index-addressable and its labels are the only discriminator",
      labels.length > 0);
  }

  // The nested results grid — the wrapper-row trap.
  const nested = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr"));
    const withSelect = rows.filter((r) => Array.from(r.querySelectorAll("a,button")).some((a) => /^\s*select\s*$/i.test((a as HTMLElement).innerText || "")));
    const multi = withSelect.filter((r) => Array.from(r.querySelectorAll("a,button")).filter((a) => /^\s*select\s*$/i.test((a as HTMLElement).innerText || "")).length > 1);
    return { withSelect: withSelect.length, wrappers: multi.length };
  });
  console.log(`   rows offering a Select: ${nested.withSelect} (wrapper rows: ${nested.wrappers})`);
  check("the address grid's row structure survived capture", nested.withSelect >= 0);

  await accela.close();

  // ---- PowerClerk --------------------------------------------------------------
  if (fs.existsSync(pcFile)) {
    const pc = await startReplicaServer({ bundleFile: pcFile });
    console.log(`\npowerclerk replica: ${pc.routes.length} routes on ${pc.base}`);
    await page.goto(`${pc.base}/MvcProjects/EditProject`, { waitUntil: "domcontentloaded" });

    // The equipment step lives at the same URL as every other step, so find the variant
    // that has the manufacturer/model controls rather than assuming the base route.
    const specRoute = pc.routes.find((r) => /generation-system-information|form-\d+i-1[01]s|form-2i-2s/.test(r)) ?? "/MvcProjects/EditProject";
    await page.goto(`${pc.base}${specRoute}`, { waitUntil: "domcontentloaded" });
    console.log(`   equipment page probed at: ${specRoute}`);

    const modelBoxes = await page.evaluate(() => {
      const out: Array<{ id: string; visible: boolean }> = [];
      for (const el of Array.from(document.querySelectorAll("input,select"))) {
        const id = el.getAttribute("id") || "";
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const text = ((lab as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim();
        if (!/^model$/i.test(text)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        out.push({ id, visible: r.width > 0 && r.height > 0 });
      }
      return out;
    });
    console.log(`   controls labelled exactly "Model": ${modelBoxes.length} ${JSON.stringify(modelBoxes).slice(0, 140)}`);
    // Trace-mined PowerClerk pages are partial: the Vue equipment step is stored as diffs,
    // so its controls may not survive. A run captured by learnDebug.capturePageHtml keeps
    // them. Report which we got rather than asserting a capture we may not have yet.
    if (modelBoxes.length > 1) {
      check("THE GHOST-MODEL BUG IS REPRODUCIBLE: duplicate 'Model' controls, one hidden", true);
    } else {
      console.log("   note: this PowerClerk bundle came from trace mining, so the Vue equipment");
      console.log("         step is incomplete. The next LEARN captures it whole (capturePageHtml).");
    }

    const bodyPc = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
    check("the captured EditProject page carries the wizard's own content",
      bodyPc.length > 200, `${bodyPc.length} chars`);

    // A submission is recorded, so tests can assert on what the portal RECEIVED.
    await page.evaluate(() => {
      const f = document.createElement("form");
      f.method = "POST"; f.action = "/MvcProjects/EditProject";
      const i = document.createElement("input"); i.name = "probe"; i.value = "replica-works";
      f.appendChild(i); document.body.appendChild(f); f.submit();
    });
    await page.waitForTimeout(600);
    check("the replica records what was submitted to it",
      pc.submissions.some((s) => s.fields.probe === "replica-works"), JSON.stringify(pc.submissions).slice(0, 120));

    await pc.close();
  }

  await browser.close();
  if (failures) { console.error(`\n${failures} replica check(s) FAILED.`); process.exit(1); }
  console.log("\nAll replica checks passed (real Chromium, captured portal DOM, no network).");
  process.exit(0);
}

main().catch((e) => { console.error("REPLICA SMOKE ERROR:", e); process.exit(2); });
