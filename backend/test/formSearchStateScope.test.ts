// ISSUE #162 — the AHJ form search is scoped to the state, and a served jurisdiction is not searched
// under its own name. Owner's live run 2026-10-04: findAhjFormUrl for the City of Monroe, Oregon spent
// its three searches on Monroe MI / CT / OH, found nothing of Monroe's, and Stage failed for want of the
// prescriptive application. Pins, with the Anthropic client stubbed (a fake search provider) and the
// process offline (_isolate):
//   · every query the form search is told to run names the state by full name AND abbreviation, and
//     the request the model receives carries them;
//   · same-named out-of-state results are discarded — from the search results, the model's candidate
//     links, its forms page and its portal — and BEFORE the result cap, so twenty-five Monroe MI hits
//     cannot crowd out the one Monroe OR result;
//   · the filter only removes: a result that names this state, or no state, is kept (must-pass);
//   · a served Oregon city (a cited buildingProgram "state") gets the statewide BCD 5952 attached and
//     its application slot answered with whose form it is — with NO search; the pre-Stage gate does
//     not promise one either;
//   · a city that runs its own program still searches (must-pass).
// Run: tsx backend/test/formSearchStateScope.test.ts
import "./_isolate"; // FIRST: temp cwd + offline (the 5952 is served from its fixture)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AhjFormUrlResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "form-search-state-scope-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "PERMIT_PROCESS_LOOKUP", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
for (const k of ["DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DOCUMENT_FETCH_BROWSER = "0";

const scope = await import("../src/formSearchScope");
const { ClaudeLLMProvider } = await import("../src/llm");
const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const auto = await import("../src/ahjFormAuto");
const pp = await import("../src/permitProcess");
const plan = await import("../src/formAcquisitionPlan");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ── The fake search provider: the Anthropic client, stubbed ────────────────────────────────────────
const hit = (url: string, title: string) => ({ type: "web_search_result", url, title, encrypted_content: "x", page_age: null });
function fakeSearch(results: Array<ReturnType<typeof hit>>, answer: unknown) {
  const provider = new ClaudeLLMProvider("sk-ant-test-not-a-key");
  const seen: Array<{ system: string; user: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = {
    messages: {
      stream(params: { system: Array<{ text: string }>; messages: Array<{ content: unknown }> }) {
        const c = params.messages[0]?.content;
        seen.push({ system: params.system.map((b) => b.text).join("\n"), user: typeof c === "string" ? c : JSON.stringify(c) });
        return {
          async finalMessage() {
            const use = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } };
            return {
              content: [use, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results }, { type: "text", text: JSON.stringify(answer) }],
              usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 3 } },
              stop_reason: "end_turn",
            };
          },
        };
      },
    },
  };
  return { provider, seen };
}

