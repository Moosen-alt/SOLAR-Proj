// THE PARSER PAGE'S SPLIT MAP READS THE COVER'S SHEET INDEX (#199, #212 review).
//
// docSplitterMirror pins parser-review.js specSheetPages to the splitter, but only through its own
// arguments: parser.html's call site decides which pages it gets. Fed only the DS-coded sheets, it
// never sees the cover's SHEET INDEX nor the image-only S-1 / S-2 datasheets the index names, and
// the map says "03 Module specs: missing" where the splitter says undecided. This runs the REAL
// detectSplitPages / updateSplitUi, cut out of parser.html and run in node:vm with parser-review.js
// as the browser loads it, and reads the split-map text the submit gate reads (splitPagesText).
// Synthetic text only. Run: tsx backend/test/parserSplitMapIndex.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};

const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
/** The source of `function name(…){…}` in parser.html, by brace matching from its declaration. */
function cut(name: string): string {
  const start = html.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`parser.html has no function ${name}`);
  const open = html.indexOf("{", html.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

const values: Record<string, string> = {};
const sandbox: Record<string, unknown> = {
  window: {} as Record<string, unknown>,
  state: { planDoc: null as unknown },
  setVal: (id: string, v: string) => { values[id] = v; },
  getVal: () => "",
  updateProjectDoxUi: () => {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), sandbox, { filename: "parser-review.js" });
// `clean` is a one-line arrow, not a function declaration: take its line as it stands.
const cleanLine = html.split("\n").find((l) => /^const clean = /.test(l));
if (!cleanLine) throw new Error("parser.html has no const clean");
vm.runInContext(cleanLine.replace(/^const /, "var "), sandbox, { filename: "parser.html" });
vm.runInContext(["normalizeText", "actualSheetCode", "pagesByCode", "dsPages", "detectSplitPages", "updateSplitUi"]
  .map((f) => cut(f)).join("\n"), sandbox, { filename: "parser.html" });

/** The split map's text for a plan set of these page texts. */
function splitMap(texts: string[]): string {
  (sandbox.state as { planDoc: unknown }).planDoc = { pageCount: texts.length, pages: texts.map((text, i) => ({ page: i + 1, text })) };
  vm.runInContext("updateSplitUi()", sandbox);
  return values.splitPagesText ?? "";
}
const line = (map: string, n: string) => map.split("\n").find((l) => l.startsWith(n)) ?? "";

const SLD = "SYNTH SOLAR CO Sheet Number E 1.1 Sheet Name ELECTRICAL LINE DIAGRAM";
const TITLE_ONLY = (sheet: string) => `SYNTH SOLAR CO ${sheet}`;

console.log("1. A SHEET INDEX NAMING IMAGE-ONLY S-PAGES: undecided, as the splitter reports");
for (const [layout, cover] of [
  ["rows", "SHEET INDEX CS-1 COVER SHEET E 1.1 ELECTRICAL LINE DIAGRAM S-1 SPEC SHEET S-2 SPEC SHEET"],
  ["columns", "SHEET INDEX SHEET # CS-1 E 1.1 S-1 S-2 SHEET NAME COVER SHEET ELECTRICAL LINE DIAGRAM SPEC SHEET SPEC SHEET"],
] as const) {
  const map = splitMap([cover, SLD, TITLE_ONLY("S-1"), TITLE_ONLY("S-2")]);
  run(`[${layout}] "03 Module specs" is undecided on pages 3, 4`, /^03 Module specs: undecided \(pages 3, 4\b/.test(line(map, "03 ")), line(map, "03 "));
  run(`[${layout}] "04 Inverter specs" is undecided on pages 3, 4`, /^04 Inverter specs: undecided \(pages 3, 4\b/.test(line(map, "04 ")), line(map, "04 "));
}

console.log("\n2. NO INDEX, OR AN INDEX THAT NAMES NO SPEC SHEET: still missing");
{
  const none = splitMap([SLD, TITLE_ONLY("S-1")]);
  run("no index: module specs missing", line(none, "03 ") === "03 Module specs: missing", line(none, "03 "));
  const calcs = splitMap(["SHEET INDEX PV-4 SITE PHOTOS S-1 STRUCTURAL CALCS", SLD, TITLE_ONLY("PV-4"), TITLE_ONLY("S-1")]);
  run("MUST-EXCLUDE: STRUCTURAL CALCS / SITE PHOTOS: module specs missing", line(calcs, "03 ") === "03 Module specs: missing", line(calcs, "03 "));
}

console.log("\n3. A DS-CODED SPEC SHEET STILL FILLS THE ROW");
{
  const map = splitMap([SLD, "SYNTH SOLAR CO Sheet Number DS 1 Sheet Name PV MODULE SPECIFICATION SHEET"]);
  run("03 Module specs: 2", line(map, "03 ") === "03 Module specs: 2", line(map, "03 "));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
