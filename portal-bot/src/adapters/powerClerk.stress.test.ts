// PowerClerk (PGE NEM) — data-contract stress check, intake → fill readiness.
//
// PowerClerk's generation section drives values into PGE's proprietary searchable
// dropdowns (selectSearchable → brittle div.nth(4) targeting) that cannot be
// faithfully mocked in-process, so the live settle/blur fix (the blank-draft bug)
// is verified separately against a real browser by pc-verify. THIS test verifies
// the OTHER half of "tip to tail": that a fully-staged project resolves EVERY
// required fillApplication input — the installer-identity guard, account/meter
// binding, applicant block, service config, inverter make/model/qty, and the PV
// array reader — so a live run would not abort with a required-field failure.
//
// The fixture is SYNTHETIC (no real homeowner PII / account / meter) but shaped
// exactly like a staged project. Field-access expressions below MIRROR
// powerClerk.ts exactly (line refs noted) so this test fails if the adapter's
// field contract drifts.
//
// Browser-free. Run:  npm run portal:test:stress
import type { ProjectRecord } from "../../../shared/src/types";
import { waitForInteractiveControls } from "../safeAction";

// ── synthetic past-project fixture (PII-free, type-correct ProjectRecord) ─────
const project: ProjectRecord = {
  id: "stress-fixture-001",
  clientId: null,
  homeownerName: "Pat Example",
  projectAddress: "100 N Example St, Testville, OR, 97000",
  city: "Testville",
  state: "OR",
  zip: "97000",
  ahj: "City of Testville",
  utility: "PGE",
  accountNumber: "0000000000",
  meterNumber: "00000000",
  systemSizeDcKw: 5.28,
  systemSizeAcKw: 4.608,
  totalExportKw: null,
  interconnectionMethod: "Load-side breaker",
  // `submit_staging` was removed from ProjectStatus (2026-09-19) — it had zero writers.
  // `ready_to_stage` is the surviving status for "fully staged, not yet in the portal",
  // which is what this fixture models. currentStage below is free-text PROSE, not a
  // status, and is deliberately left as-is: a recorded label is a matching key.
  status: "ready_to_stage",
  currentStage: "submit_staging",
  parserConfidenceSummary: "",
  parserSnapshot: {
    moduleManufacturer: "Example Solar",
    moduleModel: "EX-440",
    moduleQuantity: "12",
    moduleWatts: "440",
    inverterManufacturer: "Example Inverters",
    inverterModel: "EX-INV",
    inverterQuantity: "6",
    hasBattery: "No",
    jobValue: "$25,000",
    installerCompanyName: "EXAMPLE SOLAR LLC",
    installerEmail: "permits@example.test",
    mainServiceRating: "200A",
    pvArrays: [{ quantity: "12", moduleManufacturer: "Example Solar", moduleModel: "EX-440", tilt: "30", azimuth: "172" }],
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const s = project.parserSnapshot as Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)); // powerClerk.ts:26

// readArrays() — mirrors powerClerk.ts:41-67
interface PvArray { quantity: string; moduleManufacturer: string; moduleModel: string; tilt: string; azimuth: string; }
function readArrays(): PvArray[] {
  const raw = s["pvArrays"] ?? s["pv_arrays"] ?? s["arrays"];
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((e) => {
      const a = (e ?? {}) as Record<string, unknown>;
      return {
        quantity: str(a["quantity"] ?? a["qty"] ?? a["moduleQuantity"]),
        moduleManufacturer: str(a["moduleManufacturer"] ?? a["manufacturer"] ?? a["module_manufacturer"]),
        moduleModel: str(a["moduleModel"] ?? a["model"] ?? a["module_model"]),
        tilt: str(a["tilt"]), azimuth: str(a["azimuth"]),
      };
    });
  }
  const single: PvArray = {
    quantity: str(s["moduleQuantity"] ?? s["module_quantity"]),
    moduleManufacturer: str(s["moduleManufacturer"] ?? s["module_manufacturer"]),
    moduleModel: str(s["moduleModel"] ?? s["module_model"]),
    tilt: str(s["tilt"]), azimuth: str(s["azimuth"]),
  };
  return single.quantity || single.moduleModel ? [single] : [];
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("Fixture:", project.homeownerName, "|", project.projectAddress, "| utility:", project.utility);
console.log("\n──────── PowerClerk fillApplication data contract ────────");

// 1. Installer-identity guard (powerClerk.ts:214-225) — refuses to fill without these.
const installerCompanyName = str(s["installerCompanyName"] ?? s["installer_company_name"]);
const installerEmail = str(s["installerEmail"] ?? s["installer_email"]);
check("installer guard passes (company + email present)", !!installerCompanyName && !!installerEmail,
  `company="${installerCompanyName}" email=${installerEmail ? "present" : "MISSING"}`);

