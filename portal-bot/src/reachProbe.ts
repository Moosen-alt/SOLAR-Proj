// CAN THE BOT GET TO THE RIGHT PLACE ON A PORTAL NOBODY TAUGHT IT?
//
// Point this at any AHJ/utility portal URL. It resolves the stored credential for the
// client, then drives THE ENGINE'S OWN paths — performLogin (loginFlow) and
// findApplicationEntry (applicationEntry) — and reports how far it got. It exists to find
// where the universal engine fails on unfamiliar portals so the gap can be fixed
// generically; it deliberately contains no portal-specific logic of its own.
//
// It fills only the login form. Without --enter it CLICKS NOTHING beyond login, so it is
// safe to run against a live production portal. With --enter it clicks the application-entry
// control once (a navigation — it still fills and submits nothing).
//
//   npm run portal:reach -- <url> [more urls...] [--client=<id>] [--enter] [--headed]
//
// One login attempt per portal, ever: government portals lock accounts, so a failure is
// reported, never retried. Always exits 0 — a partial result is a finding, not a failure.
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

interface Outcome {
  url: string;
  loginStatus: string;
  entryLabel: string;
  landedUrl: string;
  note: string;
}

async function main(): Promise<void> {
  const { openPortal, closePortal } = await import("./browser");
  const { dismissPageModals, clearPageOverlays } = await import("./adapters/autoLearnAdapter");
  const { performLogin } = await import("./adapters/loginFlow");
  const { findApplicationEntryDeep, enterApplicationFlow } = await import("./adapters/applicationEntry");
  const { detectChallengeFrame } = await import("./safeAction");
  const { openDatabase } = await import("../../backend/src/db");
  const { getDecryptedCredentialByUrl } = await import("../../backend/src/portalCredentials");

  const args = process.argv.slice(2);
  const doEnter = args.includes("--enter");
  const headed = args.includes("--headed");
  const clientArg = args.find((a) => a.startsWith("--client="));
  const clientId = clientArg ? clientArg.split("=")[1] : "tml-international-llc";
  const urls = args.filter((a) => !a.startsWith("--"));
  if (!urls.length) {
    console.error("Usage: npm run portal:reach -- <url> [more urls...] [--client=<id>] [--enter] [--headed]");
    process.exit(0);
  }

  const outDir = path.join(process.cwd(), "data", "screenshots");
  fs.mkdirSync(outDir, { recursive: true });
  const db = await openDatabase();
  const results: Outcome[] = [];

  for (const url of urls) {
    const tag = (() => { try { return new URL(url).hostname.split(".").slice(0, 2).join("-"); } catch { return "portal"; } })();
    const out: Outcome = { url, loginStatus: "?", entryLabel: "-", landedUrl: "", note: "" };
    console.log(`\n=== ${url}`);
    const cred = getDecryptedCredentialByUrl(db, clientId, url) ?? undefined;
    if (!cred) { out.loginStatus = "no-credential"; out.note = `no stored credential for client ${clientId}`; results.push(out); console.log(`  no credential — skipped`); continue; }
    console.log(`  credential resolved (user=${cred.username})`);

    const opened = await openPortal({
      userDataDir: path.join(process.cwd(), "portal-profiles", clientId, `reach_${tag}`),
      headless: !headed,
    }).catch((e) => { console.log(`  browser open failed: ${(e as Error).message}`); return null; });
    if (!opened) { out.loginStatus = "browser-open-failed"; results.push(out); continue; }
    const page = opened.page;
    const shot = async (name: string) => { try { await page.screenshot({ path: path.join(outDir, `reach-${tag}-${name}.png`) }); } catch { /* ignore */ } };

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
      await dismissPageModals(page).catch(() => null);
      await clearPageOverlays(page).catch(() => null);

      const login = await performLogin(page, cred);
      out.loginStatus = login.status;
      console.log(`  login: ${login.status} — ${login.message}`);
      await shot("01-after-login");

      const challenge = await detectChallengeFrame(page).catch(() => null);
      if (challenge) { out.note = `challenge: ${challenge}`; console.log(`  ${out.note}`); }

      if (login.ok) {
        const found = await findApplicationEntryDeep(page);
        if (found) {
          out.entryLabel = found.match.label + (found.viaModule ? ` (via ${found.viaModule})` : "");
          console.log(`  application entry FOUND: "${found.match.label}"${found.viaModule ? ` — one hop through "${found.viaModule}"` : ""}${found.match.href ? ` → ${found.match.href}` : ""}`);
          if (doEnter) {
            const entered = await enterApplicationFlow(page);
            out.landedUrl = entered.url;
            console.log(`  ${entered.ok ? "entered" : "enter failed"}: ${entered.message}`);
            console.log(`  landed: ${entered.url}`);
            await shot("02-application-flow");
          }
        } else {
          out.note = out.note || "logged in but no application-entry control on this page";
          console.log(`  application entry NOT found on the landing page`);
          // Diagnostic: what DID the page offer? This is the data that extends the finder.
          const labels = await page.evaluate(() => {
            const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            return (Array.from(document.querySelectorAll("a, button, [role=button]")) as HTMLElement[])
              .filter(vis).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
              .filter((t) => t && t.length < 45).slice(0, 30);
          }).catch(() => [] as string[]);
          console.log(`  page offered: ${[...new Set(labels)].join(" | ").slice(0, 500)}`);
        }
      }
    } catch (e) {
      out.note = `probe error: ${(e as Error).message}`;
      console.log(`  ${out.note}`);
    } finally {
      await closePortal(opened).catch(() => null);
    }
    results.push(out);
  }

  console.log(`\n=== REACH SUMMARY ===`);
  for (const r of results) {
    const host = (() => { try { return new URL(r.url).hostname; } catch { return r.url; } })();
    console.log(`${host.padEnd(42)} login=${r.loginStatus.padEnd(24)} entry=${(r.entryLabel || "-").slice(0, 28).padEnd(28)}${r.note ? ` note=${r.note.slice(0, 60)}` : ""}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(0); });
