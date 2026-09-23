// ---------------------------------------------------------------------------
// DEMO UTILITY CO — A FICTIONAL INTERCONNECTION PORTAL FOR THE ACT 4 RECORDING.
//
// Act 4 of the runbook shows the product's real recipe replay engine filling a portal and
// stopping at the review screen. Doing that against a real utility portal is off the table
// in a demo — the kit has no credentials, promises no outbound traffic, and a real portal
// would be a real filing. So this is a portal that exists only on this laptop:
//
//   · Served on 127.0.0.1 from a random free port. No external fonts, images or scripts —
//     every byte comes from this file, so the page needs nothing off the machine.
//   · Clearly fictional on every page: a hazard-striped "FICTIONAL TEST PORTAL" banner, a
//     made-up company, and a palette/markup that imitates no real portal. It carries no
//     utility, AHJ or portal-vendor name, logo, colour or domain.
//   · Multi-page, shaped like the real thing where it matters to the engine: a login, four
//     data pages with labelled controls (one manufacturer -> model cascade select that loads
//     ~600ms after the manufacturer changes, the way certified-equipment lists do), a
//     documents page with file inputs, and a review page whose "Submit application" button
//     is visible and live.
//   · No step POSTs anything except that final submit. Values ride in sessionStorage between
//     pages, so the ONLY non-GET request this server can ever see is the one the automation
//     must never make. The server logs every request; the recorder refuses to keep a video
//     if that log holds a submit.
//
// Nothing here is a copy of a real portal replica (data/portal-replicas/*.json carry real
// customer data and are never used). The DOM-smoke fixtures under portal-bot/ are untouched.
// ---------------------------------------------------------------------------
import http from "node:http";

export interface PortalRequestLogEntry {
  method: string;
  path: string;
  at: number;
}

export interface DemoPortal {
  /** http://127.0.0.1:<port> — no trailing slash. */
  baseUrl: string;
  port: number;
  /** Every request the server saw, in order. */
  log: PortalRequestLogEntry[];
  /** Requests that would have filed the application (any POST to /apply/submit). */
  submitPosts(): PortalRequestLogEntry[];
  /** Every non-GET/HEAD request, whatever its path. Should also be empty. */
  nonGetRequests(): PortalRequestLogEntry[];
  close(): Promise<void>;
}

const BRAND = "Demo Utility Co";
const BANNER = `${BRAND} — FICTIONAL TEST PORTAL`;

const STEPS: Array<{ path: string; label: string }> = [
  { path: "/apply/customer", label: "Customer" },
  { path: "/apply/service", label: "Service address" },
  { path: "/apply/system", label: "Generation system" },
  { path: "/apply/documents", label: "Documents" },
  { path: "/apply/review", label: "Review" },
];