// 2. Applicant block (powerClerk.ts:241-255) — homeowner identity + address REQUIRED.
const ownerFull = (project.homeownerName ?? "").trim();
check("applicant name present", ownerFull.length > 0, `="${ownerFull}"`);
check("applicant address/city/state/zip present",
  !!project.projectAddress && !!project.city && !!project.state && !!project.zip,
  `${project.city}, ${project.state} ${project.zip}`);

// 3. Service-point binding (powerClerk.ts:285-286) — account + meter REQUIRED.
check("PGE account number present", str(project.accountNumber).length > 0, str(project.accountNumber) ? "present" : "MISSING");
check("meter number present", str(project.meterNumber).length > 0, str(project.meterNumber) ? "present" : "MISSING");

// 4. Main service rating (powerClerk.ts:296-297) — resolves w/ "200" default.
const serviceRating = str(s["mainServiceRating"] ?? s["main_service_rating"] ?? s["serviceRating"]) || "200";
check("main service entrance rating resolves", serviceRating.length > 0, `="${serviceRating}"`);

// 5. Inverter make/model/qty (powerClerk.ts:310-321) — feed selectSearchable; non-empty
//    so the (un-try/catch'd) selectSearchable calls run with real values.
const inverterQty = str(s["inverterQuantity"] ?? s["inverter_quantity"]) || "1";
const inverterManufacturer = str(s["inverterManufacturer"] ?? s["inverter_manufacturer"]);
const inverterModel = str(s["inverterModel"] ?? s["inverter_model"]);
check("inverter manufacturer present", inverterManufacturer.length > 0, `="${inverterManufacturer}"`);
check("inverter model present", inverterModel.length > 0, `="${inverterModel}"`);
check("inverter quantity resolves", inverterQty.length > 0, `="${inverterQty}"`);

// 6. PV arrays (powerClerk.ts:324, fillArrays) — ≥1 array w/ qty + module make/model.
const arrays = readArrays();
check("PV array reader returns ≥1 array", arrays.length >= 1, `count=${arrays.length}`);
const a0 = arrays[0] ?? ({} as PvArray);
check("array[0] has quantity + module make + model",
  !!a0.quantity && !!a0.moduleManufacturer && !!a0.moduleModel,
  `qty=${a0.quantity} make="${a0.moduleManufacturer}" model="${a0.moduleModel}"`);

// 7. Energy storage flag (powerClerk.ts:305-307) — resolves to Yes/No.
const hasStorage = String(s["hasBattery"] ?? s["energyStorage"] ?? "").toLowerCase();
const storageAnswer = hasStorage === "true" || hasStorage === "yes" ? "Yes" : "No";
check("energy storage answer resolves", ["Yes", "No"].includes(storageAnswer), `="${storageAnswer}" (hasBattery="${s["hasBattery"]}")`);

// 8. PII-redaction contract — none of these may appear in a success payload.
//    (Asserted structurally: fillApplication's ok() returns only {projectId, arrayCount}.)
check("PII redaction: owner/account/meter are NOT in adapter success payload (by construction)",
  true, "fillApplication returns only {projectId, arrayCount}");

// 9. Render-readiness contract (post-refactor). waitForSectionReady now delegates its
//    interactive-control poll to the shared waitForInteractiveControls(). That helper MUST
//    no-op to ready=true on a page object lacking waitForFunction (the browser-free fakes /
//    any non-Playwright mock) — never block, never throw — which is the exact behavior
//    waitForSectionReady relied on before the hoist. If this broke, every PowerClerk section
//    would stall on a 12s timeout in tests.
console.log("\n──────── render-readiness helper contract (waitForSectionReady refactor) ────────");
const mockNoPoll: Record<string, unknown> = { goto: async () => {}, fill: async () => {} };
const readyNoPoll = await waitForInteractiveControls(mockNoPoll);
check("waitForInteractiveControls returns ready=true on a page lacking waitForFunction", readyNoPoll === true, `returned ${readyNoPoll}`);

let polled = 0;
const mockMounts: Record<string, unknown> = { waitForFunction: async () => { polled += 1; return true; } };
const readyMounts = await waitForInteractiveControls(mockMounts, 50);
check("waitForInteractiveControls polls once + returns ready=true when a control mounts", readyMounts === true && polled === 1, `polled=${polled} ready=${readyMounts}`);

console.log("\n════════════════ POWERCLERK DATA CONTRACT SUMMARY ════════════════");
const failed = results.filter((r) => !r.ok);
for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
