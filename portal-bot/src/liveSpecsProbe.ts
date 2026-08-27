// ---------------------------------------------------------------------------
// LIVE SPECS-PAGE PROBE — read-only diagnostic for HANDOFF open issue #1.
//
// The specs-page fill fix (bare "Manufacturer"/"Model" labels resolved via
// field.section, plus the alreadyFilledLabels dedupe that hid the inverter
// section) passes the fixture-DOM cascade smoke. What it has never been checked
// against is a REAL PowerClerk template, where two questions remain open:
//
//   (a) does PowerClerk render the model select as a custom searchable combobox
//       (fillCustomCombobox) rather than a native <select>?
//   (b) does section extraction come back "" on their DOM, leaving the equipment
//       pass with no side (PV vs inverter) to key on?
//
// This probe answers both by LOOKING ONLY. It logs in, walks to the equipment
// section of an EXISTING draft, and dumps every control's label + section +
// element shape. It fills nothing, saves nothing, and clicks nothing that
// matches SUBMITTY. It stops immediately on MFA/CAPTCHA — a human completes
// those, per the project's hard safety rules.
//
// RUN IT FROM THE OPERATOR'S NORMAL EGRESS, NOT A DATACENTER/CI BOX.
// docs/research/GOLIVE_OPS_LEGAL_2026-07.md is explicit: these portals sit
// behind Cloudflare bot management, headless is a tell (navigator.webdriver,
// JA3/JA4, plugin surface), and a fresh login from an unfamiliar datacenter IP
// is itself a flag. Running this from CI risks the operator's real utility
// account. Hence headed by default and a deliberate HEADLESS opt-in.
//
//   PC_URL=https://pgenm.powerclerk.com/MvcAccount/Login \
//   PC_EMAIL=... PC_PASS=... PC_TAG=pge OUT_DIR=./data/live-probe \
//   npx tsx portal-bot/src/liveSpecsProbe.ts
//
// Exit codes: 0 probe complete · 2 stopped at MFA/CAPTCHA (human needed)
//             3 login rejected · 4 no existing project to inspect
// ---------------------------------------------------------------------------
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

