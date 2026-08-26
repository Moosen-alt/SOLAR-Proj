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
  const html = (await page.content()).toLowerCase();
  if (/cf-chl|turnstile|hcaptcha|recaptcha|are you a human|verify you are/.test(html)) return "captcha/challenge";
  if (/two.factor|verification code|one.time|security code|multi.factor|\bmfa\b|code sent to/.test(html)) return "mfa";
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

  await page.goto(new URL("/Homepage/ProgramHome", URL0).toString(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(2500);
  await shot(page, "03-program-home");

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='MvcProjects'], a[href*='EditProject'], a[href*='ViewProject']"))
      .map((a) => ({ text: (a.closest("tr")?.textContent || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200), href: a.href })));
  fs.writeFileSync(path.join(OUT, `${TAG}-projects.json`), JSON.stringify(rows, null, 2));
  log(`projects visible: ${rows.length}`);
  rows.slice(0, 10).forEach((r) => log(`  - ${r.text}`));

  // Prefer an in-progress draft: it has the equipment section rendered and
  // editable, and inspecting it changes nothing.
  const target = rows.find((r) => /incomplete|draft|unsubmitted|in progress/i.test(r.text)) || rows[0];
  if (!target) {
    log("No existing projects on this account. The probe will not CREATE one — that would put a real draft on the utility's portal. Start a draft by hand, then re-run.");
    process.exit(4);
  }
  log(`opening read-only: ${target.text}`);
  await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);
  await shot(page, "04-project");
  chl = await challengePresent(page);
  if (chl) { log(`STOPPED in project: ${chl}`); process.exit(2); }

  type SeenField = Awaited<ReturnType<typeof extractFields>>[number];
  const pages: Record<string, SeenField[]> = { landing: await extractFields(page) };

  const navText = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("a, [role='tab']"))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 60));
  const specsish = Array.from(new Set(navText))
    .filter((t) => /equipment|specs|specification|system info|generator|module|inverter/i.test(t) && !SUBMITTY.test(t));
  log(`specs-page nav candidates: ${JSON.stringify(specsish.slice(0, 8))}`);

  for (const t of specsish.slice(0, 3)) {
    const link = page.locator(`a:has-text("${t}"), [role='tab']:has-text("${t}")`).first();
    if (!(await link.count())) continue;
    await link.click().catch(() => null);
    await page.waitForTimeout(3500);
    await page.keyboard.press("Escape").catch(() => null); // PowerClerk date pickers
    await shot(page, `05-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`);
    pages[t] = await extractFields(page);
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
