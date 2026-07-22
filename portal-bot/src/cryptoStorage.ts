import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";

// New blobs are salted and key-stretched with scrypt (a real KDF), so a
// low-entropy SESSION_ENCRYPTION_KEY is not directly brute-forceable from a
// leaked DB. Legacy blobs used a bare SHA-256 of the passphrase as the key with
// no salt; we still DECRYPT those (backward compatibility) but never WRITE them.
// Format is distinguished by a 4-byte magic prefix that legacy base64 blobs
// (which start with a random 12-byte IV) cannot collide with.
const MAGIC = Buffer.from("SCE1", "ascii"); // Solar Crypto Envelope v1
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
// scrypt cost: N=2^15, r=8, p=1 → ~mid-tens of ms per derivation. Credential
// blobs are decrypted per portal run, not in a hot loop, so this is fine.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
// scrypt needs maxmem raised above the default 32 MB for N=2^15 (128*N*r bytes).
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function secretFromEnv(): string {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  if (!secret || secret === "replace-with-a-long-random-secret") {
    throw new Error("SESSION_ENCRYPTION_KEY must be set before saving or loading portal storage state.");
  }
  return secret;
}

function deriveKeyScrypt(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

/** Legacy key derivation: bare SHA-256 of the passphrase, no salt. Read-only. */
function legacyKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptStorageState(storageState: unknown): string {
  const secret = secretFromEnv();
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKeyScrypt(secret, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(storageState), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, encrypted]).toString("base64");
}

export function decryptStorageState(encryptedState: string): unknown {
  const raw = Buffer.from(encryptedState, "base64");
  const secret = secretFromEnv();
  let key: Buffer;
  let iv: Buffer;
  let tag: Buffer;
  let encrypted: Buffer;
  if (raw.length > MAGIC.length && raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    // New envelope: MAGIC | salt | iv | tag | ciphertext
    let off = MAGIC.length;
    const salt = raw.subarray(off, off + SALT_LEN); off += SALT_LEN;
    iv = raw.subarray(off, off + IV_LEN); off += IV_LEN;
    tag = raw.subarray(off, off + TAG_LEN); off += TAG_LEN;
    encrypted = raw.subarray(off);
    key = deriveKeyScrypt(secret, salt);
  } else {
    // Legacy: iv | tag | ciphertext, key = SHA-256(secret)
    iv = raw.subarray(0, IV_LEN);
    tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    encrypted = raw.subarray(IV_LEN + TAG_LEN);
    key = legacyKey(secret);
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

export function saveEncryptedStorageState(profileId: string, storageState: unknown): string {
  const dir = path.resolve(process.cwd(), "backend/data/storage-state");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${profileId}.json.enc`);
  fs.writeFileSync(filePath, encryptStorageState(storageState), "utf8");
  return filePath;
}

export function loadEncryptedStorageState(filePath: string): unknown {
  return decryptStorageState(fs.readFileSync(filePath, "utf8"));
}
