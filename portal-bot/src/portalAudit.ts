// WHAT IS STILL BLANK? An independent, read-only audit of an application on a live portal.
//
// A learn or replay reporting "60 steps, no failures" says only that the recorded steps ran.
// It says nothing about whether the FORM is complete — and on the first Ameren Illinois run
// it was not: Docket Number, an entire Electrical Contractor block and the document slots
// were empty while every step "succeeded". This walks the actual application afterwards and
// reports what a human would see: required fields still empty, optional gaps, and upload
// slots with nothing attached.
//
// Reads only. Clicks step navigation, never a submit, never a fee.
//   npm run portal:audit -- <portal-url> [--client=<id>]
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

interface FieldState { label: string; kind: string; required: boolean; filled: boolean; value: string }
interface PageAudit { title: string; url: string; fields: FieldState[]; uploads: { total: number; attached: number }; uploadSlots: Array<{ label: string; attached: boolean; accept: string }> }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--")) || "";
  const clientArg = args.find((a) => a.startsWith("--client="));
  const clientId = clientArg ? clientArg.split("=")[1] : "tml-international-llc";
  if (!url) { console.error("Usage: npm run portal:audit -- <portal-url> [--client=<id>]"); process.exit(0); }

  const { openPortal, closePortal } = await import("./browser");
  const { performLogin } = await import("./adapters/loginFlow");
  const { dismissPageModals, clearPageOverlays } = await import("./adapters/autoLearnAdapter");
  const { openDatabase } = await import("../../backend/src/db");
  const { getDecryptedCredentialByUrl } = await import("../../backend/src/portalCredentials");

  const db = await openDatabase();
  const cred = getDecryptedCredentialByUrl(db, clientId, url) ?? undefined;
  const outDir = path.join(process.cwd(), "data", "screenshots");
  fs.mkdirSync(outDir, { recursive: true });
  const tag = (() => { try { return new URL(url).hostname.split(".")[0]; } catch { return "portal"; } })();

  const opened = await openPortal({
    userDataDir: path.join(process.cwd(), "portal-profiles", clientId, `audit_${tag}`),
    headless: true,
  });
  const page = opened.page;

  // Read every visible control and decide, from the DOM, whether it is REQUIRED and whether
  // it is FILLED. Required is taken from the several ways portals express it — the attribute,
  // aria-required, and the asterisk convention in the label — because most of them use the
  // convention rather than the attribute.
  const auditPage = async (): Promise<PageAudit> => page.evaluate(() => {
    const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const labelFor = (el: HTMLElement): string => {
      const id = el.getAttribute("id") || "";
      let l = id ? ((document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText ?? "") : "";
      if (!l) l = (el.closest("label") as HTMLElement | null)?.innerText ?? "";
      if (!l) l = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      if (!l) {
        // Table/'<div>' layouts: the nearest preceding text node that reads like a label.
        const cell = el.closest("td, div, li");
        const prev = cell?.previousElementSibling as HTMLElement | null;
        if (prev && (prev.innerText || "").trim().length < 60) l = prev.innerText || "";
      }
      return (l || "").replace(/\s+/g, " ").trim();
    };
    const isRequired = (el: HTMLElement, label: string): boolean => {
      if (el.hasAttribute("required") || el.getAttribute("aria-required") === "true") return true;
      if (/\*/.test(label)) return true;
      const wrap = el.closest("td, div, li, fieldset");
      const wrapText = (wrap as HTMLElement | null)?.innerText || "";
      // An asterisk immediately around the control's own label block.
      return /\*\s*$/.test(label) || /\*/.test(wrapText.slice(0, Math.min(wrapText.length, 120)));
    };
    const fields: Array<{ label: string; kind: string; required: boolean; filled: boolean; value: string }> = [];
    let uploadTotal = 0; let uploadAttached = 0;
    const uploadSlots: Array<{ label: string; attached: boolean; accept: string }> = [];
    for (const el of Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[]) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image") continue;
      if (type === "file") {
        uploadTotal++;
        const attached = Boolean((el as HTMLInputElement).files && (el as HTMLInputElement).files!.length > 0);
        if (attached) uploadAttached++;
        // NAME the slot. A count of empty uploads tells you something is missing; the slot's
        // own label tells you WHICH document the portal is asking for ("Data Sheet for the
        // DC Source/PV Module", "Attach Proof of Insurance"), which is what decides whether
        // we can produce it from the plan-set split or have to go and get it.
        uploadSlots.push({ label: labelFor(el).slice(0, 80) || "(unlabelled upload)", attached, accept: el.getAttribute("accept") || "" });
        continue;
      }
      if (!vis(el)) continue;
      const label = labelFor(el);
      let value = ""; let filled = false;
      if (el.tagName === "SELECT") {
        const s = el as HTMLSelectElement;
        value = (s.options[s.selectedIndex]?.textContent || "").trim();
        filled = Boolean(value) && !/^(select|choose|--|please)/i.test(value);
      } else if (type === "checkbox" || type === "radio") {
        filled = (el as HTMLInputElement).checked;
        value = filled ? "[checked]" : "";
      } else {
        value = (el as HTMLInputElement).value ?? "";
        filled = value.trim().length > 0;
      }
      fields.push({ label: label.slice(0, 60), kind: el.tagName === "SELECT" ? "select" : (type || "text"), required: isRequired(el, label), filled, value: value.slice(0, 40) });
    }
    return { title: document.title, url: location.href, fields, uploads: { total: uploadTotal, attached: uploadAttached }, uploadSlots };
  });

  const pages: PageAudit[] = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
    const login = await performLogin(page, cred);
    console.log(`login: ${login.status}`);
    if (!login.ok) { console.log("cannot audit without a session."); await closePortal(opened); process.exit(0); }
    await page.waitForTimeout(3000);
    await dismissPageModals(page).catch(() => null);
    await clearPageOverlays(page).catch(() => null);

    // An application URL can be given directly — the reliable way to audit a SPECIFIC
    // application, since a portal home may list projects in a grid with no direct links.
    const appArg = args.find((a) => a.startsWith("--app="));
    if (appArg) {
      const appUrl = appArg.split("=").slice(1).join("=");
      await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(3500); // these forms paint late
      await dismissPageModals(page).catch(() => null);
    }

    // --row=<text> picks WHICH application to audit out of a grid — the one whose row
    // carries that text (a customer name, say). Necessary because a portal list can be a
    // JS grid with no per-row links, and auditing "the most recent" is how you end up
    // auditing an empty shell someone's diagnostic click created rather than the
    // application you care about.
    const rowArg = args.find((a) => a.startsWith("--row="));
    if (!appArg && rowArg) {
      const want = rowArg.split("=").slice(1).join("=");
      // SAY WHEN THE CHOICE IS AMBIGUOUS. Several applications can carry the same customer
      // name — a learn, a replay and a demo all produce one — and silently auditing the
      // first is how a stale application gets reported as if it were the new one. Report
      // the count; --last picks the newest-appended row instead of the first.
      const matches = page.locator("tr").filter({ hasText: want });
      const matchCount = await matches.count().catch(() => 0);
      const useLast = args.includes("--last");
      if (matchCount > 1) {
        console.log(`NOTE: ${matchCount} rows match "${want}" — auditing the ${useLast ? "LAST" : "FIRST"} one.`
          + `${useLast ? "" : " Pass --last for the most recently created, or --app=<url> to be exact."}`);
      }
      const row = useLast ? matches.nth(matchCount - 1) : matches.first();
      if (matchCount > 0) {
        // A grid row often carries no link at all: it is EXPANDABLE, and the link to the
        // application only exists once the row's chevron is opened (PowerClerk marks these
        // data-test-state="expandable"). So try a link, then expand and try again.
        let rowLink = row.locator("a").first();
        if (!(await rowLink.count().catch(() => 0))) {
          const chevron = row.locator("svg, [tabindex='0'], button").first();
          await chevron.click({ timeout: 8000 }).catch(() => null);
          await page.waitForTimeout(1800);
          // The expanded detail usually renders as the NEXT row.
          const expanded = row.locator("xpath=following-sibling::tr[1]");
          rowLink = (await expanded.locator("a").count().catch(() => 0)) ? expanded.locator("a").first() : row.locator("a").first();
        }
        if (await rowLink.count().catch(() => 0)) {
          await rowLink.click({ timeout: 10000 }).catch(() => null);
          await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
          await page.waitForTimeout(3000);
          await dismissPageModals(page).catch(() => null);
        }
        console.log(`row "${want}" → ${page.url().slice(0, 110)}`);
      } else {
        console.log(`no row matching "${want}" on this page.`);
      }
    }

    // Otherwise open the most recent application.
    const link = (appArg || rowArg) ? page.locator("__never__") : page.locator("a[href*='LandingPage'][href*='ProjectId'], a[href*='EditProject']").first();
    if (await link.count().catch(() => 0)) {
      await link.click({ timeout: 10000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(2500);
    }

    // WHICHEVER route got us to the project, we are probably on its LANDING page, not the
    // form — every path needs the same "Continue/Edit into the application" hop. Doing this
    // in only one branch is how the row route ended up auditing a landing page and calling
    // the result inconclusive.
    for (let hop = 0; hop < 2; hop++) {
      if (/EditProject/i.test(page.url())) break; // already in the form
      const cont = page.locator("a, button").filter({ hasText: /^\s*(Continue|Edit|View|Open)\s*$/i }).first();
      if (!(await cont.count().catch(() => 0))) break;
      await cont.click({ timeout: 8000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(3000);
      await dismissPageModals(page).catch(() => null);
    }
    console.log(`auditing: ${page.url().slice(0, 120)}`);

    const stepNav = page.locator("[id^='page-header'], [role='tab'], .stepNav a");
    const stepCount = Math.min(await stepNav.count().catch(() => 0), 12);
    console.log(`wizard steps found: ${stepCount}`);
    if (stepCount === 0) pages.push(await auditPage());
    for (let i = 0; i < stepCount; i++) {
      await stepNav.nth(i).click({ timeout: 8000 }).catch(() => null);
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(2200); // these forms paint late
      pages.push(await auditPage());
    }
    await page.screenshot({ path: path.join(outDir, `audit-${tag}.png`), fullPage: true }).catch(() => null);
  } catch (e) {
    console.log(`audit error: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    await closePortal(opened).catch(() => null);
  }

  // ── the verdict ────────────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const requiredBlank: string[] = [];
  const optionalBlank: string[] = [];
  let filled = 0; let uploadsTotal = 0; let uploadsAttached = 0;
  for (const p of pages) {
    uploadsTotal += p.uploads.total; uploadsAttached += p.uploads.attached;
    for (const f of p.fields) {
      const key = `${f.label}|${f.kind}`;
      if (!f.label || seen.has(key)) continue;
      seen.add(key);
      if (f.filled) { filled++; continue; }
      (f.required ? requiredBlank : optionalBlank).push(f.label);
    }
  }
  console.log(`\n${"═".repeat(70)}`);
  console.log(`APPLICATION AUDIT — ${pages.length} page(s) walked`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  filled fields:        ${filled}`);
  console.log(`  REQUIRED still blank: ${requiredBlank.length}`);
  for (const r of requiredBlank.slice(0, 30)) console.log(`     ✗ ${r}`);
  console.log(`  optional blank:       ${optionalBlank.length}`);
  console.log(`  upload slots:         ${uploadsAttached}/${uploadsTotal} attached`);
  const slots = pages.flatMap((p) => p.uploadSlots);
  const seenSlot = new Set<string>();
  for (const s of slots) {
    if (seenSlot.has(s.label)) continue;
    seenSlot.add(s.label);
    console.log(`     ${s.attached ? "✓" : "✗"} ${s.label}${s.accept ? `   [${s.accept.slice(0, 40)}]` : ""}`);
  }

  // AN AUDIT THAT FOUND NOTHING MUST NOT REPORT "COMPLETE". The first version of this walked
  // one page, saw one field, and declared the application complete — the same falsely-green
  // report it exists to catch. A real application form has many controls, so too few means
  // the audit never reached it, which is an INCONCLUSIVE result, not a pass.
  const totalFields = filled + requiredBlank.length + optionalBlank.length;
  const reachedForm = pages.length > 0 && totalFields >= 8;
  if (!reachedForm) {
    console.log(`\n  VERDICT: INCONCLUSIVE — only ${totalFields} field(s) across ${pages.length} page(s); the audit did not reach the application form.`);
    console.log("           Pass the application's own URL to audit it directly:");
    console.log("           npm run portal:audit -- <portal-login-url> --app=<application-url>");
  } else if (requiredBlank.length > 0 || (uploadsTotal > 0 && uploadsAttached === 0)) {
    console.log(`\n  VERDICT: INCOMPLETE — do not trust this recipe until the fields above are filled.`);
  } else {
    console.log(`\n  VERDICT: COMPLETE — ${totalFields} fields checked across ${pages.length} page(s), nothing required is blank.`);
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(0); });
