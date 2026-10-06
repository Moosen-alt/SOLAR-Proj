// THE PARSER PAGE'S SPLIT MAP SCORES PAGES EXACTLY AS THE SPLITTER DOES (#193).
//
// parser.html builds its split map's module / inverter spec rows with frontend/parser-review.js
// (scoreSplitPage / specSheetPages), a browser copy of backend/src/docSplitter.ts scorePage, and the
// submit gate (requiredDocuments.sheetInPlanSet) reads that map. When the two copies drift, the gate
// says "in plan set" for a sheet the splitter reports missing (#90, #149). This pins the copy to the
// original by BEHAVIOUR over a corpus of synthetic title-block strings built from every pattern word
// (singles, pairs, triples, and pairs under each sheet modifier): the same winning category list,
// the same byPattern, the same module / inverter / undecided answer. A regex-source compare would
// break on comment slashes and labels; this breaks only when an answer differs.
//
// It also pins the docType order (a tie goes to the earlier category) and that every pattern on
// either side is exercised by the corpus, so a new pattern needs a corpus word here.
// Synthetic text only. Run: npx tsx backend/test/docSplitterMirror.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";
import { CATEGORY_PATTERNS, indexSpecSheets, isUndecidedSpecPage, scorePage } from "../src/docSplitter";

const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};
// Values cross the vm realm boundary (different Array prototype), so compare by shape.
const json = (v: unknown) => JSON.stringify(v);

// One or more phrasings of every category word: sheet names, sheet numbers, words, vocabulary.
const CATEGORY_WORDS = [
  "3-LINE DIAGRAM", "3LINE DIAGRAM", "ONE-LINE DIAGRAM", "ONELINE", "SINGLE-LINE DIAGRAM", "SINGLELINE", "ELECTRICAL LINE DIAGRAM", "E 1.1", "E1.1",
  "SITE PLAN", "PLOT PLAN", "FIRE PATHWAYS", "FIRE PATHWAY", "FIRE SETBACKS", "FIRE SETBACK", "FIRE ACCESS", "PV 1.0", "PV1.1",
  "MOUNT DETAIL", "ATTACHMENT DETAIL", "S 1.2", "S1.0", "STRUCTURAL", "ROOF SECTION", "RAFTER", "TRUSS",
  "PV MODULE / INV SPECIFICATION SHEET", "MODULE & INVERTER SPEC", "MODULE/INV. SPEC", "MODULE INV SPEC",
  "MODULE SPECIFICATION SHEET", "PV MODULE SPECIFICATION SHEET", "PV MODULE SPEC",
  "MICROINVERTER SPECIFICATION SHEET", "MICRO-INVERTER SPECS", "MICROINVERTER SPECIFICATIONS", "INVERTER SPECIFICATION SHEET", "INVERTER SPEC", "INVERTERS SPECIFICATIONS",
  "WARNING LABELS", "LABEL LOCATION", "E 1.3", "E1.3", "PLACARD", "PLACARDS",
];
// Words that change how a sheet scores rather than which category it names.
const MODIFIERS = [
  "E 2.1", "E-4.0", // an electrical sheet: words / vocabulary do not count (#33)
  "WIRING CALCULATIONS", "WIRE CALCS", "ELECTRICAL CALCULATION", // a calcs sheet: no spec category (#66)
  "GENERAL NOTES", "NOTES", "LABELING NOTES", "PLACARD NOTES", "LABELS NOTES", // notes sheets vs the placard sheet's own notes (#67)
  "SHEET INDEX", "GENERAL NOTES AND PROJECT DATA", // the index / cover page
  "EQUIPMENT SPECIFICATION", "MODULES SPECIFICATIONS", "INVERTER SPECS", // spec-named pages (undecided)
  "Q.TRON Q.MI DS3 MICROINVERTER", "UL 1741", "SEE E 1.1 FOR WIRING", "DIRECTORY PLAQUE", // callout noise
];
const WORDS = [...CATEGORY_WORDS, ...MODIFIERS];
const page = (...parts: string[]) => `PV 9.9 Sheet Name ${parts.join(" ")} Sheet Number PV 9.9`;