// Module catalogue for the cascade. The project's own make/model must be present verbatim
// (the engine's model rules refuse near-matches by design); neighbours are there so a
// wrong pick would be visible, including a near-miss of the right model.
const MODULE_CATALOGUE: Record<string, string[]> = {
  "Canadian Solar": ["CS6R-400MS", "CS6R-410MS", "CS6.2-48TD-425"],
  "Q CELLS": ["Q.PEAK DUO BLK ML-G10+ 400", "Q.TRON BLK M-G2+ 425", "Q.TRON BLK M-G2.C1+", "Q.TRON BLK M-G2.C1+ 440"],
  "REC Solar": ["REC400AA Pure-R", "REC420AA Pure-R"],
  "Silfab": ["SIL-400 HC+", "SIL-430 QD"],
};
const INVERTER_MODELS = ["IQ7PLUS-72-2-US", "IQ8A-72-2-US", "IQ8M-72-2-US", "IQ8PLUS-72-2-US", "SE7600H-US"];
const STATES = ["AZ", "CA", "ID", "NV", "OR", "WA"];

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// CLASS NAMES AVOID "progress" AND "upload" ON PURPOSE. The replay engine's upload wait
// (RecipeAdapter.waitForUploadAccepted) treats any visible element whose class contains
// either word as an upload progress bar, and reads a MISSING aria-valuenow as 0% — so a
// wizard nav called "progress" made every attach wait its full 30s and report a stalled
// upload (measured: 4 x 30s on the first dev run). Reported as an engine issue; the
// fixture sidesteps it rather than hiding it.
const CSS = `
:root { --ink:#1f1b24; --muted:#5d566a; --line:#d9d3e0; --bg:#f6f4f8; --panel:#ffffff;
  --brand:#4a3560; --brand-2:#6d4f8c; --accent:#b0600f; --ok:#2f6b3a; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font: 15px/1.45 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: var(--ink); background: var(--bg); }
.fict { background: repeating-linear-gradient(135deg, #ffd23f 0 18px, #1f1b24 18px 36px); padding: 5px 0; }
.fict span { display: block; width: max-content; margin: 0 auto; background: #ffd23f; color: #1f1b24;
  font-weight: 800; letter-spacing: .06em; padding: 3px 14px; font-size: 13px; border: 2px solid #1f1b24; }
header.top { background: var(--brand); color: #fff; display: flex; align-items: center; gap: 14px; padding: 12px 28px; }
header.top .mark { width: 38px; height: 38px; border-radius: 10px; background: #fff; color: var(--brand);
  display: grid; place-items: center; font-weight: 900; font-size: 16px; }
header.top .name { font-weight: 700; font-size: 18px; }
header.top .sub { opacity: .8; font-size: 13px; }
header.top .spacer { flex: 1; }
header.top a { color: #fff; font-size: 14px; }
nav.wizard-steps { display: flex; gap: 6px; padding: 10px 28px; background: #ebe6f0; border-bottom: 1px solid var(--line); }
nav.wizard-steps .pstep { padding: 4px 12px; border-radius: 999px; font-size: 13px; color: var(--muted); background: #fff; border: 1px solid var(--line); }
nav.wizard-steps .pstep.here { background: var(--brand-2); color: #fff; border-color: var(--brand-2); font-weight: 600; }
nav.wizard-steps .pstep.done { color: var(--ok); }
main { max-width: 980px; margin: 22px auto; padding: 0 28px; }
h1 { font-size: 24px; margin: 0 0 4px; }
p.lede { color: var(--muted); margin: 0 0 18px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 22px; }
.field label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.field .req { color: var(--accent); margin-left: 2px; }
.field input[type=text], .field input[type=email], .field input[type=tel], .field input[type=password],
.field input[type=number], .field select { width: 100%; padding: 9px 10px; border: 1px solid #bdb4c7; border-radius: 6px; font: inherit; background: #fff; }
.field input:focus, .field select:focus { outline: 3px solid #e7c98f; border-color: var(--accent); }
.field .hint { font-size: 12px; color: var(--muted); margin-top: 3px; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
button.primary { background: var(--brand); color: #fff; border: 0; border-radius: 8px; padding: 10px 22px; font: inherit; font-weight: 600; cursor: pointer; }
button.secondary { background: #fff; color: var(--brand); border: 1px solid var(--brand); border-radius: 8px; padding: 10px 18px; font: inherit; cursor: pointer; }
.doc-slot { border: 2px dashed #bdb4c7; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; background: #fbfafc; }
.doc-slot .status { margin-top: 6px; font-size: 13px; color: var(--muted); }
.doc-slot .status.attached { color: var(--ok); font-weight: 600; }
table.summary { width: 100%; border-collapse: collapse; }
table.summary th, table.summary td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 14px; vertical-align: top; }
table.summary th { width: 34%; color: var(--muted); font-weight: 600; }
table.summary tr.section th { color: var(--brand); padding-top: 14px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; }
.certify { margin-top: 14px; font-size: 13px; color: var(--muted); }
button#submitApplication { background: var(--accent); font-size: 16px; padding: 12px 28px; }
.apps { width: 100%; border-collapse: collapse; margin: 10px 0 16px; }
.apps td, .apps th { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; font-size: 14px; }
.login { max-width: 420px; margin: 50px auto; }
.done-banner { background: #e6f2e8; border: 1px solid #a9cfb0; border-radius: 10px; padding: 18px; }
`;

// Shared page script. Values move between pages in sessionStorage (never POSTed); the
// review page reads them back. Kept deliberately small and framework-free.
const PAGE_JS = `
window.demoPortal = {
  save: function () {
    var all = JSON.parse(sessionStorage.getItem('demoApp') || '{}');
    document.querySelectorAll('input[name], select[name]').forEach(function (el) {
      if (el.type === 'file' || el.type === 'password') return;
      all[el.name] = el.value;
    });
    sessionStorage.setItem('demoApp', JSON.stringify(all));
  },
  go: function (next) { window.demoPortal.save(); location.href = next; },
  requireLogin: function () { if (sessionStorage.getItem('demoAuth') !== '1') location.replace('/login'); },
};
`;

