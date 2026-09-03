// Build replica bundles from every learn-run trace on disk, grouped by portal.
//   npm run replica:build
import fs from "node:fs";
import path from "node:path";
import { pagesFromTraceZip, pagesFromCaptureDir, mergeBundles, type ReplicaPage } from "./extractFromTrace";

const RUNS = path.resolve(process.cwd(), "data/learn-runs");
const OUT = path.resolve(process.cwd(), "data/portal-replicas");

// Run folder names are "<stamp>_<portal-slug>_<id>" — the slug is the portal.
function portalOf(dirName: string): string {
  const m = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)_[a-z0-9]{4}$/.exec(dirName);
  return m ? m[1] : dirName;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const byPortal = new Map<string, Array<{ run: string; pages: ReplicaPage[] }>>();
  const dirs = fs.readdirSync(RUNS).filter((d) => fs.statSync(path.join(RUNS, d)).isDirectory()).filter((d) => fs.existsSync(path.join(RUNS, d, "trace.zip")) || fs.readdirSync(path.join(RUNS, d)).some((f) => f.startsWith("page-")));
  console.log(`scanning ${dirs.length} run(s) with traces...`);
  for (const d of dirs) {
    // Prefer the run's OWN page captures (whole pages, blanked of PII). Fall back to
    // mining the trace for runs recorded before capture existed.
    let pages: ReplicaPage[] = pagesFromCaptureDir(path.join(RUNS, d));
    if (!pages.length) {
      const zip = path.join(RUNS, d, "trace.zip");
      try { pages = await pagesFromTraceZip(zip); }
      catch (e) { console.log(`  ${d}: extract failed — ${(e as Error).message.slice(0, 70)}`); continue; }
    }
    if (!pages.length) { console.log(`  ${d}: no full snapshots`); continue; }
    const portal = portalOf(d);
    (byPortal.get(portal) ?? byPortal.set(portal, []).get(portal)!).push({ run: d, pages });
    console.log(`  ${d} -> ${portal}: ${pages.length} page(s)`);
  }
  for (const [portal, runs] of byPortal) {
    const bundle = mergeBundles(portal, runs);
    const file = path.join(OUT, `${portal}.json`);
    fs.writeFileSync(file, JSON.stringify(bundle, null, 1));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`\n${portal}: ${bundle.pages.length} unique page(s), ${kb} KB -> ${path.relative(process.cwd(), file)}`);
    for (const p of bundle.pages) console.log(`   ${p.key}  (${Math.round(p.bytes / 1024)} KB) ${p.title.slice(0, 50)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
