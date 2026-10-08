// THE CLIENT'S LICENCE IS NAMED BY THE CLIENT'S STATE (#202).
//
// /parser said "CCB" for every client: the "Save to project" client prompt ("the permit
// application carries that client's CCB licence") and the parsed contractor licence note
// ("<Company> | CCB <number> | <phone>") — for a Utah installer whose number is a DOPL licence.
// Licences ruling L5 (backend/src/clients.ts): the NAMED ccbLicenseNumber column is Oregon's CCB,
// always; another state's licence is a TYPED stateLicenses row. So the column keeps its "CCB" label
// (and is left out for a client placed in another state), and the typed rows for the client's state
// are named by that state's board through parser-review.js's one LICENSE_LABELS table (DOPL for
// Utah, CID for New Mexico); an unknown state names no board ("contractor licence").
//
// Part 1 runs the page's own parser-review.js through node:vm (parserReviewList's method).
// Part 2 lifts loadContractorInfo out of parser.html and RENDERS it against a stub DOM, so the
// page's wiring — not only the helper — is pinned. Synthetic clients only.
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

const base = { companyName: "Sample Solar Co", businessPhone: "(555) 010-0100", businessEmail: "ops@example.test" };
const ccbOnly = { ...base, ccbLicenseNumber: "900001" };
// Where the Clients form directs a non-Oregon licence: a typed row for that state.
const utah = { ...base, licenseState: "", businessState: "UT", stateLicenses: [{ state: "UT", kind: "contractor", number: "UT-700002" }] };
const oregon = { ...ccbOnly, licenseState: "", businessState: "OR" };
const newMexico = { ...base, licenseState: "NM", businessState: "AZ", stateLicenses: [{ state: "NM", kind: "contractor", number: "NM-300003" }] };

// ── 1. The note, the prompt and the "no licence" warning ────────────────────────────────────────
{
  const note = PR.clientLicenceNote(utah);
  ok(note === "Sample Solar Co | DOPL UT-700002 | ops@example.test | (555) 010-0100", "note: a Utah client's typed licence is DOPL", note);
  ok(PR.clientLicenceNote(oregon).includes("| CCB 900001 |"), "note: an Oregon client's CCB column still says CCB", PR.clientLicenceNote(oregon));
  ok(PR.clientLicenceNote(newMexico).includes("| CID NM-300003 |"), "note: licenseState (NM) beats the business address — CID", PR.clientLicenceNote(newMexico));

  // L5: the CCB column is never relabelled as another state's licence, nor shown for a Utah client.
  const utahWithCcb = { ...utah, ccbLicenseNumber: "900001" };
  const n2 = PR.clientLicenceNote(utahWithCcb);
  ok(!/\bCCB\b/.test(n2) && !n2.includes("900001") && n2.includes("DOPL UT-700002"), "note: a Utah client's Oregon CCB column is neither relabelled DOPL nor shown", n2);
  ok(!PR.clientLicenceNote({ ...ccbOnly, businessState: "UT" }).includes("DOPL"), "note: the CCB column never becomes 'DOPL <CCB number>'");
  ok(PR.clientLicenceNote({ ...ccbOnly, businessState: "" }).includes("| CCB 900001 |"), "note: an unplaced client's CCB column is still labelled CCB (it is one)");

  // Typed rows: only the client's own state; other kinds name their kind; business registration never.
  const mixed = { ...utah, stateLicenses: [
    { state: "UT", kind: "electrical_contractor", number: "UT-E1" },
    { state: "OR", kind: "contractor", number: "OR-T2" },
    { state: "UT", kind: "business_registration", number: "UT-B3" },
  ] };
  const n3 = PR.clientLicenceNote(mixed);
  ok(n3.includes("UT electrical contractor licence UT-E1") && !n3.includes("OR-T2") && !n3.includes("UT-B3"), "note: typed rows of the client's state only, by kind; never a business registration", n3);
  // #240: an unplaced client's typed rows are shown, each labelled by its OWN row's state — never
  // one state's board on another's number (licenceLabelByState.test pins it in full).
  const unplaced = PR.clientLicenceNote({ ...base, stateLicenses: [{ state: "UT", kind: "contractor", number: "UT-700002" }] });
  ok(unplaced.includes("DOPL UT-700002") && !/\bCCB\b/.test(unplaced), "note: an unknown client state labels each typed row by its own state", unplaced);
  ok(PR.clientLicenceNote({ ...base, businessState: "IA", stateLicenses: [{ state: "IA", kind: "contractor", number: "IA-1" }] }).includes("IA contractor licence IA-1"),
    "note: a state with no board label reads '<ST> contractor licence' (one spelling: licence)");

  ok(/that client’s DOPL licence and the portal/.test(PR.clientGatePrompt(utah)), "prompt: Utah client — DOPL licence", PR.clientGatePrompt(utah));
  ok(/that client’s CCB licence and the portal/.test(PR.clientGatePrompt(oregon)), "prompt: Oregon client — CCB licence");
  ok(/that client’s CID licence and the portal/.test(PR.clientGatePrompt(newMexico)), "prompt: New Mexico client — CID licence");
  const none = PR.clientGatePrompt(null);
  ok(/that client’s contractor licence and the portal/.test(none) && !/CCB/.test(none), "prompt: no client chosen — the generic words, never CCB", none);
  ok(PR.licenceWords("WA") === "L&I contractor registration", "words: a label that already names a registration is not suffixed 'licence'");

  ok(PR.clientLicenceMissing(utah) === "", "warning: a Utah client with a typed DOPL row has its licence on file");
  ok(PR.clientLicenceMissing(oregon) === "", "warning: an Oregon client with a CCB has its licence on file");
  const w = PR.clientLicenceMissing({ ...ccbOnly, businessState: "UT" });
  ok(/has no DOPL licence on file/.test(w), "warning: a Utah client with only an Oregon CCB has no DOPL on file", w);
  ok(/has no CCB licence on file/.test(PR.clientLicenceMissing({ ...base, businessState: "OR" })), "warning: an Oregon client with nothing says CCB");
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
  ...["clearContractorFields", "loadContractorInfo"].map((n) => liftFunction(html, n)),
  "this.loadContractorInfo = loadContractorInfo;",
].join("\n");