// Credentials should NOT be passed on the command line (they leak into shell
// history/process lists). If PC_CREDS_FILE points at a KEY=VALUE file, load it
// into the environment first. Env vars already set take precedence.
const credsFile = process.env.PC_CREDS_FILE;
if (credsFile && fs.existsSync(credsFile)) {
  for (const line of fs.readFileSync(credsFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const URL0 = requireEnv("PC_URL");
const EMAIL = requireEnv("PC_EMAIL");
const PASS = requireEnv("PC_PASS");
const TAG = process.env.PC_TAG || "portal";
const OUT = process.env.OUT_DIR || path.join("data", "live-probe", TAG);
// Headed by default — see the WAF note above. HEADLESS=1 is an explicit override.
const HEADLESS = process.env.HEADLESS === "1";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[live-probe] ${name} is required. Credentials come from the environment — never hardcode them, and never commit them.`);
    process.exit(1);
  }
  return v;
}

fs.mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(`[${TAG}]`, ...a);
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) }).catch(() => null);

// Anything that files, pays, or destroys. This probe clicks NONE of it — the
// list is deliberately broader than the recorder's, because a diagnostic has no
// reason to ever touch a state-changing control.
const SUBMITTY = /\b(submit|pay|payment|checkout|finalize|file application|confirm|complete|delete|withdraw|cancel|remove|save)\b/i;

async function challengePresent(page: Page): Promise<string | null> {
  // CAPTCHA widgets are definitive — detect by SELECTOR.
  for (const sel of ["iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", ".cf-turnstile", "#cf-chl-widget", "iframe[title*='challenge' i]"]) {
    if (await page.locator(sel).count().catch(() => 0)) return "captcha/challenge";
  }
  // MFA is a visible interstitial. Scan VISIBLE text only — the old check ran raw HTML
  // (incl. minified JS) and false-positived on strings like "phone.time" matching
  // "one.time". Tight phrases only.
  const vis = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (/two[-\s]?factor authentication|multi[-\s]?factor authentication|enter (the )?(verification|security|one[-\s]?time) code|(verification|security) code (was )?sent|code (was )?sent to your/.test(vis)) return "mfa";
  return null;
}

// Mirror of what the adapter's fieldsSeen needs: label as rendered (so a BARE
// "Model" shows up bare) and the section context the fix depends on (so an
// empty one is visible as empty rather than silently defaulted).
async function extractFields(page: Page) {
  return page.evaluate(() => {
    const visible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && (el as HTMLInputElement).type !== "hidden";
    };
    const sectionFor = (el: Element): string => {
      const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
      if (legend) return legend;
      let node: Element | null = el;
      while (node && node !== document.body) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (/^H[1-6]$/.test(sib.tagName)) return (sib.textContent || "").trim();
          const inner = sib.querySelector?.("h1,h2,h3,h4,h5,h6");
          if (inner) return (inner.textContent || "").trim();
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return "";
    };
    const labelFor = (el: HTMLElement): string => {
      const id = el.getAttribute("id");
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l?.textContent?.trim()) return l.textContent.trim();
      }
      const wrap = el.closest("label")?.textContent?.trim();
      if (wrap) return wrap.slice(0, 80);
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent?.trim() || "").join(" ").trim();
        if (t) return t;
      }
      return (el as HTMLInputElement).placeholder || "";
    };
    // Nearest ancestor that is an ARIA group / fieldset, plus how the adapter would
    // name it (aria-label, aria-labelledby, or legend/heading text) — this is what
    // getByRole("group", {name}) matches against.
    const groupFor = (el: Element): { role: string; name: string } | undefined => {
      const g = el.closest("[role='group'], fieldset");
      if (!g) return undefined;
      const role = g.getAttribute("role") || g.tagName.toLowerCase();
      let name = g.getAttribute("aria-label") || "";
      if (!name) {
        const lb = g.getAttribute("aria-labelledby");
        if (lb) name = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent?.trim() || "").join(" ").trim();
      }
      if (!name) name = (g.querySelector("legend, h1,h2,h3,h4,h5,h6")?.textContent || "").replace(/\s+/g, " ").trim();
      return { role, name: name.slice(0, 60) };
    };
    return Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea, [role='combobox'], [role='listbox']"))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type || undefined,
        role: el.getAttribute("role") || undefined,
        id: el.getAttribute("id") || undefined,
        name: el.getAttribute("name") || undefined,
        label: labelFor(el),
        section: sectionFor(el),
        group: groupFor(el),
        className: String(el.className || "").slice(0, 80),
        optionCount: el.tagName === "SELECT" ? (el as HTMLSelectElement).options.length : undefined,
      }));
  });
}

const browser = await chromium.launch({ headless: HEADLESS });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } } as never);

try {
  await page.goto(URL0, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1500);
  await shot(page, "01-login");
  let chl = await challengePresent(page);
  if (chl) { log(`STOPPED at login: ${chl}. A human must complete it.`); process.exit(2); }

  await page.locator("input[type='email'], input[id*='user' i], input[name*='user' i], input[id*='email' i]").first().fill(EMAIL);
  await page.locator("input[type='password']").first().fill(PASS);
  await page.locator("form").filter({ has: page.locator("input[type='password']") })
    .locator("button, input[type='submit']").first().click();
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 });
  await page.waitForTimeout(2500);
  await shot(page, "02-after-login");

  chl = await challengePresent(page);
  if (chl) { log(`STOPPED after login: ${chl}. A human must complete it.`); process.exit(2); }
  if (/MvcAccount\/Login/i.test(page.url())) {
    log("LOGIN REJECTED — still on the login page. Check the credentials, or the account may be locked.");
    process.exit(3);
  }
  log(`login OK — ${page.url()}`);

  // tsx serializes in-page functions with __name() helper calls; the live page has no
  // __name defined, which crashes page.evaluate. Inject a shim on every navigation AND on
  // the current document. __name persists in a page until the next nav, so a cheap re-call
  // before each extract keeps every evaluate working.
  const NAME_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";
  await page.addInitScript({ content: NAME_SHIM });
  const evalReady = () => page.evaluate(NAME_SHIM).catch(() => null);

  const programId = new URL(page.url()).searchParams.get("ProgramId") || "";
  await page.goto(new URL(`/Homepage/ProgramHome?ProgramId=${programId}`, URL0).toString(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await evalReady();
  await shot(page, "03-program-home");

  // Targeting a specific project (PC_PROJECT)? The new PowerClerk homepage only surfaces a
  // few status buckets, so an approved/older project may not appear there — reach the FULL
  // project list via the "Projects" menu instead, then filter it below.
  const targetProjEarly = (process.env.PC_PROJECT || "").trim();
  let usedProjectsNav = false;
  if (targetProjEarly) {
    const projNav = page.getByRole("link", { name: /^\s*projects\s*$/i })
      .or(page.locator("a,button").filter({ hasText: /^\s*projects\s*$/i })).first();
    if (await projNav.count().catch(() => 0)) {
      await projNav.click({ timeout: 10000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(3500);
      await evalReady();
      await shot(page, "03b-projects-list");
      usedProjectsNav = true;
      log("navigated to the full Projects list (menu)");
    }
  }

  // ProgramHome shows status BUCKETS (each a #view hash into a Vue project grid), not
  // projects. Pick an editable bucket: PC_BUCKET (default "Corrections"), else the first
  // non-zero bucket that isn't a terminal status. Skipped when the Projects list is used.
  const buckets = usedProjectsNav ? [] : await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='ProjectList']"))
      .map((a) => ({ text: (a.textContent || "").replace(/\s+/g, " ").trim(), href: a.href }))
      .filter((b) => b.text && /#view_/.test(b.href)));
  if (!usedProjectsNav) {
    const wanted = (process.env.PC_BUCKET || "Corrections").toLowerCase();
    const nonZero = (t: string) => !/^0\D/.test(t) && t.trim() !== "0";
    const terminal = /approved|complete|cancelled|permission to operate|inspection/i;
    const bucket =
      buckets.find((b) => b.text.toLowerCase().includes(wanted) && nonZero(b.text)) ||
      buckets.find((b) => nonZero(b.text) && !terminal.test(b.text)) ||
      buckets.find((b) => nonZero(b.text));
    if (!bucket) { log("No populated project bucket found. Buckets: " + JSON.stringify(buckets.map((b) => b.text))); process.exit(4); }
    log(`opening bucket: "${bucket.text}"`);
    await page.goto(bucket.href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(3500);
    await evalReady();
  }
  await shot(page, "04-project-list");

  // Enumerate real project rows: links into a project, else clickable grid rows.
  const projectLinks = await page.evaluate(() => {
    const out: Array<{ text: string; href: string }> = [];
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      if (/EditProject|ViewProject|MvcProjects\/(Project|Load|Edit)|ProjectId=/i.test(a.href) && !/ProjectList/i.test(a.href)) {
        out.push({ text: (a.closest("tr")?.textContent || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160), href: a.href });
      }
    }
    return out;
  });
  const gridRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll("tr, [role='row'], [class*='row']"))
      .map((r) => (r.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 12 && t.length < 220).slice(0, 40));
  fs.writeFileSync(path.join(OUT, `${TAG}-projectlist.json`), JSON.stringify({ projectLinks, gridRows }, null, 2));
  log(`project links found: ${projectLinks.length}; sample grid rows: ${gridRows.length}`);
  projectLinks.slice(0, 6).forEach((r) => log(`  link: ${r.text || "(no text)"}`));
  gridRows.slice(0, 6).forEach((r) => log(`  row: ${r}`));

  // Dismiss overlays that intercept clicks (the "What's new?" tour + the cookie banner).
  for (const label of ["Got it", "Close", "Accept", "OK", "Dismiss"]) {
    const b = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => null); await page.waitForTimeout(400); }
  }

  // Target a SPECIFIC project number (PC_PROJECT) by filtering the grid's "Search All
  // Columns" box, so we open exactly that project rather than whichever is first.
  const targetProj = (process.env.PC_PROJECT || "").trim();
  if (targetProj) {
    const search = page.getByPlaceholder(/search/i).or(page.getByRole("textbox", { name: /search/i })).first();
    if (await search.count().catch(() => 0)) {
      await search.fill(targetProj).catch(() => null);
      // PowerClerk's grid filter applies on Enter / the search button, not on input.
      await search.press("Enter").catch(() => null);
      const searchBtn = page.getByRole("button", { name: /search/i }).first();
      if (await searchBtn.count().catch(() => 0)) await searchBtn.click({ timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(3000);
      await evalReady();
      await shot(page, "04a-search");
      log(`filtered grid by PC_PROJECT="${targetProj}"`);
    } else {
      log(`PC_PROJECT set but no grid search box found — will match "${targetProj}" among rows`);
    }
  }

  // Open a project. The Project Number cell (e.g. PGENM-43830) is a Vue click target,
  // not an <a href>, so page.goto can't reach it — click the matching project-number cell.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const projNumRe = targetProj ? new RegExp(escapeRe(targetProj), "i") : /[A-Z]{2,}[A-Z0-9]*-?\d{3,}/;
  let opened = false;
  if (projectLinks.length) {
    const link = targetProj ? (projectLinks.find((l) => projNumRe.test(l.text)) || null) : projectLinks[0];
    if (link) await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 45000 }).then(() => { opened = true; }).catch(() => null);
  }
  if (!opened) {
    const numCell = page.locator("td, [role='gridcell'], a, span").filter({ hasText: projNumRe }).first();
    if (await numCell.count().catch(() => 0)) {
      await numCell.click({ timeout: 10000 }).catch(() => null); // expands the row inline
      await page.waitForTimeout(1500);
      await shot(page, "04b-row-expanded");
      // The expanded row reveals a "View/Edit Project" action — THAT opens the form.
      const viewEdit = page.locator("button, a").filter({ hasText: /view\s*\/?\s*edit\s*project|view\/edit|open project/i }).first();
      if (await viewEdit.count().catch(() => 0)) {
        const before = page.url();
        await viewEdit.click({ timeout: 10000 }).catch(() => null);
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => null);
        await page.waitForTimeout(4500);
        opened = page.url() !== before
          || (await page.locator("text=/specification|equipment|preparer|generator|inverter|module|next/i").count().catch(() => 0)) > 0;
      }
    }
  }
  if (!opened) { log("Could not open a project. See projectlist.json / 04-project-list.png."); process.exit(4); }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(4000);
  await evalReady();
  await shot(page, "05-project");
  chl = await challengePresent(page);
  if (chl) { log(`STOPPED in project: ${chl}`); process.exit(2); }

  // The overview shows summary VALUES only. Control types (native select vs custom
  // combobox) live in the form. PC_VIEWONLY=1 opens READ-ONLY "View" (never Edit/Continue)
  // so an already-submitted/approved filing is NEVER mutated — the safe mode for a live
  // approved project. Otherwise open the editor via Edit/Continue.
  // The "Current Forms" table renders lazily — wait for it.
  const viewOnly = process.env.PC_VIEWONLY === "1";
  const openRe = viewOnly ? /^\s*view\s*$/i : /^\s*(edit|continue)\s*$/i;
  const openBtn = page.getByRole("button", { name: openRe })
    .or(page.getByRole("link", { name: openRe }))
    .or(page.locator("a,button,input[type='button'],input[type='submit']").filter({ hasText: openRe }))
    .first();
  await openBtn.waitFor({ state: "visible", timeout: 25000 }).catch(() => null);
  if (await openBtn.count().catch(() => 0)) {
    log(`opening the Net Metering Application form (${viewOnly ? "View — read-only" : "Edit"})`);
    await openBtn.scrollIntoViewIfNeeded().catch(() => null);
    await openBtn.click({ timeout: 12000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => null);
    await page.waitForTimeout(4500);
    await evalReady();
    await shot(page, "05b-form-open");
    const chl2 = await challengePresent(page);
    if (chl2) { log(`STOPPED opening form: ${chl2}`); process.exit(2); }
  } else {
    log(`no ${viewOnly ? "View" : "Edit/Continue"} button on the app row — inspecting overview only`);
  }

  type SeenField = Awaited<ReturnType<typeof extractFields>>[number];
  const pages: Record<string, SeenField[]> = {};
  pages["project-landing"] = await extractFields(page);

  // PowerClerk drives the form with a horizontal NUMBERED stepper near the top.
  // Step titles are clickable but aren't <a>/<li>/<button>, and later steps hide
  // behind a "Next page" chevron. Enumerate by SCREEN POSITION (the top strip),
  // reveal the hidden ones, and record the ordered titles.
  const collectSteps = () => page.evaluate(() => {
    const out: { t: string; x: number }[] = [];
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      if (el.children.length > 2) return; // leaf-ish text nodes only
      const r = el.getBoundingClientRect();
      if (r.top < 110 || r.top > 250 || r.width < 20 || r.left < 150) return; // stepper band, right of the sidebar
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length >= 4 && t.length < 46 && /[a-z]/i.test(t) && !/^\d+$/.test(t)) out.push({ t, x: r.left });
    });
    return out.sort((a, b) => a.x - b.x).map((o) => o.t);
  });
  const steps: string[] = [];
  for (let i = 0; i < 8; i++) {
    for (const t of await collectSteps()) if (!steps.includes(t)) steps.push(t);
    const next = page.locator("[aria-label='Next page'], [title='Next page']").first();
    if (!(await next.count().catch(() => 0)) || !(await next.isEnabled().catch(() => false))) break;
    await next.click({ timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(700);
  }
  fs.writeFileSync(path.join(OUT, `${TAG}-steps.json`), JSON.stringify(steps, null, 2));
  log(`stepper (${steps.length}): ${JSON.stringify(steps)}`);
  // Dump the stepper region HTML once, for tuning if the position heuristic misses.
  const stepperHtml = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("body *")).find((e) => {
      const r = e.getBoundingClientRect();
      return r.top > 110 && r.top < 220 && r.width > 600 && /information/i.test(e.textContent || "");
    });
    let n: HTMLElement | null = el || null;
    for (let k = 0; k < 4 && n?.parentElement; k++) n = n.parentElement;
    return n ? n.outerHTML.slice(0, 6000) : "";
  }).catch(() => "");
  fs.writeFileSync(path.join(OUT, `${TAG}-stepper.html`), stepperHtml);

  // Visit steps past the applicant/preparer front matter; equipment make/model
  // lives on the system / description-of-service page.
  const skip = /^(interconnection information|preparer information|pge customer information|applicant)/i;
  const toVisit = steps.filter((t) => !skip.test(t) && !SUBMITTY.test(t)).slice(0, 8);
  log(`visiting: ${JSON.stringify(toVisit)}`);
  for (const t of toVisit) {
    let tgt = page.getByText(t, { exact: true }).first();
    if (!(await tgt.count().catch(() => 0))) {
      // Stepper may have scrolled it off; page back to the start then find it.
      for (let b = 0; b < 8; b++) {
        const prev = page.locator("[aria-label='Previous page'], [title='Previous page']").first();
        if (!(await prev.count().catch(() => 0)) || !(await prev.isEnabled().catch(() => false))) break;
        await prev.click({ timeout: 4000 }).catch(() => null); await page.waitForTimeout(400);
      }
      for (let f = 0; f < 8 && !(await tgt.count().catch(() => 0)); f++) {
        const next = page.locator("[aria-label='Next page'], [title='Next page']").first();
        if (!(await next.count().catch(() => 0)) || !(await next.isEnabled().catch(() => false))) break;
        await next.click({ timeout: 4000 }).catch(() => null); await page.waitForTimeout(400);
        tgt = page.getByText(t, { exact: true }).first();
      }
    }
    if (!(await tgt.count().catch(() => 0))) { log(`  step not clickable: ${t}`); continue; }
    await tgt.scrollIntoViewIfNeeded().catch(() => null);
    await tgt.click({ timeout: 8000 }).catch(() => null);
    // We fill NOTHING, so no unsaved-changes guard should fire; if it does, DISCARD
    // (never save/submit) so no write reaches the live filing.
    const leave = page.getByRole("button", { name: /leave page|i understand/i }).first();
    if (await leave.count().catch(() => 0)) await leave.click().catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(3000);
    await page.keyboard.press("Escape").catch(() => null); // PowerClerk date pickers
    await evalReady();
    await shot(page, `06-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`);
    pages[t] = await extractFields(page);
    log(`  ${t}: ${pages[t].length} controls`);

    // On the equipment page, dump the FULL widget container around the first
    // Manufacturer combobox (walk up from the visually-hidden input[role=combobox]).
    // We only know the input's shape from extractFields; the fill path depends on the
    // PARENT (wrapper class, "Please select..." display, aria-controls) — capture it so
    // a fixture can match live exactly. Read-only: no click, no fill.
    if (pages[t].some((f) => f.role === "combobox")) {
      const comboHtml = await page.evaluate(() => {
        const inp = document.querySelector<HTMLElement>("input[role='combobox']");
        if (!inp) return "";
        let n: HTMLElement | null = inp;
        for (let k = 0; k < 6 && n?.parentElement; k++) n = n.parentElement;
        return (n ? n.outerHTML : inp.outerHTML).slice(0, 10000);
      }).catch(() => "");
      if (comboHtml) fs.writeFileSync(path.join(OUT, `${TAG}-combobox.html`), comboHtml);
    }
  }
  fs.writeFileSync(path.join(OUT, `${TAG}-fields.json`), JSON.stringify(pages, null, 2));

  // ---- The verdict the HANDOFF asks for ----
  const flat = Object.entries(pages).flatMap(([pg, fields]) => fields.map((f) => ({ page: pg, ...f })));
  const equip = flat.filter((f) => /manufacturer|model/i.test(String(f.label || "")));
  log(`\nequipment-labeled controls: ${equip.length}`);
  for (const e of equip) {
    log(`  [${e.page}] label="${e.label}" section="${e.section}" <${e.tag}${e.role ? ` role=${e.role}` : ""}>` +
      `${e.optionCount !== undefined ? ` options=${e.optionCount}` : ""} class="${String(e.className).slice(0, 40)}"`);
  }
  const bare = equip.filter((e) => /^(manufacturer|model)\s*\*?$/i.test(String(e.label).trim()));
  const noSection = equip.filter((e) => !String(e.section || "").trim());
  const combo = equip.filter((e) => e.tag !== "select" && (e.role === "combobox" || /combo|select2|choices|autocomplete|vs__/i.test(String(e.className))));
  log(`\nVERDICT  bareLabels=${bare.length}  emptySections=${noSection.length}  customComboboxes=${combo.length}  nativeSelects=${equip.filter((e) => e.tag === "select").length}`);
  log(noSection.length ? "  -> section extraction IS empty here: the section-keyed fix cannot resolve PV vs inverter. Investigate DOM structure." : "  -> sections resolve: the section-keyed fix has the signal it needs.");
  log(combo.length ? "  -> model control is a CUSTOM combobox: fillCustomCombobox is required, a native select fill will not work." : "  -> model controls are native selects: the existing cascade fill applies.");
  log(`\nartifacts in ${OUT}`);
} finally {
  await browser.close();
}
