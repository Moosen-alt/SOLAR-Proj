// THE STRUCTURAL-LETTER CARD ON THE GATE: CANDIDATE, ITS PAGES, ONE CONFIRM BUTTON (#198).
//
// Owner ruling 2026-10-08 (on #218): the stamped-structural hold and the document-inventory row show
// the candidate letter, a link to its pages and a "Confirm: this is the engineer's sealed structural
// letter for this job" button; after a confirmation they read "Engineer's structural letter on file,
// confirmed by <name> <date> — verify the seal" with a Withdraw button. This runs the SHIPPED
// renderer, structuralLetterCardHtml, lifted out of frontend/dashboard.js (brace-balanced cut, as
// recipeFlagRender.test.ts does). No Chromium.
//
// KILL: drop the esc() around the filename → (e) fails; drop the card from renderSubmitGate's
// checkRow or its button wiring → (f) fails.
//
//   npx tsx backend/test/structuralLetterCardRender.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const card = new Function(`${cut("esc")}\n${cut("structuralLetterCardHtml")}\nreturn structuralLetterCardHtml;`)() as (sl: unknown, projectId: string) => string;

const HOSTILE = `<img src=x onerror="alert(1)">.pdf`;
const candidate = card({ candidate: { documentId: "doc-1", filename: HOSTILE, source: "split", page: 3, pageCount: 4, score: 4 }, confirmation: null, voided: null }, "proj-1");
check("(a) the candidate names its document and page", /page 3 of 4/.test(candidate), candidate);
check("(b) …links to its pages, opened inline at that page",
  candidate.includes(`href="/api/projects/proj-1/documents/doc-1?inline=1#page=3"`), candidate);
check("(c) …and carries the one Confirm button, bound to that document and page",
  /<button[^>]*data-structural-letter-action="confirm"[^>]*data-document-id="doc-1"[^>]*data-page="3"[^>]*>Confirm: this is the engineer's sealed structural letter for this job<\/button>/.test(candidate),
  candidate);
check("(c2) …and no Withdraw button before anyone confirmed", !candidate.includes(`data-structural-letter-action="withdraw"`));

const confirmed = card({
  candidate: { documentId: "doc-1", filename: "structural.pdf", source: "split", page: 3, pageCount: 4, score: 4 },
  confirmation: { id: "c1", documentId: "doc-1", filename: "structural.pdf", page: 3, confirmedBy: "Jane Example", confirmedAt: "2026-10-08T14:00:00.000Z" },
}, "proj-1");
check("(d) confirmed: it reads 'on file, confirmed by Jane Example 2026-10-08 — verify the seal', with Withdraw and no Confirm",
  /Engineer's structural letter on file, confirmed by Jane Example 2026-10-08 — verify the seal/.test(confirmed)
  && confirmed.includes(`data-structural-letter-action="withdraw"`) && !confirmed.includes(`data-structural-letter-action="confirm"`), confirmed);

check("(e) every value is esc()'d: a hostile filename never becomes markup", !candidate.includes("<img") && candidate.includes("&lt;img"), candidate);
const hostileName = card({ candidate: null, confirmation: { id: "c", documentId: "d", filename: "f.pdf", page: 1, confirmedBy: "<script>x</script>", confirmedAt: "2026-10-08" } }, "p");
check("(e2) …a hostile confirmer name too", !hostileName.includes("<script>") && hostileName.includes("&lt;script&gt;"), hostileName);

const voided = card({ candidate: { documentId: "doc-2", filename: "s.pdf", source: "split", page: 1, pageCount: 1, score: 0 }, confirmation: null,
  voided: { confirmedBy: "Jane Example", confirmedAt: "2026-10-07T10:00:00.000Z", reason: "a new plan set was uploaded after it" } }, "p");
check("(g) a voided confirmation says why and asks to re-confirm; a score-0 candidate says to open it and check",
  /no longer covers what is on file: a new plan set was uploaded after it/.test(voided) && /re-confirm/.test(voided) && /open it and check/.test(voided)
  && voided.includes(`data-structural-letter-action="confirm"`), voided);
const none = card({ candidate: null, confirmation: null }, "p");
check("(h) no structural document: nothing to confirm, no button", !none.includes("<button") && /No structural document on file/.test(none), none);

const gate = cut("renderSubmitGate");
check("(f) renderSubmitGate puts the card on the stamped-structural hold's check and the inventory row's check, and wires its buttons",
  /check\.id === "permit-requirements" \|\| check\.id === "document-inventory"\) && gate\.structuralLetter \? structuralLetterCardHtml\(gate\.structuralLetter, gate\.projectId\)/.test(gate)
  && /querySelectorAll\("\[data-structural-letter-action\]"\)[\s\S]*structuralLetterAction\(/.test(gate));
const action = cut("structuralLetterAction");
check("(i) the button posts to /api/projects/:id/structural-letter/<confirm|withdraw> with the document and page it showed",
  /\/api\/projects\/\$\{id\}\/structural-letter\/\$\{action\}/.test(action) && /data-document-id/.test(action) && /data-page/.test(action));

if (failures) { console.error(`\nstructuralLetterCardRender: ${failures} failure(s)`); process.exit(1); }
console.log("\nstructuralLetterCardRender: all checks passed");
process.exit(0);
