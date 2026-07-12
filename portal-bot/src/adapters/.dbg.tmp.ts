import fs from "node:fs"; import os from "node:os"; import path from "node:path";
process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-dbg-"));
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
const HTML = fs.readFileSync("/home/user/SOLAR-Proj/portal-bot/src/adapters/powerClerkSpecs.dom.smoke.ts","utf8").match(/const HTML = `([\s\S]*?)`;/)![1];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
// Serve over HTTP (not setContent): the learn loop navigates/records by URL.
const http = await import("node:http");
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(HTML); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
await page.goto(`http://127.0.0.1:${port}/specs`);
let calls = 0;
const planner: LearnPlanner = async (req) => {
  calls++;
  if (calls === 1) console.log("PLANNER FIELDS:", JSON.stringify(req.fields.map(f => ({ l: f.label, t: f.fieldType, s: (f as any).section })), null, 0).slice(0, 1500));
  return { fills: [], atReview: calls > 1 };
};
const adapter = new AutoLearnAdapter("dbg", planner, { equipment: { inverterMake: "AP Systems", inverterModel: "DS3-L", moduleMake: "Znshine", moduleModel: "ZXM7-UHLDD108-440/N", moduleQty: "23", inverterQty: "12", tilt: "22.5", azimuth: "180", tracking: "Fixed" } });
(adapter as any).page = page;
const result = await adapter.learn({} as any, {} as any);
console.log("RESULT:", result.ok, result.message, "steps:", result.steps.length);
console.log("STEPS:", JSON.stringify(result.steps.map(s => ({ a: s.action, f: s.field, n: s.note })), null, 0).slice(0, 800));
await browser.close();