interface StubEl { value: string; textContent: string; innerHTML: string }
async function renderPage(client: Record<string, unknown>) {
  const els = new Map<string, StubEl>();
  const el = (id: string): StubEl => {
    if (!els.has(id)) els.set(id, { value: "", textContent: "", innerHTML: "" });
    return els.get(id)!;
  };
  el("saveStatus");
  const sb: Record<string, unknown> = {
    ParserReview: loadReview(),
    $: (id: string) => el(id),
    setVal: (id: string, v: string) => { el(id).value = v; },
    updateGroupSummaries: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ client }) }),
    console,
  };
  vm.runInNewContext(pageCode, sb, { filename: "parser.html (lifted)" });
  await (sb.loadContractorInfo as (id: string) => Promise<void>)("client-1");
  return { note: el("contractorLicenseNotes").value, status: el("saveStatus"), licenceField: el("contractorLicenseNumber").value };
}

(async () => {
  {
    const page = await renderPage(utah);
    ok(page.note.includes("DOPL UT-700002") && !/\bCCB\b/.test(page.note), "render: a Utah client's contractor licence note says DOPL", page.note);
    ok(page.status.textContent === "", "render: no false 'no licence' warning for a Utah client with a typed DOPL row", page.status.textContent);
  }
  {
    const page = await renderPage({ ...utah, ccbLicenseNumber: "900001" });
    ok(!/\bCCB\b/.test(page.note) && !page.note.includes("DOPL 900001"), "render: a Utah client's CCB column is never relabelled DOPL", page.note);
  }
  {
    const page = await renderPage(oregon);
    ok(page.note.includes("CCB 900001"), "render: an Oregon client's note still says CCB", page.note);
    ok(page.licenceField === "900001", "render: the CCB field is still filled from the Oregon CCB column");
  }
  {
    const page = await renderPage({ ...ccbOnly, businessState: "UT", companyName: "<img src=x onerror=alert(1)>" });
    ok(/has no DOPL licence on file/.test(page.status.textContent), "render: a Utah client with only an Oregon CCB is told it has no DOPL on file", page.status.textContent);
    ok(page.status.innerHTML === "", "render: the warning (carrying a hostile synthetic name) is textContent, never markup");
  }
  ok(!/(?:that client|their|a client)(?:&rsquo;|’)?s? CCB licence/.test(html), "source: parser.html no longer hard-codes a client's 'CCB licence'");
  const newProject = fs.readFileSync(path.join(REPO, "frontend", "new-project.html"), "utf8");
  ok(!/their CCB licence/.test(newProject), "source: new-project.html's client prompt no longer says 'their CCB licence'");
  console.log(`\nclientLicenceLabel: ${passed} checks passed`);
})().catch((e) => { console.error(`FAIL - ${e instanceof Error ? e.message : e}`); process.exit(1); });
