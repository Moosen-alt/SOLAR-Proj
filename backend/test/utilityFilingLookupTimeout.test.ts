// A TIMED-OUT UTILITY FILING LOOKUP IS NOT A VERDICT (issue #9). Owner live run: PNM's lookup ran
// 6 searches + 3 page reads for 240s, was aborted ("Request was aborted."), and the NEM track sat on
// a silent "not yet identified" with no retry. Stub LLMs only — no network.
//
//   (a) an aborted lookup is retried ONCE in the background on the tight budget; while it runs the
//       card says "timed out, retrying"; a second timeout says so (with a retry path) — and nothing
//       is written, least of all as verified (hard rule 3);
//   (b) the retry's grounded answer is stored seeded and the status clears;
//   (c) a timeout's GROUNDED partial that passes the cited discipline is kept (no retry needed);
//   (d) a grounded partial that kept nothing is NOT stored as a week-long "not found";
//   (e) partialWebSearchOf reads a stream snapshot with the finished-answer helpers.
//
// KILL TESTS (each verified red by hand with the fix removed):
//   K1 ensureUtilityFilingLookedUp: no retry after a timeout                 → (a) fails.
//   K2 runUtilityFilingLookup: a failed grounded partial stored as not-found  → (d) fails.
//   K3 utilityTrackPresentation: status ignored ("not yet identified" only)   → (a) fails.
//
// Run: npx tsx backend/test/utilityFilingLookupTimeout.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utility-filing-timeout-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.PERMIT_PROCESS_LOOKUP = "off";

const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const ufl = await import("../src/utilityFilingLookup");
const { channelKindOf } = await import("../src/submittalTracks");
const { partialWebSearchOf } = await import("../src/llm");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

type Call = { maxSearches?: number; maxFetches?: number; maxTokens?: number };
type Reply = { text?: string; groundedSearches?: number; resultUrls?: string[]; error?: string; timedOut?: boolean };
/** A stub webLookup that answers from a script, one reply per call; each reply waits on its gate. */
function scripted(replies: Reply[]) {
  const calls: Call[] = [];
  const gates = replies.map(() => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; });
  const llm = {
    webLookup: async (input: Call) => {
      const i = calls.push({ maxSearches: input.maxSearches, maxFetches: input.maxFetches, maxTokens: input.maxTokens }) - 1;
      await gates[i].p;
      const r = replies[i] ?? { error: "no more replies" };
      return { text: r.text ?? "", groundedSearches: r.groundedSearches ?? 0, stopReason: null, resultUrls: r.resultUrls ?? [], pagesRead: 0, fetchedUrls: [], error: r.error, timedOut: r.timedOut };
    },
  };
  return { llm: llm as never, calls, open: (i: number) => gates[i].open() };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const ABORTED: Reply = { error: "Request was aborted.", timedOut: true };
