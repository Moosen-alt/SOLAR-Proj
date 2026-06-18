import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";

function keyFromEnv(): Buffer {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  if (!secret || secret === "replace-with-a-long-random-secret") {
    throw new Error("SESSION_ENCRYPTION_KEY must be set before saving or loading portal storage state.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptStorageState(storageState: unknown): string {
  const iv = crypto.randomBytes(12);
  const key = keyFromEnv();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(storageState), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptStorageState(encryptedState: string): unknown {
  const raw = Buffer.from(encryptedState, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const key = keyFromEnv();
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

