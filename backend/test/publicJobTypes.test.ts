// Execute the actual POST /api/jobs callback with a fake queue/scope boundary.
// Importing server.ts would start workers and listeners; AST extraction tests
// the registered production handler without booting it, a DB or any network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { HttpError } from "../src/httpError";
import { isPublicJobType } from "../src/publicJobTypes";

const source = fs.readFileSync(path.resolve("backend/src/server.ts"), "utf8");
const ast = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
const callbacks: ts.Node[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(ast) === "app" && node.expression.name.text === "post"
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "/api/jobs") {
    callbacks.push(node.arguments[1]);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(callbacks.length, 1, "find the one production POST /api/jobs handler");
const callback = ts.transpile(`const handler = ${callbacks[0].getText(ast)}; handler;`, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
});

// The handler runs in a vm context: its objects carry that realm's prototypes, so compare as plain data.
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const queued: Array<{ jobType: unknown; payload: unknown; options: Record<string, unknown> }> = [];
const events: string[] = [];
const handler = vm.runInNewContext(callback, {
  HttpError, isPublicJobType, db: {},
  requestScope: () => { events.push("scope"); return { orgId: "org-test" }; },
  assertRefInScope: (_scope: unknown, table: string, projectId: unknown) => {
    events.push("project guard");
    assert.equal(table, "projects");
    if (projectId === "other-tenant") throw new HttpError(404, "Project not found.");
  },
  // The folder_scan confinement (#276) is batchZip's predicate; here only its wiring is pinned.
  folderScanPayload: (_scope: unknown, payload: { folderPath?: string }) => {
    events.push("folder scope");
    return payload.folderPath === "/elsewhere" ? null : { rebuiltBy: "folderScanPayload" };
  },
  enqueueJob: (_db: unknown, jobType: unknown, payload: unknown, options: Record<string, unknown>) => {
    events.push("enqueue");
    const job = { jobType, payload, options };
    queued.push(job);
    return job;
  },
}) as (req: { body?: unknown }, res: unknown) => void;
const response = { code: 0, body: undefined as unknown,
  status(code: number) { this.code = code; return this; },
  json(body: unknown) { this.body = body; return this; },
};

for (const jobType of ["fee_research", "code_research", "run_triage", "correction_triage", "new_internal_job", "__proto__", {}, [], 12]) {
  const before = queued.length;
  assert.throws(() => handler({ body: { jobType, payload: { researchKey: "invented-key" } } }, response),
    (error: unknown) => error instanceof HttpError && error.status === 400,
    `reject internal/unknown job type ${JSON.stringify(jobType)}`);
  assert.equal(queued.length, before, "rejected job must not reach the queue");
}
for (const jobType of ["permit_checks", "nem_checks", "mbox_import", "folder_scan", "autopilot", "prepare_submission", "auto_learn"]) {
  events.length = 0;
  const payload = { track: "permit" };
  handler({ body: { jobType, payload, projectId: "own-project", priority: 7, scheduledAt: "2030-01-01T00:00:00Z", assignedToUser: "operator" } }, response);
  assert.equal(response.code, 201);
  assert.deepEqual(events, jobType === "folder_scan" ? ["scope", "project guard", "folder scope", "enqueue"] : ["scope", "project guard", "enqueue"], "scope is checked before enqueue");
  const job = queued.at(-1)!;
  assert.equal(job.jobType, jobType);
  if (jobType === "prepare_submission") assert.deepEqual(plain(job.payload), payload);
  // A folder scan reaches the queue only as the server rebuilt it, never as the body sent it.
  else if (jobType === "folder_scan") assert.deepEqual(plain(job.payload), { rebuiltBy: "folderScanPayload" });
  else assert.equal(job.payload, payload);
  assert.equal(job.options.orgId, "org-test");
  assert.equal(job.options.projectId, "own-project");
  assert.equal(job.options.priority, 7);
  assert.equal(job.options.assignedToUser, "operator");
  assert.equal(job.options.scheduledAt, "2030-01-01T00:00:00Z");
}
// #276: a folder the caller may not scan is the same 404 as a missing one, and queues nothing.
// KILL: enqueue folder_scan payloads verbatim again → this fails.
{
  const before = queued.length;
  assert.throws(() => handler({ body: { jobType: "folder_scan", payload: { folderPath: "/elsewhere" } } }, response),
    (error: unknown) => error instanceof HttpError && error.status === 404,
    "an out-of-scope folder_scan is refused with 404");
  assert.equal(queued.length, before, "a refused folder_scan must not reach the queue");
}
// Close M1-jobs: final-submit authority never rides the generic route. A prepare_submission body
// carrying autoSubmit / allowFinalSubmit / someone's approvalId reaches the queue as its track only.
// KILL: pass the payload verbatim again → this fails.
{
  const forged = { track: "building", autoSubmit: true, allowFinalSubmit: true, approvalId: "alice-live-approval" };
  handler({ body: { jobType: "prepare_submission", payload: forged, projectId: "own-project", priority: 10 } }, response);
  assert.deepEqual(plain(queued.at(-1)!.payload), { track: "building" }, "the generic route carried final-submit authority into a staging job");
  handler({ body: { jobType: "prepare_submission", payload: { autoSubmit: true, approvalId: "x" }, projectId: "own-project" } }, response);
  assert.deepEqual(plain(queued.at(-1)!.payload), {}, "a trackless forged body kept a final-submit key");
  // Other job types are untouched (their payloads carry no approval).
  const auto = { track: "permit", note: "kept" };
  handler({ body: { jobType: "autopilot", payload: auto, projectId: "own-project" } }, response);
  assert.equal(queued.at(-1)!.payload, auto);
}
const beforeCrossTenant = queued.length;
assert.throws(() => handler({ body: { jobType: "autopilot", projectId: "other-tenant" } }, response),
  (error: unknown) => error instanceof HttpError && error.status === 404);
assert.equal(queued.length, beforeCrossTenant, "out-of-scope jobs stay unqueued");
assert.throws(() => handler({}, response), (error: unknown) => error instanceof HttpError && error.status === 400);
console.log("publicJobTypes: all production-route checks passed");
