// Credential-at-rest crypto: scrypt-KDF round-trip, legacy-blob backward
// compatibility, tamper detection, wrong-key rejection, and new-format shape.
// Run: tsx portal-bot/src/cryptoStorage.test.ts
import assert from "node:assert";
import crypto from "node:crypto";
import { encryptStorageState, decryptStorageState } from "./cryptoStorage";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok   ${name}`); };

function main(): void {
  process.env.SESSION_ENCRYPTION_KEY = "test-passphrase-with-enough-entropy-1234567890";

  // 1) Round-trip of a realistic storage-state object.
  const sample = { cookies: [{ name: "sid", value: "abc" }], origins: [], secret: "p@ss w0rd" };
  const blob = encryptStorageState(sample);
  assert.deepStrictEqual(decryptStorageState(blob), sample, "round-trip must preserve the object");
  ok("scrypt round-trip preserves object");

  // 2) New blobs carry the SCE1 magic prefix (base64 of "SCE1..." starts "SCE1").
  const raw = Buffer.from(blob, "base64");
  assert.strictEqual(raw.subarray(0, 4).toString("ascii"), "SCE1", "new blob must have SCE1 magic");
  ok("new blob uses SCE1 envelope");

  // 3) Distinct salt/iv per encryption → identical plaintext yields different ciphertext.
  assert.notStrictEqual(encryptStorageState(sample), encryptStorageState(sample), "salt+iv must randomize output");
  ok("distinct salt/iv per encryption");

  // 4) BACKWARD COMPATIBILITY: a legacy blob (SHA-256 key, iv|tag|ct, no magic)
  //    must still decrypt. Build one exactly as the old code did.
  const legacyKey = crypto.createHash("sha256").update(process.env.SESSION_ENCRYPTION_KEY!).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
  const pt = Buffer.from(JSON.stringify(sample), "utf8");
  const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
  const legacyBlob = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
  assert.deepStrictEqual(decryptStorageState(legacyBlob), sample, "legacy SHA-256 blob must still decrypt");
  ok("legacy SHA-256 blob still decrypts");

  // 5) Tamper detection: flipping a ciphertext byte fails the GCM auth tag.
  const t = Buffer.from(blob, "base64");
  t[t.length - 1] ^= 0xff;
  assert.throws(() => decryptStorageState(t.toString("base64")), "tampered blob must throw");
  ok("tamper detection via GCM tag");

  // 6) Wrong key cannot decrypt.
  const good = encryptStorageState(sample);
  process.env.SESSION_ENCRYPTION_KEY = "a-completely-different-passphrase-000000";
  assert.throws(() => decryptStorageState(good), "wrong key must throw");
  ok("wrong key rejected");

  // 7) Missing/placeholder key throws rather than silently using a default.
  process.env.SESSION_ENCRYPTION_KEY = "replace-with-a-long-random-secret";
  assert.throws(() => encryptStorageState(sample), /SESSION_ENCRYPTION_KEY/);
  ok("placeholder key rejected");

  console.log(`\ncryptoStorage: all ${passed} checks passed`);
}

main();