const rowCount = (where = "1=1") => (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM utility_filing_lookups WHERE ${where}`)?.n ?? 0);
const proj = (utility: string) => ({ state: "NM", utility, city: "" }) as never;
const ans = (filing: unknown, program: unknown) => JSON.stringify({ filing, program });

await check("(a) an aborted lookup is retried once, tighter; the card says so; nothing is written (never verified)", async () => {
  const s = scripted([ABORTED, ABORTED]);
  assert.equal(ufl.ensureUtilityFilingLookedUp(db, proj("Mesa Timeout Power"), s.llm), true);
  assert.equal(ufl.utilityFilingLookupStatus("NM", "Mesa Timeout Power")?.state, "running");
  s.open(0); await tick();
  assert.equal(s.calls.length, 2, "the retry is queued after the abort");
  assert.deepEqual(s.calls[0], ufl.UTILITY_FILING_BUDGETS.full);
  assert.deepEqual(s.calls[1], ufl.UTILITY_FILING_BUDGETS.tight);
  assert.ok(s.calls[1].maxSearches! < s.calls[0].maxSearches! && s.calls[1].maxFetches! < s.calls[0].maxFetches!, "the retry's budget is tighter");
  assert.equal(ufl.utilityFilingLookupStatus("NM", "Mesa Timeout Power")?.state, "retrying");
  const retrying = ufl.utilityTrackPresentation(db, { state: "NM", utility: "Mesa Timeout Power" });
  assert.match(retrying.channel, /lookup timed out, retrying/);
  assert.equal(channelKindOf(retrying), "unknown");
  s.open(1); await tick();
  assert.equal(s.calls.length, 2, "ONE retry, not a loop");
  assert.equal(ufl.utilityFilingLookupStatus("NM", "Mesa Timeout Power")?.state, "timed_out");
  const after = ufl.utilityTrackPresentation(db, { state: "NM", utility: "Mesa Timeout Power" });
  assert.match(after.channel, /timed out twice — retry/);
  assert.equal(channelKindOf(after), "unknown");
  assert.equal(ufl.getUtilityFilingLookup(db, "NM", "Mesa Timeout Power"), null, "an abort with nothing stores nothing");
  assert.equal(rowCount("verified_at IS NOT NULL"), 0, "nothing is ever written as verified");
  // Deduped meanwhile: the same utility on another project does not start a third call now.
  assert.equal(ufl.ensureUtilityFilingLookedUp(db, proj("Mesa Timeout Power"), s.llm), false);
});

await check("(b) the tight retry's grounded answer is stored seeded and the timeout status clears", async () => {
  const s = scripted([ABORTED, {
    groundedSearches: 1, resultUrls: ["https://retry-electric.example.com/solar"],
    text: ans({ value: { name: "Retry PowerClerk", url: null }, sourceUrl: "https://retry-electric.example.com/solar", quote: "Installers apply through Retry PowerClerk." }, { value: null }),
  }]);
  assert.equal(ufl.ensureUtilityFilingLookedUp(db, proj("Retry Electric"), s.llm), true);
  s.open(0); s.open(1); await tick();
  assert.equal(s.calls.length, 2);
  const row = ufl.getUtilityFilingLookup(db, "NM", "Retry Electric");
  assert.equal(row?.filing.value?.name, "Retry PowerClerk");
  assert.equal(row?.confidence, "seeded");
  assert.equal(ufl.utilityFilingLookupStatus("NM", "Retry Electric"), null);
  assert.match(ufl.utilityTrackPresentation(db, { state: "NM", utility: "Retry Electric" }).channel, /Retry PowerClerk \(cited/);
});

await check("(c) a timeout's GROUNDED partial that passes the cited discipline is kept — no retry needed", async () => {
  const s = scripted([{
    ...ABORTED, groundedSearches: 2, resultUrls: ["https://partial-power.example.com/interconnection"],
    text: ans({ value: { name: "Partial Interconnection Portal", url: null }, sourceUrl: "https://partial-power.example.com/interconnection", quote: "Submit through the Partial Interconnection Portal." }, null),
  }]);
  assert.equal(ufl.ensureUtilityFilingLookedUp(db, proj("Partial Power"), s.llm), true);
  s.open(0); await tick();
  assert.equal(s.calls.length, 1, "a kept partial is not re-searched");
  const row = ufl.getUtilityFilingLookup(db, "NM", "Partial Power");
  assert.equal(row?.filing.value?.name, "Partial Interconnection Portal");
  assert.equal(row?.confidence, "seeded");
  assert.equal(ufl.utilityFilingLookupStatus("NM", "Partial Power"), null);
});

await check("(d) a grounded partial that kept nothing is NOT stored as a week-long 'not found'; the retry is queued", async () => {
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => ({
    text: '{"filing": {"value": {"name": "Half', groundedSearches: 3, stopReason: null, resultUrls: ["https://half-electric.example.com"], pagesRead: 0, error: "Request was aborted.", timedOut: true,
  }) } as never, { state: "NM", utility: "Half Electric" });
  assert.equal(run.saved, false);
  assert.equal(run.timedOut, true);
  assert.equal(ufl.getUtilityFilingLookup(db, "NM", "Half Electric"), null);
  // Through the trigger: the same partial twice → two calls, no row.
  const s = scripted([{ ...ABORTED, groundedSearches: 3, resultUrls: ["https://half2.example.com"], text: "{" }, ABORTED]);
  ufl.ensureUtilityFilingLookedUp(db, proj("Half Two Electric"), s.llm);
  s.open(0); s.open(1); await tick();
  assert.equal(s.calls.length, 2);
  assert.equal(ufl.getUtilityFilingLookup(db, "NM", "Half Two Electric"), null);
});

await check("(e) partialWebSearchOf reads a stream snapshot: grounding, URLs and text as for a finished answer", () => {
  const p = partialWebSearchOf({ content: [
    { type: "server_tool_use", name: "web_search" },
    { type: "web_search_tool_result", content: [{ url: "https://a.example.com/solar", title: "Solar" }] },
    { type: "server_tool_use", name: "web_fetch" },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://a.example.com/apply" } },
    { type: "text", text: '{"filing":' }, { type: "text", text: " null}" },
  ] });
  assert.equal(p.groundedSearches, 1);
  assert.deepEqual(p.resultUrls, ["https://a.example.com/solar"]);
  assert.deepEqual(p.fetchedUrls, ["https://a.example.com/apply"]);
  assert.equal(p.text, '{"filing": null}');
  const none = partialWebSearchOf(undefined);
  assert.equal(none.groundedSearches, 0);
  assert.equal(none.text, "");
  // A search that returned nothing visible is not grounding.
  assert.equal(partialWebSearchOf({ content: [{ type: "server_tool_use", name: "web_search" }, { type: "text", text: "from memory" }] }).groundedSearches, 0);
});

console.log(failures ? `\nutilityFilingLookupTimeout: ${failures} check(s) FAILED` : "\nutilityFilingLookupTimeout: all checks passed");
process.exit(failures ? 1 : 0);
