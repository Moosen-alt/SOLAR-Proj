/**
 * Portal recipe recorder — TEACH THE BOT A NEW AHJ OR UTILITY PORTAL BY DEMONSTRATION.
 *
 * Runs on the operator's machine (needs a browser + reachable portal + the running app).
 * It opens a headed browser, you log in and complete the application UP TO — but NOT
 * including — the final submit, and it captures each interaction (clicks, field fills,
 * dropdowns, checkboxes, file uploads) as a portable recipe. Values you type that match
 * the recording project's data are auto-bound to that field, so the recipe replays each
 * FUTURE project's own data. When you finish, type "save" and it stores the recipe; the
 * bot will then replay it for that AHJ/utility (always stopping at review — never submits).
 *
 * Usage:
 *   npm run portal:record -- \
 *     --scope ahj --ahj "City of Bend" --state OR \
 *     --url "https://aca-oregon.accela.com/oregon/" \
 *     --project <projectId> --profile ./.portal-profiles/accela \
 *     [--api http://localhost:4173] [--platform Accela]
 *
 * Delete / re-record from the dashboard (Portal Recipes admin) if one wasn't completed.
 */
import readline from "node:readline";
import type { RecipeSelector, RecipeStep } from "../../shared/src/types";
import { openPortal } from "./browser";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

async function main(): Promise<void> {
  const scope = arg("scope", "ahj") === "utility" ? "utility" : "ahj";
  const ahj = arg("ahj");
  const utility = arg("utility");
  const state = arg("state");
  const url = arg("url");
  const platform = arg("platform");
  const projectId = arg("project");
  const profileDir = arg("profile", "./.portal-profiles/recorder");
  const api = arg("api", process.env.API_BASE || "http://localhost:4173");
  if (scope === "ahj" && !ahj) throw new Error("--ahj is required for an AHJ recipe.");
  if (scope === "utility" && !utility) throw new Error("--utility is required for a utility recipe.");

  // 1) Start (or reset) the recording row + fetch the recording project's field values
  //    so we can auto-bind typed values to their field key.
  const startRes = await fetch(`${api}/api/portal-recipes/record`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopeType: scope, ahj, utility, state, portalPlatform: platform, portalUrl: url }),
  });
  if (!startRes.ok) throw new Error(`Failed to start recording: ${startRes.status} ${await startRes.text()}`);
  const recipe = await startRes.json();

  let fieldValues: Record<string, string> = {};
  if (projectId) {
    const fvRes = await fetch(`${api}/api/projects/${projectId}/staging-field-values`);
    if (fvRes.ok) fieldValues = (await fvRes.json()).fieldValues ?? {};
  }
  // Reverse map: normalized value -> field key (longest values first to avoid collisions).
  const valueToField = new Map<string, string>();
  for (const [field, value] of Object.entries(fieldValues)) {
    const v = String(value || "").trim().toLowerCase();
    if (v.length >= 3 && !valueToField.has(v)) valueToField.set(v, field);
  }
  const bindField = (typed: string): string | undefined => valueToField.get(String(typed || "").trim().toLowerCase());

  const steps: RecipeStep[] = [];

  // 2) Open the browser with a persistent profile (login persists across runs).
  const { page } = await openPortal({ userDataDir: profileDir, headless: false });

  // The page calls this binding for every captured interaction.
  await page.exposeBinding(
    "__recordStep",
    (_src: unknown, payload: { kind: string; selector: RecipeSelector; value?: string; isFile?: boolean; label?: string }) => {
      const sel = payload.selector;
      if (payload.kind === "click") {
        steps.push({ action: "click", selector: sel, note: payload.label });
      } else if (payload.kind === "fill") {
        const field = bindField(payload.value || "");
        steps.push(field ? { action: "fill", selector: sel, field, note: payload.label } : { action: "fill", selector: sel, value: payload.value, note: payload.label });
      } else if (payload.kind === "select") {
        const field = bindField(payload.value || "");
        steps.push(field ? { action: "select", selector: sel, field, note: payload.label } : { action: "select", selector: sel, value: payload.value, note: payload.label });
      } else if (payload.kind === "check") {
        steps.push({ action: "check", selector: sel, note: payload.label });
      } else if (payload.kind === "upload") {
        steps.push({ action: "upload", selector: sel, docType: "", note: `UPLOAD — set docType (e.g. sld, site_plan) in the dashboard. ${payload.label ?? ""}` });
      }
      process.stdout.write(`  · captured ${payload.kind}${steps[steps.length - 1]?.field ? ` → field ${steps[steps.length - 1].field}` : ""}\n`);
    },
  );

  // Inject the capture listeners into every page/frame.
  await page.addInitScript(captureScript);
  if (url) await page.goto(url);

  console.log(`\nRecording "${ahj || utility}" (${platform || "portal"}).`);
  console.log("→ Log in and complete the application UP TO the final review/submit screen.");
  console.log("→ Do NOT click the final Submit/Pay. When done, come back here and type: save\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (line.trim().toLowerCase() === "save") resolve();
    });
  });
  rl.close();

  // Terminal review marker so replay always stops before submit.
  steps.push({ action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." });

  const saveRes = await fetch(`${api}/api/portal-recipes/${recipe.id}/steps`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps, status: "complete" }),
  });
  if (!saveRes.ok) throw new Error(`Failed to save recipe: ${saveRes.status} ${await saveRes.text()}`);
  console.log(`\nSaved ${steps.length} step(s) to recipe ${recipe.id}. Set any UPLOAD docTypes in the dashboard, then the bot will replay it.`);
  process.exit(0);
}

