/**
 * THE PRODUCT, WALKED THROUGH ON ITS OWN SCREEN — recorded, for the room that has no time.
 *
 *   npx tsx scripts/demo-record-walkthrough.ts --url http://127.0.0.1:4270 --out walkthrough.webm [--shots dir]
 *
 * A captioned video tour of the demo kit's dashboard: the board with a project in every
 * column, the gate refusing Tigard, a clean project's fees and built documents, then one
 * project at each later stage (staged for review, tracking approvals, handed off). Everything
 * on screen is the kit's synthetic data; the tour only CLICKS AND SCROLLS — it presses no
 * button that changes a project, so recording it leaves the kit exactly as it was.
 *
 * REFUSES to record anything but a demo kit: the server's clients must be exactly
 * "Solaris Demo Co" and every project's address must carry ZIP 99999. Pointed at the
 * production dashboard by mistake, it stops before the browser opens.
 *
 * Every non-loopback request the page makes is aborted and counted; the video is kept only
 * when that count is zero.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg("url", "http://127.0.0.1:4270").replace(/\/$/, "");
const OUT = path.resolve(arg("out", "walkthrough.webm"));
const SHOTS = arg("shots") ? path.resolve(arg("shots")) : "";
const W = 1440, H = 900;

interface ListProject { id: string; homeownerName?: string; ahj?: string; utility?: string; status: string; stageKey?: string; projectAddress?: string; zip?: string }

async function getJson<T>(p: string): Promise<T> {
  const res = await fetch(`${BASE}${p}`);
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

// Loopback only: exact names, not a prefix test ('127.0.0.1.nip.io' is not loopback).
function isLoopback(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch { return u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:"); }
}

async function main(): Promise<void> {
  if (!isLoopback(BASE)) throw new Error(`Refusing: ${BASE} is not a loopback address. The walkthrough records a local demo kit only.`);

  // --- The guard: a demo kit, and only a demo kit ---------------------------------------
  const { clients } = await getJson<{ clients: Array<{ companyName: string }> }>("/api/clients");
  const names = clients.map((c) => c.companyName);
  if (names.length !== 1 || names[0] !== "Solaris Demo Co") {
    throw new Error(`Refusing: this server's clients are ${JSON.stringify(names)}, not only "Solaris Demo Co". It is not a demo kit.`);
  }
  const listed = await getJson<{ projects: ListProject[] } | ListProject[]>("/api/projects?limit=200");
  const projects = Array.isArray(listed) ? listed : listed.projects;
  const notDemo = projects.filter((p) => String(p.zip ?? "").trim() !== "99999" || !/\b99999\b/.test(String(p.projectAddress ?? "")));
  if (!projects.length || notDemo.length) {
    throw new Error(`Refusing: ${notDemo.length} project(s) here do not carry the demo ZIP 99999.`);
  }

  // One project per column, chosen from the live data rather than hardcoded names, so the
  // tour follows whatever the kit build actually seeded.
  const byStage = (key: string, pick?: (p: ListProject) => boolean) =>
    projects.find((p) => p.stageKey === key && (!pick || pick(p))) ?? null;
  const tigard = projects.find((p) => /tigard/i.test(p.ahj ?? "")) ?? null;
  const clean = projects.find((p) => /coos bay/i.test(p.ahj ?? "") && p.stageKey === "build") ?? byStage("build");
  const submit = byStage("submit");
  const track = byStage("track");
  const closeout = byStage("closeout");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: path.dirname(OUT) + path.sep + ".walkthrough-tmp", size: { width: W, height: H } },
  });
  let aborted = 0;
  await context.route("**/*", (route) => {
    if (isLoopback(route.request().url())) return route.continue();
    aborted += 1;
    return route.abort();
  });
  // tsx/esbuild wraps named inner functions in __name(...), which does not exist in the page:
  // without this shim the caption script below throws on load and silently shows nothing.
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  // The caption bar: fixed, above everything, never takes a click.
  await context.addInitScript(() => {
    const mount = () => {
      if (document.getElementById("__wt_caption")) return;
      const bar = document.createElement("div");
      bar.id = "__wt_caption";
      bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;"
        + "background:rgba(17,24,39,.94);color:#fff;font:600 22px/1.35 system-ui,Segoe UI,sans-serif;padding:14px 28px 12px;"
        + "border-top:3px solid #16a34a";
      bar.innerHTML = '<div id="__wt_head"></div><div id="__wt_sub" style="font-weight:400;font-size:16px;opacity:.9;margin-top:4px"></div>'
        + '<div style="font-weight:400;font-size:12px;opacity:.6;margin-top:6px">Demo kit · synthetic homeowners at ZIP 99999 · nothing here reaches a real portal</div>';
      document.body.appendChild(bar);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  });

  const page = await context.newPage();
  let shot = 0;
  const caption = async (head: string, sub = "") => {
    await page.evaluate(([h, s]) => {
      const a = document.getElementById("__wt_head"); const b = document.getElementById("__wt_sub");
      if (a) a.textContent = h; if (b) b.textContent = s;
    }, [head, sub]);
  };
  const hold = (ms: number) => page.waitForTimeout(ms);
  const snap = async (label: string) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    shot += 1;
    await page.screenshot({ path: path.join(SHOTS, `${String(shot).padStart(2, "0")}-${label}.png`) });
  };
  const board = async () => {
    // Not "networkidle": the dashboard holds an SSE connection open (/api/events), so the
    // network is never idle. The board's own cards are the readiness signal.
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#projectBoard button", { timeout: 15_000 });
  };
  const open = async (p: ListProject) => {
    await board();
    await page.locator("#projectBoard button", { hasText: p.homeownerName ?? "" }).first().click();
    await page.waitForFunction(() => !document.getElementById("detailView")?.hidden, null, { timeout: 15_000 });
    await hold(1800); // panels load in parallel; let them land before the camera looks
  };
  const scrollTo = async (selector: string) => {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "start" }), selector);
    await hold(1200);
  };
  const scrollToText = async (text: string) => {
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll("#detailView *")].find((e) => e.childElementCount === 0 && e.textContent?.includes(t));
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, text);
    await hold(1200);
  };

  // --- The tour -------------------------------------------------------------------------
  await board();
  await caption("One board, five stages.", "Plan set in, filed permits out. Every project here was created and moved by the product's own code.");
  await snap("board");
  await hold(6000);

  if (tigard) {
    await open(tigard);
    await caption(`${tigard.homeownerName} — ${tigard.ahj}`, "The gate knows this job is on the engineered path and refuses to call it ready without a PE-stamped structural package.");
    await scrollToText("PE-stamped");
    await snap("gate-refuses");
    await hold(6500);
  }

  if (clean) {
    await open(clean);
    await caption(`${clean.homeownerName} — ${clean.ahj}`, "The permit and interconnection fees come from each authority's own published schedule — with the source one click away.");
    await snap("fees");
    await hold(6000);
    await scrollTo("#stage-build");
    await caption("Build & Validate ran by itself.", "QC passed, the application package and AHJ forms were built, and the reviewer gate checked the plan sheets — no one clicked a button.");
    await snap("build-validate");
    await hold(6500);
  }

  if (submit) {
    await open(submit);
    await caption(`${submit.homeownerName} — staged for review`, "Filled into the portal up to the review screen. A person reviews, submits, and records the confirmation number — the automation cannot click submit.");
    await scrollTo("#stage-submit");
    await snap("submit");
    await hold(7000);
  }

  if (track) {
    await open(track);
    await caption(`${track.homeownerName} — tracking approvals`, "Each permit and the interconnection are tracked separately. Here the building permit is ready to issue — the fee is a person's to pay.");
    await scrollTo("#stage-track");
    await snap("track");
    await hold(7000);
  }

  if (closeout) {
    await open(closeout);
    await caption(`${closeout.homeownerName} — closed out`, "Permits issued and interconnection approved: the project hands off to the installer with its packet.");
    await scrollTo("#stage-closeout");
    await snap("closeout");
    await hold(6500);
  }

  await board();
  await caption("The machine does the typing. A person signs off.", "Every gate, every document, every fee — checked before a human files it.");
  await snap("end");
  await hold(5000);

  const video = page.video();
  await context.close();
  await browser.close();
  const tmp = video ? await video.path() : "";
  if (aborted > 0) {
    if (tmp) fs.rmSync(tmp, { force: true });
    throw new Error(`Refused to keep the video: the page tried ${aborted} non-loopback request(s).`);
  }
  if (!tmp || !fs.existsSync(tmp)) throw new Error("No video was produced.");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.renameSync(tmp, OUT);
  fs.rmSync(path.dirname(OUT) + path.sep + ".walkthrough-tmp", { recursive: true, force: true });
  const missing = [["Tigard gate", tigard], ["clean project", clean], ["Submit", submit], ["Track", track], ["Closeout", closeout]]
    .filter(([, p]) => !p).map(([n]) => n);
  console.log(`Saved ${OUT} (${fs.statSync(OUT).size} bytes). Non-loopback requests: ${aborted}.`
    + (missing.length ? ` Skipped (no such project in this kit): ${missing.join(", ")}.` : ""));
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
