// THE REPLICA REPRODUCES THE BUGS WE DEBUGGED LIVE — AND THE BOT'S OWN CODE IS RUN AGAINST IT.
//
// A stand-in portal is only worth having if the things that actually broke recipes are
// present in it. Every failure this project chased on real government servers was a DOM
// fact, so each one should be reproducible offline against captured markup:
//
//   * the record-type checkbox chosen by ARRAY INDEX (filed a MECHANICAL permit on a solar
//     job, issued, fees paid)
//   * the address results grid NESTED inside an outer layout table
//   * PowerClerk's HIDDEN combobox whose label also reads "Model"
//
// This file used to import only the replica server: it proved the capture renders, three of
// its checks could not fail (`>= 0`, `check(..., true)`, `labels.length > 0`), and a missing
// bundle printed "Skipping." and EXITED 0 — which the runner counted as a pass. Now:
//   - the record-type guard is exercised by RUNNING RecipeAdapter's own step executor against
//     the captured Accela page: an unoffered type is refused with nothing checked (the
//     positional fallback is present in the DOM and must not fire), an offered type is checked
//     by its label;
//   - the ghost-Model shape is judged by the shared visibility predicate;
//   - a section whose inputs are absent is REPORTED as skipped with a denominator, and a
//     missing Accela bundle is a whole-smoke SKIP (exit 3 + "SMOKE SKIPPED -"), never a pass.
//   - every request that is not to the local replica is ABORTED and counted: a replica run
//     never reaches a real portal.
// Captured pages come from real runs: this prints counts, never labels, values or text.
//   npx tsx portal-bot/src/replica/replica.dom.smoke.ts
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "../adapters/recipeAdapter";
import { visibilityOf } from "../visibility";
import { startReplicaServer, bundleDir } from "./replicaServer";

let failures = 0;
let ran = 0;
const skippedSections: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  ran++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const skipSection = (name: string, why: string): void => {
  skippedSections.push(`${name}: ${why}`);
  console.log(`  skip - ${name}: ${why}`);
};

const SKIP_EXIT_CODE = 3;

/** Await a teardown step, but never for more than 10s — a hung close must not hang the suite. */
const bounded = async (p: Promise<unknown>, what: string): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((r) => { timer = setTimeout(() => { console.log(`   note: ${what} did not finish in 10s — moving on`); r(); }, 10_000); });
  await Promise.race([p.then(() => undefined, () => undefined), late]);
  if (timer) clearTimeout(timer);
};
const replicas: Array<{ close(): Promise<void> }> = [];

