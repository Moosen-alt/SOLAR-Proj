// =================================================================================================
// THE DASHBOARD'S HALF OF THE FIVE-STAGE PIPELINE, AND THE ONE RULE THE SUB-STAGE CHIP MUST OBEY.
//
// The operator called the status sub-stages "jank". The dashboard's share of that was three things:
//
//   (A) SIX STAGES WHERE THERE ARE FIVE. "Intake" was permanently complete the moment a project
//       existed — upload and parse happen together in the parser, so a project is born `parsed`.
//       Removed on 2026-09-19 by operator ruling. The numbering in this file set is a CHAIN:
//       PROJECT_STAGES labels, the accordion data-stage-index values, the accordion titles, the
//       action-button numbers, the Next-step banner's "Stage N", the filter optgroups and the
//       review page's strip all say the same number for the same stage, or the operator is
//       reading two pipelines at once. Nothing in the old six-stage copy contained the digit 6
//       — "4 · Prepare Submittal" is exactly as stale as "six stages" — so this pins the CHAIN,
//       not the word.
//
//   (B) DEAD VOCABULARY RENDERED AS LIVE UI. `intake_uploaded`, `submit_staging` and
//       `resubmit_staging` had zero writers anywhere, yet carried friendly labels, operator
//       instructions in the Next-step banner, and board filter options that could only ever
//       return nothing. Removed from ProjectStatus in the same round; this pins that none of
//       the three came back to the screen.
//
//   (C) AN UNKNOWN THAT READS AS REASSURANCE. `stage_detail` is "" for every row that existed
//       before the column did, and for any project whose state no writer has claimed. The chip
//       for it must render NOTHING AT ALL — no "—", no neutral pill, no empty shell. A
//       placeholder there invents progress nobody reported, on the exact screen an operator
//       uses to decide what to do next. That is the check this file exists for, and it is
//       asserted at the DOM level (zero child elements, zero text) rather than as a string
//       comparison, because an empty <span class="chip"> IS a visible pill.
//
// NOT A COPY OF THE RENDERERS. `stageDetailChipHtml`, `renderStatusOverride`, `esc`, `humanize`
// and `STATUS_LABELS` are lifted OUT OF THE SHIPPED frontend/dashboard.js by brace-matching and
// run here — the same idiom backend/test/requiredApplicationSet.test.ts uses. A copy would go on
// passing after somebody changed the real one. The markup is the shipped frontend/dashboard.html,
// loaded into a real browser with every subresource blocked, so dashboard.js never runs and the
// DOM under test is exactly what ships.
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/stageUiContract.dom.smoke.ts`
// =================================================================================================

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// Read with the line ending the file actually has: a `\n}` scan silently finds nothing in a
// CRLF checkout, which would read as "the renderer is missing" rather than "the harness is wrong".
const read = (f: string): string => fs.readFileSync(path.join(FRONTEND, f), "utf8").replace(/\r\n/g, "\n");

const dashboardJs = read("dashboard.js");
const dashboardHtml = read("dashboard.html");
const reviewHtml = read("review.html");
const css = read("styles.css");

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

// ── lifting the real source ──────────────────────────────────────────────────────────────────
// Brace/bracket-matched so exactly one declaration comes out regardless of what follows it.
function cut(kind: "function" | "const", name: string): string {
  const needle = kind === "function" ? `function ${name}(` : `const ${name} = `;
  const at = dashboardJs.indexOf(needle);
  if (at < 0) throw new Error(`${name} is gone from dashboard.js — re-point this smoke`);
  const rel = dashboardJs.slice(at).search(/[{[]/);
  if (rel < 0) throw new Error(`no opening brace/bracket after ${name}`);
  const openAt = at + rel;
  const open = dashboardJs[openAt];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = openAt; j < dashboardJs.length; j++) {
    if (dashboardJs[j] === open) depth++;
    else if (dashboardJs[j] === close && --depth === 0) {
      return dashboardJs.slice(at, j + 1) + (kind === "const" ? ";" : "");
    }
  }
  throw new Error(`unbalanced ${open}${close} reading ${name}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// The esbuild keepNames transform wraps nameable functions as __name(fn); a raw page has no such
// global, so anything declared inside page.evaluate throws ReferenceError and a .catch() would
// quietly turn that into "found nothing". Same shim every other dom smoke uses.
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const page = await ctx.newPage();
// Hermetic: nothing this page references is part of this contract, and crucially dashboard.js
// must NOT execute — the DOM under test is the shipped markup, not the markup after a render.
await page.route("**/*", (route: { abort(): Promise<void> }) => route.abort());
await page.setContent(dashboardHtml, { waitUntil: "domcontentloaded" });
await page.addStyleTag({ content: css });

try {
  // ===========================================================================================
  console.log("\n[1] THE SUB-STAGE CHIP: an unknown renders NOTHING");
  // ===========================================================================================
  const chipBundle = [cut("function", "esc"), cut("function", "humanize"), cut("function", "stageDetailChipHtml")].join("\n\n");

  type ChipProbe = { html: string; children: number; text: string; tags: string[] };
  const renderChip = (project: unknown): Promise<ChipProbe> =>
    page.evaluate(
      ([src, proj]: [string, unknown]) => {
        const fn = new Function(`${src}\nreturn stageDetailChipHtml;`)() as (p: unknown) => string;
        const html = fn(proj);
        const box = document.createElement("div");
        box.innerHTML = html;
        document.body.appendChild(box);
        const out = {
          html,
          children: box.childElementCount,
          text: (box.textContent || "").trim(),
          tags: Array.from(box.querySelectorAll("*")).map((el) => el.tagName.toLowerCase()),
        };
        box.remove();
        return out;
      },
      [chipBundle, project] as [string, unknown],
    );

  // THE RULE. Four shapes of "nobody has said anything about this project's sub-stage", and all
  // four must put zero elements and zero characters on the screen. `""` is the one that matters
  // most: it is what mapProject ships for every pre-existing row in the live database today.
  const unknowns: Array<[string, unknown]> = [
    ["the field is absent entirely (a payload from before the column existed)", {}],
    ['stageDetail is "" (what mapProject ships for every unclaimed row)', { stageDetail: "" }],
    ["stageDetail is null", { stageDetail: null }],
    ["stageDetail is whitespace only", { stageDetail: "   " }],
    ["the project object itself is null", null],
  ];
  for (const [label, project] of unknowns) {
    const probe = await renderChip(project);
    check(
      `no chip when ${label}`,
      probe.children === 0 && probe.text === "",
      `rendered ${probe.children} element(s) [${probe.tags.join(",")}] and text ${JSON.stringify(probe.text)} — `
      + "an empty pill or a dash here invents progress nobody reported",
    );
  }

  // The other half: a sub-stage that WAS recorded has to actually show up, or the check above
  // would pass just as well on a function that returns "" for everything.
  const known = await renderChip({ stageDetail: "staged_for_review" });
  check(
    "a recorded stage_detail DOES render exactly one chip, humanized",
    known.children === 1 && known.tags.join(",") === "span" && known.text === "Staged For Review",
    `children=${known.children} tags=[${known.tags.join(",")}] text=${JSON.stringify(known.text)}`,
  );
  check(
    "...and it carries the stage-detail-chip class the stylesheet targets",
    /class="[^"]*\bstage-detail-chip\b/.test(known.html),
    known.html,
  );

  // esc() EVERYTHING into innerHTML. stage_detail is a backend enum today, but the chip is the
  // renderer, and a renderer that trusts its input is one writer away from being wrong.
  const hostile = await renderChip({ stageDetail: `x" onmouseover="alert(1)` + `<img src=q onerror="document.title='pwned'">` });
  const title = await page.evaluate(() => document.title);
  check(
    "a hostile stage_detail is escaped: no injected element, no executed handler",
    !hostile.tags.includes("img") && title !== "pwned" && hostile.children === 1,
    `tags=[${hostile.tags.join(",")}] title=${JSON.stringify(title)}`,
  );

  // A NEW FIELD WITH NO PRODUCTION CALLER IS THE BUG.
  const pillBody = dashboardJs.slice(dashboardJs.indexOf("function stagePillHtml(project) {"));
  check(
    "stagePillHtml CALLS the chip — the row pill is the production caller",
    /stageDetailChipHtml\(project\)/.test(pillBody.slice(0, 900)),
    pillBody.slice(0, 600),
  );
  check(
    "the project header's Status metric is the second caller (textContent, never innerHTML)",
    /\$\("metricStageDetail"\)/.test(dashboardJs) && /stageDetailEl\.textContent/.test(dashboardJs),
  );

  // The header chip's "renders nothing" is enforced by markup + stylesheet, not by JS: the span
  // ships `hidden` and empty. .chip sets display:inline-flex, which OUTRANKS the UA [hidden]
  // rule — without an explicit [hidden] rule the header would carry a visible empty pill.
  const headerChip = await page.evaluate(() => {
    const el = document.getElementById("metricStageDetail");
    if (!el) return null;
    return {
      hidden: (el as HTMLElement).hidden,
      text: (el.textContent || "").trim(),
      display: getComputedStyle(el).display,
    };
  });
  check("the header sub-stage chip exists in the shipped markup", headerChip !== null);
  check(
    "...and ships hidden, empty, and computing to display:none",
    !!headerChip && headerChip.hidden && headerChip.text === "" && headerChip.display === "none",
    JSON.stringify(headerChip),
  );

  // ===========================================================================================
  console.log("\n[2] FIVE STAGES, AND THE NUMBERS AGREE WITH EACH OTHER");
  // ===========================================================================================
  const EXPECTED = ["QC / Verify", "Build & Validate", "Submit", "Track Approvals", "Closeout"];

  const accordions = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".stage-accordion[data-stage-index]")).map((el) => ({
      index: (el as HTMLElement).dataset.stageIndex,
      id: el.id,
      name: (el.querySelector(".stage-name")?.textContent || "").trim(),
    })));
  check(
    `dashboard.html ships exactly ${EXPECTED.length} stage accordions`,
    accordions.length === EXPECTED.length,
    `found ${accordions.length}: ${accordions.map((a) => `${a.index}:${a.name}`).join(" | ")}`,
  );
  check(
    "their data-stage-index values are 0..4, contiguous and in document order",
    accordions.map((a) => a.index).join(",") === EXPECTED.map((_, i) => String(i)).join(","),
    accordions.map((a) => a.index).join(","),
  );
  check(
    "each accordion title is numbered 1..5 and names its stage",
    accordions.every((a, i) => a.name === `${i + 1} · ${EXPECTED[i]}`),
    accordions.map((a) => a.name).join(" | "),
  );
  check(
    "no Intake accordion survives",
    !accordions.some((a) => /intake/i.test(a.id) || /intake/i.test(a.name)),
    accordions.map((a) => `${a.id}=${a.name}`).join(" | "),
  );

  // The Intake accordion held ONE panel — Project Documents — and deleting the section without
  // rehoming it would silently remove the only upload affordance on the project screen. Every id
  // dashboard.js reaches for must still resolve, and the panel must now live inside QC / Verify.
  const DOC_IDS = ["projectDocsList", "projectDocsCount", "docUploadType", "docUploadFile", "docUploadBtn", "docUploadStatus"];
  const docHome = await page.evaluate((ids: string[]) => {
    const missing = ids.filter((id) => !document.getElementById(id));
    const host = document.getElementById("projectDocsList")?.closest(".stage-accordion");
    return { missing, hostIndex: host ? (host as HTMLElement).dataset.stageIndex : null, hostId: host ? host.id : null };
  }, DOC_IDS);
  check(
    "every Project Documents id survived the move",
    docHome.missing.length === 0,
    `missing: ${docHome.missing.join(", ")} — the upload affordance went down with the Intake section`,
  );
  check(
    "...and the panel now lives in stage 0, QC / Verify",
    docHome.hostIndex === "0" && docHome.hostId === "stage-qc",
    `host=${docHome.hostId} index=${docHome.hostIndex}`,
  );

  // PROJECT_STAGES in dashboard.js is the board's column list. Lifted, not re-typed.
  const stages = await page.evaluate((src: string) =>
    new Function(`${src}\nreturn PROJECT_STAGES;`)() as Array<{ key: string; label: string }>,
  cut("const", "PROJECT_STAGES"));
  check(
    `dashboard.js PROJECT_STAGES has ${EXPECTED.length} entries, labelled 1..5, matching the accordions`,
    stages.length === EXPECTED.length && stages.every((s, i) => s.label === `${i + 1} · ${EXPECTED[i]}`),
    stages.map((s) => s.label).join(" | "),
  );
  check(
    "no `intake` stage key remains on the board",
    !stages.some((s) => s.key === "intake"),
    stages.map((s) => s.key).join(","),
  );

  // The review page prints the same strip. It is a different file and drifts silently.
  const rvStages = Array.from(reviewHtml.matchAll(/<span class="rv-stage[^"]*">([^<]+)<\/span>/g)).map((m) =>
    m[1].replace(/&middot;/g, "·").replace(/&amp;/g, "&").trim());
  check(
    `review.html's pipeline strip is the same ${EXPECTED.length} stages, same numbers`,
    rvStages.length === EXPECTED.length && rvStages.every((s, i) => s === `${i + 1} · ${EXPECTED[i]}`),
    rvStages.join(" | "),
  );
  check(
    "review.html marks QC / Verify as the stage it IS (is-here moved with the renumber)",
    /<span class="rv-stage is-here">1 &middot; QC \/ Verify<\/span>/.test(reviewHtml),
  );

  // THE NUMBERING CHAIN. None of these strings contains a 6, which is exactly why a grep for
  // "six" would have reported this round complete while the buttons still said 2 / 3 / 4.
  const BUTTON_NUMBERS: Array<[string, string]> = [
    ["runQcBtn", "1 · Run QC"],
    ["buildAppDocsBtn", "2 · Build AHJ/NEM Docs"],
    ["runReviewerGateBtn", "2 · Reviewer Gate"],
    ["prepareBtn", "3 · Prepare Submittal"],
  ];
  const buttonText = await page.evaluate((ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, (document.getElementById(id)?.textContent || "").trim()])),
  BUTTON_NUMBERS.map(([id]) => id));
  for (const [id, expected] of BUTTON_NUMBERS) {
    check(
      `the action button #${id} is numbered on the five-stage scale ("${expected}")`,
      buttonText[id] === expected,
      `reads "${buttonText[id]}" — a button numbered off the stage scale is the jank`,
    );
  }

  // The Next-step banner names a stage number for every status. It must be a number that exists.
  const nextSteps = await page.evaluate((src: string) =>
    new Function(`${src}\nreturn NEXT_STEPS;`)() as Record<string, { step: string; text: string }>,
  cut("const", "NEXT_STEPS"));
  const badStep = Object.entries(nextSteps).filter(([, v]) => {
    const m = /^Stage (\d+)$/.exec(v.step);
    return m ? Number(m[1]) < 1 || Number(m[1]) > EXPECTED.length : false;
  });
  check(
    `every Next-step banner points at a stage that exists (1..${EXPECTED.length})`,
    badStep.length === 0,
    badStep.map(([k, v]) => `${k}=${v.step}`).join(", "),
  );
  const badButton = Object.entries(nextSteps).filter(([, v]) => /<strong>[4-9] · /.test(v.text));
  check(
    "no Next-step banner tells the operator to click a button numbered off the scale",
    badButton.length === 0,
    badButton.map(([k, v]) => `${k}: ${v.text}`).join(" | "),
  );

  // ===========================================================================================
  console.log("\n[3] DEAD VOCABULARY IS OFF THE SCREEN");
  // ===========================================================================================
  const REMOVED = ["intake_uploaded", "submit_staging", "resubmit_staging"];
  const statusLabels = await page.evaluate((src: string) =>
    new Function(`${src}\nreturn STATUS_LABELS;`)() as Record<string, string>,
  cut("const", "STATUS_LABELS"));
  for (const dead of REMOVED) {
    check(`STATUS_LABELS no longer labels the removed status \`${dead}\``, !(dead in statusLabels));
    check(`NEXT_STEPS no longer banners \`${dead}\` with operator instructions`, !(dead in nextSteps));
  }
  const filterValues = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#projectStatusFilter option")).map((o) => (o as HTMLOptionElement).value));
  for (const dead of REMOVED) {
    check(
      `the board filter no longer offers \`${dead}\` — a filter guaranteed to find nothing`,
      !filterValues.includes(dead),
      filterValues.join(","),
    );
  }
  // ...and the five zero-writer statuses that get writers in later rounds are UNTOUCHED. Removing
  // those too would be the over-correction: their banners are the copy those rounds land against.
  const KEPT = ["ready_to_stage", "waiting_on_designer", "ready_to_resubmit", "awaiting_human_resubmit", "blocked"];
  check(
    "the five statuses that get writers in later rounds kept their labels and banners",
    KEPT.every((s) => s in statusLabels && s in nextSteps),
    KEPT.filter((s) => !(s in statusLabels) || !(s in nextSteps)).join(", "),
  );

  // ===========================================================================================
  console.log("\n[4] THE OPERATOR STATUS OVERRIDE");
  // ===========================================================================================
  const overrideBundle = [
    cut("function", "esc"),
    cut("function", "humanize"),
    cut("const", "STATUS_LABELS"),
    cut("const", "STATUS_OVERRIDE_EXCLUDED"),
    cut("function", "statusLabel"),
    cut("function", "renderStatusOverride"),
  ].join("\n\n");

  const runOverride = (status: string): Promise<{ options: Array<{ value: string; text: string }>; selected: string; reason: string }> =>
    page.evaluate(
      ([src, st]: [string, string]) => {
        const $ = (id: string) => document.getElementById(id);
        const state = { detail: { project: { id: "p1", status: st } } };
        const fn = new Function("$", "state", `${src}\nreturn renderStatusOverride;`)($, state) as () => void;
        fn();
        const sel = document.getElementById("statusOverrideSelect") as HTMLSelectElement;
        return {
          options: Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent || "" })),
          selected: sel.value,
          reason: (document.getElementById("statusOverrideReason") as HTMLInputElement).value,
        };
      },
      [overrideBundle, status] as [string, string],
    );

  const menu = await runOverride("qc_passed");
  check(
    "the override menu is built from STATUS_LABELS — one vocabulary, not a second hand-kept list",
    menu.options.length === Object.keys(statusLabels).length - 1,
    `${menu.options.length} options vs ${Object.keys(statusLabels).length} labels`,
  );
  check(
    "handoff_ready is NOT offered — the backend computes it and A2's route refuses it",
    !menu.options.some((o) => o.value === "handoff_ready"),
    menu.options.map((o) => o.value).join(","),
  );
  check(
    "`blocked` IS offered — this control is its only writer in the whole product",
    menu.options.some((o) => o.value === "blocked"),
    menu.options.map((o) => o.value).join(","),
  );
  for (const dead of REMOVED) {
    check(
      `the override menu cannot set the removed status \`${dead}\``,
      !menu.options.some((o) => o.value === dead),
    );
  }

  // THE MENU MUST OFFER EXACTLY WHAT THE ROUTE ACCEPTS.
  // A2's setProjectStatusByOperator keeps OVERRIDABLE_STATUS, an exhaustive
  // Record<ProjectStatus, "operator" | "computed">: "operator" it writes, "computed" it refuses
  // with a 409. An option the route refuses is a button whose only outcome is an error, and a
  // status the route accepts but the menu hides is an override the operator cannot reach — the
  // exact hole this round was opened to close. Read from the backend source so the two cannot
  // drift apart silently; a floor on the parse means a regex that stopped matching reports FAIL
  // rather than "all 0 statuses agree".
  const repoSrc = fs.readFileSync(path.join(FRONTEND, "..", "backend", "src", "repository.ts"), "utf8").replace(/\r\n/g, "\n");
  const tableAt = repoSrc.indexOf("const OVERRIDABLE_STATUS");
  const tableEnd = repoSrc.indexOf("\n};", tableAt);
  const table = tableAt >= 0 && tableEnd > tableAt ? repoSrc.slice(tableAt, tableEnd) : "";
  const entries = Array.from(table.matchAll(/^\s{2}(\w+): "(operator|computed)",/gm)).map((m) => [m[1], m[2]] as const);
  check(
    "the backend's OVERRIDABLE_STATUS table was found and parsed (denominator, not a silent zero)",
    entries.length >= 15,
    `parsed ${entries.length} entries — re-point this check if the table moved`,
  );
  const routeAccepts = entries.filter(([, d]) => d === "operator").map(([s]) => s).sort();
  const menuOffers = menu.options.map((o) => o.value).sort();
  check(
    "the menu offers EXACTLY the statuses POST /api/projects/:id/status accepts — no dead button, no unreachable override",
    routeAccepts.join(",") === menuOffers.join(","),
    `route accepts [${routeAccepts.join(",")}] | menu offers [${menuOffers.join(",")}]`,
  );
  check(
    "...and every status the route calls `computed` is absent from the menu",
    entries.filter(([, d]) => d === "computed").every(([s]) => !menuOffers.includes(s)),
    entries.filter(([, d]) => d === "computed").map(([s]) => s).join(","),
  );
  check("the menu opens on the project's CURRENT status", menu.selected === "qc_passed", menu.selected);
  check("the reason box always opens empty — a reason is never inherited from a previous change", menu.reason === "");

  // A project already at handoff_ready has a status the menu cannot offer. It must not silently
  // preselect a DIFFERENT status, which would arm the button to make a change nobody asked for.
  const atHandoff = await runOverride("handoff_ready");
  check(
    "a project at handoff_ready preselects nothing, so one click cannot change a status by accident",
    atHandoff.selected === "" && atHandoff.options[0].value === "",
    `selected=${JSON.stringify(atHandoff.selected)} first=${JSON.stringify(atHandoff.options[0])}`,
  );

  // AN IN-PROGRESS EDIT SURVIVES A BACKGROUND RE-RENDER, AND DIES ON A PROJECT SWITCH.
  // renderDetail re-runs on every refresh and after every autopilot poll. A panel that rebuilt
  // itself unconditionally would erase a half-typed reason mid-sentence — and a panel that kept
  // it forever would carry one project's reason onto the next project's record. One `state`
  // object is threaded through all four renders here, which is what the real page does.
  const draft = await page.evaluate(
    ([src]: [string]) => {
      const $ = (id: string) => document.getElementById(id);
      const state: Record<string, unknown> = { detail: { project: { id: "p1", status: "qc_passed" } } };
      const fn = new Function("$", "state", `${src}\nreturn renderStatusOverride;`)($, state) as () => void;
      const sel = () => document.getElementById("statusOverrideSelect") as HTMLSelectElement;
      const box = () => document.getElementById("statusOverrideReason") as HTMLInputElement;
      fn();
      // The operator picks a status and starts typing.
      sel().value = "blocked";
      box().value = "PacifiCorp suspended the interconnection, ten-day clo";
      // A background refresh lands.
      fn();
      const afterRefresh = { status: sel().value, reason: box().value };
      // The operator navigates to a different project.
      (state.detail as { project: { id: string; status: string } }).project = { id: "p2", status: "submitted" };
      fn();
      const afterSwitch = { status: sel().value, reason: box().value };
      return { afterRefresh, afterSwitch };
    },
    [overrideBundle] as [string],
  );
  check(
    "a background re-render does NOT wipe the operator's half-typed reason",
    draft.afterRefresh.reason === "PacifiCorp suspended the interconnection, ten-day clo",
    `reason became ${JSON.stringify(draft.afterRefresh.reason)} — the control built to fix drift cannot itself lose what you typed`,
  );
  check(
    "...nor the status they had picked",
    draft.afterRefresh.status === "blocked",
    `selected became ${JSON.stringify(draft.afterRefresh.status)}`,
  );
  check(
    "opening a DIFFERENT project clears the draft — one project's reason never lands on another's record",
    draft.afterSwitch.reason === "" && draft.afterSwitch.status === "submitted",
    JSON.stringify(draft.afterSwitch),
  );

  // Markup + wiring: the control exists on the page, the reason field is required by the handler,
  // and it posts where the plan says. A control with no caller is the bug.
  const controls = await page.evaluate(() => ({
    wrap: !!document.getElementById("statusOverrideWrap"),
    select: !!document.getElementById("statusOverrideSelect"),
    reason: !!document.getElementById("statusOverrideReason"),
    button: !!document.getElementById("applyStatusOverrideBtn"),
    copy: (document.getElementById("statusOverrideWrap")?.textContent || "").replace(/\s+/g, " "),
  }));
  check("the override control ships in the project action area",
    controls.wrap && controls.select && controls.reason && controls.button, JSON.stringify(controls));
  check(
    "the copy tells the operator the change is recorded with their reason",
    /recorded with your reason/i.test(controls.copy),
    controls.copy.slice(0, 200),
  );
  check(
    "the copy states it does not submit or pay anything (hard rule 1 is never bent by a status edit)",
    /does not submit, resubmit or pay/i.test(controls.copy),
    controls.copy.slice(0, 300),
  );
  check("the button is wired to the handler", /\$\("applyStatusOverrideBtn"\)\?\.addEventListener\("click", applyStatusOverride\)/.test(dashboardJs));
  check("the handler REFUSES an empty reason before it posts anything",
    /if \(!reason\) \{[\s\S]{0,200}return;/.test(dashboardJs));
  check(
    "it posts to POST /api/projects/:id/status (A2's route; reconcile if the shape moved)",
    dashboardJs.includes("/api/projects/${projectId}/status")
    && /applyStatusOverride[\s\S]{0,1200}method: "POST"/.test(dashboardJs),
  );
  check("renderStatusOverride runs on every detail render", /safeRender\("statusOverride", renderStatusOverride\)/.test(dashboardJs));

  // ===========================================================================================
  console.log("\n[5] NO STALE SIX-STAGE COPY ANYWHERE IN THE FILE SET");
  // ===========================================================================================
  const STALE = /\b(six[- ]stage|six stages|the 6 stages|stage \d+ of 6|1 · Intake|1 &middot; Intake)\b/i;
  for (const [name, src] of [["dashboard.js", dashboardJs], ["dashboard.html", dashboardHtml], ["review.html", reviewHtml], ["styles.css", css]] as const) {
    const hits = src.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => STALE.test(line))
      // A line that says the stage WAS removed is the record of the decision, not stale copy.
      .filter(([, line]) => !/removed|deleted|gone|was permanently|not six|FIVE steps, not six/i.test(line));
    check(`${name} carries no stale six-stage copy`, hits.length === 0,
      hits.map(([n, l]) => `${n}: ${l.trim()}`).join(" | "));
  }
} finally {
  await page.close();
  await ctx.close();
  await browser.close();
}

const total = passed + failures.length;
console.log(`\n${"=".repeat(80)}`);
if (failures.length) {
  console.log(`STAGE UI CONTRACT: ${passed}/${total} checks passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`STAGE UI CONTRACT: all ${total}/${total} checks passed`);