function layout(opts: { title: string; step?: string; signedIn?: boolean; body: string; script?: string }): string {
  const idx = STEPS.findIndex((s) => s.path === opts.step);
  const progress = opts.step
    ? `<nav class="wizard-steps" aria-label="Application progress">${STEPS.map((s, i) =>
        `<span class="pstep${i === idx ? " here" : i < idx ? " done" : ""}">${i + 1}. ${esc(s.label)}</span>`).join("")}</nav>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(opts.title)} · ${esc(BANNER)}</title>
<link rel="icon" href="data:,">
<style>${CSS}</style>
<script>${PAGE_JS}${opts.signedIn ? "window.demoPortal.requireLogin();" : ""}</script>
</head><body>
<div class="fict" role="note"><span>${esc(BANNER)} · not a real utility · nothing here is sent anywhere</span></div>
<header class="top"><div class="mark" aria-hidden="true">DU</div>
  <div><div class="name">${esc(BRAND)}</div><div class="sub">Interconnection applications (fictional)</div></div>
  <div class="spacer"></div>${opts.signedIn ? `<a href="/logout" id="logoutLink">Log out</a>` : ""}</header>
${progress}
<main>${opts.body}</main>
${opts.script ? `<script>${opts.script}</script>` : ""}
</body></html>`;
}

function field(id: string, label: string, control: string, hint = ""): string {
  return `<div class="field"><label for="${id}">${esc(label)}<span class="req" aria-hidden="true">*</span></label>${control}${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</div>`;
}
const text = (id: string, type = "text", extra = ""): string => `<input type="${type}" id="${id}" name="${id}" required ${extra}>`;
const select = (id: string, options: string[], placeholder: string): string =>
  `<select id="${id}" name="${id}" required><option value="">${esc(placeholder)}</option>${options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>`;

function introPage(): string {
  return layout({
    title: "About this portal",
    body: `<div class="panel" style="margin-top:40px">
  <h1>This portal is fictional</h1>
  <p class="lede">${esc(BRAND)} does not exist. This site runs on this laptop only, so a real replay can be shown without touching a real utility.</p>
</div>`,
  });
}

function loginPage(): string {
  return layout({
    title: "Sign in",
    body: `<div class="panel login">
  <h1>Sign in</h1>
  <p class="lede">Installer access to interconnection applications.</p>
  <form id="loginForm" onsubmit="return false;">
    ${field("username", "Username", `<input type="text" id="username" name="username" autocomplete="username">`)}
    <div style="height:12px"></div>
    ${field("password", "Password", `<input type="password" id="password" name="password" autocomplete="current-password">`)}
    <div class="actions"><button type="submit" class="primary" id="loginButton">Log in</button></div>
  </form>
</div>`,
    script: `document.getElementById('loginForm').addEventListener('submit', function () {
  var u = document.getElementById('username').value, p = document.getElementById('password').value;
  if (!u || !p) return;
  sessionStorage.setItem('demoAuth', '1');
  sessionStorage.setItem('demoUser', u);
  setTimeout(function () { location.href = '/home'; }, 400);
});`,
  });
}

function homePage(): string {
  return layout({
    title: "Your applications",
    signedIn: true,
    body: `<h1>Your applications</h1>
<p class="lede">Signed in as <strong id="whoami"></strong>.</p>
<div class="panel">
  <table class="apps"><thead><tr><th>Application</th><th>Customer</th><th>Status</th></tr></thead>
  <tbody><tr><td colspan="3" style="color:var(--muted)">No applications yet.</td></tr></tbody></table>
  <button type="button" class="primary" id="startNew" onclick="sessionStorage.removeItem('demoApp'); location.href='/apply/customer';">Start a new application</button>
</div>`,
    script: `document.getElementById('whoami').textContent = sessionStorage.getItem('demoUser') || '';`,
  });
}

