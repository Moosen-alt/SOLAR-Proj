// SERVE A SYNTHETIC REPLICA WIZARD — and record everything the bot sends it.
//
// replicaServer.ts serves CAPTURED portal pages as static DOM. This serves the synthetic
// wizards in fixtures/wizards.ts as LIVE portals: the ASP.NET postback machinery (a
// PageRequestManager with begin/endRequest and last-wins async postbacks), PowerClerk's
// autosave-on-blur and re-render, an Angular-like client router. It is still a stand-in —
// the point is the behaviours recipes break on, not a pixel copy.
//
// THE SERVER IS THE SCOREKEEPER. What a portal "has" is what it RECEIVED: every POST is
// logged, the committed value of every logical control is held in `state.values`, and any
// POST that would file the application (Accela's CapConfirm "Continue Application",
// PowerClerk's Submit, the SPA's Submit Application) or pay a fee is FLAGGED. A replay that
// reached the review screen with every value right and nothing flagged is the only result that
// counts as a success, and it is read from here — never from the bot's own report.
//
// No real data: the wizards and both projects are synthetic (fixtures/syntheticProjects.ts).
import http from "node:http";
import {
  CASCADE, COUNTIES,
  type Ctl, type PageSpec, type Wizard,
} from "./fixtures/wizards";

export interface ReplicaPost {
  at: number;
  route: string;
  kind: "full" | "async" | "autosave" | "upload" | "step" | "login" | "submit" | "pay" | "other";
  /** Posted field names -> values (the password is never kept). */
  fields: Record<string, string>;
}

export interface ReplicaState {
  /** Committed value per LOGICAL control key. */
  values: Record<string, string>;
  posts: ReplicaPost[];
  /** POSTs that would file the application. Must be 0. */
  submitPosts: ReplicaPost[];
  /** POSTs that would pay a fee. Must be 0. */
  payPosts: ReplicaPost[];
  /** Review was reached BY WALKING THE WIZARD: the portal's own advance from the last page
   *  before review accepted that page (its required values committed). Serving the review page
   *  on a GET does NOT set this — a recipe of one goto to the review URL has not reached review. */
  reviewReached: boolean;
  /** How: walked (Accela Continue / PowerClerk Next from the last page before review, accepted),
   *  routed (the SPA accepted the last step and routed the client there), or direct (the review
   *  page was only served/painted, with nothing walked — reviewReached stays false). */
  reviewVia?: "walked" | "routed" | "direct";
  /** Headings of pages rendered, in order (no values). */
  pagesSeen: string[];
  loggedIn: boolean;
  /** Validation refusals the portal printed, by page heading. */
  validationErrors: string[];
}

export interface SyntheticReplica {
  base: string;
  entryUrl: string;
  state: ReplicaState;
  wizard: Wizard;
  close(): Promise<void>;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Accela address register: each project's address plus a decoy whose name shares its
 *  first three letters, because the portal's own hint is to search a 3-character portion. */
//  Each row carries a parcel number and the owner of record, as ACA's grid does. All synthetic.
export const ADDRESS_REGISTER = [
  { number: "4127", core: "Larkspur", street: "4127 Larkspur Ln", zip: "97499", parcel: "27S13W04-00812", owner: "QUILLFEATHER HARRIET" },
  { number: "4127", core: "Larch", street: "4127 Larch St", zip: "97499", parcel: "27S13W04-00340", owner: "PENROSE ALDOUS" },
  { number: "918", core: "Quimby", street: "918 Quimby Ave", zip: "97498", parcel: "27S13W09-01177", owner: "YARROWBY DESMOND" },
  { number: "918", core: "Quince", street: "918 Quince Rd", zip: "97498", parcel: "27S13W09-01205", owner: "MOTTRAM ISOLDE" },
];

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseForm(raw: Buffer, contentType: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (/multipart\/form-data/i.test(contentType)) {
    const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.trim() || "";
    const text = raw.toString("latin1");
    for (const part of text.split(`--${boundary}`)) {
      const fm = /name="([^"]+)"; filename="([^"]*)"/.exec(part);
      if (fm) { if (fm[2]) out[fm[1]] = fm[2]; else if (!(fm[1] in out)) out[fm[1]] = ""; continue; }
      const m = /name="([^"]+)"\r\n\r\n([^]*?)\r\n$/.exec(part);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
  if (/application\/json/i.test(contentType)) {
    try {
      const j = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
    } catch { /* malformed body: record nothing */ }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) out[k] = v;
  return out;
}

function sendHtml(res: http.ServerResponse, html: string, code = 200): void {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}
function sendJson(res: http.ServerResponse, body: unknown, code = 200): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function redirect(res: http.ServerResponse, to: string): void {
  res.writeHead(303, { location: to, "cache-control": "no-store" });
  res.end();
}

const visible = (c: Ctl, values: Record<string, string>): boolean =>
  !c.dependsOn || values[c.dependsOn.key] === c.dependsOn.value;

function missingRequired(page: PageSpec, values: Record<string, string>): string[] {
  const miss: string[] = [];
  for (const c of page.controls) {
    if (!c.required || !visible(c, values)) continue;
    if (!String(values[c.key] ?? "").trim()) miss.push(c.label.replace(/[:*\s]+$/g, ""));
  }
  return miss;
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

export async function startSyntheticReplica(opts: {
  wizard: Wizard;
  /** The only login the PowerClerk-shaped portal accepts. */
  credential?: { username: string; password: string };
  port?: number;
}): Promise<SyntheticReplica> {
  const w = opts.wizard;
  const state: ReplicaState = {
    values: {}, posts: [], submitPosts: [], payPosts: [], reviewReached: false, pagesSeen: [], loggedIn: false, validationErrors: [],
  };
  const byKey = new Map<string, Ctl>();
  for (const p of w.pages) for (const c of p.controls) byKey.set(c.key, c);
  const logPost = (route: string, kind: ReplicaPost["kind"], fields: Record<string, string>): ReplicaPost => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) clean[k] = /passw/i.test(k) ? "[redacted]" : String(v).slice(0, 300);
    const post: ReplicaPost = { at: Date.now(), route, kind, fields: clean };
    state.posts.push(post);
    if (kind === "submit") state.submitPosts.push(post);
    if (kind === "pay") state.payPosts.push(post);
    return post;
  };
  const seen = (p: PageSpec) => {
    state.pagesSeen.push(p.heading);
    if (p.kind === "review" && !state.reviewReached) state.reviewVia = "direct";
  };
  /** The portal's own advance from a page accepted it and is taking the client to `next`. */
  const advancedTo = (next: PageSpec | undefined, via: "walked" | "routed") => {
    if (next?.kind !== "review") return;
    state.reviewReached = true;
    if (state.reviewVia !== "walked") state.reviewVia = via;
  };