const corpus: string[] = [page("COVER SHEET")];
for (const a of WORDS) corpus.push(page(a));
for (let i = 0; i < WORDS.length; i++) for (let j = 0; j < WORDS.length; j++) if (i !== j) corpus.push(page(WORDS[i], WORDS[j]));
for (let i = 0; i < CATEGORY_WORDS.length; i++) for (let j = i + 1; j < CATEGORY_WORDS.length; j++) {
  for (let k = j + 1; k < CATEGORY_WORDS.length; k++) corpus.push(page(CATEGORY_WORDS[i], CATEGORY_WORDS[j], CATEGORY_WORDS[k]));
  for (const m of MODIFIERS) corpus.push(page(CATEGORY_WORDS[i], CATEGORY_WORDS[j], m));
}

console.log("1. EVERY PATTERN IS IN THE CORPUS");
{
  type Cat = { docType: string; patterns?: RegExp[]; sheetNumbers?: RegExp[]; words?: RegExp[]; vocabulary?: RegExp[] };
  const regexes = (cats: Cat[]) => cats.flatMap((c) => [...(c.patterns ?? []), ...(c.sheetNumbers ?? []), ...(c.words ?? []), ...(c.vocabulary ?? [])].map((re) => ({ docType: c.docType, re })));
  const backendUnused = regexes(CATEGORY_PATTERNS).filter(({ re }) => !CATEGORY_WORDS.some((w) => re.test(w)));
  run("every backend CATEGORY_PATTERNS regex matches a corpus word", backendUnused.length === 0, json(backendUnused.map((u) => `${u.docType} ${u.re}`)));
  const fe = PR.SPLIT_CATEGORIES as Cat[] | undefined;
  run("parser-review.js exposes SPLIT_CATEGORIES", Array.isArray(fe));
  const frontendUnused = regexes(fe ?? []).filter(({ re }) => !CATEGORY_WORDS.some((w) => re.test(w)));
  run("every frontend SPLIT_CATEGORIES regex matches a corpus word", frontendUnused.length === 0, json(frontendUnused.map((u) => `${u.docType} ${u.re}`)));
}

console.log("\n2. THE SAME ANSWER ON EVERY PAGE OF THE CORPUS");
{
  const mismatch = (kind: string) => {
    const bad: string[] = [];
    return { bad, note: (t: string, be: unknown, fe: unknown) => { if (json(be) !== json(fe) && bad.length < 5) bad.push(`${kind} ${JSON.stringify(t)}: backend ${json(be)} page ${json(fe)}`); if (json(be) !== json(fe)) count[kind] = (count[kind] ?? 0) + 1; } };
  };
  const count: Record<string, number> = {};
  const winners = mismatch("winners");
  const mod = mismatch("module");
  const inv = mismatch("inverter");
  const und = mismatch("undecided");
  const lab = mismatch("labels");
  for (const t of corpus) {
    const be = scorePage(t);
    const fe = PR.scoreSplitPage(t);
    winners.note(t, be, { docTypes: fe.docTypes, byPattern: fe.byPattern });
    const one = PR.specSheetPages([{ page: 1, text: t }]);
    mod.note(t, be.docTypes.includes("module_spec") ? [1] : [], one.moduleSpecs);
    inv.note(t, be.docTypes.includes("inverter_spec") ? [1] : [], one.inverterSpecs);
    und.note(t, isUndecidedSpecPage(t, be) ? [1] : [], one.undecidedSpecs);
    lab.note(t, be.docTypes.includes("labels"), [...fe.docTypes].includes("labels"));
  }
  run(`scoreSplitPage = scorePage (docTypes, byPattern) on all ${corpus.length} pages`, !winners.bad.length, `${count.winners} differ, e.g. ${winners.bad.join(" | ")}`);
  run("specSheetPages module spec = the splitter's module_spec part", !mod.bad.length, `${count.module} differ, e.g. ${mod.bad.join(" | ")}`);
  run("specSheetPages inverter spec = the splitter's inverter_spec part", !inv.bad.length, `${count.inverter} differ, e.g. ${inv.bad.join(" | ")}`);
  run("specSheetPages undecided = the splitter's undecidedSpecPages", !und.bad.length, `${count.undecided} differ, e.g. ${und.bad.join(" | ")}`);
  run("labels (PLACARD words, wordsSkipNotes on a NOTES sheet) agree", !lab.bad.length, `${count.labels} differ, e.g. ${lab.bad.join(" | ")}`);
}

