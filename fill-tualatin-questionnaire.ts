// One-off ENGINE TEST: fill the City of Tualatin Prescriptive Photovoltaic
// Questionnaire with the Blake Fixture TEST project's data via the deterministic
// form-fill engine (autoFillByFieldName + checkboxLabels + prescriptive answers).
// Output is a TEST FILL for engine evaluation — swap the project id to produce a
// real one. Delete this file after the session.
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { autoFillByFieldName } from "./backend/src/formFiller";
import { checkboxLabels } from "./backend/src/formTextLayer";
import { evaluatePrescriptiveCriteria } from "./backend/src/permitPath";

const { openDatabase } = await import("./backend/src/db");
const { getProjectDetail } = await import("./backend/src/repository");
const { getClient } = await import("./backend/src/clients");

const db = await openDatabase();
const projectId = "cf1c56aa"; // Blake Fixture TEST project (matched by prefix below)
const row = db.get<{ id: string }>("SELECT id FROM projects WHERE id LIKE ?", [`${projectId}%`]);
if (!row) throw new Error("test project not found");
const detail = getProjectDetail(db, String(row.id));
const project = detail.project;
const client = project.clientId ? getClient(db, project.clientId) : null;
const snap = (project.parserSnapshot ?? {}) as Record<string, unknown>;
const s = (k: string) => String(snap[k] ?? "").trim();

const src = "C:/Users/isobl/Downloads/Prescriptive-Photovoltaic-Questionnaire (13).pdf";
const bytes = fs.readFileSync(src);

// 1) ENGINE: text fields by name/synonym (unknown keys match by identity).
const data: Record<string, string> = {
  installer: client?.companyName || "",
  name: client?.contactName || "",
  phone: client?.phone || client?.businessPhone || "",
  email: client?.contactEmail || client?.businessEmail || "",
  street: project.projectAddress || "",
  manufacturer: s("moduleMake") || s("moduleManufacturer"),
  "model number": s("moduleModel"),
};
const res = await autoFillByFieldName(bytes, data);
console.log("== engine text-field matches ==");
for (const m of res.matched) console.log(`  ${m.key} -> "${m.field}" = ${m.value}`);
const missed = Object.entries(data).filter(([k, v]) => v && !res.matched.some((m) => m.key === k));
console.log("  missed keys:", JSON.stringify(missed.map(([k]) => k)));

// 2) checkboxLabels: recover the text beside each generically-named box so the
//    Yes/No pairs and UL listing boxes can be mapped to their questions.
const labels = await checkboxLabels(bytes);
console.log("== recovered checkbox labels ==");
for (const [name, text] of Object.entries(labels)) console.log(`  ${name}: ${String(text).slice(0, 90)}`);

// 3) Prescriptive answers from project data (the same criteria the reviewer uses).
const criteria = evaluatePrescriptiveCriteria(project);
console.log("== prescriptive criteria (project-derived) ==");
for (const c of criteria) console.log(`  [${c.answer}] ${c.label} — ${c.detail}`);

// 4) Demonstrate the answer application: check the UL module listing box and the
//    Yes/No pairs the criteria can answer confidently, via the recovered labels.
const doc = await PDFDocument.load(res.filled);
const form = doc.getForm();
const applied: string[] = [];
const crit = (re: RegExp) => criteria.find((c) => re.test(c.label));
const yn = (c?: { answer: string }) => (c?.answer === "Yes" ? "Yes" : c?.answer === "No" ? "No" : null) as "Yes" | "No" | null;
const answerFor = (labelText: string): "Yes" | "No" | null => {
  const t = labelText.toLowerCase();
  if (/risk category/.test(t)) return yn(crit(/risk category/i));
  if (/light framed wood construction|pre-engineered trusses/.test(t)) {
    const ft = (s("framingType") || "").toLowerCase();
    if (/truss|rafter|stick/.test(ft)) return "Yes";
    return yn(crit(/light-frame/i));
  }
  if (/spaced at 24 inches on center or less/.test(t)) return yn(crit(/spacing/i));
  if (/4\.5 pounds per square foot/.test(t)) return yn(crit(/dead load/i));
  if (/18 inches or less above the roof/.test(t)) return yn(crit(/height above roof/i));
  return null; // joist/purlin/tie sub-questions need plan-set facts the parser does not carry
};
// Yes/No pairs share adjacent-question text via the recovered labels of the YES box.
for (const [boxName, labelText] of Object.entries(labels)) {
  if (!/^Yes(_\d+)?$/.test(boxName)) continue;
  const ans = answerFor(String(labelText));
  if (!ans) continue;
  const target = ans === "Yes" ? boxName : boxName.replace("Yes", "No");
  try { form.getCheckBox(target).check(); applied.push(`${target} <- ${ans} (${String(labelText).slice(0, 60)})`); } catch { /* skip */ }
}
// UL 61730 module listing (modern modules list under 61730; 1703 is the legacy mark).
for (const [boxName, labelText] of Object.entries(labels)) {
  if (/61730/.test(String(labelText))) {
    try { form.getCheckBox(boxName).check(); applied.push(`${boxName} <- UL 61730 listing`); } catch { /* skip */ }
    break;
  }
}
console.log("== applied answers ==");
for (const a of applied) console.log("  " + a);

const out = "C:/Users/isobl/SOLAR-Proj/data/filled/tualatin-questionnaire-TEST-FILL.pdf";
fs.mkdirSync("C:/Users/isobl/SOLAR-Proj/data/filled", { recursive: true });
fs.writeFileSync(out, await doc.save());
console.log("saved:", out);