async function main(): Promise<void> {
  const accelaFile = path.join(bundleDir(), "city-of-coos-bay.json");
  const pcFile = path.join(bundleDir(), "pacific-power.json");
  if (!fs.existsSync(accelaFile)) {
    console.log(`SMOKE SKIPPED - no replica bundle at ${path.relative(process.cwd(), accelaFile)} (run npm run replica:build). Nothing was asserted.`);
    process.exit(SKIP_EXIT_CODE);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  let blockedExternal = 0;
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue();
    blockedExternal++;
    return route.abort();
  });
  const page = await context.newPage();

  // ---- Accela ------------------------------------------------------------------
  const accela = await startReplicaServer({ bundleFile: accelaFile });
  console.log(`\naccela replica: ${accela.routes.length} routes`);

  await page.goto(`${accela.base}/oregon/Cap/WorkLocation.aspx`, { waitUntil: "domcontentloaded" });
  const bodyText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  check("the captured WorkLocation page renders its real content",
    /Work Site Location|Street Number|Search/i.test(bodyText), `${bodyText.length} chars`);

  // The record-type checkboxes — the control that filed the wrong permit.
  const offered = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="checkbox"][id*="cbListServices"]')).map((cb) => {
      const id = cb.getAttribute("id") || "";
      const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return { id, label: ((lab as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim() };
    }));
  console.log(`   record types offered: ${offered.length}`);
  if (offered.length < 2 || !offered.some((o) => o.label)) {
    skipSection("record-type guard", `the capture offers ${offered.length} labelled record type(s); the positional trap needs >= 2`);
  } else {
    const recipe = { id: "replica", scopeType: "ahj", profileKey: "replica", state: "OR", ahj: "Replica", utility: "",
      portalPlatform: "accela", portalUrl: accela.base, status: "complete", version: 1, steps: [],
      createdBy: "t", createdAt: "", updatedAt: "", notes: "" } as unknown as PortalRecipe;
    const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
    (adapter as unknown as { page: unknown }).page = page;
    const run = (step: RecipeStep): Promise<unknown> =>
      (adapter as unknown as { executeStep(s: RecipeStep, pastReview: boolean): Promise<boolean> }).executeStep(step, false);
    const checkedIds = (): Promise<string[]> => page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="checkbox"][id*="cbListServices"]')).filter((c) => (c as HTMLInputElement).checked).map((c) => c.id));

    // A type this list does not offer, recorded WITH the positional fallback that fired live.
    const labels = new Set(offered.map((o) => o.label.toLowerCase()));
    const absent = ["Residential - Electrical", "Residential - Solar Photovoltaic", "Residential - Nonexistent Discipline"]
      .find((l) => ![...labels].some((x) => x.includes(l.toLowerCase())))!;
    const fallbackId = offered[1].id;
    let refusal = "";
    await run({ action: "check", selector: { label: absent, fallbacks: [{ css: `#${fallbackId}` }] }, note: absent })
      .catch((e: unknown) => { refusal = String((e as Error)?.message ?? e); });
    const afterRefusal = await checkedIds();
    check("RecipeAdapter REFUSES a record type this jurisdiction does not offer",
      /not offered/i.test(refusal), refusal ? "(refused for another reason)" : "(no refusal — it proceeded)");
    check("...and the positional fallback present in the captured DOM did NOT fire (nothing checked)",
      afterRefusal.length === 0, `${afterRefusal.length} box(es) checked`);

    // A type it DOES offer, with a fallback pointing at a DIFFERENT box: the label must win.
    const target = offered.find((o, i) => i !== 0 && o.label && offered.filter((x) => x.label.toLowerCase().includes(o.label.toLowerCase())).length === 1);
    if (!target) {
      skipSection("record type checked by label", "no offered label is unambiguous in this capture");
    } else {
      let err = "";
      await run({ action: "check", selector: { label: target.label, fallbacks: [{ css: `#${offered[0].id}` }] }, note: target.label })
        .catch((e: unknown) => { err = String((e as Error)?.message ?? e).slice(0, 80); });
      const now = await checkedIds();
      check("an offered record type is checked by its LABEL, not by the recorded position",
        !err && now.length === 1 && now[0] === target.id, err ? "(threw)" : `${now.length} checked, label match=${now[0] === target.id}`);
    }
  }

  // The nested results grid — the wrapper-row trap. Reported, not asserted, when absent.
  const nested = await page.evaluate(() => {
    const isSelect = (a: Element): boolean => /^\s*select\s*$/i.test((a as HTMLElement).innerText || "");
    const rows = Array.from(document.querySelectorAll("tr"));
    const withSelect = rows.filter((r) => Array.from(r.querySelectorAll("a,button")).some(isSelect));
    return { withSelect: withSelect.length, wrappers: withSelect.filter((r) => Array.from(r.querySelectorAll("a,button")).filter(isSelect).length > 1).length };
  });
  console.log(`   rows offering a Select: ${nested.withSelect} (wrapper rows: ${nested.wrappers})`);
  if (nested.wrappers === 0) skipSection("nested address grid", "this capture has no wrapper row around the results grid");
  else check("the wrapper row contains MORE than one Select (the trap is present)", nested.wrappers > 0 && nested.withSelect > nested.wrappers);

  replicas.push(accela);

  // ---- PowerClerk --------------------------------------------------------------
  if (!fs.existsSync(pcFile)) {
    skipSection("powerclerk", "no pacific-power replica bundle");
  } else {
    const pc = await startReplicaServer({ bundleFile: pcFile });
    console.log(`\npowerclerk replica: ${pc.routes.length} routes`);
    const specRoute = pc.routes.find((r) => /generation-system-information|form-\d+i-1[01]s|form-2i-2s/.test(r)) ?? "/MvcProjects/EditProject";
    await page.goto(`${pc.base}${specRoute}`, { waitUntil: "domcontentloaded" });

    const modelIds = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll("input,select"))) {
        const id = el.getAttribute("id") || "";
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (/^model$/i.test(((lab as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim()) && id) out.push(id);
      }
      return out;
    });
    console.log(`   controls labelled exactly "Model": ${modelIds.length}`);
    if (modelIds.length < 2) {
      // Trace-mined PowerClerk bundles store the Vue equipment step as diffs, so its controls may
      // not survive. A bundle rebuilt from learnDebug.capturePageHtml keeps them.
      skipSection("ghost Model", `${modelIds.length} "Model" control(s) in this capture; the trap needs a visible one and a hidden twin`);
    } else {
      const verdicts = await Promise.all(modelIds.map((id) => visibilityOf(page.locator(`[id="${id}"]`))));
      check("THE GHOST-MODEL SHAPE: among the 'Model' namesakes the shared predicate finds a visible one AND a hidden twin",
        verdicts.some((v) => v.visible) && verdicts.some((v) => !v.visible),
        JSON.stringify(verdicts.map((v) => v.visible)));
    }

    const bodyPc = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").length);
    check("the captured EditProject page carries the wizard's own content", bodyPc > 200, `${bodyPc} chars`);

    // A submission is recorded, so tests can assert on what the portal RECEIVED.
    await page.evaluate(() => {
      const f = document.createElement("form");
      f.method = "POST"; f.action = "/MvcProjects/EditProject";
      const i = document.createElement("input"); i.name = "probe"; i.value = "replica-works";
      f.appendChild(i); document.body.appendChild(f); f.submit();
    });
    await page.waitForTimeout(600);
    check("the replica records what was submitted to it", pc.submissions.some((s) => s.fields.probe === "replica-works"));
    replicas.push(pc);
  }

  console.log(`   external requests aborted (never reached a real portal): ${blockedExternal}`);
  // TEARDOWN ORDER: the browser first, then the servers, each bounded. A replica server's
  // close() waits for the page's open keep-alive connections, so closing it while the page still
  // held one hung this smoke (flaky: 1 run in 2 sat until killed; once, fifty minutes).
  await bounded(browser.close(), "browser.close");
  for (const r of replicas) await bounded(r.close(), "replica.close");

  // THE DENOMINATOR: what ran, and what could not be asserted on this capture.
  console.log(`\nreplica smoke: ${ran} check(s) ran, ${failures} failed; ${skippedSections.length} section(s) skipped` +
    `${skippedSections.length ? ` — ${skippedSections.join(" | ")}` : ""}`);
  if (failures) { console.error(`\n${failures} replica check(s) FAILED.`); process.exit(1); }
  console.log("All replica checks that could run passed (real Chromium, captured portal DOM, no network).");
  process.exit(0);
}

main().catch((e) => { console.error("REPLICA SMOKE ERROR:", e); process.exit(2); });