console.log("\n3. A WHOLE SET: EACH SPEC SIDE IS ONLY ITS OWN PAGES");
{
  const MICRO = page("MICROINVERTER SPECIFICATION SHEET");
  const MODULE = page("PV MODULE SPECIFICATION SHEET");
  const COMBINED = page("PV MODULE / INV SPECIFICATION SHEET");
  const SLD = page("ELECTRICAL LINE DIAGRAM");
  // The splitter's classifyPlanSetPages over a whole set, the cover's sheet index included (#199).
  const splitter = (texts: string[]) => {
    const parts = { moduleSpecs: [] as number[], inverterSpecs: [] as number[], undecidedSpecs: [] as number[] };
    const index = indexSpecSheets(texts);
    texts.forEach((t, i) => {
      const s = scorePage(t);
      if (s.docTypes.includes("module_spec")) parts.moduleSpecs.push(i + 1);
      if (s.docTypes.includes("inverter_spec")) parts.inverterSpecs.push(i + 1);
      if (isUndecidedSpecPage(t, s, index)) parts.undecidedSpecs.push(i + 1);
    });
    return parts;
  };
  const sets: Array<[string, string[]]> = [
    ["only a MICROINVERTER SPECIFICATION SHEET", [SLD, MICRO]],
    ["only a PV MODULE SPECIFICATION SHEET", [MODULE, SLD]],
    ["a combined MODULE / INV sheet", [SLD, COMBINED]],
    ["module and microinverter sheets", [MODULE, SLD, MICRO]],
  ];
  for (const [name, texts] of sets) {
    const fe = PR.specSheetPages(texts.map((text, i) => ({ page: i + 1, text })));
    const be = splitter(texts);
    run(`${name}: the page's spec rows = the splitter's parts`,
      json(fe.moduleSpecs) === json(be.moduleSpecs) && json(fe.inverterSpecs) === json(be.inverterSpecs) && json(fe.undecidedSpecs) === json(be.undecidedSpecs),
      `page ${json(fe)} splitter ${json(be)}`);
  }
  // A SHEET INDEX cover naming image-only, title-block-only S-pages (#199): the page's map reads the
  // index from the whole set and reports them undecided, as the splitter does — before, "missing".
  const TITLE_ONLY = (n: string) => `SYNTH SOLAR CO ${n}`;
  const indexSets: Array<[string, string[], number[]]> = [
    ["a SHEET INDEX in rows", ["SHEET INDEX CS-1 COVER SHEET E-1 ELECTRICAL LINE DIAGRAM S-1 SPEC SHEET S-2 SPEC SHEET", SLD, TITLE_ONLY("S-1"), TITLE_ONLY("S-2")], [3, 4]],
    ["a SHEET INDEX in columns", ["SHEET INDEX SHEET # CS-1 E-1 S-1 S-2 SHEET NAME COVER SHEET ELECTRICAL LINE DIAGRAM SPEC SHEET SPEC SHEET", SLD, TITLE_ONLY("S-1"), TITLE_ONLY("S-2")], [3, 4]],
    ["columns followed by NOTES: SEE MODULE SPEC (#212 review)",
      ["SHEET INDEX SHEET # PV-1 PV-2 PV-3 S-1 S-2 SHEET NAME ROOF PLAN SITE PLAN LAYOUT SPEC SHEET SPEC SHEET NOTES: SEE MODULE SPEC FOR RATINGS", TITLE_ONLY("PV-1"), TITLE_ONLY("S-1"), TITLE_ONLY("S-2")], [3, 4]],
    ["columns followed by PROJECT DATA MODULE SPEC (#212 review)",
      ["SHEET INDEX SHEET # PV-1 PV-2 PV-3 S-1 S-2 SHEET NAME ROOF PLAN SITE PLAN LAYOUT SPEC SHEET SPEC SHEET PROJECT DATA MODULE SPEC QTRON 400W", TITLE_ONLY("PV-1"), TITLE_ONLY("S-1"), TITLE_ONLY("S-2")], [3, 4]],
    ["MUST-EXCLUDE: S-1 STRUCTURAL CALCS, PV-4 SITE PHOTOS", ["SHEET INDEX PV-4 SITE PHOTOS S-1 STRUCTURAL CALCS", TITLE_ONLY("PV-4"), TITLE_ONLY("S-1")], []],
  ];
  for (const [name, texts, want] of indexSets) {
    const all = texts.map((text, i) => ({ page: i + 1, text }));
    // The page passes only its DS-coded sheets as `pages` (none here) and the whole set as `allPages`.
    const fe = PR.specSheetPages([], all);
    const be = splitter(texts);
    run(`${name}: undecided = the splitter's = ${json(want)}`, json(fe.undecidedSpecs) === json(be.undecidedSpecs) && json(be.undecidedSpecs) === json(want),
      `page ${json(fe.undecidedSpecs)} splitter ${json(be.undecidedSpecs)}`);
    run(`${name}: the map says ${want.length ? "undecided" : "missing"}, not a page list`,
      PR.specMapValue(fe.moduleSpecs, fe.undecidedSpecs).startsWith(want.length ? "undecided" : "missing"), PR.specMapValue(fe.moduleSpecs, fe.undecidedSpecs));
  }

  const micro = PR.specSheetPages([{ page: 1, text: SLD }, { page: 2, text: MICRO }]);
  run("THE POINT (#193): a set with only a MICROINVERTER SPECIFICATION SHEET maps the module spec as missing",
    PR.specMapValue(micro.moduleSpecs, micro.undecidedSpecs) === "missing" && json(micro.inverterSpecs) === "[2]", json(micro));
  const mod = PR.specSheetPages([{ page: 1, text: MODULE }]);
  run("…and a set with only a module spec sheet maps the inverter spec as missing",
    PR.specMapValue(mod.inverterSpecs, mod.undecidedSpecs) === "missing" && json(mod.moduleSpecs) === "[1]", json(mod));
  const combined = PR.specSheetPages([{ page: 3, text: COMBINED }]);
  run("a combined MODULE / INV sheet is still both specs", json(combined.moduleSpecs) === "[3]" && json(combined.inverterSpecs) === "[3]", json(combined));
}

