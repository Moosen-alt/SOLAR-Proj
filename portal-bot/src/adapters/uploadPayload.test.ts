// The one place replay decides what filename a portal reviewer sees — and how a document too
// large for a Playwright buffer still reaches the portal under that name.
//   npx tsx portal-bot/src/adapters/uploadPayload.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INLINE_UPLOAD_LIMIT, removeUploadStaging, uploadDisplayName, uploadPayloadFor } from "./uploadPayload";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-payload-"));
const staged: string[] = [];
try {
  const uuid = "cf33f760-1a2b-4c3d-8e9f-0123456789ab";
  const stored = path.join(dir, `${uuid}-zztest-plan-set.pdf`);
  fs.writeFileSync(stored, "%PDF-1.4\n");

  assert.equal(uploadDisplayName(stored), "zztest-plan-set.pdf", "strips the stored UUID prefix");
  assert.equal(uploadDisplayName(path.join(dir, "plain-name.pdf")), "plain-name.pdf", "leaves an unprefixed name alone");
  assert.equal(uploadDisplayName("ABCDEFAB-CDEF-4AAA-8AAA-AAAAAAAAAAAA-x.pdf"), "x.pdf", "case-insensitive");
  // Only a real UUID shape is a storage prefix — 36 hex-or-dash characters are not enough.
  assert.equal(uploadDisplayName("--------------------------------------x.pdf"), "--------------------------------------x.pdf",
    "a dash run is not a UUID (the old loose regex [0-9a-f-]{36}- would have stripped it)");
  assert.equal(uploadDisplayName(`${uuid}-`), `${uuid}-`, "never produces an empty name");

  const p = uploadPayloadFor(stored, null);
  assert.equal(p.tempDir, null, "a small file stages nothing on disk");
  assert.ok(typeof p.file === "object");
  assert.equal(p.file.name, "zztest-plan-set.pdf");
  assert.equal(p.file.mimeType, "application/pdf");
  assert.equal(p.file.buffer.toString(), "%PDF-1.4\n");

  const jpg = path.join(dir, `${uuid}-meter.jpg`);
  const wrapped = uploadPayloadFor(jpg, Buffer.from("%PDF-wrapped"));
  assert.ok(typeof wrapped.file === "object");
  assert.equal(wrapped.file.name, "meter.pdf", "the PDF-wrap name comes from the same cleaned basename");
  assert.equal(wrapped.file.mimeType, "application/pdf");

  const missing = path.join(dir, `${uuid}-gone.pdf`);
  assert.deepEqual(uploadPayloadFor(missing, null), { file: missing, tempDir: null },
    "unreadable → raw path, so Playwright reports the real error");

  // A DOCUMENT OF 50MB OR MORE. Playwright throws "Cannot set buffer larger than 50Mb" for a
  // buffer payload this size, and the sweep's catch turned that into a document silently not
  // attached. It must travel as a PATH whose basename is the clean display name.
  const bigSize = INLINE_UPLOAD_LIMIT + 2 * 1024 * 1024;
  const big = path.join(dir, `9f8e7d6c-5b4a-4392-a1b0-c9d8e7f6a5b4-zztest-big-single-line.pdf`);
  fs.writeFileSync(big, Buffer.alloc(bigSize, 0x20));
  const bp = uploadPayloadFor(big, null);
  if (bp.tempDir) staged.push(bp.tempDir);
  assert.equal(typeof bp.file, "string", "a >=50MB document is handed over as a path, not a buffer Playwright will refuse");
  const bigPath = bp.file as string;
  assert.notEqual(bigPath, big, "...and not the stored path, whose basename carries the UUID prefix");
  assert.equal(path.basename(bigPath), "zztest-big-single-line.pdf", "the staged file IS the clean display name");
  assert.equal(fs.statSync(bigPath).size, bigSize, "the staged file carries every byte");
  assert.ok(bp.tempDir && path.dirname(path.resolve(bp.tempDir)) === path.resolve(os.tmpdir()), "staged under the OS temp dir");
  assert.equal(path.dirname(bigPath), bp.tempDir, "the caller is handed the dir to remove");
  assert.ok(fs.existsSync(big), "the stored original is untouched");

  // A wrapped PDF that is itself >= the limit takes the same path.
  const bigPdf = uploadPayloadFor(path.join(dir, `${uuid}-huge-photo.jpg`), Buffer.alloc(INLINE_UPLOAD_LIMIT, 0x25));
  if (bigPdf.tempDir) staged.push(bigPdf.tempDir);
  assert.equal(typeof bigPdf.file, "string", "a >=50MB wrapped PDF is also staged as a path");
  assert.equal(path.basename(bigPdf.file as string), "huge-photo.pdf");
  assert.equal(fs.statSync(bigPdf.file as string).size, INLINE_UPLOAD_LIMIT);

  // Removal is scoped to its own staging dirs — it will not delete an arbitrary directory.
  removeUploadStaging(dir);
  assert.ok(fs.existsSync(dir), "removeUploadStaging refuses a dir it did not create");
  removeUploadStaging(bp.tempDir);
  assert.ok(!fs.existsSync(bp.tempDir!), "removeUploadStaging removes its own staging dir");
  assert.ok(fs.existsSync(big), "...and never the stored original (a hard link shares bytes, not the name)");
  console.log("uploadPayload.test: all checks passed");
} finally {
  for (const d of staged) removeUploadStaging(d);
  fs.rmSync(dir, { recursive: true, force: true });
}
