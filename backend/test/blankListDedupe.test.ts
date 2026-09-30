// ONE BLANK, ONE LINE (Yamhill County, live 2026-09-28).
//
// The packet card "N application fields still blank" listed the same printed field twice — once as
// the stored map named it and once as the fill (or a second form) did: "Cross street/directions to
// job site" beside "Cross street/directions to job site:", "Tax map/parcel no.: (no data on file for
// this job)" beside "Tax map/parcel number. (no data on file for this job)". The list is now keyed by
// the label before its note (lowercased, "number" / "no." / "#" read alike, punctuation dropped),
// keeping the line that says more; two boxes that share a label (operatorItemLabels' "— the box
// named …") stay two. The card stays a WARNING: a blank on a generated form never holds staging.
//
// The REAL documentVerdictHtml / filledFormBlanks, lifted out of frontend/dashboard.js.
//
//   npx tsx backend/test/blankListDedupe.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const src = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name} is gone from dashboard.js`);
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
};
// eslint-disable-next-line no-new-func
const render = new Function(`${["esc", "plural", "filledFormBlanks", "documentVerdictHtml"].map(cut).join("\n\n")}
return (pkg, forms) => documentVerdictHtml(pkg, ...filledFormBlanks(forms));`)() as (pkg: unknown, forms: unknown[]) => string;

const PKG = { missingDocumentsStatus: "resolved", missingDocuments: [], filledAtStagingDocuments: [] };
// The Yamhill shape: the building application's stored map names its blanks, the fill names them
// again (a trailing colon, "no." vs "number."), and a licence form carries two Expiration Date boxes.
const FORMS = [
  {
    status: "filled", formName: "Building Permit Application — YAMHILL COUNTY", unmappedRequested: [],
    operatorItems: ["Cross street/directions to job site", "Tax map/parcel no.: (no data on file for this job)", "Construction Type", "Occupancy"],
  },
  {
    status: "filled", formName: "Renewable Energy Electrical Permit Application", unmappedRequested: [],
    operatorItems: [
      "Cross street/directions to job site:", "Tax map/parcel number. (no data on file for this job)", "Construction type:",
      'Expiration date — the box named "CCB Exp"', 'Expiration date — the box named "License Exp"',
    ],
  },
];
const listOf = (html: string): string[] => {
  const block = /still blank<\/span>[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
  return [...block.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'"));
};
const html = render(PKG, FORMS);
const list = listOf(html);

check("the Yamhill-shaped duplicates collapse to ONE line each", () => {
  assert.equal(list.filter((l) => /^cross street/i.test(l)).length, 1, JSON.stringify(list));
  assert.equal(list.filter((l) => /^tax map\/parcel/i.test(l)).length, 1, JSON.stringify(list));
  assert.equal(list.filter((l) => /^construction type/i.test(l)).length, 1, JSON.stringify(list));
});
check("the line kept is the one that says more (its note in brackets)", () => {
  const parcel = list.find((l) => /^tax map\/parcel/i.test(l));
  assert.match(String(parcel), /\(no data on file for this job\)$/);
  const withNote = listOf(render(PKG, [{ status: "filled", unmappedRequested: [], operatorItems: ["Occupancy", "Occupancy: (no data on file for this job)"] }]));
  assert.deepEqual(withNote, ["Occupancy: (no data on file for this job)"]);
});
check("MUST-EXCLUDE: two boxes sharing a label (\"— the box named …\") stay two lines; different fields stay apart", () => {
  assert.equal(list.filter((l) => /^Expiration date — the box named/.test(l)).length, 2, JSON.stringify(list));
  assert.ok(list.includes("Occupancy"), JSON.stringify(list));
  assert.equal(list.length, 6, JSON.stringify(list));
  assert.match(html, /6 application fields still blank/);
});
check("the card stays a WARNING, never a blocker: 'is-missing' with the 'does not hold staging' sentence", () => {
  assert.match(html, /<div class="kx-docstate is-missing">\s*<span class="kx-docstate-icon" aria-hidden="true">⚠<\/span>[\s\S]*?still blank/);
  assert.match(html, /A blank on a generated form does not hold staging/);
  assert.doesNotMatch(html, /blocker|is-blocked|Resolve them in QC/i);
});
check("pkg.missingFields and the forms' blanks are one list: the same field from both is one line", () => {
  const got = listOf(render({ ...PKG, missingFields: ["owner email"] }, [{ status: "filled", unmappedRequested: ["Owner Email:"], operatorItems: [] }]));
  assert.equal(got.length, 1, JSON.stringify(got));
});

console.log("");
if (failures) {
  console.error(`blankListDedupe: ${failures} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`blankListDedupe: all ${passed} checks passed — one line per blank (label before its note, no./number/# alike), the fuller note kept, two boxes stay two, the card a warning`);
process.exit(0);
