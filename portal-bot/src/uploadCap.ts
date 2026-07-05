// Shared per-file upload size cap for portal uploads. ONE knob for both the portal-bot's
// upload resolver (which refuses to offer files a portal will bounce) and the backend's
// plan-set splitter (which trims oversized category splits) — the two previously
// hardcoded the same 5 MB default separately, inviting drift when a portal's limit changes.
//
//   PORTAL_UPLOAD_MAX_MB   overrides the default cap (applies to BOTH split and combined
//                          upload modes when set — an operator setting it means it).
//   default                5 MB for split-mode portals (PowerClerk's published limit);
//                          Infinity for combined-mode AHJ portals (Accela takes the full
//                          plan set) unless the env override says otherwise.
export function portalUploadCapBytes(mode: "split" | "combined" = "split"): number {
  const envMb = Number(process.env.PORTAL_UPLOAD_MAX_MB || "");
  if (Number.isFinite(envMb) && envMb > 0) return envMb * 1024 * 1024;
  return mode === "combined" ? Number.POSITIVE_INFINITY : 5 * 1024 * 1024;
}
