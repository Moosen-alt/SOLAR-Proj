// CLI: re-encrypt every stored secret from one SESSION_ENCRYPTION_KEY to another.
//
//   npm run rekey:credentials -- --old=<current key> --new=<new key> [--dry-run]
//
// Why this exists: SESSION_ENCRYPTION_KEY encrypts every portal credential, every saved
// portal session blob, and every mailbox password. There was no way to change it — rotating
// the key made all of them permanently undecryptable, so a leaked key meant either living
// with the leak or re-entering every credential by hand. A rotation you cannot perform is
// not a security control.
//
// Safety: takes a database backup first, decrypts with the OLD key, re-encrypts with the
// NEW one, and writes back inside a single transaction. A row that will not decrypt with
// the old key is REPORTED AND LEFT ALONE — never silently dropped or overwritten.
// --dry-run verifies every row decrypts and reports what would change, writing nothing.
//
// After a successful run, set SESSION_ENCRYPTION_KEY to the new value and restart. Keep the
// old key until you have confirmed the app can read its credentials.
import "dotenv/config";
import { openDatabase } from "./db";
import { runBackup } from "./backup";

interface Target { table: string; column: string; idColumn: string; label: string }
const TARGETS: Target[] = [
  { table: "portal_credentials", column: "encrypted_secret", idColumn: "id", label: "portal credential" },
  { table: "portal_profiles", column: "encrypted_storage_state", idColumn: "id", label: "portal session" },
  { table: "email_tracking_sources", column: "imap_pass_encrypted", idColumn: "id", label: "mailbox password" },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const oldKey = (args.find((a) => a.startsWith("--old="))?.split("=").slice(1).join("=") ?? "").trim();
  const newKey = (args.find((a) => a.startsWith("--new="))?.split("=").slice(1).join("=") ?? "").trim();
  if (!oldKey || (!newKey && !dryRun)) {
    console.error("Usage: npm run rekey:credentials -- --old=<current key> --new=<new key> [--dry-run]");
    console.error("  --dry-run verifies every secret decrypts with --old and writes nothing (--new optional).");
    process.exit(1);
  }
  if (newKey && newKey === oldKey) { console.error("--new must differ from --old."); process.exit(1); }
  if (newKey && newKey.length < 24) { console.error("--new looks too short; use a long random value (e.g. `openssl rand -base64 32`)."); process.exit(1); }

  const db = await openDatabase();

  // The crypto module reads the key from the environment at call time, so swap the env var
  // around each call rather than threading a key parameter through it.
  const withKey = async <T>(key: string, fn: () => T): Promise<T> => {
    const prev = process.env.SESSION_ENCRYPTION_KEY;
    process.env.SESSION_ENCRYPTION_KEY = key;
    try { return fn(); } finally { process.env.SESSION_ENCRYPTION_KEY = prev; }
  };
  const { encryptStorageState, decryptStorageState } = await import("../../portal-bot/src/cryptoStorage");

  if (!dryRun) {
    const backup = runBackup(db);
    console.log(`backup written before rekey: ${backup.file}`);
  }

  let ok = 0; let failed = 0; let empty = 0;
  const failures: string[] = [];
  const pending: Array<{ table: string; column: string; idColumn: string; id: string; blob: string }> = [];

  for (const t of TARGETS) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = db.query<Record<string, unknown>>(`SELECT ${t.idColumn} AS id, ${t.column} AS blob FROM ${t.table}`);
    } catch {
      console.log(`  (skipping ${t.table} — table not present)`);
      continue;
    }
    for (const r of rows) {
      const id = String(r.id ?? "");
      const blob = String(r.blob ?? "");
      if (!blob) { empty++; continue; }
      let plain: unknown;
      try {
        plain = await withKey(oldKey, () => decryptStorageState(blob));
      } catch (e) {
        failed++;
        failures.push(`${t.label} ${id}: ${(e as Error).message.slice(0, 90)}`);
        continue;
      }
      if (!dryRun) {
        const reEncrypted = await withKey(newKey, () => encryptStorageState(plain));
        pending.push({ table: t.table, column: t.column, idColumn: t.idColumn, id, blob: reEncrypted });
      }
      ok++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} secret(s) did NOT decrypt with --old:`);
    for (const f of failures.slice(0, 10)) console.error(`  ! ${f}`);
    console.error("\nRefusing to rekey: the old key is wrong, or these rows were written under a different key.");
    console.error("Nothing was changed. Fix --old (or delete/re-enter those credentials) and retry.");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\nDRY RUN — nothing written. ${ok} secret(s) decrypt cleanly with --old (${empty} empty).`);
    process.exit(0);
  }

  // All-or-nothing: a half-rekeyed database is unreadable by BOTH keys.
  db.transaction(() => {
    for (const p of pending) {
      db.run(`UPDATE ${p.table} SET ${p.column} = ? WHERE ${p.idColumn} = ?`, [p.blob, p.id]);
    }
  });

  console.log(`\nRekeyed ${ok} secret(s) (${empty} empty rows untouched).`);
  console.log("NEXT: set SESSION_ENCRYPTION_KEY to the new value and restart the server.");
  console.log("Keep the old key somewhere safe until you have confirmed a portal run can log in.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
