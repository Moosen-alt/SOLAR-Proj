// A CREATE DIALOG'S "SUBMIT" IS NOT A FILING — AND EVERYTHING ELSE'S STILL IS.
//
// ComEd's ConnectTheGrid gates every application behind a "New Application" drawer whose only
// forward control is labelled "Submit". Rule 1 (automation never files) means the planner will
// never nominate a submit-shaped control, so the learn filled that drawer and stopped with no
// advance — which is why ComEd's list read "No applications were found" after every run.
//
// The exception that unblocks it is a conjunction, because getting it wrong files an
// application with a utility. This pins the one case that must pass and the four that must
// keep failing. It exercises the same page-side detection the adapter runs.
//   npx tsx portal-bot/src/adapters/createDialog.dom.smoke.ts
import http from "node:http";
import { chromium, type Page } from "playwright";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// The detection the adapter evaluates in-page. Kept in step with clickCreateDialogAdvance.
const detect = (): { name?: string; blocked?: string } | null => {
  const CREATE_HEADING = /\b(new|create|start|begin|add)\b[\s\S]{0,40}\b(application|project|request|submittal|interconnection)\b/i;
  const SUBMIT_SHAPED = /^(submit|create|start|begin|add|ok)$/i;
  // NO trailing \b: these are STEMS. "certif" inside \b(...)\b cannot match "certify",
  // so a drawer gated on "I certify under penalty of perjury" read as safe to click.
  const FILING_LANGUAGE = /by submitting|cannot be (edited|changed|modified)|certif|affirm|under penalt|perjur|final submi|review (and|&) submit|terms and conditions|accept the terms/i;
  const panels = Array.from(document.querySelectorAll(
    "[role='dialog'], mat-dialog-container, .cdk-overlay-pane, .mat-drawer, .modal, [aria-modal='true']"));
  for (const p of panels) {
    const r = (p as HTMLElement).getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const text = ((p as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (!text || !CREATE_HEADING.test(text.slice(0, 200))) continue;
    if (FILING_LANGUAGE.test(text)) return { blocked: "the dialog carries filing/certification language" };
    for (const b of Array.from(p.querySelectorAll("button, [role='button'], input[type='submit']"))) {
      if ((b as HTMLButtonElement).disabled) continue;
      const br = (b as HTMLElement).getBoundingClientRect();
      if (br.width < 1 || br.height < 1) continue;
      const t = `${(b as HTMLElement).innerText || (b as HTMLInputElement).value || ""} ${b.getAttribute("aria-label") || ""}`
        .replace(/\s+/g, " ").trim();
      if (SUBMIT_SHAPED.test(t)) return { name: t };
    }
  }
  return null;
};

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

// 1) ComEd's shape AFTER the type choice: the drawer carries the mini-form and a Submit.
const CREATE_DRAWER = html(`
  <div role="dialog" style="width:400px;height:300px">
    <h2>New Application</h2>
    <button>Distributed Generation</button>
    <label>Project Name <input type="text" value="Testerson Residence"></label>
    <label>Address <input type="text" value="123 Main St"></label>
    <button>Cancel</button>
    <button>Submit</button>
  </div>`);

// 2) The SAME drawer with a certification gate — that is a filing, and must stay blocked.
const CERTIFYING_DRAWER = html(`
  <div role="dialog" style="width:400px;height:300px">
    <h2>New Application</h2>
    <label><input type="checkbox"> I certify under penalty of perjury that the above is true</label>
    <button>Cancel</button>
    <button>Submit</button>
  </div>`);

// 3) A wizard's real final submit, on the PAGE and not in any overlay.
const REVIEW_PAGE = html(`
  <h2>Review and Submit</h2>
  <p>By submitting this application you agree it cannot be edited.</p>
  <button>Submit</button>`);

// 4) A create dialog whose forward control is a PAYMENT. Never, under any condition.
const PAY_DRAWER = html(`
  <div role="dialog" style="width:400px;height:300px">
    <h2>Start New Application</h2>
    <button>Cancel</button>
    <button>Pay Fee</button>
  </div>`);

// 5) A dialog that is not about creating anything — an unrelated confirm.
const OTHER_DIALOG = html(`
  <div role="dialog" style="width:400px;height:300px">
    <h2>Session about to expire</h2>
    <button>Submit</button>
  </div>`);

const pages: Record<string, string> = {
  "/create": CREATE_DRAWER,
  "/certify": CERTIFYING_DRAWER,
  "/review": REVIEW_PAGE,
  "/pay": PAY_DRAWER,
  "/other": OTHER_DIALOG,
};

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(pages[q.url || "/create"] ?? "<html></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page: Page = await context.newPage();
const at = async (route: string): Promise<{ name?: string; blocked?: string } | null> => {
  await page.goto(`http://127.0.0.1:${port}${route}`);
  return page.evaluate(detect);
};

const created = await at("/create");
check("a create drawer's Submit is offered as an advance", created?.name === "Submit", JSON.stringify(created));

const certifying = await at("/certify");
check("a drawer carrying a certification gate is REFUSED (that is a filing)",
  Boolean(certifying?.blocked) && !certifying?.name, JSON.stringify(certifying));

const review = await at("/review");
check("a review page's Submit is untouched — it is not in a dialog at all",
  review === null, JSON.stringify(review));

// Pay/fee is rejected by isPayFee on the Node side; assert the label reaches it unmasked
// rather than being silently treated as an ordinary advance.
const pay = await at("/pay");
check("a create dialog offering only a payment yields no submit-shaped advance",
  pay === null || !/^(submit|create|start|begin|add|ok)$/i.test(pay?.name || ""), JSON.stringify(pay));

const other = await at("/other");
check("a dialog that is not about creating an application is ignored",
  other === null, JSON.stringify(other));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} create-dialog check(s) FAILED.`); process.exit(1); }
console.log("\nAll create-dialog checks passed (real Chromium).");
process.exit(0);
