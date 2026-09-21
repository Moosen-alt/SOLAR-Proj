// A CONTROL BYTE IN SOURCE IS INVISIBLE, AND IT DISARMS THE CODE AROUND IT.
//
// Writing source through a heredoc or an inline python patch on this machine drops one level of
// backslash. `\n` collapses loudly — a parse error, you find it in seconds. `\b` collapses
// SILENTLY into a literal backspace byte (0x08): the regex still compiles, still looks perfect in
// every editor, in grep and in `sed -n`, and simply never matches again.
//
// This test exists because one had been sitting in the tree for months. `frontend/parser.html`
// carried
//
//     s = s.replace(/\s*-\s*\d{3,4}\s*W(?:ATT)?<0x08>/i, '')
//
// where the author wrote `\b`. The regex strips a trailing wattage suffix off a module model, so
// that "ZXM7-SPLD144-540W" reaches equipment matching as "ZXM7-SPLD144" — the name the CEC list
// and the PowerClerk model dropdown actually carry. With a backspace in place of the word
// boundary it required a literal 0x08 after the W, matched nothing, and every module model kept
// its wattage suffix. The identical regex 500 lines below it still read `\b`, which is how we
// know it was corruption and not intent. Nothing failed. Nothing was going to fail.
//
// So the guard cannot be "remember to look". It has to be a test that reads the BYTES.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Tab (0x09), LF (0x0a) and CR (0x0d) are the only control bytes a source file may hold.
 * Everything else below 0x20, plus DEL (0x7f), is corruption: 0x08 from a collapsed `\b`,
 * 0x1b from a collapsed `\e`, 0x0c from `\f`, 0x0b from `\v`, and a raw NUL from `\0`.
 */
export function offendingByte(buf: Buffer): { offset: number; byte: number } | null {
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) return { offset: i, byte: c };
  }
  return null;
}

const lineOf = (buf: Buffer, offset: number): number =>
  buf.slice(0, offset).toString("utf8").split("\n").length;

// ---------------------------------------------------------------------------
// 1. THE DETECTOR ITSELF. A scanner that cannot see the byte would report a clean
//    tree forever, which is the exact shape of reassurance this file exists to refuse.
// ---------------------------------------------------------------------------
console.log("\n1. THE DETECTOR CAN SEE WHAT IT IS LOOKING FOR");
{
  const collapsed: Record<string, number> = { "\\b -> backspace": 0x08, "\\f -> formfeed": 0x0c, "\\v -> vtab": 0x0b, "\\e -> escape": 0x1b, "\\0 -> nul": 0x00 };
  for (const [what, byte] of Object.entries(collapsed)) {
    const poisoned = Buffer.concat([Buffer.from("const re = /W(?:ATT)?", "utf8"), Buffer.from([byte]), Buffer.from("/i;\n", "utf8")]);
    const found = offendingByte(poisoned);
    check(`1a. ${what} (0x${byte.toString(16).padStart(2, "0")}) is caught`, found?.byte === byte, `got ${JSON.stringify(found)}`);
  }
  const wholesome = Buffer.from("const re = /W(?:ATT)?\\b/i;\r\n\tconst x = 1;\n", "utf8");
  check("1b. MUST PASS: tab, CR and LF are not corruption — a scanner that flags them flags everything",
    offendingByte(wholesome) === null, JSON.stringify(offendingByte(wholesome)));
  check("1c. MUST PASS: an escaped \\b (backslash + b, two real characters) is what CLEAN source looks like",
    offendingByte(Buffer.from("/W(?:ATT)?\\b/i", "utf8")) === null);
}

// ---------------------------------------------------------------------------
// 2. THE TREE. Every tracked source file, read as bytes.
// ---------------------------------------------------------------------------
console.log("\n2. NO TRACKED SOURCE FILE CARRIES A CONTROL BYTE");
{
  let listed: string[] = [];
  try {
    listed = execFileSync("git", ["ls-files", "-z", "*.ts", "*.tsx", "*.js", "*.mjs", "*.cjs", "*.html", "*.css", "*.json", "*.md", "*.yml", "*.yaml"], {
      cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean);
  } catch (err) {
    check("2a. the file list could be read from git", false, err instanceof Error ? err.message : String(err));
  }

  // A DENOMINATOR, OR THIS SECTION IS THEATRE. A `git ls-files` that returns nothing — wrong cwd,
  // no git, a pathspec typo — would scan zero files and print a clean result. Anchor on real files.
  check("2a. git listed a plausible number of source files", listed.length > 200, `listed=${listed.length}`);
  for (const anchor of ["frontend/parser.html", "backend/src/repository.ts", "portal-bot/src/adapters/autoLearnAdapter.ts"]) {
    check(`2b. the scan actually covers ${anchor}`, listed.includes(anchor));
  }

  const dirty: string[] = [];
  let scanned = 0;
  for (const rel of listed) {
    let buf: Buffer;
    try { buf = fs.readFileSync(path.join(REPO, rel)); } catch { continue; }
    scanned += 1;
    const hit = offendingByte(buf);
    if (!hit) continue;
    const ctx = buf.slice(Math.max(0, hit.offset - 40), hit.offset + 20).toString("utf8");
    dirty.push(`${rel}:${lineOf(buf, hit.offset)} byte 0x${hit.byte.toString(16).padStart(2, "0")} in ${JSON.stringify(ctx)}`);
  }
  check(`2c. ${scanned} files scanned, none holds a stray control byte`, dirty.length === 0,
    `\n      ${dirty.join("\n      ")}`);
}

console.log(failures ? `\nsourceControlBytes: ${failures} check(s) FAILED` : "\nsourceControlBytes: all checks passed");
if (failures) process.exit(1);
