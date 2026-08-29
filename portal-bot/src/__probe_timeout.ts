import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); // exactly like browser.ts: no setDefaultTimeout
  const page = await context.newPage();
  // A page that does NOT contain the '/240' service-voltage radio (powerClerk.ts:740)
  await page.setContent("<html><body><h1>PowerClerk section</h1><input id=x></body></html>");

  const loc = page.getByRole("radio", { name: "/240" });

  let t = Date.now();
  const n = await loc.count().catch(() => 0);
  const countMs = Date.now() - t;

  t = Date.now();
  const result = await loc.check().catch(() => null);   // the EXACT current code shape
  const checkMs = Date.now() - t;

  console.log(JSON.stringify({
    countMs, countResult: n,
    checkMs, checkReturned: result,
    invisibleInLogs: result === null,
  }, null, 2));
  await browser.close();
})();
