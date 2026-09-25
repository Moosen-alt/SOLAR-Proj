// The scoreboard's commit anchor, tested against REAL git in a scratch repository:
//   MUST-PASS    a run whose HEAD moves mid-run reports the START commit and headMoved=true;
//                a run from a detached worktree (where .git is a FILE) reports that worktree's
//                40-hex hash; an unmoved clean run is trustworthy.
//   MUST-EXCLUDE an empty-string anchor; a moved HEAD reported as the anchor without saying so;
//                an unresolvable anchor that reads as anything but UNKNOWN.
//
//   npx tsx portal-bot/src/replica/benchAnchor.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finishAnchor, readHead, realGit, startAnchor } from "./benchAnchor";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-anchor-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "portal-bot"), { recursive: true });
const git = (...args: string[]) => realGit(args, repo).trim();
git("init", "-q");
git("config", "user.email", "anchor@example.com");
git("config", "user.name", "anchor test");
git("config", "commit.gpgsign", "false");
const commit = (file: string, text: string) => {
  fs.writeFileSync(path.join(repo, file), text);
  git("add", "--", file);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
};

try {
  const first = commit("portal-bot/a.txt", "one");
  console.log("\n1. HEAD moves during the run");
  const start = startAnchor(repo);
  const second = commit("portal-bot/a.txt", "two");
  const moved = finishAnchor(repo, start);
  check("commitAtStart is the commit the run STARTED on", moved.commitAtStart === first, JSON.stringify(moved));
  check("commitAtEnd is where HEAD ended", moved.commitAtEnd === second, JSON.stringify(moved));
  check("headMoved=true, and the summary says HEAD MOVED", moved.headMoved === true && /HEAD MOVED/.test(moved.summary), moved.summary);
  check("MUST-EXCLUDE: a moved run is not trustworthy", moved.trustworthy === false);

  console.log("\n2. An unmoved, clean run");
  const s2 = startAnchor(repo);
  const still = finishAnchor(repo, s2);
  check("unmoved: headMoved=false and trustworthy", still.headMoved === false && still.trustworthy && still.commitAtStart === second, JSON.stringify(still));

  console.log("\n3. Uncommitted edits under the measured paths");
  fs.writeFileSync(path.join(repo, "portal-bot/a.txt"), "three (uncommitted)");
  const s3 = startAnchor(repo);
  const dirty = finishAnchor(repo, s3);
  check("dirtyAtStart=true is reported and the run is not trustworthy", dirty.dirtyAtStart === true && !dirty.trustworthy && /DIRTY/.test(dirty.summary), JSON.stringify(dirty));
  git("checkout", "--", "portal-bot/a.txt");

  console.log("\n4. A detached worktree (.git is a file there)");
  const wt = path.join(root, "wt");
  git("worktree", "add", "-q", "--detach", wt, first);
  check("the worktree's .git is a FILE (the shape that wrote commit \"\" before)", fs.statSync(path.join(wt, ".git")).isFile());
  const wtAnchor = finishAnchor(wt, startAnchor(wt));
  check("the worktree anchor is its own 40-hex hash", wtAnchor.commitAtStart === first && /^[0-9a-f]{40}$/.test(wtAnchor.commitAtStart), JSON.stringify(wtAnchor));
  check("MUST-EXCLUDE: never an empty-string anchor", wtAnchor.commitAtStart !== "" && wtAnchor.commitAtEnd !== "");

  console.log("\n5. Packed refs");
  git("pack-refs", "--all");
  check("a packed branch ref still resolves", readHead(repo) === second, readHead(repo));

  console.log("\n6. Unresolvable");
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "bench-anchor-none-"));
  const none = finishAnchor(notRepo, startAnchor(notRepo));
  check("outside any repository the anchor is UNKNOWN, headMoved null, not trustworthy", none.commitAtStart === "UNKNOWN" && none.commitAtEnd === "UNKNOWN" && none.headMoved === null && !none.trustworthy && /UNKNOWN/.test(none.summary), JSON.stringify(none));
  const broken = finishAnchor(repo, startAnchor(repo, () => { throw new Error("git not found"); }), () => "");
  check("a failing or empty git answer is UNKNOWN, never \"\"", broken.commitAtStart === "UNKNOWN" && broken.commitAtEnd === "UNKNOWN", JSON.stringify(broken));
  fs.rmSync(notRepo, { recursive: true, force: true });
} finally {
  try { git("worktree", "remove", "--force", path.join(root, "wt")); } catch { /* not created */ }
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) { console.error(`\nbenchAnchor: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nbenchAnchor: all checks passed");
