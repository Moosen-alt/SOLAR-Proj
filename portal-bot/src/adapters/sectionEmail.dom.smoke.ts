// A REQUIRED "Email" BOX IS ANSWERED BY THE SECTION IT SITS IN, NOT BY ITS LABEL.
//
// Live on Marineau's PacifiCorp interconnection: page 3 "Customer Information" and page 5
// "Installer Information" each render a bare, required `Email *`, and the planner left both
// blank. Page 4 "Property Owner Information" then mirrored the customer block READ-ONLY, so
// one blank showed as two, and PacifiCorp refuses a filing over a field whose value we hold.
// Four characters of label cannot say whose email it is — the section heading can.
//
// Pins the rule against the real DOM shapes: heading match, required-only, never overwrite,
// never touch a read-only mirror, and refuse rather than guess on an unknown heading.
//   npx tsx portal-bot/src/adapters/sectionEmail.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// The page-side scan, mirroring fillSectionEmails.
const scanEmails = (): Array<{ key: string; heading: string; label: string }> => {
  const out: Array<{ key: string; heading: string; label: string }> = [];
  let n = 0;
  const nodes = Array.from(document.querySelectorAll('input[type="email"], input[type="text"], input:not([type])')) as HTMLInputElement[];
  for (const el of nodes) {
    if ((el.value || "").trim()) continue;
    if (el.disabled || el.readOnly) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const id = el.getAttribute("id") || "";
    let label = id ? ((document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText || "") : "";
    if (!label) label = (el.closest("label") as HTMLElement | null)?.innerText || "";
    if (!label) label = el.getAttribute("placeholder") || "";
    label = label.replace(/\s+/g, " ").trim();
    if (!/^\*?\s*e-?mail\b/i.test(label)) continue;
    const wrap = el.closest("td, div, li, fieldset") as HTMLElement | null;
    const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true"
      || /\*/.test(label) || /\*/.test((wrap?.innerText || "").slice(0, 120));
    if (!required) continue;
    let heading = "";
    for (let node: Element | null = el; node && !heading; node = node.parentElement) {
      let sib: Element | null = node.previousElementSibling;
      for (; sib && !heading; sib = sib.previousElementSibling) {
        const t = ((sib as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (t && t.length < 80 && /information|contact|details/i.test(t)) heading = t;
      }
    }
    out.push({ key: `em${n++}`, heading, label });
    el.setAttribute("data-al-email", `em${n - 1}`);
  }
  return out;
};

// The routing rule the caller applies.
const roleFor = (heading: string): "installer" | "owner" | "" =>
  /installer|contractor/i.test(heading) ? "installer"
  : /customer|property owner|applicant|generation system owner|site/i.test(heading) ? "owner"
  : "";

// PowerClerk's own shape: section heading, then the contact block. Page 4 mirrors page 3
// read-only (grey, uneditable) exactly as the live screenshot showed.
const PAGE = `<!doctype html><html><body>
  <section>
    <h3>Customer Information</h3>
    <div><label for="c-email">Email *</label><input id="c-email" type="text"></div>
    <div><label for="c-phone">Phone *</label><input id="c-phone" type="text" value="(541) 404-7973"></div>
  </section>
  <section>
    <h3>Property Owner Information</h3>
    <div><label for="p-email">Email *</label><input id="p-email" type="text" readonly></div>
  </section>
  <section>
    <h3>Installer Information</h3>
    <div><label for="i-email">Email *</label><input id="i-email" type="text"></div>
  </section>
  <section>
    <h3>Interconnection Details</h3>
    <div><label for="n-email">Notification Email</label><input id="n-email" type="text"></div>
  </section>
  <section>
    <h3>Some Unknown Information</h3>
    <div><label for="u-email">Email *</label><input id="u-email" type="text"></div>
  </section>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const found = await page.evaluate(scanEmails);
const byRole = found.map((f) => ({ ...f, role: roleFor(f.heading) }));

check("THE REGRESSION: the customer block's required Email is found and routed to the owner",
  byRole.some((f) => f.role === "owner" && /Customer Information/.test(f.heading)),
  JSON.stringify(byRole.map((f) => [f.heading, f.role])));

check("the installer block's Email routes to the installer, not the owner",
  byRole.some((f) => f.role === "installer" && /Installer/.test(f.heading)));

check("the READ-ONLY mirrored Property Owner block is never touched",
  !found.some((f) => /Property Owner/.test(f.heading)),
  "a mirror is filled by its source, not by us");

check("an OPTIONAL email (no asterisk) is left alone",
  !found.some((f) => /Notification/i.test(f.label)));

check("a required email under an UNRECOGNISED heading is found but refused, not guessed",
  byRole.some((f) => /Unknown/.test(f.heading) && f.role === ""),
  JSON.stringify(byRole.map((f) => [f.heading, f.role])));

check("the phone box next to the email is not mistaken for one", !found.some((f) => /phone/i.test(f.label)));

// Fill exactly as the pass does, then confirm what landed where.
for (const f of byRole) {
  const v = f.role === "installer" ? "permit@infinitysolarusa.com" : f.role === "owner" ? "annmarineau@gmail.com" : "";
  if (v) await page.locator(`[data-al-email="${f.key}"]`).first().fill(v);
}
check("customer email landed", await page.locator("#c-email").inputValue() === "annmarineau@gmail.com");
check("installer email landed", await page.locator("#i-email").inputValue() === "permit@infinitysolarusa.com");
check("the unknown-heading box stayed EMPTY", await page.locator("#u-email").inputValue() === "");
check("an already-answered field is never overwritten", await page.locator("#c-phone").inputValue() === "(541) 404-7973");

// A page with nothing required must produce no work at all.
await page.setContent(`<!doctype html><body><h3>Contact Information</h3>
  <label for="e">Email</label><input id="e" type="text"></body>`);
check("no required email anywhere → the pass does nothing", (await page.evaluate(scanEmails)).length === 0);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} section-email check(s) FAILED.`); process.exit(1); }
console.log("\nAll section-email checks passed (real Chromium).");
process.exit(0);