// Browser-side capture: generates a portable selector for the target element and reports
// each interaction back to the recorder via window.__recordStep.
function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  function describe(el: Element): Record<string, unknown> {
    const role = el.getAttribute("role") || ({ INPUT: "textbox", BUTTON: "button", SELECT: "combobox", A: "link", TEXTAREA: "textbox" } as Record<string, string>)[el.tagName] || "";
    const name =
      el.getAttribute("aria-label") ||
      (el.getAttribute("id") ? (document.querySelector(`label[for="${el.getAttribute("id")}"]`)?.textContent || "").trim() : "") ||
      (el as HTMLInputElement).placeholder ||
      (el.textContent || "").trim().slice(0, 60);
    const sel: Record<string, unknown> = {};
    const frameName = window.name || undefined;
    if (frameName) sel.frame = frameName;
    if (role && name) { sel.role = role; sel.name = name; }
    else if (el.getAttribute("aria-label")) sel.label = el.getAttribute("aria-label");
    else if ((el as HTMLInputElement).placeholder) sel.placeholder = (el as HTMLInputElement).placeholder;
    else if (el.getAttribute("id")) sel.css = `#${CSS.escape(el.getAttribute("id") as string)}`;
    else if (el.getAttribute("name")) sel.css = `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
    else if (name) sel.text = name;
    return { selector: sel, label: name };
  }
  document.addEventListener("click", (e) => {
    const el = e.target as Element;
    if (!el || !(el instanceof Element)) return;
    const tag = el.tagName;
    if (tag === "INPUT" && (el as HTMLInputElement).type === "file") return; // handled by change
    const d = describe(el.closest("button,a,[role]") || el);
    w.__recordStep({ kind: "click", ...d });
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (!el) return;
    const d = describe(el);
    if (el.type === "file") w.__recordStep({ kind: "upload", ...d });
    else if (el.tagName === "SELECT") w.__recordStep({ kind: "select", value: el.value, ...d });
    else if (el.type === "checkbox" || el.type === "radio") { if (el.checked) w.__recordStep({ kind: "check", ...d }); }
    else w.__recordStep({ kind: "fill", value: el.value, ...d });
  }, true);
}

main().catch((err) => {
  console.error("recordRecipe failed:", err);
  process.exit(1);
});