console.log("\n3b. THE COVER'S SHEET INDEX READS THE SAME ON BOTH SIDES (#199)");
{
  const ROW_NAMES = ["COVER SHEET", "SITE PLAN", "SPEC SHEET", "CUT SHEET", "DATA SHEET", "DATASHEET", "SPECIFICATION SHEET", "MODULE SPEC SHEET",
    "EQUIPMENT SPECIFICATION", "STRUCTURAL CALCS", "SITE PHOTOS", "MODULE DATA SHEET CALCULATIONS", "GENERAL NOTES"];
  const NUMBERS = ["S-1", "S1", "S 1.1", "PV-4", "E-1.2", "CS-1", "OF 2", "REV 1"];
  const TAILS = ["", "NOTES: SEE MODULE SPEC FOR RATINGS", "PROJECT DATA MODULE SPEC QTRON 400W", "1. ALL WORK PER THE DATA SHEET"];
  const covers: string[] = [];
  for (const a of NUMBERS) for (const x of ROW_NAMES) for (const tail of TAILS) covers.push(`SHEET INDEX ${a} ${x} PV-2 SITE PLAN ${tail}`);
  for (const x of ROW_NAMES) for (const y of ROW_NAMES) for (const tail of TAILS) {
    covers.push(`SHEET INDEX SHEET # CS-1 PV-1 S-1 S-2 SHEET NAME COVER ${x} ${y} SPEC SHEET ${tail}`);
    covers.push(`SHEET INDEX SHEET # CS-1 S-1 S-2 S-3 SHEET NAME ${x} ${y} SPEC SHEET ${tail}`);
  }
  const bad: string[] = [];
  for (const c of covers) {
    const be = indexSpecSheets([c]);
    const fe = PR.indexSpecSheets([c]);
    const shape = (r: { spec: Set<string>; listed: Set<string> }) => json([[...r.spec].sort(), [...r.listed].sort()]);
    if (shape(be) !== shape(fe) && bad.length < 5) bad.push(`${JSON.stringify(c)}: backend ${shape(be)} page ${shape(fe)}`);
  }
  run(`indexSpecSheets agrees on all ${covers.length} covers`, !bad.length, bad.join(" | "));
  const pagesFor = ["SYNTH SOLAR CO S-1", "SHEET NUMBER: S-1 SEE S-2", "SHEET NUMBER: PV-11 SEE S-1", "S-1 SEE S-2", "SYNTH SOLAR CO S 1.1", "SHEET 1 OF 2 S-1"];
  const index = "SHEET INDEX S-1 SPEC SHEET S-2 CUT SHEET S 1.1 DATA SHEET PV-11 SITE PLAN";
  const wrong = pagesFor.filter((t) => isUndecidedSpecPage(t, scorePage(t), indexSpecSheets([index])) !== PR.isUndecidedSpecPage(t, PR.scoreSplitPage(t), PR.indexSpecSheets([index])));
  run("isUndecidedSpecPage with an index agrees on every page", !wrong.length, json(wrong));
}

