// THE PAGE THE BENCHMARK CALLED CLEAN.
//
// The first live replay benchmark scored PacifiCorp `replayed_clean` — "every recorded step
// ran and nothing was left blank" — and the screenshot it saved of that very page shows the
// portal refusing the filing in red: an empty required PV-array model select reading
// "This field is required.", and an empty required "Total System Export (kW) *". Two blanks,
// both stated on screen, both invisible to the sweep whose entire job is to find them.
//
// The shapes below are that page, reduced. They are not PacifiCorp-specific: a quantity
// beside a model select is the ordinary form of every equipment row, and a caption rendered
// outside a <label> is the ordinary form of half the forms on the web.
//
// The negative cases carry equal weight. A sweep that cries blank on a correctly filled page
// teaches the operator to click past the warning, and then it protects nobody.
//   npx tsx portal-bot/src/requiredSweep.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { sweepEmptyRequiredControls } from "./requiredControlSweep";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const shell = (body: string): string =>
  `<!doctype html><html><head><style>
     body{font:14px sans-serif;padding:20px} .row{display:flex;gap:8px;align-items:center}
     .err{color:#c00;display:block} .form-group{margin:18px 0}
   </style></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  // ---- the live miss, shape 1: a complaint in a row that holds TWO controls ----------
  arrayRow: shell(`
    <div class="form-group">
      <div class="row">
        <span>Qty</span><input name="qty" value="18" />
        <select name="module"><option>Please select...</option><option>REC400AA</option></select>
      </div>
      <span class="err">This field is required.</span>
    </div>`),

  // ---- the live miss, shape 2: an asterisk rendered OUTSIDE a <label for> ------------
  captionAsterisk: shell(`
    <div class="form-group">
      <div>Total System Export (kW) *</div>
      <input name="export" value="" />
    </div>`),

  // ---- both together, as the portal actually served them -----------------------------
  pacificorp: shell(`
    <div class="form-group">
      <div class="row">
        <span>Qty</span><input name="qty" value="18" />
        <select name="module"><option>Please select...</option></select>
      </div>
      <span class="err">This field is required.</span>
    </div>
    <div class="form-group"><div>Total System Export (kW) *</div><input name="export" value="" /></div>
    <div class="form-group"><div>Does The Generation System Size Exceed The Limit?</div><span>false</span></div>`),

  // ---- NEGATIVE: the same page, correctly filled. Must be silent. --------------------
  filled: shell(`
    <div class="form-group">
      <div class="row">
        <span>Qty</span><input name="qty" value="18" />
        <select name="module"><option>Please select...</option><option selected>REC400AA</option></select>
      </div>
    </div>
    <div class="form-group"><div>Total System Export (kW) *</div><input name="export" value="6.4" /></div>`),

  // ---- NEGATIVE: the bug the old single-control bound was defending against ----------
  // One complaint, a page full of filled fields. It must claim the ONE field it sits under,
  // not every control on the page.
  oneComplaintManyFields: shell(`
    <div class="form-group"><label for="a">Applicant *</label><input id="a" value="Wynema Wright" /></div>
    <div class="form-group"><label for="b">Street *</label><input id="b" value="1075 Flanagan Ave" /></div>
    <div class="form-group"><label for="c">City *</label><input id="c" value="Coos Bay" /></div>
    <div class="form-group"><label for="d">Meter number *</label><input id="d" value="" />
      <span class="err">This field is required.</span></div>`),

  // ---- NEGATIVE: INSTRUCTIONS ARE NOT ERRORS -----------------------------------------
  // "Please select all that apply" is the caption above a checkbox group, not a complaint.
  // Checkboxes are excluded from the controls list, so this is exactly the shape that lands
  // in the unattributable bucket — and reporting it would demote a correct run AND stop
  // replay clicking on, because pageIsPassThrough shares this sweep.
  instructions: shell(`
    <div class="form-group"><p>Please select all that apply to this installation:</p>
      <label><input type="checkbox" checked /> Battery storage</label>
      <label><input type="checkbox" /> Generator</label>
    </div>
    <div class="form-group"><label for="q">System size (kW) *</label><input id="q" value="7.2" /></div>`),

  // ---- NEGATIVE: A LEGEND IS NOT A COMPLAINT -----------------------------------------
  // Ameren's live run reported this sentence as a blank required field. Nearly every form
  // carries one, it matches "is required" exactly as a validation message does, and it
  // refers to no field at all — a fabricated gap on a page that may have been complete.
  legend: shell(`
    <p class="err">All Information indicated with a red * (asterisk) is required.</p>
    <div class="form-group"><label for="e">Email *</label><input id="e" value="permit@example.com" /></div>
    <div class="form-group"><label for="p">Phone *</label><input id="p" value="(503) 555-0142" /></div>`),

  // ...but a real complaint on the SAME page is still caught, so the exclusion is not a mute.
  legendPlusRealComplaint: shell(`
    <p class="err">All fields marked with an asterisk are required.</p>
    <div class="form-group"><label for="e2">Email *</label><input id="e2" value="permit@example.com" /></div>
    <div class="form-group"><label for="p2">Meter number *</label><input id="p2" value="" />
      <span class="err">This field is required.</span></div>`),

  // ---- NEGATIVE: THE OTHER LEGEND WORDING, which cost a live run ---------------------
  // Oregon ePermitting's "Licensed Professional List" page carries only "* indicates a
  // required field". The first legend guard covered "indicated with" and not "indicates a",
  // so the sweep called it a blank, pageIsPassThrough refused to click through a page that
  // needed nothing but Continue, and the whole Coos Bay flow stopped there.
  legendIndicates: shell(`
    <p><span>*</span> indicates a required field.</p>
    <div class="form-group"><label for="lp">Licensed Professional</label>
      <input id="lp" value="TML INTERNATIONAL" /></div>`),

  // ---- a complaint no control can own must still be reported -------------------------
  orphanComplaint: shell(`
    <div class="err">Please select at least one option before continuing.</div>
    <div style="height:600px"></div>
    <div class="form-group"><label for="z">Notes</label><input id="z" value="ok" /></div>`),
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? shell("none"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws
// and the .catch turns a crash into "found nothing" — which is this sweep's failure mode.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const sweep = async (key: string) => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(60);
  return await sweepEmptyRequiredControls(page);
};

// ---------------------------------------------------------------------------
// The two live misses.
// ---------------------------------------------------------------------------
const row = await sweep("arrayRow");
check("THE LIVE MISS: an empty select in a two-control row, flagged by the portal, is caught",
  row.length > 0, `sweep returned nothing; the portal said "This field is required."`);
check("...and it names the SELECT, not the filled quantity beside it",
  row.length > 0 && !row.some((r) => /^qty$/i.test(r.name)) && !!row.length,
  JSON.stringify(row));

const cap = await sweep("captionAsterisk");
check("THE LIVE MISS: a required asterisk outside a <label for> is honoured",
  cap.length === 1, JSON.stringify(cap));
check("...and the field is named from the caption a human reads",
  cap.some((r) => /total system export/i.test(r.name)), JSON.stringify(cap));

const pc = await sweep("pacificorp");
check("the page the benchmark called CLEAN reports both blanks",
  pc.length >= 2, `${pc.length} found: ${JSON.stringify(pc)}`);
console.log(`   would have reported: ${JSON.stringify(pc.map((r) => `${r.name} [${r.why}]`))}`);

// ---------------------------------------------------------------------------
// The expensive direction: false alarms train people to ignore the alarm.
// ---------------------------------------------------------------------------
const ok = await sweep("filled");
check("a correctly filled page reports NOTHING", ok.length === 0, JSON.stringify(ok));

const many = await sweep("oneComplaintManyFields");
check("one complaint claims ONE field, not the whole page",
  many.length === 1, `${many.length} reported: ${JSON.stringify(many)}`);
check("...and it is the field the message sits under",
  many.some((r) => /meter/i.test(r.name)), JSON.stringify(many));

const instr = await sweep("instructions");
check("INSTRUCTIONAL 'please select all that apply' is not treated as a complaint",
  instr.length === 0, `false blanks manufactured: ${JSON.stringify(instr)}`);

const legend = await sweep("legend");
check("THE LIVE FALSE POSITIVE: a form's asterisk LEGEND is not a blank field",
  legend.length === 0, `fabricated ${legend.length} gap(s): ${JSON.stringify(legend)}`);

const both = await sweep("legendPlusRealComplaint");
check("...and a real complaint on the same page is still caught",
  both.some((r) => /meter/i.test(r.name)), JSON.stringify(both));
check("...without the legend adding a second, phantom entry",
  both.length === 1, JSON.stringify(both));

const legend2 = await sweep("legendIndicates");
check("THE LIVE FALSE POSITIVE: '* indicates a required field' is a legend, not a blank",
  legend2.length === 0, `fabricated ${legend2.length}: ${JSON.stringify(legend2)}`);

const orphan = await sweep("orphanComplaint");
check("a complaint no field can own is still reported, not dropped",
  orphan.some((r) => r.why === "unattributed-complaint"), JSON.stringify(orphan));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} required-sweep check(s) FAILED.`); process.exit(1); }
console.log("\nAll required-sweep checks passed.");
process.exit(0);
