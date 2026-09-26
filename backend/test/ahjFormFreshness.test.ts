// KB link-freshness sweep + multi-form acquisition plumbing.
// - checkKnowledgeLinks: probes stored portal URLs against a LOCAL http server
//   (200 → ok, 403 → unknown [not stale], 404/refused → dead), replaces prior
//   link-check note segments instead of stacking them.
// - classifyFormType / hasStoredTemplateOfType / ensureAhjFormsForProject:
//   the needed-form set includes the checklist when the KB requires one, and
//   per-type existence means a stored application doesn't block checklist
//   acquisition.
// Run: tsx backend/test/ahjFormFreshness.test.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ahj-freshness-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.ANTHROPIC_API_KEY = ""; // stub LLM — no network research
  const { openDatabase } = await import("../src/db");
  const { importSeededAhjKnowledge } = await import("../src/knowledgeBase");
  const { checkKnowledgeLinks } = await import("../src/ahjFormRefresh");
  const { classifyFormType, hasStoredTemplateOfType, ensureAhjFormsForProject, storeAhjFormTemplate } = await import("../src/ahjFormAuto");
  const { createLLMProvider } = await import("../src/llm");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // Local server: /ok 200, /blocked 403, /gone 404.
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>portal</html>"); return; }
    if (req.url === "/blocked") { res.writeHead(403); res.end("forbidden"); return; }
    // A minimal PDF so the refresh sweep's fetch succeeds and it takes the re-map path.
    if (req.url === "/form.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(Buffer.from("%PDF-1.4 refreshed blank %%EOF")); return; }
    res.writeHead(404); res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  // Keep the sweep hermetic: blank the built-in seed rows' real portal URLs so
  // the test never probes the public internet.
  db.run("UPDATE permit_utility_knowledge SET portal_url = ''");

  importSeededAhjKnowledge(db, { state: "OR", ahj: "Alive City", portalUrl: `${base}/ok`, notes: "n1", sourceLabel: "test" });
  importSeededAhjKnowledge(db, { state: "OR", ahj: "Blocked City", portalUrl: `${base}/blocked`, notes: "n2", sourceLabel: "test" });
  importSeededAhjKnowledge(db, { state: "OR", ahj: "Gone City", portalUrl: `${base}/gone`, notes: "n3", sourceLabel: "test" });

  const llm = createLLMProvider();
  const s1 = await checkKnowledgeLinks(db, llm, { limit: 10, researchCap: 5 });
  check("sweep counts", s1.checked === 3 && s1.ok === 1 && s1.unknown === 1 && s1.dead === 1, JSON.stringify(s1));
  const status = (ahj: string) => db.get<{ portal_link_status: string; notes: string; link_checked_at: string | null }>(
    "SELECT portal_link_status, notes, link_checked_at FROM permit_utility_knowledge WHERE ahj = ?", [ahj]);
  check("alive → ok", status("Alive City")?.portal_link_status === "ok");
  check("403 → unknown, NOT stale", status("Blocked City")?.portal_link_status === "unknown");
  const gone1 = status("Gone City");
  check("404 → dead with dated note", gone1?.portal_link_status === "dead" && /appears DEAD/.test(gone1?.notes || ""), gone1?.notes);

  // Second sweep must REPLACE the link-check note, not stack a second copy.
  await checkKnowledgeLinks(db, llm, { limit: 10, researchCap: 5 });
  const gone2 = status("Gone City");
  const deadNotes = (gone2?.notes.match(/appears DEAD/g) || []).length;
  check("re-sweep replaces the note instead of stacking", deadNotes === 1, `found ${deadNotes} copies: ${gone2?.notes}`);
  check("original note segment preserved", /n3/.test(gone2?.notes || ""), gone2?.notes);

  // --- multi-form acquisition plumbing --------------------------------------
  check("classify checklist", classifyFormType("Solar_Installation_Checklist.pdf", "permit_application") === "solar_checklist");
  check("classify electrical", classifyFormType("https://city.gov/forms/electrical-permit-app.pdf", "permit_application") === "electrical_application");
  check("classify building", classifyFormType("Building Permit Application 2026.pdf", "permit_application") === "building_application");
  check("classify fallback", classifyFormType("solar-pv-app.pdf", "permit_application") === "permit_application");

  const pdfStub = new Uint8Array(Buffer.from("%PDF-1.4 test"));
  storeAhjFormTemplate(db, {
    ahjName: "Formville", state: "OR", formType: "permit_application", filename: "app.pdf", bytes: pdfStub,
    map: { formName: "Formville app", sourceUrl: "", fillMode: "acroform", textFields: { A: "project.homeownerName" }, checkboxes: {}, notes: "" },
  });
  check("stored type found (fuzzy name)", hasStoredTemplateOfType(db, "City of Formville", "OR", "permit_application"));
  check("other type not found", !hasStoredTemplateOfType(db, "City of Formville", "OR", "solar_checklist"));

  // KB says this AHJ requires a checklist → needed set includes it; the stored
  // application reports "exists" while the checklist is still attempted.
  importSeededAhjKnowledge(db, { state: "OR", ahj: "Formville", requiredDocuments: ["Solar worksheet / checklist", "Site plan"], sourceLabel: "test" });
  const project = { id: "p-forms", clientId: null, state: "OR", ahj: "City of Formville", utility: "PGE", parserSnapshot: {} } as never;
  const ensured = await ensureAhjFormsForProject(db, llm, project);
  check("needed set includes checklist from KB", ensured.neededTypes.includes("solar_checklist"), JSON.stringify(ensured.neededTypes));
  // An unknown OREGON AHJ now files building + electrical (cited state rule, 2026-09-26): the stored
  // generic application answers the BUILDING-side slot (its altDocTypes alias).
  const appResult = ensured.results.find((r) => r.formType === "permit_application" || r.formType === "building_application");
  const checklistResult = ensured.results.find((r) => r.formType === "solar_checklist");
  check("stored application short-circuits as exists", appResult?.status === "exists", JSON.stringify(ensured.results.map((r) => [r.formType, r.status, String(r.message).slice(0, 80)])));
  check("checklist still attempted (stub → not_found)", Boolean(checklistResult) && checklistResult!.status !== "exists", JSON.stringify(checklistResult));

  // AN OPERATOR VERIFYING MID-REFRESH MUST NOT LOSE THAT WORK.
  // The refresh reads a template's field map, then spends minutes fetching the PDF and
  // re-mapping it with an LLM, then writes back. It used to write the SNAPSHOT it read
  // before all that, so a verify/edit made in the window was silently overwritten by a
  // minutes-old copy of itself. The write must carry over the CURRENT stored map.
  const { refreshAhjFormTemplates } = await import("../src/ahjFormRefresh");
  const tplId = db.get<{ id: string }>("SELECT id FROM ahj_form_templates LIMIT 1")?.id ?? "";
  // Point the stored template at a source the fixture server serves, with a stale hash so
  // the refresh takes the "changed → re-map and re-store" path (the long one).
  const liveUrl = `http://127.0.0.1:${port}/form.pdf`;
  db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [
    JSON.stringify({ formName: "Formville app", sourceUrl: liveUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, sourceHash: "stale-hash-forces-remap", verified: false, notes: "" }),
    tplId,
  ]);
  // Simulate the operator: between the sweep's read and its write, they verify the mapping
  // and add placement work. fetchPdf is awaited inside the refresh, so patching here — just
  // before awaiting it — lands inside that window.
  const operatorEdit = () => db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [
    JSON.stringify({ formName: "Formville app", sourceUrl: liveUrl, fillMode: "overlay", textFields: { A: "project.homeownerName" }, checkboxes: {}, overlayFields: [{ page: 0, x: 10, y: 20, source: "project.homeownerName" }], verified: true, notes: "operator verified" }),
    tplId,
  ]);
  const refreshPromise = refreshAhjFormTemplates(db, llm);
  operatorEdit();
  await refreshPromise;
  const after = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [tplId])?.field_map ?? "{}");
  check("operator's overlay placement survives a concurrent refresh", Array.isArray(after.overlayFields) && after.overlayFields.length === 1, JSON.stringify(after.overlayFields));
  check("refresh still demotes verified so the fill gate re-checks the new revision", after.verified === false, JSON.stringify(after.verified));

  server.close();
  // Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nahjFormFreshness: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
