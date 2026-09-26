// AN UNREAD STATE STAYS BLANK AND IS ASKED FOR — never "OR" (UI audit F31, new-AHJ e2e).
//
// parser.html defaulted the state to "OR" in three places (splitStreetCityStateZip's no-match
// return, parseAddressBlock's initial value, parsePlanData's `addr.state || 'OR'`), and every
// address regex knew only OR|WA|CA|ID|AZ|NV|UT. So an Iowa City, Waltham, Northern Cambria, Corry,
// Venus or Santa Fe County title block never matched, and the job went out as an Oregon job —
// Oregon codes, an Oregon CCB licence ask, PGE.
//
// The fix: one US_STATE_ALT list (50 states + DC, always followed by a ZIP), a blank state when no
// address is read, stateAskFor() naming the gap at the end of the parse, and Oregon-only city
// repairs ("…TER PORTLAND") gated on an OR/WA address.
//
// Method: the named functions/consts are lifted out of parser.html's inline script (brace-matched,
// parserOutputAmps' method) and run in a vm sandbox. Synthetic addresses only (public buildings).
// PARSER_HTML_PATH points it at a mutated copy for the kill runs.
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = fs.readFileSync(process.env.PARSER_HTML_PATH || path.join(REPO, "frontend", "parser.html"), "utf8").replace(/\r\n/g, "\n");

function liftFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `parser.html defines ${name}`);
  let i = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const liftLine = (re: RegExp, what: string): string => {
  const m = html.match(re);
  assert.ok(m, `parser.html defines ${what}`);
  return m[0];
};
const code = [
  liftLine(/^const clean = v => [^\n]+/m, "clean"),
  liftLine(/^const title = v => [^\n]+/m, "title"),
  liftLine(/^const US_STATE_ALT = [^\n]+/m, "US_STATE_ALT"),
  ...["normalizeText", "parseAddressBlock", "stateAskFor"].map((n) => liftFunction(html, n)),
].join("\n");
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(`${code}\nthis.parseAddressBlock = parseAddressBlock; this.stateAskFor = stateAskFor;`, sandbox);
type Addr = { owner: string; street: string; city: string; state: string; zip: string; ahj: string };
const parse = sandbox.parseAddressBlock as (all: string) => Addr;
const ask = sandbox.stateAskFor as (v: string) => string;

let n = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => { assert.ok(cond, `${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); n++; };

// ── MUST-PASS: the new-AHJ states are read off the title block ──────────────────────────────
const cases: Array<[string, string, string, string]> = [
  // [plan text, state, city, zip]
  ["TEST RESIDENCE\n410 E WASHINGTON ST\nIOWA CITY, IA 52240\nSHEET PV-1", "IA", "Iowa City", "52240"],
  ["TEST RESIDENCE\n610 MAIN STREET\nWALTHAM, MA 02452\nPHOTOVOLTAIC SYSTEM", "MA", "Waltham", "02452"],
  ["PROJECT ADDRESS\n4101 CRAWFORD AVE NORTHERN CAMBRIA, PA 15714\nSCOPE OF WORK", "PA", "Northern Cambria", "15714"],
  ["SITE: 700 MAIN ST VENUS, TX 76084", "TX", "Venus", "76084"],
  ["TEST RESIDENCE\n102 GRANT AVE\nSANTA FE, NM 87501", "NM", "Santa Fe", "87501"],
  ["TEST RESIDENCE\n3939 N DRINKWATER BLVD\nSCOTTSDALE, AZ 85251", "AZ", "Scottsdale", "85251"],
  // Oregon still reads as Oregon — the fix removes the default, not the state.
  ["TEST RESIDENCE\n13125 SW HALL BLVD\nTIGARD, OR 97223", "OR", "Tigard", "97223"],
];
for (const [text, st, city, zip] of cases) {
  const a = parse(text);
  ok(a.state === st && a.city === city && a.zip === zip, `MUST-PASS: ${city}, ${st} is read as ${st}`, a);
}

// ── MUST-EXCLUDE: nothing read -> nothing claimed ──────────────────────────────────────────
for (const text of ["", "ELECTRICAL NOTES\nALL WORK PER NEC 2020\nSHEET E-1", "SYSTEM SIZE 8.2 KW DC\nMODULES (20) QCELLS Q.TRON"]) {
  const a = parse(text);
  ok(a.state === "", "MUST-EXCLUDE: text with no address yields a BLANK state, never 'OR'", { text, a });
}
// A two-letter word that is a state code, with no ZIP after it, is not an address.
ok(parse("PANEL IN GARAGE OR BASEMENT\nME 12").state === "", "MUST-EXCLUDE: 'IN' / 'OR' / 'ME' as words are not states", parse("PANEL IN GARAGE OR BASEMENT\nME 12"));

// ── MUST-EXCLUDE: Oregon city repairs stay on Oregon addresses ─────────────────────────────
{
  const a = parse("TEST RESIDENCE\n12 OCEAN ST\nSOUTH PORTLAND, ME 04106");
  ok(a.state === "ME" && a.city === "South Portland" && a.street === "12 Ocean St", "MUST-EXCLUDE: SOUTH PORTLAND, ME is not re-split into 'Ocean St South' / 'Portland'", a);
}

// ── The operator is asked ──────────────────────────────────────────────────────────────────
ok(/STATE NOT READ/.test(ask("")) && /never assumed/.test(ask("")), "MUST-PASS: a blank state produces the ask", ask(""));
ok(ask("  ") !== "", "MUST-PASS: whitespace is blank");
ok(/not a US state code/.test(ask("ZZ")), "MUST-PASS: a non-state value is asked about too", ask("ZZ"));
for (const st of ["IA", "ma", "TX", "OR", "DC", "wy"]) ok(ask(st) === "", `MUST-EXCLUDE: a real state (${st}) is not flagged`, ask(st));

// ── MUST-EXCLUDE (source): no "OR" default left anywhere in the page ───────────────────────
// parsePlanData is ~700 lines and reads the DOM, so its `addr.state || 'OR'` is pinned by source.
const script = html.replace(/\/\/[^\n]*/g, "");
const defaults = [
  /\|\|\s*['"`]OR['"`]/,                         // x || 'OR'
  /\bstate\s*[:=]\s*['"`]OR['"`]/,               // state:'OR' / state = 'OR'
  /defaultState\s*[:=]\s*['"`]OR['"`]/,
  /(?:id="state"|id='state')[^>]*\bvalue=["']OR["']/i,
];
for (const re of defaults) ok(!re.test(script), `MUST-EXCLUDE: parser.html has no state default matching ${re}`, script.match(re)?.[0]);
ok(!/\(OR\|WA\|CA\|ID\|AZ\|NV\|UT\)/.test(script), "MUST-EXCLUDE: no address regex is limited to the seven western states");

console.log(`parserStateDefault: all ${n} checks passed`);
