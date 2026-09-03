// Serve a captured portal replica so you can click through it yourself.
//   npm run replica:serve -- city-of-coos-bay [port]
//   npm run replica:serve                      (lists what is available)
import path from "node:path";
import fs from "node:fs";
import { startReplicaServer, bundleDir, listBundles } from "./replicaServer";

async function main(): Promise<void> {
  const name = process.argv[2];
  const port = Number(process.argv[3] || 45900);
  const bundles = listBundles();
  if (!name) {
    console.log(bundles.length ? "Available replicas:" : `No replicas yet — run: npm run replica:build`);
    for (const b of bundles) console.log(`   ${path.basename(b, ".json")}`);
    return;
  }
  const file = path.join(bundleDir(), `${name}.json`);
  if (!fs.existsSync(file)) { console.error(`No replica named "${name}". Run: npm run replica:build`); process.exitCode = 1; return; }
  const server = await startReplicaServer({ bundleFile: file, port });
  console.log(`${name} replica serving ${server.routes.length} page(s) at ${server.base}`);
  console.log(`   submissions: ${server.base}/__state`);
  for (const r of server.routes) console.log(`   ${server.base}${r}`);
  console.log("\nNo live portal is involved. Ctrl-C to stop.");
}

main().catch((e) => { console.error(e); process.exit(1); });
