// A WRITE TO THE WRONG ELEMENT MUST NOT READ BACK CLEAN (replay skeptic MF5).
//
// accela/relabelled: the owner step recorded {label "E-mail:", fingerprint id OwnerEdit_txtEmail,
// section "Property Owner"}. The owner's label became "Email Address:", so "E-mail:" resolved to the
// APPLICANT's box — the same label, so the wrong-control check agreed, the installer's email was
// overwritten, and the read-back from that same box agreed. The scoreboard saw wrongbox=1; the
// adapter reported ok=true.
//
// MUST-PASS: that shape -> the owner email lands in OwnerEdit_txtEmail and the applicant's email
//   is intact.
// MUST-EXCLUDE: a step with no fingerprint and one label match still fills (no new refusal); a
//   fingerprint whose element is absent redirects the write nowhere else.
//
// Run: npx tsx portal-bot/src/adapters/replayWrongElement.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const INSTALLER = "permits@sunco.example";
const OWNER = "harriet@owner.example";
const page = (ownerId: string) => `<!doctype html><html><body><h1>Step 1: Contacts</h1><form onsubmit="return false">
  <fieldset><legend>Applicant</legend>
    <label for="ApplicantEdit_txtEmail">E-mail:</label><input id="ApplicantEdit_txtEmail" name="ctl00$ApplicantEdit$txtEmail" value="${INSTALLER}">
  </fieldset>
  <fieldset><legend>Property Owner</legend>
    <label for="${ownerId}">Email Address:</label><input id="${ownerId}" name="ctl00$${ownerId}">
  </fieldset></form></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(url.pathname === "/renamed" ? "OwnerEdit_txtEmailAddr2" : "OwnerEdit_txtEmail"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (p: string, withFp: boolean): PortalRecipe => ({
  id: "wrong-element", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}${p}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}${p}`, note: "open" } as RecipeStep,
    { action: "fill", selector: { label: "E-mail:" }, field: "homeownerEmail", note: "E-mail:",
      ...(withFp ? { fingerprint: { id: "OwnerEdit_txtEmail", name: "ctl00$OwnerEdit_txtEmail", section: "Property Owner" } } : {}) } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  const run = async (p: string, withFp: boolean) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const pg = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(p, withFp), { homeownerEmail: OWNER }, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = pg;
    const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) }));
    const boxes = await pg.evaluate(() => Array.from(document.querySelectorAll("input")).map((i) => ({ id: i.id, v: (i as HTMLInputElement).value })));
    const warnings = (adapter as unknown as { driftWarnings: string[] }).driftWarnings.join(" | ");
    await ctx.close();
    const byId = Object.fromEntries(boxes.map((b) => [b.id, b.v]));
    return { r, byId, warnings };
  };

  const a = await run("/relabelled", true);
  check("MUST-PASS relabelled + fingerprint: the owner email lands in OwnerEdit_txtEmail", a.byId.OwnerEdit_txtEmail === OWNER, JSON.stringify(a.byId));
  check("MUST-PASS relabelled + fingerprint: the applicant's email is intact (wrongbox 0)", a.byId.ApplicantEdit_txtEmail === INSTALLER, JSON.stringify(a.byId));
  check("MUST-PASS ...and the re-anchor is named", /recorded control #OwnerEdit_txtEmail/.test(a.warnings), a.warnings.slice(0, 240));

  const b = await run("/relabelled", false);
  check("MUST-EXCLUDE no fingerprint, one label match: the step still fills (the label's box)", b.byId.ApplicantEdit_txtEmail === OWNER, JSON.stringify(b.byId));

  const c = await run("/renamed", true);
  check("MUST-EXCLUDE fingerprint element absent: no redirect — the owner box (another id) is untouched and nothing names a fingerprint re-anchor",
    c.byId.OwnerEdit_txtEmailAddr2 === "" && !/recorded control #/.test(c.warnings), `${JSON.stringify(c.byId)} ${c.warnings.slice(0, 200)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} wrong-element check(s) FAILED.`); process.exit(1); }
console.log("\nAll wrong-element checks passed (real Chromium).");
process.exit(0);
