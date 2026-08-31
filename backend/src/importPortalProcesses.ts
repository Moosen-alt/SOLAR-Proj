// CLI: import an operator "Permit Processes" workbook — store portal credentials
// under a client and seed AHJ portal knowledge (platform, MFA marker, contact).
//   npm run import:portal-processes -- <file.xlsx> [--client=<id>] [--dry-run]
// Defaults to the TML International client. Credentials are encrypted; passwords
// and security answers are NEVER printed. Knowledge lands SEEDED (never overwrites
// a human-verified row). Use --dry-run to preview the mapping without writing.

import "dotenv/config"; // credential storage needs SESSION_ENCRYPTION_KEY from .env
import fs from "node:fs";
import { openDatabase } from "./db";
import { importPortalProcessesWorkbook } from "./portalProcessImport";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const clientArg = args.find((a) => a.startsWith("--client="));
  const clientId = clientArg ? clientArg.split("=")[1] : "tml-international-llc";
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("Usage: npm run import:portal-processes -- <file.xlsx> [--client=<id>] [--dry-run]");
    process.exit(1);
  }
  const db = await openDatabase();
  let creds = 0, defaulted = 0, seeded = 0, skipped = 0, mfa = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) { console.error(`  ! not found: ${file}`); continue; }
    const label = `Permit Processes workbook (${file.split(/[\\/]/).pop()}, imported ${new Date().toISOString().slice(0, 10)})`;
    console.log(`\n=== ${file}${dryRun ? " (DRY RUN)" : ""} → client ${clientId} ===`);
    const summaries = importPortalProcessesWorkbook(db, fs.readFileSync(file), { clientId, dryRun, sourceLabel: label });
    for (const sm of summaries) {
      creds += sm.credentialsStored; defaulted += sm.credentialsDefaultedUser;
      seeded += sm.knowledgeSeeded; skipped += sm.knowledgeSkippedVerified; mfa += sm.mfaPortals;
      console.log(`  ${sm.state.padEnd(3)} [${sm.sheet}] creds=${sm.credentialsStored}(default-user ${sm.credentialsDefaultedUser}) seeded=${sm.knowledgeSeeded} skipVerified=${sm.knowledgeSkippedVerified} mfaPortals=${sm.mfaPortals}${sm.credentialErrors ? ` credErrors=${sm.credentialErrors}` : ""}`);
      if (sm.credentialErrors) console.log(`      ! credential error: ${sm.lastCredentialError}`);
      for (const s of sm.samples) console.log(`      • ${s}`);
    }
  }
  console.log(`\n${dryRun ? "DRY RUN — nothing written. " : ""}Totals: credentials=${creds} (username defaulted on ${defaulted}), knowledge seeded=${seeded}, skipped(verified)=${skipped}, MFA-email-code portals=${mfa}.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