function customerPage(): string {
  return layout({
    title: "Customer information",
    step: "/apply/customer",
    signedIn: true,
    body: `<h1>Customer information</h1>
<p class="lede">The utility account holder for the service where the system is installed.</p>
<div class="panel"><div class="grid">
  ${field("firstName", "First name", text("firstName"))}
  ${field("lastName", "Last name", text("lastName"))}
  ${field("email", "Email address", text("email", "email"))}
  ${field("phone", "Phone number", text("phone", "tel"))}
  ${field("accountNumber", "Utility account number", text("accountNumber"), "As printed on the customer's bill.")}
</div>
<div class="actions"><button type="button" class="primary" onclick="demoPortal.go('/apply/service')">Continue</button></div></div>`,
  });
}

function servicePage(): string {
  return layout({
    title: "Service address",
    step: "/apply/service",
    signedIn: true,
    body: `<h1>Service address</h1>
<p class="lede">Where the generating system will be interconnected.</p>
<div class="panel"><div class="grid">
  ${field("street", "Street address", text("street"))}
  ${field("city", "City name", text("city"))}
  ${field("state", "State", select("state", STATES, "Select a state"))}
  ${field("zip", "ZIP code", text("zip"))}
</div>
<div class="actions"><button type="button" class="primary" onclick="demoPortal.go('/apply/system')">Continue</button></div></div>`,
  });
}

function systemPage(): string {
  const makes = Object.keys(MODULE_CATALOGUE);
  return layout({
    title: "Generation system",
    step: "/apply/system",
    signedIn: true,
    body: `<h1>Generation system</h1>
<p class="lede">Nameplate ratings and certified equipment. Choosing a manufacturer loads its models.</p>
<div class="panel"><div class="grid">
  ${field("dcKw", "System size (kW DC)", text("dcKw"))}
  ${field("acKw", "System size (kW AC)", text("acKw"))}
  ${field("moduleManufacturer", "Module manufacturer", select("moduleManufacturer", makes, "Select a manufacturer"))}
  ${field("moduleModel", "Module model", `<select id="moduleModel" name="moduleModel" required><option value="">Select a manufacturer first</option></select>`, "Loads after a manufacturer is chosen.")}
  ${field("moduleCount", "Number of modules", text("moduleCount"))}
  ${field("inverterModel", "Inverter model", select("inverterModel", INVERTER_MODELS, "Select an inverter"))}
  ${field("inverterCount", "Number of inverters", text("inverterCount"))}
</div>
<div class="actions"><button type="button" class="primary" onclick="demoPortal.go('/apply/documents')">Continue</button></div></div>`,
    // The cascade: the model list is REPLACED ~600ms after the manufacturer changes, like
    // a certified-equipment lookup. Until then it holds only its placeholder.
    script: `(function () {
  var catalogue = ${JSON.stringify(MODULE_CATALOGUE)};
  var make = document.getElementById('moduleManufacturer');
  var model = document.getElementById('moduleModel');
  make.addEventListener('change', function () {
    model.innerHTML = '<option value="">Loading models…</option>';
    var chosen = make.value;
    setTimeout(function () {
      var list = catalogue[chosen] || [];
      model.innerHTML = '<option value="">Select a model</option>' + list.map(function (m) {
        var o = document.createElement('option'); o.value = m; o.textContent = m; return o.outerHTML;
      }).join('');
    }, 600);
  });
})();`,
  });
}

function upload(id: string, label: string, hint: string): string {
  return `<div class="doc-slot"><label for="${id}" style="font-weight:600">${esc(label)}<span class="req" aria-hidden="true">*</span></label>
  <div class="hint" style="font-size:12px;color:var(--muted)">${esc(hint)}</div>
  <input type="file" id="${id}" name="${id}" accept=".pdf,application/pdf" required style="margin-top:8px">
  <div class="status" id="${id}Status">No file attached.</div></div>`;
}

function documentsPage(): string {
  return layout({
    title: "Documents",
    step: "/apply/documents",
    signedIn: true,
    body: `<h1>Documents</h1>
<p class="lede">PDF only. Files stay in this browser — this fictional portal uploads nothing.</p>
<div class="panel">
  ${upload("planSetFile", "Plan set (PDF)", "The full stamped or unstamped plan set.")}
  ${upload("oneLineFile", "Single-line diagram", "Electrical one-line for the system.")}
  <div class="actions"><button type="button" class="primary" onclick="demoPortal.go('/apply/review')">Continue</button></div>
</div>`,
    // Record only the NAME and size of what was attached — the review page lists them.
    script: `document.querySelectorAll('input[type=file]').forEach(function (el) {
  el.addEventListener('change', function () {
    var f = el.files && el.files[0];
    var status = document.getElementById(el.id + 'Status');
    var all = JSON.parse(sessionStorage.getItem('demoApp') || '{}');
    if (f) {
      status.textContent = 'Attached: ' + f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)';
      status.className = 'status attached';
      all[el.id] = f.name;
    } else { status.textContent = 'No file attached.'; status.className = 'status'; delete all[el.id]; }
    sessionStorage.setItem('demoApp', JSON.stringify(all));
  });
});`,
  });
}

