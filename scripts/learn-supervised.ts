// WATCH THE LEARN, AND ANYTHING YOU DO ON THE PAGE IS LEARNED.
//
//   npm run learn:supervised -- --project <id-or-homeowner-name> [--track nem|building|electrical|combo]
//   npm run learn:supervised -- --project "David Simmons" --dry-run
//   npm run learn:supervised -- --project <id> --url https://egov.example.org/energovprod/selfservice#/home
//
// The machinery for this already existed and had no door. autoLearnPortal takes
// `headless: false`, and autoLearnAdapter arms armHumanCaptureOnPage on every page it walks — so
// a real window opens, you watch it, and when it stalls you click or type the thing it could not
// work out. Those actions are captured as recipe steps and merged, so the NEXT run does it
// without you. That is the whole point: a supervised run is not a manual filing, it is a lesson.
//
// WHY THIS EXISTS NOW. Staging refuses a portal whose login was rejected
// (PORTAL_CREDENTIAL_LOCKOUT — repeated attempts are what locks an account), and it points here.
// This is the other way through: a person present, a real window, and whatever it learns kept.
//
// It still never clicks final submit, never pays a fee and never solves a CAPTCHA or MFA — those
// are yours, in the window, in front of you. That is not a limitation of this script; it is the
// rule, and the run stops at review either way.
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
};
const projectArg = arg("project");
const trackArg = (arg("track") || "").toLowerCase();
const dryRun = process.argv.includes("--dry-run");
// --url: the portal to open, stated by the operator. Four of Monday's five portals have no KB
// portal or only a stale one (Carlsbad and Iowa City have none; Columbus's seeded row is the old
// ca.columbus.gov), so without this the script either exits or opens the wrong site. It is
// judged by the SAME predicate the dashboard's auto-learn route uses (assertOperatorPortalUrlFits
// -> portalChannel.hostFitsTrackAndEntity, CLAUDE.md rule 5): one question, one predicate.
const urlGiven = process.argv.includes("--url");
const urlArg = arg("url").trim();

if (!projectArg) {
  console.error(`
Name the project:
  npm run learn:supervised -- --project <id-or-homeowner-name> [--track nem|building|electrical|combo]

  --track   which filing to learn. Omit for the permit side. "nem" learns the utility portal.
  --url     the portal to open (overrides the KB/recipe URL). Refused when it does not fit the
            track or the entity, exactly as the dashboard's auto-learn refuses it.
  --dry-run show what would be learned and where, and open nothing.
`);
  process.exit(1);
}

const { openDatabase } = await import("../backend/src/db");
const { autoLearnPortal } = await import("../backend/src/autoLearn");
const { recipeDisciplineForTrack, isUtilityPlatformUrl } = await import("../backend/src/portalChannel");
const { findKnowledgeForLearn } = await import("../backend/src/knowledgeBase");
const { listPortalCredentials } = await import("../backend/src/portalCredentials");
const repo = await import("../backend/src/repository");

const db = await openDatabase();

