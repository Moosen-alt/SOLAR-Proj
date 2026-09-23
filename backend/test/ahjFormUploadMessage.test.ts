// AN UPLOADED FORM THAT DID NOT MAP MUST SAY WHY — IN THE SERVER'S WORDS.
//
// POST /api/ahj-templates/upload answers { fillable, fieldCount, status, message }, and
// `fillable` is simply status === "acquired". The dashboard's upload handler answered every
// not-fillable result with one fixed sentence: "this PDF has no fillable fields". That is wrong
// for most of the ways an upload ends up not fillable — an AcroForm whose fields mapped to
// nothing, another jurisdiction's form, a revision that needs re-mapping — and it sends the
// operator hunting for a problem the PDF does not have.
//
//   MUST PASS    — a not-fillable answer shows the server's own message;
//                  that message reaches the page as TEXT (showMessage assigns textContent),
//                  so markup in it is shown, never parsed, and "&" is not double-escaped.
//   MUST EXCLUDE — the false blanket claim "no fillable fields" is gone when the server said
//                  something else; a fillable answer still reports the mapped field count;
//                  an answer with no message falls back to a neutral sentence, not the false one.
//
// DRIVEN, NOT COPIED: uploadAhjForm and showMessage are lifted out of the shipped
// frontend/dashboard.js at runtime and run against stubs.
import fs from "node:fs";
import path from "node:path";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const src = fs.readFileSync(path.join(process.cwd(), "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
function lift(signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`dashboard.js no longer has ${signature}`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}

interface FakeEl { hidden: boolean; textContent: string; innerHTML: string; style: Record<string, string> }
async function upload(serverAnswer: Record<string, unknown>): Promise<{ text: string; kind: string; el: FakeEl }> {
  const el: FakeEl = { hidden: true, textContent: "", innerHTML: "", style: {} };
  const status: FakeEl = { hidden: false, textContent: "", innerHTML: "", style: {} };
  let kind = "";
  const $ = (id: string) => (id === "message" ? el : id === "findAhjFormStatus" ? status : null);
  const realShowMessage = new Function("$", `${lift("function showMessage(")}\nreturn showMessage;`)($) as (m: string, k?: string) => void;
  const showMessage = (m: string, k = "info") => { kind = k; realShowMessage(m, k); };
  const fetchStub = async () => ({ ok: true, json: async () => serverAnswer });
  const fn = new Function(
    "state", "$", "fetch", "api", "renderApplicationDocs", "showMessage",
    `${lift("async function uploadAhjForm(")}\nreturn uploadAhjForm;`,
  )(
    { selectedProjectId: "p1", detail: { project: { ahj: "City of Example", state: "OR" } } },
    $, fetchStub, async () => [], () => {}, showMessage,
  ) as (ev: unknown) => Promise<void>;
  await fn({ target: { files: [{ name: "form.pdf", arrayBuffer: async () => new ArrayBuffer(4) }] } });
  return { text: el.textContent, kind, el };
}

const SERVER_MSG = "The official PDF has changed since its field map was checked. Review & re-map the new revision <b>before</b> filling it.";
{
  const r = await upload({ fillable: false, status: "needs_manual", fieldCount: 0, message: SERVER_MSG });
  check("1. a not-fillable answer shows the server's own message", r.text.includes(SERVER_MSG), r.text);
  check("2. MUST EXCLUDE: the blanket 'no fillable fields' claim is gone", !/no fillable fields/i.test(r.text), r.text);
  check("3. it is a warning", r.kind === "warning", r.kind);
  check("4. the message is TEXT: markup shown literally, '&' not double-escaped, nothing written to innerHTML",
    r.text.includes("<b>before</b>") && r.text.includes("Review & re-map") && !r.text.includes("&amp;") && r.el.innerHTML === "", r.text);
}
{
  const r = await upload({ fillable: true, status: "acquired", fieldCount: 42, message: "Acquired and mapped." });
  check("5. MUST EXCLUDE: a fillable answer still reports the mapped field count", /mapped 42 field\(s\)/.test(r.text) && r.kind === "success", r.text);
}
{
  const r = await upload({ fillable: false, status: "needs_manual", fieldCount: 0 });
  check("6. no server message: a neutral fallback, not the false 'no fillable fields' claim",
    r.text.length > 10 && !/no fillable fields/i.test(r.text), r.text);
}

console.log(failures ? `\nahjFormUploadMessage: ${failures} FAILED` : "\nahjFormUploadMessage: all checks passed");
process.exit(failures ? 1 : 0);
