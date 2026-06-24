import assert from "node:assert/strict";
import {
  extractPathParamKeys,
  findCsrfBodyKey,
  findCsrfHeader,
  inferBindings,
  NetworkRecorder,
  redactSensitive,
  shouldCapture,
} from "./networkRecorder";

// Pure-logic tests for the network recorder. No browser — we feed bodies/headers
// directly and assert the redaction, binding inference, CSRF detection, capture
// filter, and a simulated request/response capture via a fake page.
// Run: npm run portal:test:net

function test(name: string, fn: () => void): [string, () => void] {
  return [name, fn];
}

const tests: Array<[string, () => void]> = [
  test("sensitive values are redacted and never stored as recordedValue", () => {
    const body = "Account=ACME123456&Meter=M88899900&Name=Pat";
    const { body: out, bindings } = redactSensitive(body, {
      accountNumber: "ACME123456",
      meterNumber: "M88899900",
    });
    assert.ok(out.includes("__REDACTED:accountNumber__"), "account redacted");
    assert.ok(out.includes("__REDACTED:meterNumber__"), "meter redacted");
    assert.ok(!out.includes("ACME123456"), "raw account must be gone");
    assert.ok(!out.includes("M88899900"), "raw meter must be gone");
    assert.equal(bindings.length, 2);
    assert.ok(bindings.every((b) => b.sensitive && b.recordedValue === undefined), "sensitive bindings store no value");
  }),

  test("non-sensitive field values are bound with their recorded value", () => {
    const body = "InstallerCompany=EXAMPLE SOLAR LLC&City=Testville&Phase=Yes";
    const bindings = inferBindings(body, {
      installerCompanyName: "EXAMPLE SOLAR LLC",
      city: "Testville",
      // "Yes" is non-bindable (too generic) — must NOT bind even though present.
      limitExport: "Yes",
    });
    const fields = bindings.map((b) => b.field).sort();
    assert.deepEqual(fields, ["city", "installerCompanyName"]);
    const company = bindings.find((b) => b.field === "installerCompanyName");
    assert.equal(company?.recordedValue, "EXAMPLE SOLAR LLC");
  }),

  test("CSRF token is detected in header and in body", () => {
    assert.equal(findCsrfHeader({ "RequestVerificationToken": "abc", "content-type": "x" }), "RequestVerificationToken");
    assert.equal(findCsrfHeader({ "X-CSRF-Token": "abc" }), "X-CSRF-Token");
    assert.equal(findCsrfHeader({ "content-type": "x" }), undefined);
    assert.equal(findCsrfBodyKey("__RequestVerificationToken=xyz&Field=1"), "__RequestVerificationToken");
    assert.equal(findCsrfBodyKey("Field=1"), undefined);
  }),

  test("shouldCapture keeps mutating xhr/fetch, drops GET/assets/telemetry", () => {
    assert.equal(shouldCapture("POST", "https://pgenm.powerclerk.com/MvcProjects/Save", "xhr"), true);
    assert.equal(shouldCapture("PUT", "https://pgenm.powerclerk.com/MvcProjects/Field", "fetch"), true);
    assert.equal(shouldCapture("GET", "https://pgenm.powerclerk.com/MvcProjects/Load", "xhr"), false);
    assert.equal(shouldCapture("POST", "https://www.google-analytics.com/collect", "xhr"), false);
    assert.equal(shouldCapture("POST", "https://pgenm.powerclerk.com/app.js", "script"), false);
    assert.equal(shouldCapture("POST", "https://pgenm.powerclerk.com/logo.png", "image"), false);
  }),

  test("extractPathParamKeys pulls ProgramId/ProjectId/FormId from a PowerClerk URL", () => {
    const url = "https://pgenm.powerclerk.com/MvcProjects/PrintViewProject?ProgramId=JYEHFEPJXQ00&ProjectId=NPAA8645J795&FormId=6FJDHPYAD2H1";
    assert.deepEqual(extractPathParamKeys(url), {
      programId: "JYEHFEPJXQ00",
      projectId: "NPAA8645J795",
      formId: "6FJDHPYAD2H1",
    });
  }),

  test("end-to-end capture via a fake page records save POSTs and flags final submit", () => {
    // Minimal fake Playwright page: store the request/response handlers and fire them.
    const handlers: Record<string, ((arg: any) => void)[]> = {};
    const page: any = {
      on: (evt: string, cb: (arg: any) => void) => {
        (handlers[evt] ??= []).push(cb);
      },
    };
    const rec = new NetworkRecorder({
      fieldValues: { installerCompanyName: "EXAMPLE SOLAR LLC" },
      sensitiveValues: { accountNumber: "ACME123456" },
    });
    rec.attach(page);

    function fireRequest(method: string, url: string, body: string, resourceType = "xhr") {
      const request: any = {
        method: () => method,
        url: () => url,
        resourceType: () => resourceType,
        headers: () => ({ "content-type": "application/x-www-form-urlencoded", "RequestVerificationToken": "live-token-ignored" }),
        postData: () => body,
      };
      handlers["request"]?.forEach((h) => h(request));
      return request;
    }

    // A real save call — captured.
    fireRequest("POST", "https://pgenm.powerclerk.com/MvcProjects/SaveField", "InstallerCompany=EXAMPLE SOLAR LLC&Account=ACME123456");
    // A GET — ignored.
    fireRequest("GET", "https://pgenm.powerclerk.com/MvcProjects/Load", "");
    // The final submit — captured but flagged.
    fireRequest("POST", "https://pgenm.powerclerk.com/MvcProjects/SubmitApplication", "ProjectId=NPA");

    const recipe = rec.build({
      scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
      portalPlatform: "powerclerk", portalUrl: "https://pgenm.powerclerk.com", createdBy: "test",
      nowIso: "2026-01-01T00:00:00.000Z",
    });

    assert.equal(recipe.requests.length, 2, "GET dropped; 2 POSTs captured");
    const save = recipe.requests[0];
    assert.ok(save.bodyRaw?.includes("__REDACTED:accountNumber__"), "account redacted in stored body");
    assert.ok(!save.bodyRaw?.includes("ACME123456"), "raw account never stored");
    assert.equal(save.csrfHeaderName, "RequestVerificationToken", "csrf header recorded");
    assert.ok(save.bindings?.some((b) => b.field === "installerCompanyName" && b.recordedValue === "EXAMPLE SOLAR LLC"));
    assert.ok(save.bindings?.some((b) => b.field === "accountNumber" && b.sensitive));
    const submit = recipe.requests[1];
    assert.equal(submit.isFinalSubmit, true, "submit request flagged final");
  }),
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (failures) {
  console.error(`\n${failures} network-recorder test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} network-recorder tests passed.`);
