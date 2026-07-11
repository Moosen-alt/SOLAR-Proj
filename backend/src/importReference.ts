// CLI: import operator reference spreadsheets into the knowledge base.
//   npm run import:reference -- <file1.xlsx> [file2.xlsx ...] [--dry-run]
// Auto-detects each workbook's dataset (AHJ codes / utility NEM / AHJ process).
// Imports are SEEDED and never overwrite a human-verified row. Use --dry-run to
// preview counts + samples without writing.

import fs from "node:fs";
import { openDatabase } from "./db";
import { importReferenceWorkbook } from "./referenceImport";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("Usage: npm run import:reference -- <file.xlsx> [more.xlsx ...] [--dry-run]");
    process.exit(1);
  }
  const db = await openDatabase();
  let totalImported = 0;
  let totalSkippedVerified = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) { console.error(`  ! not found: ${file}`); continue; }
    console.log(`\n=== ${file}${dryRun ? " (dry run)" : ""} ===`);
    const summaries = importReferenceWorkbook(db, fs.readFileSync(file), { dryRun });
    if (!summaries.length) { console.log("  (no recognized dataset)"); continue; }
    for (const s of summaries) {
      totalImported += s.imported;
      totalSkippedVerified += s.skippedVerified;
      console.log(`  [${s.dataset}] imported=${s.imported} skippedVerified=${s.skippedVerified} skippedEmpty=${s.skippedEmpty}`);
      for (const sample of s.samples) console.log(`      • ${sample}`);
    }
  }
  console.log(`\n${dryRun ? "DRY RUN — nothing written. " : ""}Total imported: ${totalImported}, skipped (human-verified): ${totalSkippedVerified}.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
