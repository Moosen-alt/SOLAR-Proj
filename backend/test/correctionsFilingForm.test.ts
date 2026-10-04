// THE MANUAL CORRECTIONS FORM NAMES ITS FILING AND ITS NOTICE (#58) — frontend/corrections-filing.js,
// loaded here through node:vm exactly as the browser sees it.
//
// The route took submissionId / noticeId / noticedAt (#47) but the dashboard sent only the text, so
// every typed correction landed with track '' (no filing), as its own notice, clocked from the moment
// it was typed. Synthetic data only. Run: npx tsx backend/test/correctionsFilingForm.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";

const src = fs.readFileSync(path.join(REPO, "frontend", "corrections-filing.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "corrections-filing.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CF = sandbox.window.CorrectionsFiling as any;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};
check("corrections-filing.js attaches window.CorrectionsFiling", Boolean(CF));

const submissions = [
  { id: "sub-building", submissionType: "permit", permitType: "building", status: "submitted", submittedAt: "2026-09-10T16:00:00Z", applicationNumber: "BLD-TEST-1", permitNumber: "", confirmationNumber: "" },
  { id: "sub-nem", submissionType: "interconnection", permitType: "nem", status: "submitted", submittedAt: "2026-09-20T16:00:00Z", applicationNumber: "NEM-TEST-1", permitNumber: "", confirmationNumber: "" },
  { id: "sub-staged", submissionType: "permit", permitType: "electrical", status: "staged", submittedAt: null, applicationNumber: "", permitNumber: "", confirmationNumber: "" },
  { id: "sub-failed", submissionType: "permit", permitType: "electrical", status: "failed", submittedAt: "2026-09-21T16:00:00Z", applicationNumber: "", permitNumber: "", confirmationNumber: "" },
  { id: "sub-<x>", submissionType: "permit", permitType: "combo", status: "submitted", submittedAt: "2026-09-01T16:00:00Z", applicationNumber: "<img src=x onerror=alert(1)>", permitNumber: "", confirmationNumber: "" },
];

// ── the picker offers the SENT filings only, newest first — the set the server resolves against ──
const sent = CF.sentFilings(submissions).map((s: { id: string }) => s.id);
check("only sent, non-failed filings are offered, newest first",
  JSON.stringify(sent) === JSON.stringify(["sub-nem", "sub-building", "sub-<x>"]), JSON.stringify(sent));
const html = CF.filingOptionsHtml(submissions, "sub-building");
check("a 'not sure' option comes first", html.startsWith('<option value="">Filing: not sure</option>'), html.slice(0, 60));
check("each filing is named by its track, date and number", html.includes("Interconnection (NEM) · sent 2026-09-20 · NEM-TEST-1") && html.includes("Building · sent 2026-09-10 · BLD-TEST-1"), html);
check("the chosen filing stays selected", /<option value="sub-building" selected>/.test(html), html);
check("esc(): a portal's application number cannot inject markup", !html.includes("<img") && html.includes("&lt;img src=x onerror=alert(1)&gt;"), html);
check("esc(): ids are escaped in the value attribute too", html.includes('value="sub-&lt;x&gt;"'), html);
check("no sent filing: the picker says so", CF.filingOptionsHtml([], "") === '<option value="">No sent filing on record</option>');

// ── the payload: filing, notice date, and one noticeId for items of the same notice ──
const base = { projectId: "proj-1", submissions, today: "2026-10-04" };
const a = CF.correctionPayload({ ...base, correctionText: "  Show attachment spacing. ", submissionId: "sub-building", noticedAt: "2026-09-28" });
const b = CF.correctionPayload({ ...base, correctionText: "Add fire setback dimensions.", submissionId: "sub-building", noticedAt: "2026-09-28" });
check("the body names the filing and the notice date", a.ok && a.body.submissionId === "sub-building" && a.body.noticedAt === "2026-09-28" && a.body.correctionText === "Show attachment spacing.", JSON.stringify(a));
check("items typed with the same filing and notice date share one noticeId", a.ok && b.ok && Boolean(a.body.noticeId) && a.body.noticeId === b.body.noticeId, `${a.body?.noticeId} / ${b.body?.noticeId}`);
const otherDate = CF.correctionPayload({ ...base, correctionText: "x", submissionId: "sub-building", noticedAt: "2026-09-29" });
const otherFiling = CF.correctionPayload({ ...base, correctionText: "x", submissionId: "sub-nem", noticedAt: "2026-09-28" });
const otherProject = CF.correctionPayload({ ...base, projectId: "proj-2", correctionText: "x", submissionId: "", noticedAt: "2026-09-28" });
check("another notice date is another notice", otherDate.body.noticeId !== a.body.noticeId);
check("another filing is another notice", otherFiling.body.noticeId !== a.body.noticeId);
check("the project is in the notice id (notice ids are counted across projects)", otherProject.body.noticeId.includes("proj-2"), otherProject.body.noticeId);
const bare = CF.correctionPayload({ ...base, correctionText: "Call the homeowner.", submissionId: "", noticedAt: "" });
check("no filing and no date: text only — the server's defaults (own notice, clock from now)",
  bare.ok && JSON.stringify(bare.body) === JSON.stringify({ correctionText: "Call the homeowner.", source: "manual" }), JSON.stringify(bare.body));
const filingOnly = CF.correctionPayload({ ...base, correctionText: "x", submissionId: "sub-nem", noticedAt: "" });
check("a filing with no notice date groups nothing (each item its own notice)", filingOnly.ok && filingOnly.body.submissionId === "sub-nem" && !("noticeId" in filingOnly.body), JSON.stringify(filingOnly.body));

// ── refusals the operator sees before anything is sent ──
check("empty text is refused", !CF.correctionPayload({ ...base, correctionText: "  ", submissionId: "", noticedAt: "" }).ok);
check("a filing that was never sent is refused", !CF.correctionPayload({ ...base, correctionText: "x", submissionId: "sub-staged", noticedAt: "" }).ok);
check("a filing of another project is refused", !CF.correctionPayload({ ...base, correctionText: "x", submissionId: "sub-elsewhere", noticedAt: "" }).ok);
check("a date the calendar does not have is refused", !CF.correctionPayload({ ...base, correctionText: "x", submissionId: "", noticedAt: "2026-02-30" }).ok);
check("a notice date in the future is refused", !CF.correctionPayload({ ...base, correctionText: "x", submissionId: "", noticedAt: "2026-10-05" }).ok);
check("today is a notice date", CF.correctionPayload({ ...base, correctionText: "x", submissionId: "", noticedAt: "2026-10-04" }).ok);

// ── the page wires it: the script is loaded and the form carries both fields ──
const page = fs.readFileSync(path.join(REPO, "frontend", "dashboard.html"), "utf8");
check("dashboard.html loads corrections-filing.js before the dashboard module",
  page.indexOf('src="/corrections-filing.js"') > 0 && page.indexOf('src="/corrections-filing.js"') < page.indexOf('src="/dashboard.js"'));
check("the corrections form has the filing picker and the notice date", page.includes('id="correctionSubmissionId"') && page.includes('id="correctionNoticedAt"'));
const dash = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
check("addCorrection posts the module's payload", /CorrectionsFiling\.correctionPayload\(/.test(dash) && /JSON\.stringify\(payload\.body\)/.test(dash));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall corrections filing form checks passed");
process.exit(0);
