// ---------------------------------------------------------------------------
// READ THE PIXELS BACK: OCR over recorded frames, and PII hit counting.
//
// The masking is rendering-only, so the only honest check is on the rendered pixels — not on
// the DOM (whose values are unchanged by design). This repo has no OCR dependency and adding
// one (tesseract.js) would download language data at test time; Windows 10/11 ships an OCR
// engine (Windows.Media.Ocr) reachable from PowerShell 5.1, which reads a 1440x900 Playwright
// frame's 14px text well enough to find a name, a phone number and an address (probed
// 2026-09-24). Off Windows, or with no recogniser language installed, ocrAvailable() is false
// and the caller SKIPS with a reason — it never reports "0 hits" on frames it could not read.
//
// NOTHING THE OCR READS IS PRINTED BY THIS MODULE: the unmasked control run's text is PII by
// construction. Callers get counts and frame names.
//
// Frame paths reach PowerShell through a manifest file, never argv (cmd.exe's 8191-character
// limit has already bitten this repo once).
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OCR_PS1 = String.raw`
$ErrorActionPreference = "Stop"
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output "OCR-ENGINE-UNAVAILABLE"; exit 3 }
if ($args.Count -eq 0) { Write-Output ("OCR-ENGINE-OK " + $engine.RecognizerLanguage.LanguageTag); exit 0 }
$manifest = $args[0]
$outFile = $args[1]
$sb = New-Object System.Text.StringBuilder
foreach ($f in (Get-Content -LiteralPath $manifest -Encoding UTF8)) {
  if (-not $f) { continue }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $r = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  [void]$sb.AppendLine("=====FRAME===== " + $f)
  [void]$sb.AppendLine($r.Text)
  $stream.Dispose()
}
[System.IO.File]::WriteAllText($outFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "OCR-DONE"
`;

let scriptPath = "";
function ocrScript(): string {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-frames-"));
  scriptPath = path.join(dir, "ocr.ps1");
  fs.writeFileSync(scriptPath, OCR_PS1, "utf8");
  return scriptPath;
}

function runPs(args: string[], timeoutMs: number): { status: number | null; out: string } {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ocrScript(), ...args], {
    encoding: "utf8", timeout: timeoutMs, windowsHide: true,
  });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

/** Null when frames can be read on this machine; otherwise why not (the SKIP reason). */
export function ocrUnavailableReason(): string | null {
  if (process.platform !== "win32") return `Windows OCR is the only OCR engine this check knows; platform is ${process.platform}`;
  const r = runPs([], 60_000);
  if (/OCR-ENGINE-OK/.test(r.out)) return null;
  if (/OCR-ENGINE-UNAVAILABLE/.test(r.out)) return "Windows OCR has no recogniser language installed for this user profile";
  return `Windows OCR could not start (exit ${r.status}): ${r.out.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

/** OCR text per frame, keyed by the frame's absolute path. Frames the engine could not read
 *  are absent from the map — a caller counting hits must count frames read, not frames given. */
export function ocrFrames(pngs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!pngs.length) return out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-run-"));
  const manifest = path.join(dir, "frames.txt");
  const result = path.join(dir, "text.txt");
  fs.writeFileSync(manifest, pngs.map((p) => path.resolve(p)).join("\n") + "\n", "utf8");
  const r = runPs([manifest, result], Math.max(120_000, pngs.length * 4_000));
  if (!/OCR-DONE/.test(r.out) || !fs.existsSync(result)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    throw new Error(`OCR run failed (exit ${r.status}): ${r.out.replace(/\s+/g, " ").trim().slice(0, 300)}`);
  }
  const text = fs.readFileSync(result, "utf8");
  for (const chunk of text.split("=====FRAME===== ").slice(1)) {
    const nl = chunk.indexOf("\n");
    const file = (nl >= 0 ? chunk.slice(0, nl) : chunk).replace(/\r$/, "").trim();
    out.set(path.resolve(file), nl >= 0 ? chunk.slice(nl + 1) : "");
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  return out;
}

/** ffmpeg on PATH? (Frames are sampled from the .webm only when it is.) */
export function ffmpegAvailable(): boolean {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

/** Sample a video at `fps` frames per second into `outDir` as PNGs; returns the frame paths. */
export function sampleVideoFrames(video: string, outDir: string, fps = 2): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, "frame-%04d.png");
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", `fps=${fps}`, pattern], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || "").slice(0, 300)}`);
  return fs.readdirSync(outDir).filter((f) => /^frame-\d+\.png$/.test(f)).sort().map((f) => path.join(outDir, f));
}

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which of `values` the OCR text carries. Matching is on the alphanumerics alone (OCR drops
 * and re-spaces punctuation; a spaced account number is still the account number), and a
 * purely alphabetic value must sit at word boundaries in the raw text — the same rule the
 * masker applies, so the two instruments agree on what counts.
 */
export function piiHitsInText(text: string, values: string[]): string[] {
  const raw = text.toLowerCase();
  const norm = alnum(text);
  const hits: string[] = [];
  for (const v of values) {
    const n = alnum(v);
    if (n.length < 3 || !norm.includes(n)) continue;
    if (/^[a-z]+$/.test(n)) {
      const re = new RegExp(`(^|[^a-z])${n}([^a-z]|$)`, "i");
      if (!re.test(raw)) continue;
    }
    hits.push(v);
  }
  return hits;
}
