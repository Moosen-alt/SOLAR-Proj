// THE LICENCE LABEL FOLLOWS THE STATE — EVERY DOOR, ONE LABEL TABLE (#208, #240).
//
// #208: two more places printed Oregon's "CCB" for any state's licence — the filled form's
// installerBlock ("<company> — CCB <n>") and the dashboard's Clients card ("CCB <n>" / "No CCB on
// file"). #240: /parser's clientLicences labelled an UNTYPED stateLicenses row as the board's
// contractor licence ("DOPL <n>") and let it silence the "no licence on file" warning, and an
// unplaced client's typed rows were ignored.
//
// The rule, one label source: CCB for Oregon, the state's board label otherwise (the LICENSE_LABELS
// table — shared/src/licenceKinds.ts LICENCE_BOARD_LABELS for the backend, pinned equal below), the
// generic "contractor licence" when the state is unknown. Synthetic clients and numbers only.
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

process.env.AUTOPILOT_DB_PATH = path.join(process.cwd(), "licence-label.sqlite");

let passed = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => {
  assert.ok(cond, `${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`ok   - ${what}`);
};

const reviewSrc = fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadReview(): Record<string, any> {
  const sb: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(reviewSrc, sb, { filename: "parser-review.js" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sb.window.ParserReview as Record<string, any>;
}
const PR = loadReview();

const base = { companyName: "Sample Solar Co", businessPhone: "(555) 010-0100" };
const oregon = { ...base, licenseState: "OR", ccbLicenseNumber: "900001" };
const utah = { ...base, licenseState: "UT", stateLicenses: [{ state: "UT", kind: "contractor", number: "UT-700002" }] };
const unknown = { ...base, licenseState: "", businessState: "" };

(async () => {
  // ── 0. ONE LABEL TABLE: the frontend copy is the shared table ────────────────────────────────────
  const kinds = await import("../../shared/src/licenceKinds");
  {
    const m = /const LICENSE_LABELS = (\{[\s\S]*?\});/.exec(reviewSrc);
    assert.ok(m, "parser-review.js defines LICENSE_LABELS");
    // eslint-disable-next-line no-new-func
    const front = new Function(`return ${m![1]};`)() as Record<string, string>;
    ok(JSON.stringify(front) === JSON.stringify(kinds.LICENCE_BOARD_LABELS), "parser-review.js LICENSE_LABELS == shared LICENCE_BOARD_LABELS");
    for (const st of [...Object.keys(front), "IA", "or", " ut ", "", "Oregon", "XYZ"]) {
      assert.equal(PR.contractorLicenceLabel(st), kinds.contractorLicenceLabel(st), `contractorLicenceLabel(${JSON.stringify(st)}) front == back`);
    }
    ok(true, "contractorLicenceLabel: the page and the backend give one label for every state, known or not");
    ok(kinds.contractorLicenceLabel("OR") === "CCB" && kinds.contractorLicenceLabel("UT") === "DOPL" && kinds.contractorLicenceLabel("") === "contractor licence",
      "contractorLicenceLabel: CCB for Oregon, the board for Utah, the generic words for an unknown state");
    ok(JSON.stringify([...PR.LICENCE_KINDS_KNOWN].sort()) === JSON.stringify([...kinds.LICENCE_KIND_SET].sort()), "parser-review.js LICENCE_KINDS_KNOWN == shared LICENCE_KINDS");
  }

  // ── 1. #240: an untyped row is never the contractor licence ─────────────────────────────────────
  {
    for (const [st, words] of [["UT", "DOPL"], ["OR", "CCB"], ["IA", "IA contractor licence"]] as const) {
      const c = { ...base, licenseState: st, stateLicenses: [{ state: st, kind: "", number: `${st}-U1` }, { state: st, kind: "misc text", number: `${st}-U2` }] };
      const labels = PR.clientLicences(c).map((l: { label: string; number: string }) => `${l.label} ${l.number}`);
      ok(labels.includes(`${st} licence (unclassified) ${st}-U1`) && labels.includes(`${st} licence (unclassified) ${st}-U2`),
        `MUST-PASS ${st}: an untyped row is labelled "${st} licence (unclassified)"`, labels);
      ok(!labels.some((l: string) => l.startsWith(`${words} `)), `MUST-EXCLUDE ${st}: an untyped row never reads as the ${words}`, labels);
      const w = PR.clientLicenceMissing(c);
      ok(w.includes(`has no ${PR.licenceWords(st)} on file`), `MUST-PASS ${st}: an untyped row alone does not silence the "no licence on file" warning`, w);
      const typed = { ...c, stateLicenses: [...c.stateLicenses, { state: st, kind: "contractor", number: `${st}-C3` }] };
      ok(PR.clientLicenceMissing(typed) === "", `${st}: a typed contractor row beside it does`);
    }
    const unplacedUntyped = { ...unknown, stateLicenses: [{ state: "UT", kind: "", number: "UT-U9" }] };
    ok(/has no contractor licence on file/.test(PR.clientLicenceMissing(unplacedUntyped)), "MUST-PASS unknown state: an untyped row does not count either");
  }

  // ── 2. #240: an unplaced client's typed rows, each by its own state ─────────────────────────────
  {
    const c = { ...unknown, stateLicenses: [
      { state: "UT", kind: "contractor", number: "UT-1" },
      { state: "NM", kind: "contractor", number: "NM-2" },
      { state: "IA", kind: "electrical_contractor", number: "IA-3" },
      { state: "UT", kind: "business_registration", number: "UT-B4" },
    ] };
    const labels = PR.clientLicences(c).map((l: { label: string; number: string }) => `${l.label} ${l.number}`);
    ok(labels.includes("DOPL UT-1") && labels.includes("CID NM-2") && labels.includes("IA electrical contractor IA-3"), "MUST-PASS unplaced: every typed row, labelled by its own state", labels);
    ok(!labels.some((l: string) => /UT-B4|^CCB /.test(l)), "MUST-EXCLUDE unplaced: no business registration, and no row called CCB", labels);
    ok(PR.clientLicenceMissing(c) === "", "unplaced: a typed contractor row is a contractor licence on file");
    const placed = PR.clientLicences({ ...c, licenseState: "UT" }).map((l: { number: string }) => l.number);
    ok(placed.join(",") === "UT-1", "MUST-EXCLUDE placed: a Utah client still shows only its Utah rows", placed);
  }

  // ── 3. #208: the dashboard's Clients card (the real function, lifted) ───────────────────────────
  {
    const dash = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
    const start = dash.search(/^function clientCardLicenceText\(/m);
    assert.ok(start >= 0, "dashboard.js defines clientCardLicenceText");
    let i = dash.indexOf("{", dash.indexOf(")", start)), depth = 0;
    for (; i < dash.length; i++) { if (dash[i] === "{") depth++; else if (dash[i] === "}" && --depth === 0) break; }
    const sb: Record<string, unknown> = { window: { ParserReview: PR } };
    vm.runInNewContext(`${dash.slice(start, i + 1)}\nthis.card = clientCardLicenceText;`, sb);
    const card = sb.card as (c: unknown) => string;
    ok(card(oregon) === "CCB 900001", "MUST-PASS Oregon card: CCB <n>", card(oregon));
    ok(card(utah) === "DOPL UT-700002", "MUST-PASS Utah card: DOPL <n>", card(utah));
    const utahCcbOnly = { ...base, licenseState: "UT", ccbLicenseNumber: "900001" };
    ok(card(utahCcbOnly) === "No DOPL licence on file", "MUST-EXCLUDE Utah card: an Oregon CCB column is never shown as a Utah licence", card(utahCcbOnly));
    ok(card(unknown) === "No contractor licence on file", "MUST-PASS unknown-state card: the generic words", card(unknown));
    ok(!/CCB/.test(card(unknown)) && !/CCB/.test(card({ ...base, licenseState: "NM" })), "MUST-EXCLUDE: no 'CCB' on a client that is not Oregon's");
    ok(!/esc\(client\.ccbLicenseNumber \? "CCB "|: "No CCB on file"\)/.test(dash), "source: the Clients card no longer hard-codes CCB");
    ok(/\$\{esc\(clientCardLicenceText\(client\)\)\}/.test(dash), "source: the card's licence line is esc()'d");
  }

  // ── 4. #208: the filled form's installerBlock ──────────────────────────────────────────────────
  {
    const { resolveSource } = await import("../src/ahjForms");
    type Ctx = Parameters<typeof resolveSource>[1];
    const ctx = (state: string, client: Record<string, unknown>): Ctx => ({
      project: { state } as Ctx["project"],
      client: { installerCompanyName: "Sample Solar Co", ...(state === "OR" && client.ccbLicenseNumber ? { ccbLicenseNumber: String(client.ccbLicenseNumber) } : {}) },
      snapshot: {},
      licences: { client, state, companyName: "Sample Solar Co", projectTracks: [], planSetLicences: [], planSetWarning: "" },
    });
    const block = (state: string, client: Record<string, unknown>) => resolveSource("computed.installerBlock", ctx(state, client));
    ok(block("OR", oregon) === "Sample Solar Co — CCB 900001", "MUST-PASS Oregon form: '<company> — CCB <n>'", block("OR", oregon));
    ok(block("UT", utah) === "Sample Solar Co — DOPL UT-700002", "MUST-PASS Utah form: '<company> — DOPL <n>'", block("UT", utah));
    ok(!/CCB/.test(block("UT", { ...utah, ccbLicenseNumber: "900001" })), "MUST-EXCLUDE Utah form: never CCB, never the Oregon column", block("UT", { ...utah, ccbLicenseNumber: "900001" }));
    ok(block("", { ...utah, ccbLicenseNumber: "900001" }) === "Sample Solar Co", "MUST-EXCLUDE unknown-state form: no licence and no CCB label — the company alone");
    const untyped = { ...base, stateLicenses: [{ state: "UT", kind: "", number: "UT-U1" }] };
    ok(block("UT", untyped) === "Sample Solar Co", "MUST-EXCLUDE: an untyped licence is never put on the form as the contractor's", block("UT", untyped));
    const ia = { ...base, stateLicenses: [{ state: "IA", kind: "contractor", number: "IA-1" }] };
    ok(block("IA", ia) === "Sample Solar Co — IA contractor licence IA-1", "a state with no board label: '<ST> contractor licence <n>'", block("IA", ia));
    // A hand-built context with no licence book reads the overlay's CCB column — Oregon's CCB (L5).
    const bare = { project: { state: "OR" }, client: { installerCompanyName: "Sample Solar Co", ccbLicenseNumber: "900001" }, snapshot: {} } as unknown as Ctx;
    ok(resolveSource("computed.installerBlock", bare) === "Sample Solar Co — CCB 900001", "no licence book: the CCB column still says CCB");
  }

  console.log(`\nlicenceLabelByState: ${passed} checks passed`);
})().catch((e) => { console.error(`FAIL - ${e instanceof Error ? e.message : e}`); process.exit(1); });