console.log("\n4. THE DOCTYPE ORDER (A TIE GOES TO THE EARLIER CATEGORY)");
{
  // One sheet-NAME word per category, each scoring exactly 1 on a non-electrical, non-notes page.
  const ONE: Record<string, string> = {
    sld: "ONE-LINE DIAGRAM", site_plan: "SITE PLAN", structural: "MOUNT DETAIL",
    module_spec: "MODULE SPECIFICATION SHEET", inverter_spec: "MICROINVERTER SPECIFICATION SHEET", labels: "WARNING LABELS",
  };
  const ORDER = ["sld", "site_plan", "structural", "module_spec", "inverter_spec", "labels"];
  run("backend CATEGORY_PATTERNS order is sld, site_plan, structural, module_spec, inverter_spec, labels",
    json(CATEGORY_PATTERNS.map((c) => c.docType)) === json(ORDER), json(CATEGORY_PATTERNS.map((c) => c.docType)));
  run("parser-review.js SPLIT_CATEGORIES has the same order",
    json((PR.SPLIT_CATEGORIES ?? []).map((c: { docType: string }) => c.docType)) === json(ORDER));
  const wrong: string[] = [];
  for (let i = 0; i < ORDER.length; i++) for (let j = i + 1; j < ORDER.length; j++) {
    for (const t of [page(ONE[ORDER[i]], ONE[ORDER[j]]), page(ONE[ORDER[j]], ONE[ORDER[i]])]) {
      const be = scorePage(t).docTypes[0];
      const fe = PR.scoreSplitPage(t).docTypes[0];
      if (be !== ORDER[i] || fe !== ORDER[i]) wrong.push(`${ORDER[i]} vs ${ORDER[j]}: backend ${be}, page ${fe}`);
    }
  }
  run("every one-to-one tie goes to the earlier category, on both sides", !wrong.length, wrong.join(" | "));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
