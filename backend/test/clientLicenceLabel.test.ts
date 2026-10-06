// THE CLIENT'S LICENCE IS NAMED BY THE CLIENT'S STATE (#202).
//
// /parser said "CCB" for every client: the "Save to project" client prompt ("the permit
// application carries that client's CCB licence") and the parsed contractor licence note
// ("<Company> | CCB <number> | <phone>") — for a Utah installer whose number is a DOPL licence.
// The label now comes from the client's state through parser-review.js's one LICENSE_LABELS table
// (CCB for Oregon, DOPL for Utah, CID for New Mexico; the generic "contractor licence" when the
// state is unknown).
//
// Part 1 runs the page's own parser-review.js through node:vm (parserReviewList's method).
// Part 2 lifts loadContractorInfo / refreshClientGate out of parser.html and RENDERS them against
// a stub DOM, so the page's wiring — not only the helper — is pinned. Synthetic clients only.
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

let passed = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => {
  assert.ok(cond, `${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`ok   - ${what}`);
};

const reviewSrc = fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8");
function loadReview(): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const sb: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(reviewSrc, sb, { filename: "parser-review.js" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sb.window.ParserReview as Record<string, any>;
}
const PR = loadReview();

const base = {
  companyName: "Sample Solar Co", businessPhone: "(555) 010-0100", businessEmail: "ops@example.test",
  ccbLicenseNumber: "900001",
};
const utah = { ...base, licenseState: "UT", businessState: "UT" };
const oregon = { ...base, licenseState: "OR", businessState: "OR" };
const newMexico = { ...base, licenseState: "", businessState: "NM" };
const unknown = { ...base, licenseState: "", businessState: "" };

// ── 1. The note and the prompt ─────────────────────────────────────────────────────────────
{
  const note = PR.clientLicenceNote(utah);
  ok(note === "Sample Solar Co | DOPL 900001 | ops@example.test | (555) 010-0100", "note: a Utah client's licence is DOPL", note);
  ok(!/\bCCB\b/.test(note), "note: a Utah client's note never says CCB", note);
  ok(PR.clientLicenceNote(oregon).includes("| CCB 900001 |"), "note: an Oregon client still says CCB", PR.clientLicenceNote(oregon));
  ok(PR.clientLicenceNote(newMexico).includes("| CID 900001 |"), "note: no licenseState — the business state (NM) names it: CID", PR.clientLicenceNote(newMexico));
  const generic = PR.clientLicenceNote(unknown);
  ok(generic.includes("| contractor license 900001 |") && !/\bCCB\b/.test(generic), "note: unknown state is the generic label, never Oregon's", generic);
  ok(PR.clientLicenceNote({ ...base, licenseState: "Utah", businessState: "" }).includes("contractor license 900001"), "note: a state that is not a two-letter code is unknown");
  ok(PR.clientLicenceNote({ ...base, licenseState: "UT", businessState: "OR" }).includes("DOPL 900001"), "note: licenseState (the licences' issuing state) beats the business address");

  ok(/that client’s DOPL licence and the portal/.test(PR.clientGatePrompt(utah)), "prompt: Utah client — DOPL licence", PR.clientGatePrompt(utah));
  ok(/that client’s CCB licence and the portal/.test(PR.clientGatePrompt(oregon)), "prompt: Oregon client — CCB licence");
  ok(/that client’s CID licence and the portal/.test(PR.clientGatePrompt(newMexico)), "prompt: New Mexico client — CID licence");
  const none = PR.clientGatePrompt(null);
  ok(/that client’s contractor licence and the portal/.test(none) && !/CCB/.test(none), "prompt: no client chosen — the generic words, never CCB", none);
  ok(PR.licenceWords("WA") === "L&I contractor registration", "words: a label that already names a registration is not suffixed 'licence'");
}

// ── 2. The page renders them (parser.html's own functions, stub DOM) ───────────────────────────
const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8").replace(/\r\n/g, "\n");
function liftFunction(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `parser.html defines ${name}`);
  let i = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const fieldsLine = html.match(/^const CONTRACTOR_FIELDS = [^\n]+/m);
assert.ok(fieldsLine, "parser.html defines CONTRACTOR_FIELDS");
const pageCode = [
  fieldsLine[0],
  ...["clearContractorFields", "loadContractorInfo", "refreshClientGate", "pendingClientConfirmation"].map((n) => liftFunction(html, n)),
  "this.loadContractorInfo = loadContractorInfo; this.refreshClientGate = refreshClientGate;",
].join("\n");

interface StubEl { value: string; textContent: string; innerHTML: string; title: string; disabled: boolean; style: { display: string } }
async function renderPage(client: Record<string, unknown> | null) {
  const els = new Map<string, StubEl>();
  const el = (id: string): StubEl => {
    if (!els.has(id)) els.set(id, { value: "", textContent: "", innerHTML: "", title: "", disabled: false, style: { display: "" } });
    return els.get(id)!;
  };
  // The page's static hint, as parser.html ships it, before any script runs.
  const staticHint = html.match(/<span id="clientGateLicence">([^<]*)<\/span>/);
  el("clientGateLicence").textContent = staticHint ? staticHint[1] : "";
  for (const id of ["saveToSystemBtn", "clientGateHint", "saveStatus"]) el(id);
  if (client) el("clientSelect").value = "client-1";
  const sb: Record<string, unknown> = {
    ParserReview: loadReview(),
    state: { clientResolution: null, clientConfirmed: true, selectedClient: null },
    $: (id: string) => el(id),
    getVal: (id: string) => el(id).value,
    setVal: (id: string, v: string) => { el(id).value = v; },
    updateGroupSummaries: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ client }) }),
    console,
  };
  vm.runInNewContext(pageCode, sb, { filename: "parser.html (lifted)" });
  (sb.refreshClientGate as () => void)();
  if (client) await (sb.loadContractorInfo as (id: string) => Promise<void>)("client-1");
  return { note: el("contractorLicenseNotes").value, gateWords: el("clientGateLicence").textContent, el };
}

(async () => {
  {
    const page = await renderPage(utah);
    ok(page.note.includes("DOPL 900001") && !/\bCCB\b/.test(page.note), "render: a Utah client's contractor licence note says DOPL", page.note);
    ok(page.gateWords === "DOPL licence", "render: the gate's licence words name the picked Utah client's DOPL licence", page.gateWords);
    ok(page.el("clientGateLicence").innerHTML === "", "render: the licence words are textContent, never markup");
  }
  {
    const page = await renderPage(oregon);
    ok(page.note.includes("CCB 900001"), "render: an Oregon client's note still says CCB", page.note);
    ok(page.gateWords === "CCB licence", "render: an Oregon client's gate words still say CCB", page.gateWords);
  }
  {
    const page = await renderPage(null);
    ok(page.gateWords === "contractor licence", "render: no client chosen — the 'Save to project' prompt names no state's licence", page.gateWords);
    ok(page.el("clientGateHint").style.display === "", "render: and the prompt is shown");
  }
  {
    // A synthetic hostile company name lands only in an input's value / the note text.
    const page = await renderPage({ ...utah, companyName: "<img src=x onerror=alert(1)>" });
    ok(page.el("clientGateLicence").innerHTML === "" && page.gateWords === "DOPL licence", "render: a hostile client name never reaches the gate's markup");
  }
  ok(!/client(?:&rsquo;|’)s CCB licence/.test(html), "source: parser.html no longer hard-codes 'that client's CCB licence'");
  console.log(`\nclientLicenceLabel: ${passed} checks passed`);
})().catch((e) => { console.error(`FAIL - ${e instanceof Error ? e.message : e}`); process.exit(1); });