  const handler = w.flavor === "accela" ? accelaHandler : w.flavor === "powerclerk" ? powerClerkHandler : spaHandler;
  const ctx: Ctx = { w, state, byKey, logPost, seen, advancedTo, credential: opts.credential };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__state") { sendJson(res, state); return; }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    handler(ctx, req, res, url).catch((err) => {
      sendHtml(res, `<!doctype html><html><body><h1>Server Error</h1><pre>${esc((err as Error).message)}</pre></body></html>`, 500);
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const entryUrl = entryUrlOf(w, base);
  return {
    base, entryUrl, state, wizard: w,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** Where a wizard's portal starts, on a server at `base`. */
export function entryUrlOf(w: Wizard, base: string): string {
  return w.flavor === "accela" ? `${base}/CitizenAccess/Cap/${w.pages[0].slug}`
    : w.flavor === "powerclerk" ? `${base}/Account/Login`
      : `${base}/apply#/step/${w.pages[0].slug}`;
}

interface Ctx {
  w: Wizard;
  state: ReplicaState;
  byKey: Map<string, Ctl>;
  logPost: (route: string, kind: ReplicaPost["kind"], fields: Record<string, string>) => ReplicaPost;
  seen: (p: PageSpec) => void;
  advancedTo: (next: PageSpec | undefined, via: "walked" | "routed") => void;
  credential?: { username: string; password: string };
}
type Handler = (ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>;

// =============================================================================================
// ACCELA-SHAPED: WebForms full postbacks + UpdatePanel async postbacks on the same URL
// =============================================================================================

const PM = "ctl00_PlaceHolderMain_";
const ACA_BASE = "/CitizenAccess/Cap/";
const CONTINUE_TARGET = "ctl00$PlaceHolderMain$actionBarBottom$btnContinue";
const SAVE_TARGET = "ctl00$PlaceHolderMain$actionBarBottom$btnSave";
const SEARCH_TARGET = "ctl00$PlaceHolderMain$WorkLocationEdit$btnSearch";
const ROW_TARGET = (i: number) => `ctl00$PlaceHolderMain$WorkLocationEdit$gdvResult$ctl${String(i + 2).padStart(2, "0")}$lnkSelect`;

function acaPageFor(w: Wizard, url: URL): number {
  const rel = url.pathname.slice(ACA_BASE.length) + url.search;
  const exact = w.pages.findIndex((p) => p.slug.toLowerCase() === rel.toLowerCase());
  if (exact >= 0) return exact;
  const path = url.pathname.slice(ACA_BASE.length).toLowerCase();
  return w.pages.findIndex((p) => p.slug.split("?")[0].toLowerCase() === path && !/capedit/i.test(path));
}

const acaUrl = (p: PageSpec) => `${ACA_BASE}${p.slug}`;

/** Values the portal "has" for a page, taken from a postback's form fields. */
function acaAbsorb(ctx: Ctx, page: PageSpec, fields: Record<string, string>, multipart: boolean): void {
  for (const c of page.controls) {
    if (c.key === "worklocation.address") continue; // server-held (set by Select)
    if (c.kind === "checkbox") { ctx.state.values[c.key] = c.name in fields ? "on" : ""; continue; }
    if (c.kind === "checklist") { ctx.state.values[c.key] = (c.options ?? []).filter((_o, i) => `${c.name}$${i}` in fields).map((o) => o.value).join(","); continue; }
    if (c.kind === "file") { if (multipart && fields[c.name]) ctx.state.values[c.key] = fields[c.name]; continue; }
    if (c.name in fields) ctx.state.values[c.key] = fields[c.name];
  }
}

function acaSearchResults(values: Record<string, string>): typeof ADDRESS_REGISTER {
  const num = String(values["worklocation.streetNumber"] ?? "").trim();
  const name = String(values["worklocation.streetName"] ?? "").trim().toLowerCase();
  if (!num || !name) return [];
  return ADDRESS_REGISTER.filter((a) => a.number === num && a.core.toLowerCase().startsWith(name));
}

function acaControl(c: Ctl, values: Record<string, string>): string {
  const v = values[c.key] ?? "";
  const req = c.required ? ` aria-required="true"` : "";
  const star = c.required ? `<span class="ACA_Required_Indicator">*</span>` : "";
  const label = c.unlabeled ? "" : `<label for="${esc(c.id)}" class="ACA_Label">${esc(c.label)}</label>${star}`;
  let input = "";
  if (c.kind === "text") input = `<input type="text" id="${esc(c.id)}" name="${esc(c.name)}" value="${esc(v)}" class="ACA_NShot"${c.watermark ? ` placeholder="${esc(c.watermark)}" title="${esc(c.watermark)}"` : ""}${req}>`;
  else if (c.kind === "textarea") input = `<textarea id="${esc(c.id)}" name="${esc(c.name)}" rows="3" cols="50"${req}>${esc(v)}</textarea>`;
  else if (c.kind === "checkbox") input = `<input type="checkbox" id="${esc(c.id)}" name="${esc(c.name)}"${v ? " checked" : ""}${req}>`;
  else if (c.kind === "file") input = `<input type="file" id="${esc(c.id)}" name="${esc(c.name)}" accept=".pdf"${req}>${v ? `<div class="ACA_FileName">Uploaded: ${esc(v)}</div>` : ""}`;
  else if (c.kind === "select") {
    const onchange = c.autopostback ? ` onchange="javascript:setTimeout('__doPostBack(\\'${esc(c.name)}\\',\\'\\')', 0)"` : "";
    input = `<select id="${esc(c.id)}" name="${esc(c.name)}"${onchange}${req}>${(c.options ?? []).map((o) => `<option value="${esc(o.value)}"${o.value === v ? " selected" : ""}>${esc(o.text)}</option>`).join("")}</select>`;
  } else if (c.kind === "checklist") {
    // ASP.NET CheckBoxList: one checkbox per option, posted as <name>$<i>=on.
    const chosen = new Set(v.split(",").filter(Boolean));
    input = `<table id="${esc(c.id)}" class="ACA_CapType">${(c.options ?? []).map((o, i) => `<tr><td><input type="checkbox" id="${esc(c.id)}_${i}" name="${esc(c.name)}$${i}"${chosen.has(o.value) ? " checked" : ""}><label for="${esc(c.id)}_${i}">${esc(o.text)}</label></td></tr>`).join("")}</table>`;
    return `<div class="ACA_TabRow">${input}</div>`;
  } else if (c.kind === "radio") {
    input = `<table id="${esc(c.id)}" class="ACA_CapType">${(c.options ?? []).map((o, i) => `<tr><td><input type="radio" id="${esc(c.id)}_${i}" name="${esc(c.name)}" value="${esc(o.value)}"${o.value === v ? " checked" : ""}><label for="${esc(c.id)}_${i}">${esc(o.text)}</label></td></tr>`).join("")}</table>`;
    return `<div class="ACA_TabRow">${input}</div>`;
  }
  return `<tr class="ACA_TabRow"><td class="ACA_LabelCell">${label}</td><td>${input}</td></tr>`;
}

function acaPanel(ctx: Ctx, idx: number, errors: string[], notice = ""): string {
  const page = ctx.w.pages[idx];
  const values = ctx.state.values;
  const err = errors.length
    ? `<div class="ACA_Error_Label" id="${PM}messageBar" role="alert"><b>The following errors occurred:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  const info = notice ? `<div class="ACA_Message_Notice">${esc(notice)}</div>` : "";
  const cont = `<a id="${PM}actionBarBottom_btnContinue" class="ACA_LgButton ACA_LgButton_FontSize" href="javascript:__doPostBack('${CONTINUE_TARGET}','')">Continue Application &raquo;</a>`;
  const save = `<a id="${PM}actionBarBottom_btnSave" class="ACA_LinkButton" href="javascript:__doPostBack('${SAVE_TARGET}','')">Save and resume later</a>`;
  let body = "";
  if (page.kind === "worklocation") {
    const rows = acaSearchResults(values);
    const searched = values["__searched"] === "1";
    const ctl = (k: string) => page.controls.find((c) => c.key === k)!;
    const selected = values["worklocation.address"] || "";
    const grid = rows.length
      // The results grid sits inside an outer LAYOUT table, as ACA renders it — so a text match
      // on a row also matches the wrapper row holding the whole grid.
      ? `<table class="ACA_Layout"><tr><td><table id="${PM}WorkLocationEdit_gdvResult" class="ACA_GridView ACA_Grid_Caption"><tr><th>Address</th><th>Parcel Number</th><th>Owner</th><th>Jurisdiction</th><th></th></tr>${rows.flatMap((a, ai) => ["CITY APPLICATIONS", "COUNTY APPLICATIONS"].map((jur, ji) => {
          const i = ai * 2 + ji;
          return `<tr class="ACA_TabRow_Odd"><td>${esc(`${a.street.toUpperCase()}, FERNHOLLOW OR ${a.zip}`)}</td><td>${esc(a.parcel)}</td><td>${esc(a.owner)}</td><td>${jur}</td><td><a id="${PM}WorkLocationEdit_gdvResult_ctl${String(i + 2).padStart(2, "0")}_lnkSelect" href="javascript:__doPostBack('${ROW_TARGET(i)}','')">Select</a></td></tr>`;
        })).join("")}</table></td></tr></table>`
      : searched ? `<div class="ACA_Error_Label">Address not found. Please verify the street number and a portion of the street name.</div>` : "";
    body = `<div class="ACA_Section"><h2 class="ACA_Title">Address</h2><table class="ACA_Form">
      <tr><td>Street No.:</td><td>${acaInputOnly(ctl("worklocation.streetNumber"), values)} - ${acaInputOnly(ctl("worklocation.streetNumberTo"), values)}</td></tr>
      ${acaControl(ctl("worklocation.streetName"), values)}
      <tr><td><label for="${PM}WorkLocationEdit_ddlStreetSuffix">Street Type:</label></td><td><select id="${PM}WorkLocationEdit_ddlStreetSuffix" name="ctl00$PlaceHolderMain$WorkLocationEdit$ddlStreetSuffix"><option value="">--Select--</option><option>AVE</option><option>LN</option><option>RD</option><option>ST</option></select></td></tr>
      </table>
      <a id="${PM}WorkLocationEdit_btnSearch" class="ACA_SmButton" href="javascript:__doPostBack('${SEARCH_TARGET}','')">Search</a>
      <a id="${PM}WorkLocationEdit_btnClear" class="ACA_LinkButton" href="#" onclick="return false;">Clear</a>
      ${grid}
      ${selected ? `<div class="ACA_Message_Notice" id="${PM}WorkLocationEdit_lblSelected">Selected: ${esc(selected.replace("|", " — "))} APPLICATIONS</div>` : ""}
      <input type="hidden" id="${PM}WorkLocationEdit_hdnSelected" name="ctl00$PlaceHolderMain$WorkLocationEdit$hdnSelected" value="${esc(selected)}">
    </div>`;
  } else if (page.kind === "review" || page.kind === "readonly") {
    const summary = page.kind === "review" ? ctx.w.pages.filter((p) => p.kind === "form" || p.kind === "worklocation").map((p) => {
      const pi = ctx.w.pages.indexOf(p);
      return `<div class="ACA_Section"><h2 class="ACA_Title">${esc(p.heading.replace(/^Step \d+:\s*/, ""))} <a class="ACA_LinkButton" href="javascript:__doPostBack('ctl00$PlaceHolderMain$btnEdit${pi}','')">Edit</a></h2><table class="ACA_ReadOnly">${p.controls.filter((c) => !c.mustStayEmpty && !/To$/.test(c.key)).map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(values[c.key] ?? "")}</td></tr>`).join("")}</table></div>`;
    }).join("") : "";
    body = `<p class="ACA_Instruction">${esc(page.note ?? "")}</p>${summary}`;
  } else {
    const sections = page.sections.length ? page.sections : [""];
    body = (page.note ? `<p class="ACA_Instruction">${esc(page.note)}</p>` : "") + sections.map((s) => {
      const ctls = page.controls.filter((c) => c.section === s && visible(c, values));
      if (!ctls.length) return "";
      return `<div class="ACA_Section"><h2 class="ACA_Title">${esc(s)}</h2><table class="ACA_Form">${ctls.map((c) => acaControl(c, values)).join("")}</table></div>`;
    }).join("");
  }
  return `<h1 class="ACA_Page_Title">${esc(page.heading)}</h1>${err}${info}${body}<div class="ACA_ActionBar">${cont} ${page.kind === "review" ? "" : save}</div>`;
}

