// A PORTAL REPLICA IS A BLANK FORM. Playwright trace snapshots record live form state in
// `__playwright_value_` / `__playwright_checked_` / `__playwright_selected_` attributes — what
// the operator actually typed. renderSnapshotNode dropped `value`/`checked`/`selected` and
// kept these, so a replica built from a learn trace carried homeowner data in its markup.
//
// Lives in backend/test (it is on the backend unit chain) but tests portal-bot code.
// Run: tsx backend/test/replicaAttrStrip.test.ts
const { renderSnapshotNode } = await import("../../portal-bot/src/replica/extractFromTrace");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const SECRET = "Fixture Homeowner 4411";
const html = renderSnapshotNode(["FORM", {},
  ["INPUT", { name: "owner", type: "text", value: SECRET, __playwright_value_: SECRET }],
  ["INPUT", { name: "agree", type: "checkbox", __playwright_checked_: "true" }],
  ["SELECT", { name: "state", __Playwright_Scroll_Top_: "40" },
    ["OPTION", { value: "OR", __playwright_selected_: "true" }, "Oregon"]],
] as never);

check("1. no __playwright* attribute survives, whatever its case", !/__playwright/i.test(html), html);
check("2. the typed value is not in the replica", !html.includes(SECRET), html);
check("3. the form's structure is kept (names, types, option text)",
  /name="owner"/.test(html) && /type="checkbox"/.test(html) && /name="state"/.test(html) && />Oregon</.test(html), html);

console.log(failures ? `\nreplicaAttrStrip: ${failures} FAILED` : "\nreplicaAttrStrip: all passed");
process.exit(failures ? 1 : 0);