const row = db.get<{ id: string }>(
  "SELECT id FROM projects WHERE id = ? OR homeowner_name LIKE ? ORDER BY created_at DESC LIMIT 1",
  [projectArg, `%${projectArg}%`],
);
if (!row) { console.error(`\nNo project matches ${JSON.stringify(projectArg)}.\n`); process.exit(1); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const project = (repo as any).getProjectDetail(db, row.id)?.project;
if (!project) { console.error(`\nCould not load project ${row.id}.\n`); process.exit(1); }

const scope = trackArg === "nem" ? "utility" : "ahj";
const discipline = recipeDisciplineForTrack(trackArg || "permit");

// THE SAME PRECEDENCE STAGING USES, and it is not decoration. Measured on this very project:
// the KB row or|city of coos bay|pacific power carries a PacifiCorp PowerClerk URL as its AHJ
// portal — a utility URL contaminating an AHJ profile — while the two complete recipes carry the
// right one (aca-oregon.accela.com). Production survives that because repository.ts prefers the
// RECIPE's URL and passes every candidate through permitSafeUrl; reading the KB first would have
// opened a utility portal for a permit learn.
const match = findKnowledgeForLearn(db, { state: project.state, ahj: project.ahj, utility: project.utility });
const profile = scope === "utility" ? match.utility : match.ahj;
const safeForTrack = (url: string): string => {
  const u = String(url || "");
  if (!u) return "";
  // A permit track must never resolve a utility platform (CLAUDE.md safety rule 5).
  if (scope === "ahj" && isUtilityPlatformUrl(u)) return "";
  return u;
};
// With no --track, discipline is "" and that must mean "any discipline will do", not "only an
// untagged recipe". The first version filtered to discipline = '' and found nothing on a
// jurisdiction whose recipes are all properly tagged structural/electrical — which is every
// jurisdiction that has been learned since the discipline dimension landed.
const recipeUrl = safeForTrack(String((discipline
  ? db.get<{ portal_url?: string }>(
    `SELECT portal_url FROM portal_recipes
      WHERE profile_key = ? AND status = 'complete' AND portal_url <> ''
        AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [String(profile?.profileKey || ""), discipline, discipline],
  )
  : db.get<{ portal_url?: string }>(
    `SELECT portal_url FROM portal_recipes
      WHERE profile_key = ? AND status = 'complete' AND portal_url <> ''
      ORDER BY updated_at DESC LIMIT 1`,
    [String(profile?.profileKey || "")],
  ))?.portal_url || ""));
let portalUrl = recipeUrl || safeForTrack(String(profile?.portalUrl || ""));
if (urlGiven) {
  if (!/^https?:\/\/[^\s/]+/i.test(urlArg)) {
    console.error(`\nREFUSED: --url needs an absolute http(s) portal URL (got ${JSON.stringify(urlArg)}).\n`);
    process.exit(1);
  }
  const { assertOperatorPortalUrlFits, findAnyRecipeForProject } = await import("../backend/src/portalRecipes");
  try {
    // The project's own recipe for this key is not evidence for the URL being judged — the same
    // exclusion the route applies.
    const own = findAnyRecipeForProject(db, { scopeType: scope, state: project.state, ahj: project.ahj, utility: project.utility });
    assertOperatorPortalUrlFits(db, {
      track: scope === "utility" ? "nem" : "permit",
      state: project.state,
      name: scope === "utility" ? project.utility : project.ahj,
      url: urlArg,
      excludeRecipeIds: own ? [own.id] : [],
    });
  } catch (err) {
    console.error(`\nREFUSED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  portalUrl = urlArg;
}

console.log(`\n── SUPERVISED LEARN ─────────────────────────────────────────────`);
console.log(`   project    ${project.homeownerName || project.id}  (${row.id.slice(0, 8)})`);
console.log(`   filing     ${trackArg || "permit"}${discipline ? `  discipline=${discipline}` : ""}`);
console.log(`   authority  ${scope === "utility" ? project.utility : project.ahj}`);
console.log(`   portal     ${portalUrl || "(none on file)"}`);

if (!portalUrl) {
  console.error(`
No portal URL is on file for the ${scope === "utility" ? "utility" : "permit"} side of this project,
so there is nothing to open. Record it first (the coverage report names this as the blocker:
npx tsx scripts/coverage-report.ts), then come back.
`);
  process.exit(1);
}
if (portalUrl && scope === "ahj" && isUtilityPlatformUrl(portalUrl)) {
  console.error(`
REFUSED: ${portalUrl} is a utility interconnection platform, and this is a PERMIT learn. A permit
track must never open a utility portal (CLAUDE.md safety rule 5). Use --track nem, or fix the
portal URL recorded against this AHJ.
`);
  process.exit(1);
}

// Is the login one the portal has already refused? Worth saying up front: a supervised run is
// exactly when somebody can fix it, and knowing beforehand beats watching it fail.
const creds = project.clientId ? listPortalCredentials(db, project.clientId) : [];
const stale = creds.filter((c) => c.stale);
if (stale.length) {
  console.log(`   NOTE       ${stale.length} credential(s) on this client were refused at their last login:`);
  for (const c of stale) console.log(`              ${c.portalUrl}  ${c.lastLoginNote || ""}`.trimEnd());
  console.log(`              A successful login clears that by itself — no flag to reset.`);
}

console.log(`
   A real window opens. Watch it. When it stalls on something it cannot work out, do that
   thing yourself in the window — your clicks and typing are captured and merged into the
   recipe, so the next run does it without you.

   It stops at the review screen. Final submit, portal fees, CAPTCHA and MFA stay yours.
   If the portal asks for a second factor (a code, an email link, a push), the run PAUSES with
   the window open — "PAUSED — needs-human (mfa)" prints here — and carries on by itself once
   you complete it in the window (bounded by PORTAL_PROFILE_WAIT_MS, default 15 min). The bot
   never types, requests or picks a factor.
`);

if (dryRun) { console.log("--dry-run: nothing opened.\n"); process.exit(0); }

const result = await autoLearnPortal(db, row.id, {
  scope,
  portalUrl,
  discipline,
  createdBy: "operator (supervised)",
  // THE WHOLE POINT. A headless run cannot be watched and cannot be helped.
  headless: false,
  project,
  onProgress: (p: unknown) => {
    const s = p as { phase?: string; page?: number; note?: string };
    if (s?.phase || s?.note) console.log(`   ${String(s.phase ?? "").padEnd(14)} ${s.page != null ? `p${s.page} ` : ""}${s.note ?? ""}`);
  },
});

console.log(`\n── RESULT ───────────────────────────────────────────────────────`);
console.log(`   ${result?.ok ? "OK" : "STOPPED"}  ${String((result as { message?: string })?.message || "").slice(0, 400)}`);
const steps = (result as { steps?: unknown[] })?.steps?.length ?? 0;
console.log(`   ${steps} step(s) recorded. Anything you did in the window is among them.`);
console.log(`
   Next: review the recipe before it replays for anyone else —
     npx tsx scripts/portal-questions.ts
   and check what it froze that should be per-job:
     npm run portal:triage
`);