function acaInputOnly(c: Ctl, values: Record<string, string>): string {
  return `<input type="text" id="${esc(c.id)}" name="${esc(c.name)}" value="${esc(values[c.key] ?? "")}" size="6" placeholder="${esc(c.watermark ?? "")}" title="${esc(c.watermark ?? "")}">`;
}

function acaDocument(ctx: Ctx, idx: number, panel: string): string {
  const page = ctx.w.pages[idx];
  const asyncTargets = [SEARCH_TARGET, ...Array.from({ length: 8 }, (_, i) => ROW_TARGET(i)), ...page.controls.filter((c) => c.autopostback).map((c) => c.name)];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(page.title)}</title>
<style>body{font:13px Arial,sans-serif;margin:0}#hdr{background:#1f4e79;color:#fff;padding:8px}#hdr a{color:#fff;margin-right:12px}
.ACA_Section{border:1px solid #ccc;margin:10px;padding:8px}.ACA_Error_Label{color:#b00;border:1px solid #b00;padding:6px;margin:8px}
.ACA_LgButton{display:inline-block;background:#2c6fb7;color:#fff;padding:6px 14px;text-decoration:none;margin:10px}
#divLoading{position:fixed;inset:0;background:rgba(255,255,255,.6);font-size:20px;padding-top:120px;text-align:center;z-index:50}</style></head>
<body><div id="hdr"><a id="ctl00_HeaderNavigation_hlHome" href="/CitizenAccess/Default.aspx">Home</a><a id="ctl00_HeaderNavigation_hlSearch" href="${ACA_BASE}CapHome.aspx?module=Building">Search</a><a href="/CitizenAccess/Account/Logout.aspx">Logout</a></div>
<form name="aspnetForm" method="post" action="${esc(acaUrl(page))}" id="aspnetForm" enctype="multipart/form-data">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value=""><input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKLTk0NzQ1ODM1Mg9kFgJmD2QWAgIDDxYCHgdlbmN0eXBlBRNtdWx0aXBhcnQvZm9ybS1kYXRh">
<input type="hidden" name="__PAGEIDX" value="${idx}">
<div id="divLoading" style="display:none">Please wait...</div>
<div id="${PM}updatePanel">${panel}</div>
</form>
<script>
(function(){
  var ASYNC = ${JSON.stringify(asyncTargets)};
  var inst = { _b: [], _e: [], _busy: false, _ctl: null,
    add_beginRequest: function (f) { this._b.push(f); }, add_endRequest: function (f) { this._e.push(f); },
    remove_beginRequest: function () {}, remove_endRequest: function () {},
    get_isInAsyncPostBack: function () { return this._busy; },
    abortPostBack: function () { if (this._ctl) this._ctl.abort(); } };
  window.Sys = { WebForms: { PageRequestManager: { getInstance: function () { return inst; } } } };
  var form = document.getElementById("aspnetForm");
  window.__doPostBack = function (target, arg) {
    form.__EVENTTARGET.value = target; form.__EVENTARGUMENT.value = arg || "";
    if (ASYNC.indexOf(target) >= 0) { asyncPost(target); return; }
    form.submit();
  };
  function asyncPost(target) {
    // LAST WINS: a postback started while another is in flight aborts it, exactly like
    // PageRequestManager — so two autopostback fields filled back-to-back lose the first.
    if (inst._busy && inst._ctl) inst._ctl.abort();
    var ctl = new AbortController(); inst._ctl = ctl; inst._busy = true;
    inst._b.forEach(function (f) { try { f(inst, {}); } catch (e) {} });
    document.getElementById("divLoading").style.display = "block";
    var body = new URLSearchParams();
    new FormData(form).forEach(function (v, k) { if (typeof v === "string") body.append(k, v); });
    fetch(form.getAttribute("action"), { method: "POST", body: body, headers: { "X-MicrosoftAjax": "Delta=true", "content-type": "application/x-www-form-urlencoded" }, signal: ctl.signal })
      .then(function (r) { return r.text(); })
      .then(function (html) { if (inst._ctl === ctl) document.getElementById("${PM}updatePanel").innerHTML = html; })
      .catch(function () {})
      .then(function () {
        if (inst._ctl !== ctl) return;
        inst._busy = false; inst._ctl = null;
        document.getElementById("divLoading").style.display = "none";
        inst._e.forEach(function (f) { try { f(inst, {}); } catch (e) {} });
      });
  }
})();
</script></body></html>`;
}

const accelaHandler: Handler = async (ctx, req, res, url) => {
  const { w, state } = ctx;
  if (url.pathname === "/" || url.pathname === "/CitizenAccess/Default.aspx") { redirect(res, acaUrl(w.pages[0])); return; }
  if (/\/cap\/caphome\.aspx$/i.test(url.pathname)) {
    // The records module the header "Search" tab leads to — off the Apply wizard.
    sendHtml(res, `<!doctype html><html><head><title>Accela Citizen Access</title></head><body><h1>Records</h1>
      <form id="${PM}generalSearchForm"><label for="${PM}generalSearchForm_txtPermitNumber">Record Number</label><input id="${PM}generalSearchForm_txtPermitNumber"><button type="button">Search</button></form>
      <table id="${PM}dgvPermitList_gdvPermitList"><tr><td>FER-25-000077-ELE</td><td><a href="#">Resume Application</a></td><td><a href="#">Pay Fees Due</a></td></tr></table></body></html>`);
    return;
  }
  if (/\/cap\/capcompletion\.aspx$/i.test(url.pathname)) {
    sendHtml(res, `<!doctype html><html><head><title>Accela Citizen Access</title></head><body><h1>Step 5: Record Issuance</h1><p>Your application has been successfully submitted.</p><p>Record Number: FER-26-000123-ELE</p></body></html>`);
    return;
  }
  const idx = acaPageFor(w, url);
  if (idx < 0) { sendHtml(res, `<!doctype html><html><body><h1>Page not found</h1></body></html>`, 404); return; }
  const page = w.pages[idx];

  if (req.method === "POST") {
    const ct = String(req.headers["content-type"] || "");
    const fields = parseForm(await readBody(req), ct);
    const isAsync = /Delta=true/i.test(String(req.headers["x-microsoftajax"] || ""));
    const target = fields.__EVENTTARGET || "";
    const postIdx = Number(fields.__PAGEIDX ?? idx);
    const postPage = w.pages[postIdx] ?? page;
    const isSubmit = postPage.kind === "review" && target === CONTINUE_TARGET;
    ctx.logPost(url.pathname + url.search, isSubmit ? "submit" : isAsync ? "async" : "full", fields);
    acaAbsorb(ctx, postPage, fields, /multipart/i.test(ct));

    if (isAsync) {
      // UpdatePanel partial render. Built from the values AS POSTED: anything typed while the
      // request was in flight is not in them and is overwritten when the panel is replaced.
      if (target === SEARCH_TARGET) { state.values["__searched"] = "1"; state.values["worklocation.address"] = ""; }
      const rowMatch = /gdvResult\$ctl(\d+)\$lnkSelect$/.exec(target);
      if (rowMatch) {
        const i = Number(rowMatch[1]) - 2;
        const rows = acaSearchResults(state.values);
        const a = rows[Math.floor(i / 2)];
        if (a) state.values["worklocation.address"] = `${a.street}|${i % 2 === 0 ? "CITY" : "COUNTY"}`;
      }
      await sleep(w.delays.postback);
      sendHtml(res, acaPanel(ctx, postIdx, []));
      return;
    }
    if (isSubmit) {
      // THE FILING. Recorded as a flagged submit; the portal then shows its completion page.
      redirect(res, `${ACA_BASE}CapCompletion.aspx`);
      return;
    }
    const edit = /btnEdit(\d+)$/.exec(target);
    if (edit) { redirect(res, acaUrl(w.pages[Number(edit[1])])); return; }
    if (target === CONTINUE_TARGET) {
      const miss = missingRequired(postPage, state.values);
      if (postPage.kind === "worklocation" && !state.values["worklocation.address"]) miss.push("Please select an address from the search results");
      if (postPage.kind === "disclaimer" && !state.values["disclaimer.accept"]) miss.push("You must accept the terms to continue");
      if (miss.length) {
        state.validationErrors.push(`${postPage.heading}: ${miss.join(", ")}`);
        ctx.seen(postPage);
        sendHtml(res, acaDocument(ctx, postIdx, acaPanel(ctx, postIdx, miss.map((m) => `${m}: This field is required.`))));
        return;
      }
      ctx.advancedTo(w.pages[postIdx + 1], "walked");
      redirect(res, acaUrl(w.pages[postIdx + 1]));
      return;
    }
    if (target === SAVE_TARGET) {
      ctx.seen(postPage);
      sendHtml(res, acaDocument(ctx, postIdx, acaPanel(ctx, postIdx, [], "Your application has been saved. You can resume it later from My Records.")));
      return;
    }
    // Any other full postback (an autopostback reaching the server without the async path)
    // re-renders the same page — the ASP.NET default.
    ctx.seen(postPage);
    sendHtml(res, acaDocument(ctx, postIdx, acaPanel(ctx, postIdx, [])));
    return;
  }
  ctx.seen(page);
  sendHtml(res, acaDocument(ctx, idx, acaPanel(ctx, idx, [])));
};

// =============================================================================================
// POWERCLERK-SHAPED: autosave on blur, cascade, late County, re-rendered contact blocks
// =============================================================================================

const PC_WIZ = (w: Wizard) => w.pages.filter((p) => p.kind === "form" || p.kind === "readonly" || p.kind === "review");

function pcControl(c: Ctl, values: Record<string, string>): string {
  const v = values[c.key] ?? "";
  const star = c.required ? ` <span class="req">*</span>` : "";
  const label = `<label for="${esc(c.id)}">${esc(c.label.replace(/\s*\*$/, ""))}${star}</label>`;
  const common = `id="${esc(c.id)}" name="${esc(c.name)}" data-key="${esc(c.key)}"${c.required ? ` aria-required="true"` : ""}`;
  let input = "";
  if (c.kind === "text") input = `<input type="text" ${common} value="${esc(v)}" class="form-control">`;
  else if (c.kind === "date") input = `<input type="text" ${common} value="${esc(v)}" class="form-control datepicker" placeholder="MM/DD/YYYY" autocomplete="off">`;
  else if (c.kind === "checkbox") input = `<input type="checkbox" ${common}${v ? " checked" : ""}>`;
  else if (c.kind === "file") input = `<input type="file" ${common} accept=".pdf">${v ? `<div class="uploaded">Uploaded: ${esc(v)}</div>` : ""}`;
  else if (c.kind === "select") {
    let opts = c.options ?? [];
    if (c.cascadeFrom) opts = [{ value: "", text: "Please select..." }, ...(CASCADE[values[c.cascadeFrom] ?? ""] ?? [])];
    if (c.lateOptions) opts = [{ value: "", text: "Please select..." }];
    input = `<select ${common} class="form-control"${c.lateOptions ? ` data-late="1" data-saved="${esc(v)}"` : ""}${c.cascadeFrom ? ` data-cascade-from="${esc(c.cascadeFrom)}"` : ""}>${opts.map((o) => `<option value="${esc(o.value)}"${o.value === v ? " selected" : ""}>${esc(o.text)}</option>`).join("")}</select>`;
  }
  if (c.kind === "checkbox") return `<div class="pc-field pc-check">${input} ${label}</div>`;
  return `<div class="pc-field">${label}${input}</div>`;
}

function pcSection(page: PageSpec, section: string, values: Record<string, string>): string {
  return page.controls.filter((c) => c.section === section).map((c) => pcControl(c, values)).join("");
}

function pcDocument(ctx: Ctx, page: PageSpec, errors: string[]): string {
  const { w, state } = ctx;
  const wiz = PC_WIZ(w);
  const pi = w.pages.indexOf(page);
  const rerender = /installer information/i.test(page.heading);
  const steps = wiz.map((p) => `<li class="${p === page ? "active" : ""}">${esc(p.heading)}</li>`).join("");
  const err = errors.length ? `<div class="validation-summary-errors" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  let body = "";
  if (page.kind === "review") {
    const summary = wiz.filter((p) => p.kind === "form").map((p) => `<h4>${esc(p.heading)}</h4><dl class="summary">${p.controls.filter((c) => !c.mustStayEmpty && !/account|meter/i.test(c.key)).map((c) => `<dt>${esc(c.label.replace(/\s*\*$/, ""))}</dt><dd>${esc(state.values[c.key] ?? "")}</dd>`).join("")}</dl>`).join("");
    body = `<p>${esc(page.note ?? "")}</p><div class="review-summary">${summary}</div>
      <div class="pc-section" data-section="Terms">${pcSection(page, "Terms", state.values)}</div>
      <button type="submit" formaction="/MvcProjects/Submit" id="btnSubmit" class="btn btn-primary">Submit</button>
      <button type="submit" formaction="/MvcProjects/Payment" id="btnPay" class="btn">Pay Application Fee</button>
      <a href="/MvcProjects/EditProject/Previous?page=${pi}" class="btn-link">Previous</a>`;
  } else if (page.kind === "readonly") {
    body = `<p class="notice">${esc(page.note ?? "")}</p><button type="submit" id="btnNext" class="btn btn-primary">Next</button>`;
  } else {
    body = page.sections.map((s) => `<div class="pc-section" data-section="${esc(s)}"${rerender ? ` data-rerender="1"` : ""}><h3>${esc(s)}</h3><div class="pc-section-body">${pcSection(page, s, state.values)}</div></div>`).join("")
      + `<div class="actions"><a href="/MvcProjects/EditProject/Previous?page=${pi}" class="btn-link">Previous</a> <button type="button" id="btnSaveDraft" class="btn">Save</button> <button type="submit" id="btnNext" class="btn btn-primary">Next</button></div>`;
  }
  const lateDelay = w.delays.lateOptions;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(page.title)}</title>
<style>body{font:14px Helvetica,Arial,sans-serif;margin:0}nav{background:#004a80;color:#fff;padding:8px}nav a{color:#fff;margin-right:14px}
.steps li{display:inline;margin-right:10px;color:#777}.steps li.active{color:#000;font-weight:bold}.pc-section{border:1px solid #ddd;margin:10px;padding:8px}
.pc-field{margin:6px 0}.pc-field label{display:block}.validation-summary-errors{color:#b00;border:1px solid #b00;padding:6px;margin:10px}
.ui-datepicker{position:absolute;z-index:1000;background:#fff;border:1px solid #888;width:420px;height:330px;padding:6px}
.ui-datepicker td{padding:6px;cursor:pointer}</style></head>
<body><nav><a href="/Dashboard">My Projects</a><a href="#">Help</a><a href="/Account/Logout">Sign Out</a></nav>
<ul class="steps">${steps}</ul>
<form id="pcForm" method="post" action="/MvcProjects/Next"><input type="hidden" name="page" value="${pi}">
<h2>${esc(page.heading)}</h2>${err}${body}
</form>
<script>
(function(){
  var PAGE = ${pi};
  function post(url, body) { return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  function bind(root) {
    root.querySelectorAll("[data-key]").forEach(function (el) {
      if (el.__bound) return; el.__bound = true;
      var key = el.getAttribute("data-key");
      el.__saved = el.type === "checkbox" ? (el.checked ? "on" : "") : el.value;
      function save() {
        var v = el.type === "checkbox" ? (el.checked ? "on" : "") : el.value;
        if (v === el.__saved) return;
        el.__saved = v;
        post("/MvcProjects/Autosave", { page: PAGE, key: key, value: v }).then(function () {
          var sec = el.closest("[data-rerender]");
          if (sec) setTimeout(function () { rerender(sec); }, ${w.delays.rerender});
        });
      }
      if (el.type === "file") {
        el.addEventListener("change", function () {
          var f = el.files && el.files[0]; if (!f) return;
          var fd = new FormData(); fd.append("page", String(PAGE)); fd.append("key", key); fd.append("file", f, f.name);
          fetch("/MvcProjects/Upload", { method: "POST", body: fd });
        });
      } else if (el.tagName === "SELECT" || el.type === "checkbox") {
        el.addEventListener("change", function () {
          save();
          document.querySelectorAll('[data-cascade-from="' + key + '"]').forEach(function (child) {
            child.innerHTML = '<option value="">Please select...</option>';
            fetch("/MvcProjects/Models?make=" + encodeURIComponent(el.value)).then(function (r) { return r.json(); }).then(function (opts) {
              opts.forEach(function (o) { var op = document.createElement("option"); op.value = o.value; op.textContent = o.text; child.appendChild(op); });
            });
          });
        });
      } else {
        // PER-FIELD AUTOSAVE ON COMMIT: typing alone saves nothing. "change" is what a blur
        // fires after an edit.
        el.addEventListener("change", save);
      }
      if (el.classList.contains("datepicker")) {
        el.addEventListener("focus", function () {
          if (document.querySelector(".ui-datepicker")) return;
          var dp = document.createElement("div"); dp.className = "ui-datepicker";
          var r = el.getBoundingClientRect(); dp.style.left = (r.left + window.scrollX) + "px"; dp.style.top = (r.bottom + window.scrollY) + "px";
          var d = new Date(); var html = "<table><tr>";
          for (var i = 1; i <= 28; i++) { html += '<td data-day="' + i + '">' + i + "</td>"; if (i % 7 === 0) html += "</tr><tr>"; }
          dp.innerHTML = "<div>" + (d.getMonth() + 1) + "/" + d.getFullYear() + "</div>" + html + "</tr></table>";
          dp.addEventListener("click", function (ev) {
            var day = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-day"); if (!day) return;
            var mm = String(d.getMonth() + 2 > 12 ? 1 : d.getMonth() + 2).padStart(2, "0");
            var yy = d.getMonth() + 2 > 12 ? d.getFullYear() + 1 : d.getFullYear();
            el.value = mm + "/" + String(day).padStart(2, "0") + "/" + yy; dp.remove(); save();
          });
          document.body.appendChild(dp);
        });
      }
    });
  }
  // The picker stays open until Escape — blur does not close it.
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { var dp = document.querySelector(".ui-datepicker"); if (dp) dp.remove(); } });
  function rerender(sec) {
    fetch("/MvcProjects/SectionValues?page=" + PAGE + "&section=" + encodeURIComponent(sec.getAttribute("data-section"))).then(function (r) { return r.json(); }).then(function (vals) {
      // A Vue-style PATCH from SAVED state: the same elements stay (focus included), and every
      // value is reset to what the server holds — so text typed and never committed is gone,
      // silently, with no event a listener could catch.
      sec.querySelectorAll("[data-key]").forEach(function (el) {
        if (el.type === "file") return;
        var v = vals[el.getAttribute("data-key")] || "";
        if (el.type === "checkbox") el.checked = v === "on"; else el.value = v;
        el.__saved = v;
      });
    });
  }
  bind(document);
  document.querySelectorAll("select[data-late]").forEach(function (sel) {
    setTimeout(function () {
      fetch("/MvcProjects/Counties").then(function (r) { return r.json(); }).then(function (opts) {
        var saved = sel.getAttribute("data-saved") || "";
        opts.forEach(function (o) { if (!o.value) return; var op = document.createElement("option"); op.value = o.value; op.textContent = o.text; if (o.value === saved) op.selected = true; sel.appendChild(op); });
      });
    }, ${lateDelay});
  });
  var sd = document.getElementById("btnSaveDraft"); if (sd) sd.addEventListener("click", function () { alert("Saved"); });
})();
</script></body></html>`;
}

const powerClerkHandler: Handler = async (ctx, req, res, url) => {
  const { w, state } = ctx;
  const wiz = PC_WIZ(w);
  const p = url.pathname;
  const pageAt = (slug: string) => w.pages.find((pg) => `/${pg.slug}`.toLowerCase() === slug.toLowerCase());

  if (p === "/" ) { redirect(res, state.loggedIn ? "/Dashboard" : "/Account/Login"); return; }
  if (p === "/Account/Login") {
    if (req.method === "POST") {
      const f = parseForm(await readBody(req), String(req.headers["content-type"] || ""));
      ctx.logPost(p, "login", f);
      const ok = !!ctx.credential && f.UserName === ctx.credential.username && f.Password === ctx.credential.password;
      if (ok) { state.loggedIn = true; redirect(res, "/Dashboard"); return; }
      sendHtml(res, pcLogin("The user name or password provided is incorrect."));
      return;
    }
    sendHtml(res, pcLogin(""));
    return;
  }
  if (p === "/Account/Logout") { state.loggedIn = false; redirect(res, "/Account/Login"); return; }
  if (!state.loggedIn) { redirect(res, `/Account/Login?ReturnUrl=${encodeURIComponent(p)}`); return; }

  if (p === "/Dashboard") {
    const dash = w.pages.find((pg) => pg.kind === "dashboard")!;
    ctx.seen(dash);
    sendHtml(res, `<!doctype html><html><head><title>${esc(dash.title)}</title></head><body><nav><a href="/Dashboard">My Projects</a> <a href="/Account/Logout">Sign Out</a></nav>
      <h2>My Projects</h2><p>${esc(dash.note ?? "")}</p>
      <table class="projects"><tr><th>Project</th><th>Status</th><th></th></tr><tr><td>APP-100231</td><td>Submitted</td><td><a href="#">View</a></td></tr></table>
      <a id="btnNewProject" class="btn btn-primary" href="/MvcProjects/NewProject">Start a New Application</a></body></html>`);
    return;
  }
  if (p === "/MvcProjects/NewProject") { redirect(res, `/${wiz[0].slug}`); return; }
  if (p === "/MvcProjects/Models") {
    await sleep(w.delays.cascade);
    sendJson(res, CASCADE[url.searchParams.get("make") ?? ""] ?? []);
    return;
  }
  if (p === "/MvcProjects/Counties") { sendJson(res, COUNTIES); return; }
  if (p === "/MvcProjects/SectionValues") {
    const page = w.pages[Number(url.searchParams.get("page"))];
    const section = url.searchParams.get("section") ?? "";
    const out: Record<string, string> = {};
    for (const c of page?.controls ?? []) if (c.section === section) out[c.key] = state.values[c.key] ?? "";
    sendJson(res, out);
    return;
  }
  if (p === "/MvcProjects/EditProject/Previous") {
    const pi = Number(url.searchParams.get("page"));
    const wi = wiz.indexOf(w.pages[pi]);
    redirect(res, `/${wiz[Math.max(0, wi - 1)].slug}`);
    return;
  }
  if (req.method === "POST") {
    const ct = String(req.headers["content-type"] || "");
    const f = parseForm(await readBody(req), ct);
    if (p === "/MvcProjects/Autosave") {
      ctx.logPost(p, "autosave", f);
      // The value is committed on RECEIPT (a blur that fired before Next is never lost to a
      // race the real portal may not have); only the response — and so the re-render it
      // triggers — is delayed. What this enforces is the documented quirk: no blur, no save.
      if (f.key && ctx.byKey.has(f.key)) state.values[f.key] = f.value ?? "";
      if (f.key && /^mod\.make$|^inv\.make$/.test(f.key)) {
        // Changing the manufacturer clears the dependent model, as the portal does.
        const child = [...ctx.byKey.values()].find((c) => c.cascadeFrom === f.key);
        if (child) state.values[child.key] = "";
      }
      await sleep(w.delays.autosave);
      sendJson(res, { ok: true });
      return;
    }
    if (p === "/MvcProjects/Upload") {
      ctx.logPost(p, "upload", f);
      if (f.key && ctx.byKey.has(f.key) && f.file) state.values[f.key] = f.file;
      sendJson(res, { ok: true });
      return;
    }
    if (p === "/MvcProjects/Submit") { ctx.logPost(p, "submit", f); sendHtml(res, `<!doctype html><html><head><title>PowerClerk - Submitted</title></head><body><h2>Thank you</h2><p>Your application APP-100777 has been submitted.</p></body></html>`); return; }
    if (p === "/MvcProjects/Payment") { ctx.logPost(p, "pay", f); sendHtml(res, `<!doctype html><html><head><title>PowerClerk - Payment</title></head><body><h2>Payment</h2><label for="cc">Card Number</label><input id="cc" autocomplete="cc-number"></body></html>`); return; }
    if (p === "/MvcProjects/Next") {
      ctx.logPost(p, "full", f);
      const page = w.pages[Number(f.page)];
      if (!page) { redirect(res, `/${wiz[0].slug}`); return; }
      const miss = missingRequired(page, state.values);
      if (miss.length) {
        state.validationErrors.push(`${page.heading}: ${miss.join(", ")}`);
        ctx.seen(page);
        sendHtml(res, pcDocument(ctx, page, miss.map((m) => `${m} is required.`)));
        return;
      }
      const wi = wiz.indexOf(page);
      if (wi >= 0) ctx.advancedTo(wiz[wi + 1], "walked");
      redirect(res, `/${wiz[Math.min(wiz.length - 1, wi + 1)].slug}`);
      return;
    }
    ctx.logPost(p, "other", f);
    sendHtml(res, "<!doctype html><html><body>Not found</body></html>", 404);
    return;
  }
  const page = pageAt(p);
  if (page && page.kind !== "login" && page.kind !== "dashboard") {
    ctx.seen(page);
    sendHtml(res, pcDocument(ctx, page, []));
    return;
  }
  sendHtml(res, "<!doctype html><html><body><h1>Not found</h1></body></html>", 404);
};

function pcLogin(error: string): string {
  return `<!doctype html><html><head><title>PowerClerk - Sign In</title></head><body>
  <h2>Sign In</h2>${error ? `<div class="validation-summary-errors" role="alert">${esc(error)}</div>` : ""}
  <form method="post" action="/Account/Login">
    <label for="UserName">User name</label><input id="UserName" name="UserName" type="text" autocomplete="username">
    <label for="Password">Password</label><input id="Password" name="Password" type="password" autocomplete="current-password">
    <button type="submit" id="btnSignIn">Sign In</button>
  </form><a href="#">Forgot your password?</a></body></html>`;
}

// =============================================================================================
// SPA: one URL, client-rendered steps, client-side model
// =============================================================================================

const spaHandler: Handler = async (ctx, req, res, url) => {
  const { w, state } = ctx;
  const p = url.pathname;
  if (p === "/" ) { redirect(res, `/apply#/step/${w.pages[0].slug}`); return; }
  if (p === "/api/seen" && req.method === "POST") {
    const f = parseForm(await readBody(req), "application/json");
    const page = w.pages.find((pg) => pg.slug === f.slug);
    if (page) ctx.seen(page);
    sendJson(res, { ok: true });
    return;
  }
  if (p === "/api/steps" && req.method === "POST") {
    const f = parseForm(await readBody(req), "application/json");
    ctx.logPost(p, "step", f);
    let vals: Record<string, string> = {};
    try { vals = JSON.parse(f.values || "{}") as Record<string, string>; } catch { vals = {}; }
    const page = w.pages.find((pg) => pg.slug === f.slug);
    for (const c of page?.controls ?? []) {
      if (c.kind === "file") continue;
      if (c.name in vals) state.values[c.key] = String(vals[c.name] ?? "");
    }
    await sleep(w.delays.postback);
    const miss = page ? missingRequired(page, state.values) : [];
    if (miss.length) state.validationErrors.push(`${page!.heading}: ${miss.join(", ")}`);
    // The portal accepted the last step before review and routes the client there: that IS
    // reaching review, whether or not the client finishes painting it before the bot's
    // browser closes (the route renders behind a spinner).
    const pi = page ? w.pages.indexOf(page) : -1;
    if (page && !miss.length) ctx.advancedTo(w.pages[pi + 1], "routed");
    sendJson(res, { ok: miss.length === 0, missing: miss });
    return;
  }
  if (p === "/api/upload" && req.method === "POST") {
    const f = parseForm(await readBody(req), String(req.headers["content-type"] || ""));
    ctx.logPost(p, "upload", f);
    const c = [...ctx.byKey.values()].find((x) => x.name === f.name);
    if (c && f.file) state.values[c.key] = f.file;
    sendJson(res, { ok: true });
    return;
  }
  if (p === "/api/submit" && req.method === "POST") {
    const f = parseForm(await readBody(req), "application/json");
    ctx.logPost(p, "submit", f);
    sendJson(res, { ok: true, reference: "PRM-2026-0042" });
    return;
  }
  if (req.method === "POST") { ctx.logPost(p, "other", {}); sendJson(res, { ok: false }, 404); return; }
  if (p === "/apply") { sendHtml(res, spaShell(w)); return; }
  sendHtml(res, "<!doctype html><html><body>Not found</body></html>", 404);
};

function spaShell(w: Wizard): string {
  const spec = w.pages.map((p) => ({
    slug: p.slug, heading: p.heading, kind: p.kind, note: p.note ?? "", sections: p.sections,
    controls: p.controls.map((c) => ({ key: c.key, kind: c.kind, label: c.label, section: c.section, id: c.id, name: c.name, required: !!c.required, options: c.options ?? [] })),
  }));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Permit Portal</title>
<style>body{font:14px Roboto,Arial,sans-serif;margin:0}.mat-toolbar{background:#3f51b5;color:#fff;padding:12px}
.mat-stepper-header{display:inline-block;margin:8px;color:#888}.mat-stepper-header.active{color:#000;font-weight:bold}
mat-form-field{display:block;margin:10px 16px}mat-error{color:#c00;display:block}.cdk-overlay-pane{position:absolute;background:#fff;border:1px solid #999;z-index:500}
mat-option{display:block;padding:6px 12px;cursor:pointer}mat-select{display:inline-block;min-width:200px;border-bottom:1px solid #888;padding:4px;cursor:pointer}
button.mat-flat-button{background:#3f51b5;color:#fff;border:0;padding:8px 16px;margin:10px}</style></head>
<body><div class="mat-toolbar"><span>Permit Portal</span></div><app-root></app-root>
<script>
(function(){
  var SPEC = ${JSON.stringify(spec).replace(/</g, "\\u003c")};
  var RENDER_MS = ${w.delays.render};
  var model = {};
  var root = document.querySelector("app-root");
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function current() { var m = /#\\/step\\/([^?]+)/.exec(location.hash); var slug = m ? m[1] : SPEC[0].slug; return SPEC.findIndex(function (p) { return p.slug === slug; }); }
  function field(c) {
    var v = model[c.name] || "";
    var lbl = '<label class="mat-form-field-label" for="' + esc(c.id) + '" id="' + esc(c.id) + '-label"><mat-label>' + esc(c.label) + '</mat-label>' + (c.required ? '<span class="mat-placeholder-required"> *</span>' : "") + "</label>";
    if (c.kind === "combo") {
      var opt = c.options.find(function (o) { return o.value === v; });
      return '<mat-form-field>' + lbl + '<mat-select role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0" id="' + esc(c.id) + '" aria-labelledby="' + esc(c.id) + '-label" data-name="' + esc(c.name) + '"' + (c.required ? ' aria-required="true"' : "") + '><span class="mat-select-value-text">' + esc(opt ? opt.text : "--Select--") + "</span></mat-select></mat-form-field>";
    }
    if (c.kind === "file") return '<mat-form-field>' + lbl + '<input type="file" id="' + esc(c.id) + '" formcontrolname="' + esc(c.name) + '" accept=".pdf"' + (c.required ? ' aria-required="true"' : "") + ">" + (v ? '<div class="file-name">' + esc(v) + "</div>" : "") + "</mat-form-field>";
    return '<mat-form-field>' + lbl + '<input matinput class="mat-input-element" id="' + esc(c.id) + '" formcontrolname="' + esc(c.name) + '" value="' + esc(v) + '"' + (c.required ? ' aria-required="true" required' : "") + "></mat-form-field>";
  }
  function render() {
    var i = current(); if (i < 0) i = 0; var page = SPEC[i];
    root.innerHTML = '<mat-spinner role="progressbar">Loading...</mat-spinner>';
    setTimeout(function () {
      fetch("/api/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: page.slug }) });
      var head = SPEC.map(function (p, j) { return '<div class="mat-stepper-header' + (j === i ? " active" : "") + '">' + (j + 1) + " " + esc(p.heading) + "</div>"; }).join("");
      var body = "";
      if (page.kind === "review") {
        body = "<p>" + esc(page.note) + "</p>" + SPEC.filter(function (p) { return p.kind === "form"; }).map(function (p) {
          return "<h3>" + esc(p.heading) + "</h3><dl>" + p.controls.map(function (c) { return "<dt>" + esc(c.label) + "</dt><dd>" + esc(model[c.name] || "") + "</dd>"; }).join("") + "</dl>";
        }).join("") + '<button mat-flat-button class="mat-flat-button" type="button" id="submitBtn"><span class="mat-button-wrapper">Submit Application</span></button>';
      } else if (page.kind === "readonly") {
        body = "<p>" + esc(page.note) + "</p>";
      } else {
        body = page.sections.map(function (s) { return "<fieldset><legend>" + esc(s) + "</legend>" + page.controls.filter(function (c) { return c.section === s; }).map(field).join("") + "</fieldset>"; }).join("");
      }
      var nav = page.kind === "review" ? "" : '<button mat-stroked-button type="button" id="backBtn"><span class="mat-button-wrapper">Back</span></button><button mat-flat-button class="mat-flat-button" type="button" id="nextBtn"><span class="mat-button-wrapper">Next</span></button>';
      root.innerHTML = '<div class="mat-horizontal-stepper-header-container">' + head + "</div><h2>" + esc(page.heading) + '</h2><div class="errors"></div>' + body + nav;
      wire(page, i);
    }, RENDER_MS);
  }
  function wire(page, i) {
    root.querySelectorAll("input[formcontrolname]").forEach(function (el) {
      var name = el.getAttribute("formcontrolname");
      if (el.type === "file") {
        el.addEventListener("change", function () { var f = el.files && el.files[0]; if (!f) return; model[name] = f.name; var fd = new FormData(); fd.append("name", name); fd.append("file", f, f.name); fetch("/api/upload", { method: "POST", body: fd }); });
      } else {
        el.addEventListener("input", function () { model[name] = el.value; });
      }
    });
    root.querySelectorAll("mat-select").forEach(function (sel) {
      sel.addEventListener("click", function () {
        var name = sel.getAttribute("data-name");
        var c = page.controls.find(function (x) { return x.name === name; });
        var old = document.querySelector(".cdk-overlay-pane"); if (old) old.remove();
        var pane = document.createElement("div"); pane.className = "cdk-overlay-pane";
        var r = sel.getBoundingClientRect(); pane.style.left = (r.left + scrollX) + "px"; pane.style.top = (r.bottom + scrollY) + "px";
        pane.innerHTML = '<div role="listbox" id="' + sel.id + '-panel">' + c.options.filter(function (o) { return o.value; }).map(function (o) { return '<mat-option role="option" data-value="' + esc(o.value) + '">' + esc(o.text) + "</mat-option>"; }).join("") + "</div>";
        pane.addEventListener("click", function (ev) {
          var o = ev.target.closest("mat-option"); if (!o) return;
          model[name] = o.getAttribute("data-value"); sel.querySelector(".mat-select-value-text").textContent = o.textContent; sel.setAttribute("aria-expanded", "false"); pane.remove();
        });
        sel.setAttribute("aria-expanded", "true");
        document.body.appendChild(pane);
      });
    });
    var next = document.getElementById("nextBtn");
    if (next) next.addEventListener("click", function () {
      var miss = page.controls.filter(function (c) { return c.required && !String(model[c.name] || "").trim(); });
      var errs = root.querySelector(".errors");
      if (miss.length) { errs.innerHTML = miss.map(function (c) { return "<mat-error>" + esc(c.label) + " is required</mat-error>"; }).join(""); return; }
      var vals = {}; page.controls.forEach(function (c) { vals[c.name] = model[c.name] || ""; });
      fetch("/api/steps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: page.slug, values: vals }) })
        .then(function (r) { return r.json(); }).then(function () { location.hash = "#/step/" + SPEC[i + 1].slug; });
    });
    var back = document.getElementById("backBtn");
    if (back) back.addEventListener("click", function () { if (i > 0) location.hash = "#/step/" + SPEC[i - 1].slug; });
    var submit = document.getElementById("submitBtn");
    if (submit) submit.addEventListener("click", function () {
      fetch("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model }) })
        .then(function () { root.innerHTML = "<h2>Application submitted</h2><p>Reference PRM-2026-0042</p>"; });
    });
  }
  window.addEventListener("hashchange", render);
  render();
})();
</script></body></html>`;
}