function reviewPage(): string {
  const rows: Array<[string, string] | [string]> = [
    ["Customer"],
    ["First name", "firstName"], ["Last name", "lastName"], ["Email address", "email"], ["Phone number", "phone"],
    ["Utility account number", "accountNumber"],
    ["Service address"],
    ["Street address", "street"], ["City name", "city"], ["State", "state"], ["ZIP code", "zip"],
    ["Generation system"],
    ["System size (kW DC)", "dcKw"], ["System size (kW AC)", "acKw"], ["Module manufacturer", "moduleManufacturer"],
    ["Module model", "moduleModel"], ["Number of modules", "moduleCount"], ["Inverter model", "inverterModel"],
    ["Number of inverters", "inverterCount"],
    ["Documents"],
    ["Plan set (PDF)", "planSetFile"], ["Single-line diagram", "oneLineFile"],
  ];
  const body = rows.map((r) => r.length === 1
    ? `<tr class="section"><th colspan="2">${esc(r[0])}</th></tr>`
    : `<tr><th>${esc(r[0])}</th><td data-key="${esc(r[1])}"></td></tr>`).join("");
  return layout({
    title: "Review your application",
    step: "/apply/review",
    signedIn: true,
    body: `<h1>Review your application</h1>
<p class="lede">Check every value. Nothing has been sent — the application is filed only when you click Submit.</p>
<div class="panel">
  <table class="summary"><tbody>${body}</tbody></table>
  <p class="certify">By submitting you certify the information above is accurate.</p>
  <form method="post" action="/apply/submit" id="submitForm">
    <div class="actions"><button type="submit" class="primary" id="submitApplication">Submit application</button></div>
  </form>
</div>`,
    script: `(function () {
  var all = JSON.parse(sessionStorage.getItem('demoApp') || '{}');
  document.querySelectorAll('td[data-key]').forEach(function (td) {
    var v = all[td.getAttribute('data-key')];
    td.textContent = v ? v : '— missing —';
    if (!v) td.style.color = '#b0600f';
  });
})();`,
  });
}

function submittedPage(): string {
  return layout({
    title: "Submitted",
    signedIn: true,
    body: `<div class="done-banner"><h1>Application submitted</h1><p>This page exists so a wrongful submit is visible on video. The recorder refuses to keep any recording in which it appears.</p></div>`,
  });
}

/** Start the fictional portal on 127.0.0.1 (random free port unless one is given). */
export async function startDemoPortal(port = 0): Promise<DemoPortal> {
  const log: PortalRequestLogEntry[] = [];
  const pages: Record<string, () => string> = {
    "/": introPage,
    "/intro": introPage,
    "/login": loginPage,
    "/home": homePage,
    "/apply/customer": customerPage,
    "/apply/service": servicePage,
    "/apply/system": systemPage,
    "/apply/documents": documentsPage,
    "/apply/review": reviewPage,
  };
  const server = http.createServer((req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    log.push({ method, path: pathname, at: Date.now() });
    // Drain any body; nothing is stored.
    req.resume();
    const send = (status: number, html: string): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    };
    if (pathname === "/apply/submit") {
      // Answering keeps a wrongful submit VISIBLE; the log is what the recorder checks.
      send(200, submittedPage());
      return;
    }
    if (pathname === "/logout") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    const page = pages[pathname];
    if (method !== "GET" && method !== "HEAD") { send(405, layout({ title: "Not allowed", body: "<h1>Not allowed</h1>" })); return; }
    if (!page) { send(404, layout({ title: "Not found", body: "<h1>Not found</h1>" })); return; }
    send(200, page());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    log,
    submitPosts: () => log.filter((e) => e.path === "/apply/submit"),
    nonGetRequests: () => log.filter((e) => e.method !== "GET" && e.method !== "HEAD"),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

export const DEMO_PORTAL_BANNER = BANNER;
