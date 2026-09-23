// DOCUMENT_FETCH=off MEANS THE FORM FILL NEVER LEAVES THE MACHINE.
//
// fetchFormTemplate kept its own SSRF-guarded fetch and never asked the DOCUMENT_FETCH switch,
// so filling Portland's registry form on the offline demo kit resolved www.portland.gov every
// time (the SSRF guard's dns.lookup runs before any fetch), failed, and fell back to the
// cached blank. The fill "worked" — which is exactly why nobody saw the outbound lookup.
// So the discriminator here is the TRAP COUNT, not whether bytes came back.
//
// Run: tsx backend/test/offlineFormFetch.test.ts
import dnsCb from "node:dns";
import dnsP from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

// Traps FIRST, before the module under test can capture a reference.
const attempts: string[] = [];
const trap = (kind: string) => (...a: unknown[]): never => {
  attempts.push(`${kind} ${String(a[0]).slice(0, 80)}`);
  throw new Error(`offline test: ${kind} refused`);
};
globalThis.fetch = trap("fetch") as typeof fetch;
(dnsP as unknown as Record<string, unknown>).lookup = trap("dns/promises.lookup");
(dnsCb as unknown as Record<string, unknown>).lookup = trap("dns.lookup");
(http as unknown as Record<string, unknown>).request = trap("http.request");
(https as unknown as Record<string, unknown>).request = trap("https.request");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-form-fetch-"));
process.chdir(dir); // TEMPLATE_DIR resolves off cwd at module load
process.env.DOCUMENT_FETCH = "off";

const { fetchFormTemplate } = await import("../src/ahjForms");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const cacheDir = path.join(dir, "backend", "data", "ahj-forms");
fs.mkdirSync(cacheDir, { recursive: true });
const cachedBytes = Buffer.from("%PDF-1.4\n% cached blank\n");
fs.writeFileSync(path.join(cacheDir, "offline-cached.pdf"), cachedBytes);
const def = (id: string) => ({ id, formName: `Form ${id}`, matchJurisdictions: [], sourceUrl: "https://forms.example.gov/blank.pdf", version: "1", status: "verified" as const, textFields: {} });

console.log("\n1. CACHED BLANK — served from disk, nothing outbound");
{
  attempts.length = 0;
  let got: Uint8Array | null = null; let err = "";
  try { got = await fetchFormTemplate(def("offline-cached") as never); } catch (e) { err = String((e as Error).message); }
  check("1a. the cached bytes come back", got !== null && Buffer.from(got).equals(cachedBytes), err);
  check("1b. MUST EXCLUDE: zero outbound attempts (fetch / dns / http / https)", attempts.length === 0, JSON.stringify(attempts));
}

console.log("\n2. NO CACHED BLANK — a clear refusal, still nothing outbound");
{
  attempts.length = 0;
  let status = 0; let msg = "";
  try { await fetchFormTemplate(def("offline-missing") as never); } catch (e) { status = Number((e as { status?: number }).status); msg = String((e as Error).message); }
  check("2a. refused (502) and the message names the switch", status === 502 && /DOCUMENT_FETCH=off/.test(msg), `${status} ${msg}`);
  check("2b. MUST EXCLUDE: zero outbound attempts", attempts.length === 0, JSON.stringify(attempts));
}

process.chdir(os.tmpdir());
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures ? `\nofflineFormFetch: ${failures} FAILED` : "\nofflineFormFetch: all passed");
process.exit(failures ? 1 : 0);