try {
  // ═══ UNIT — the queries ══════════════════════════════════════════════════════════════════════
  await check("every form-search query names the state by full name AND abbreviation", () => {
    for (const formType of ["permit_application", "building_application", "electrical_application", "solar_checklist"]) {
      const qs = scope.stateScopedFormQueries("City of Monroe", "OR", formType);
      assert.ok(qs.length >= 2, formType);
      for (const q of qs) {
        assert.match(q, /\bOregon\b/, q);
        assert.match(q, /\bOR\b/, q);
        assert.match(q, /"City of Monroe"/, q);
      }
    }
    assert.match(scope.stateScopedFormQueries("Town of Example", "NM")[0], /New Mexico NM/);
    assert.deepEqual(scope.stateScopedFormQueries("City of Monroe", "XX"), [], "an unknown state is not guessed");
  });

  // ═══ UNIT — the filter, both ways ═══════════════════════════════════════════════════════════
  await check("a same-named place in another state is discarded (MUST-EXCLUDE)", () => {
    const out: Array<[string, string, string]> = [
      ["https://www.monroemi.gov/building", "Building Department", "mi"],
      ["https://www.monroe-ct.gov/forms/building.pdf", "Forms", "ct"],
      ["https://www.monroetwpoh.org/permits", "Permits", "oh"],
      ["https://ci.monroe.mi.us/forms", "Forms", "mi"],
      ["https://www.michigan.gov/lara/bureau-list/bcc", "Bureau of Construction Codes", "mi"],
      ["https://www.cityofmonroemichigan.org/permits", "Permits", "mi"],
      ["https://www.example-news.com/a", "City of Monroe, MI - Building Permit Application", "mi"],
      ["https://www.example-news.com/b", "Building permits | Monroe, Connecticut", "ct"],
      ["https://www.example-news.com/c", "Monroe Township (OH) zoning and building", "oh"],
    ];
    for (const [url, title, want] of out) assert.equal(scope.outOfStateResultState({ url, title }, "City of Monroe", "OR"), want, `${url} | ${title}`);
  });
  await check("this state's place, or one naming no state, is kept (MUST-PASS)", () => {
    const keep: Array<[string, string]> = [
      ["https://www.ci.monroe.or.us/forms", "Forms"],
      ["https://www.cityofmonroe.org/building", "City of Monroe, Oregon — Building"],
      ["https://www.cityofmonroe.org/building", "Monroe, OR permit center"],
      ["https://www.monroeor.gov/permits", "Permits"],
      ["https://www.co.benton.or.us/cd/page/building-permits", "Benton County Building Permits"],
      ["https://www.oregon.gov/bcd/Formslibrary/5952.pdf", "Prescriptive solar checklist"],
      ["https://www.monroeco.org/building", "Building"], // "co" is county, never read as Colorado
      ["https://www.example-news.com/d", "Monroe in the news: permits up"], // "in" is not Indiana
      ["https://www.example-news.com/e", "MONROE IN BRIEF"], // an all-caps title has no abbreviations
      ["https://www.example-news.com/f", "Monroe, OR vs Monroe, MI"], // names this state too
    ];
    for (const [url, title] of keep) assert.equal(scope.outOfStateResultState({ url, title }, "City of Monroe", "OR"), "", `${url} | ${title}`);
  });

  // ═══ END TO END — findAhjFormUrl with the fake search provider ═══════════════════════════════
  await check("findAhjFormUrl: the request carries the state; out-of-state hits are not consumed or accepted", async () => {
    const elsewhere = [
      hit("https://www.monroemi.gov/DocumentCenter/View/1/Building-Permit-Application", "Building Permit Application"),
      hit("https://www.monroe-ct.gov/forms/building.pdf", "Building Permit Application"),
      hit("https://www.example-news.com/monroe-oh", "City of Monroe, OH - Building Department forms"),
    ];
    // Twenty-five out-of-state hits FIRST: with the cap applied before the filter, Monroe OR's one
    // result fell off the end (askWithWebSearch kept the first 20).
    const crowd = Array.from({ length: 25 }, (_, i) => hit(`https://www.monroemi.gov/DocumentCenter/View/${100 + i}/Form-${i}`, `Form ${i}`));
    const own = hit("https://www.ci.monroe.or.us/DocumentCenter/View/7/Building-Permit-Application", "City of Monroe, Oregon - Building Permit Application");
    const { provider, seen } = fakeSearch([...elsewhere, ...crowd, own], {
      formName: "Building permit application",
      candidateUrls: ["https://www.monroemi.gov/DocumentCenter/View/1/Building-Permit-Application", "https://www.monroe-ct.gov/forms/building.pdf"],
      formsPageUrl: "https://www.monroemi.gov/forms",
      submittalPortalUrl: "https://www.monroe-ct.gov/portal",
      confidence: "low",
      notes: "all results were for same-named cities",
    });
    const r: AhjFormUrlResult = await provider.findAhjFormUrl({ ahj: "City of Monroe", state: "OR", formType: "building_application" });
    assert.equal(seen.length, 1, "one search call, no new call sites");
    assert.match(seen[0].system, /STATE SCOPE/);
    assert.match(seen[0].user, /State: Oregon \(OR\)/);
    const queryLines = seen[0].user.split("\n").filter((l) => l.startsWith("- "));
    assert.ok(queryLines.length >= 2, "the request lists state-scoped queries");
    for (const q of queryLines) { assert.match(q, /\bOregon\b/); assert.match(q, /\bOR\b/); }
    assert.deepEqual(r.searchResults?.map((x) => x.url), [own.url], "only Monroe, Oregon's result is kept — and it survives the crowd");
    assert.deepEqual(r.candidateUrls, [], "no out-of-state candidate is accepted");
    assert.equal(r.formsPageUrl, "");
    assert.equal(r.submittalPortalUrl, "");
    assert.equal(r.discardedOutOfState?.length, 3 + 25 + 2, "every discarded result (and the model's out-of-state forms page and portal) is reported");
    assert.deepEqual([...new Set(r.discardedOutOfState!.map((d) => d.state))].sort(), ["CT", "MI", "OH"]);
    assert.match(r.notes, /same-named place in another state/);
  });

  // ═══ THE SERVED-CITY FALLBACK ═════════════════════════════════════════════════════════════════
  const CITE = "https://www.co.example.or.us/building/served-cities";
  const mkProject = (ahj: string, state = "OR") => repo.createProject(db, {
    owner: "Fixture Owner", street: "1 Fixture Rd", city: ahj.replace(/^(?:City|Town) of /, ""), state, zip: state === "OR" ? "97000" : "02000", ahj, utility: "Example Utility", dcKw: "6.0", acKw: "5.0",
    permitPathOverride: state === "OR" ? "prescriptive" : "engineered", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
  } as never).project;
  const lookup = (ahj: string, value: "own" | "state", quote: string, state = "OR") => pp.savePermitProcessLookup(db, {
    state, ahj, lookedUpAt: new Date().toISOString(), confidence: "verified",
    issuingAgency: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, permits: [],
    buildingProgram: { value, sourceUrl: CITE, quote, origin: "verified" },
  } as never, { verifiedBy: "reviewer@example.test" });
  const countingLlm = () => {
    const calls: string[] = [];
    const llm = {
      async findAhjFormUrl(input: { ahj: string; formType?: string }) {
        calls.push(`${input.ahj}:${input.formType}`);
        return { provider: "claude", formName: "", candidateUrls: [], formType: input.formType || "permit_application", confidence: "low", notes: "" };
      },
      async mapAcroFormFields() { throw new Error("the BCD 5952 has a built-in map; no model may map it"); },
      async mapFlatFormOverlay() { throw new Error("no model mapping expected"); },
    } as unknown as LLMProvider;
    return { llm, calls };
  };

  await check("a served Oregon city: the statewide 5952 is attached and NO search runs", async () => {
    const ahj = "City of Example Served";
    lookup(ahj, "state", "The City of Example Served has no building program; building permits are issued by the state");
    const project = mkProject(ahj);
    assert.ok(pp.servedByStateIssuer(project), "the cited buildingProgram says the state issues");
    const { llm, calls } = countingLlm();
    const pass = await auto.ensureAhjFormsForProject(db, llm, project, { formsPage: { reader: null, minGapMs: 0 } });
    assert.deepEqual(calls, [], "findAhjFormUrl was never called");
    const checklist = pass.results.find((r) => r.formType === "solar_checklist");
    assert.ok(checklist, `the statewide checklist is wanted (needed: ${pass.neededTypes.join(", ")})`);
    assert.equal(checklist!.status, "acquired", checklist!.message);
    for (const r of pass.results.filter((x) => x.formType !== "solar_checklist")) {
      assert.equal(r.status, "not_found", `${r.formType}: ${r.message}`);
      assert.match(r.message, /does not run its own building program/);
      assert.match(r.message, /Oregon BCD 5952 is attached/);
      assert.ok(r.message.includes(CITE), "the slot cites why");
    }
    const acq = plan.stageAcquisitionFor(db, project);
    assert.equal(plan.stageAcquiresForm(db, project, "building_application", "prescriptive", { ...acq, acquires: true, research: true, researchOpen: true }), null,
      "the gate does not promise a search Stage will not run");
  });

  // (An Oregon city with no profile of its own is portal-entry-only — oregon-generic-epermitting — and
  // never searched either way, so the searching case is a town whose profile publishes a PDF.)
  await check("a served town elsewhere is not searched either; its slot says whose form it is", async () => {
    const ahj = "Town of Example Served";
    lookup(ahj, "state", "The Town of Example Served has no building program; building permits are issued by the state", "MA");
    const project = mkProject(ahj, "MA");
    const { llm, calls } = countingLlm();
    const pass = await auto.ensureAhjFormsForProject(db, llm, project, { formsPage: { reader: null, minGapMs: 0 } });
    assert.deepEqual(calls, []);
    assert.ok(pass.results.length >= 1);
    for (const r of pass.results) {
      assert.equal(r.status, "not_found", `${r.formType}: ${r.message}`);
      assert.match(r.message, /does not run its own building program/);
      assert.doesNotMatch(r.message, /5952/, "no Oregon checklist outside Oregon");
    }
  });

  await check("a town that runs its own program still searches (MUST-PASS)", async () => {
    const ahj = "Town of Example Own";
    lookup(ahj, "own", "The Town of Example Own Building Division issues building permits for the town", "MA");
    const project = mkProject(ahj, "MA");
    assert.equal(pp.servedByStateIssuer(project), null);
    assert.equal(plan.servedJurisdictionForms(project, "building_application"), null);
    const { llm, calls } = countingLlm();
    const pass = await auto.ensureAhjFormsForProject(db, llm, project, { formsPage: { reader: null, minGapMs: 0 } });
    assert.ok(calls.length >= 1, `its own form is searched for (${pass.results.map((r) => `${r.formType}: ${r.status} ${r.message}`).join(" / ")})`);
  });

  await check("a city nothing is known about keeps its search (unknown stays unknown)", async () => {
    const project = mkProject("City of Example Unknown");
    assert.equal(plan.servedJurisdictionForms(project, "building_application"), null);
  });
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`formSearchStateScope: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("formSearchStateScope: all checks passed");
