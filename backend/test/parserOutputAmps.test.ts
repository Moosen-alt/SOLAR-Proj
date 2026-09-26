// ONE UNIT, END TO END: invOutputW / pvMicroOutputW are AMPS.
//
// The llm.ts contract ("rated output CURRENT in amps"), qc.ts's critical rule, baselineRules'
// 125% breaker check and dashboard.js ("Inverter output (A)") all read these two fields as the
// rated continuous output current of ONE inverter. parser.html did not: it labelled them "(W)",
// its regex fallback filled WATTS (7600 for a Tesla 7.6 kW, 349 for a Q.MI-349, 768 for any DS3,
// and multiplied a printed Tesla 32 A by 240), and its planner text said "W each". The only thing
// between a 768 in the amps field and a false "PV breaker below 125%" finding was baselineRules'
// >100 A plausibility guard — and a 7.6 kW DS3 branch at 3.2 A x 12 x 1.25 = 48 A and a Q.MI at
// 349 "A" never reached it.
//
// Iowa City corpus (.probe/kin/ia/corpus): 54/54 parsed values correct under the amps contract;
// the conflict was only ever in parser.html. This file pins the fallback and the UI to amps.
//
// Method: the named functions are lifted out of parser.html's inline script (brace-matched) and
// run in a vm sandbox with the file's own normalizeText/clean/matchFirst. Synthetic text only.
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// PARSER_HTML_PATH lets a mutation run point the test at a deliberately broken copy.
const html = fs.readFileSync(process.env.PARSER_HTML_PATH || path.join(REPO, "frontend", "parser.html"), "utf8");

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
const cleanLine = html.match(/const clean = v => [^\n]+/)?.[0];
assert.ok(cleanLine, "parser.html defines clean");
const code = [cleanLine, ...["normalizeText", "matchFirst", "parseInverterOutputAmps", "essOutputAmpsFromKw"].map((n) => liftFunction(html, n))].join("\n");
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(`${code}\nthis.parseInverterOutputAmps = parseInverterOutputAmps; this.essOutputAmpsFromKw = essOutputAmpsFromKw;`, sandbox);
const amps = sandbox.parseInverterOutputAmps as (sld: string, model?: string, make?: string, line?: string, all?: string) => string;
const essAmps = sandbox.essOutputAmpsFromKw as (kw: string) => string;

let n = 0;
const eq = (actual: string, expected: string, what: string) => { assert.equal(actual, expected, what); n++; };

// ── MUST-PASS: a value printed in W / VA becomes amps at the nominal voltage ─────────────────
eq(amps("MICROINVERTER MAX. CONT. OUTPUT POWER 768 W", "DS3-L"), "3.2", "DS3 768 W -> 3.2 A");
eq(amps("MICROINVERTERS SPECIFICATION MAXIMUM AC OUTPUT 290 VA", "IQ8PLUS-72-2-US"), "1.21", "290 VA -> 1.21 A");
eq(amps("INVERTER CHARACTERISTICS - TESLA NOMINAL POWER 7600 W", "TESLA 7.6 KW SOLAR 1538000"), "31.67", "Tesla 7600 W -> 31.67 A");
eq(amps("Q.MI-480LH (240V) 480 W", "Q.MI-480LH"), "2", "Q.MI 480 W at 240 V -> 2 A");
// 208 V service: the same watts are more amps.
eq(amps("MAX. CONT. OUTPUT POWER 290 W", "IQ8PLUS", "", "", "SERVICE 208V 3-PHASE"), "1.39", "290 W at 208 V -> 1.39 A");
// ── MUST-PASS: a value printed in AMPS stays amps (the old code multiplied Tesla's by 240) ───
eq(amps("TESLA 7.6 KW SOLAR INVERTER OUTPUT: 240VAC, 32 A", "TESLA 7.6 KW SOLAR 1538000", "Tesla"), "32", "Tesla printed 32 A stays 32");
eq(amps("MAXIMUM CONTINUOUS OUTPUT CURRENT 1.21 A", "IQ8PLUS-72-2-US"), "1.21", "datasheet amps stay amps");
// ── MUST-PASS: model-only fallbacks are the model's amps, not its watts ─────────────────────
eq(amps("", "TESLA 7.6KW SOLAR"), "31.67", "Tesla 7.6 fallback in amps");
eq(amps("", "Q.MI.349"), "1.45", "Q.MI 349 fallback in amps");
eq(amps("", "DS3-S"), "3.2", "DS3 fallback in amps");
// ── MUST-EXCLUDE: nothing on the plan -> blank, never a guessed number ─────────────────────
eq(amps("NO INVERTER DATA ON THIS SHEET", "SE7600H-US"), "", "no rating printed, unknown model -> blank");
// A PV-1 circuit-total "MAX AC OUT CURRENT 14.60A" is NOT a per-unit continuous current.
eq(amps("MAX AC OUT CURRENT 14.60A", "MI-700"), "", "a circuit total is not a per-unit current");
// ── ESS: battery kW -> amps, never watts ─────────────────────────────────────────────────
eq(essAmps("11.5"), "47.92", "PW3 11.5 kW -> 47.92 A");
eq(essAmps("5"), "20.83", "5 kW -> 20.83 A");
eq(essAmps(""), "", "blank kW -> blank");

// ── MUST-EXCLUDE: no fallback result is a watt-sized number (the >100 guard must not be what
// saves correctness) ─────────────────────────────────────────────────────────────────────────
for (const [sld, model] of [
  ["MICROINVERTER MAX. CONT. OUTPUT POWER 768 W", "DS3-L"],
  ["INVERTER CHARACTERISTICS - TESLA NOMINAL POWER 7600 W", "TESLA 7.6 KW SOLAR"],
  ["TESLA 7.6 KW SOLAR INVERTER OUTPUT: 240VAC, 32 A", "TESLA 7.6 KW SOLAR"],
  ["", "Q.MI.349"], ["", "DS3"], ["", "TESLA 7.6KW SOLAR"],
]) {
  const v = Number(amps(sld, model, /TESLA/.test(model) ? "Tesla" : ""));
  assert.ok(v > 0 && v < 100, `${model}: ${v} is an amp-sized number`); n++;
}

// ── THE UI: labels and planner text say amps ────────────────────────────────────────────────
const label = (id: string) => html.match(new RegExp(`<label for="${id}">([^<]*)</label>`))?.[1] ?? "";
for (const id of ["invOutputW", "pvMicroOutputW"]) {
  assert.match(label(id), /\(A\)/, `${id} label says (A)`); n++;
  assert.doesNotMatch(label(id), /\(W\)|power/i, `${id} label no longer says watts/power`); n++;
}
assert.doesNotMatch(html, /OutputW\}\s*W each/, "planner text no longer says 'W each' for an output current"); n++;
assert.match(html, /\$\{plan\.invOutputW\} A each/, "planner text says amps"); n++;
// The watt-to-amp multiplication that used to live in the fallback is gone.
assert.doesNotMatch(html, /invOutputW\)\s*\*\s*240/, "no x240 on invOutputW"); n++;
assert.doesNotMatch(html, /essInverterOutputW/, "the ESS output key is amps-named"); n++;

console.log(`parserOutputAmps: ${n}/${n} passed`);
