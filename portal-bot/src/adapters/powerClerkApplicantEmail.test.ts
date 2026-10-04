// THE POWERCLERK APPLICANT EMAIL IS AN EMAIL OR NOTHING — AND A BLANK IS SAID (#71, #92).
//
// The adapter blanks the customer step's Email box when the stored homeowner email is not an
// email address (a name typed into the slot), so the name never reaches the utility. But nothing
// said why the box was empty: the run stalled on a generic required-field miss. fillApplicantEmail
// now raises a human item on gapFillReport.reportedMissing (the review screen's banner) that
// DESCRIBES the problem and never pastes the stored value.
//
// The fill input is stubbed: the test records every value the adapter would type.
//   npx tsx portal-bot/src/adapters/powerClerkApplicantEmail.test.ts
import { fillApplicantEmail } from "./powerClerk";

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};
const attempt = async (snapshot: Record<string, unknown>) => {
  const typed: string[] = [];
  const report = { filled: [] as string[], skippedUngrounded: [] as string[], reportedMissing: [] as string[] };
  await fillApplicantEmail(snapshot, report, async (value) => { typed.push(value); });
  return { typed, items: report.reportedMissing };
};

const NOT_AN_EMAIL = ["Jordan Sample", "owner phone 555-0100", "jordan@example", "mailto:"];
for (const bad of NOT_AN_EMAIL) {
  const { typed, items } = await attempt({ homeownerEmail: bad });
  run(`a non-email is never typed (${JSON.stringify(bad)})`, typed.length === 0, `${typed.length} fill(s)`);
  run("…a human item is raised", items.length === 1 && /email/i.test(items[0]) && /not an email address/i.test(items[0]));
  run("…which never pastes the stored value", items.every((m) => !m.includes(bad)));
}
{
  const { typed, items } = await attempt({ homeownerEmail: "Jordan Sample", owner_email: "jordan@example.com" });
  run("a real address under the legacy key is typed instead", typed.length === 1 && typed[0] === "jordan@example.com" && items.length === 0);
}
{
  const { typed, items } = await attempt({ homeownerEmail: " jordan@example.com " });
  run("a real address is typed, trimmed, with no item", typed.length === 1 && typed[0] === "jordan@example.com" && items.length === 0);
}
{
  const { typed, items } = await attempt({});
  run("no email on file: nothing typed, no not-an-email item (the generic missing path owns it)", typed.length === 0 && items.length === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
