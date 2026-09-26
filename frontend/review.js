// Plan Review Gate — the AHJ-facing page. Vanilla JS, session-cookie auth
// (requireAuth redirects to /login when auth is enabled).
/* eslint-disable no-undef */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, init = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json", ...(init.headers || {}) }, ...init });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res;
}

let lastSubmissionId = "";

// --- Work types + solar-field toggling --------------------------------------
async function loadWorkTypes() {
  // Every other loader on this page reports its own failure; this one threw into an unhandled
  // rejection, so a 500 on /api/review/work-types left an empty picker, a Run button that could
  // never validate, and nothing on screen saying why. Same failure, now visible.
  let workTypes;
  try {
    ({ workTypes } = await (await api("/api/review/work-types")).json());
  } catch (err) {
    $("runStatus").textContent = `Could not load the work types: ${err.message || err}. Reload the page.`;
    return;
  }
  if (!Array.isArray(workTypes)) {
    $("runStatus").textContent = "The server returned no work types. Reload the page, or check the review service.";
    return;
  }
  $("workType").innerHTML = workTypes
    // The review mode rides in the tooltip: as a suffix on the option text it clipped the
    // label in the picker ("Residential rooftop solar PV (de…").
    .map((w) => `<option value="${esc(w.workType)}" title="${esc(w.description)} — ${w.deterministic ? "deterministic checks" : "AI pre-review"}">${esc(w.label)}</option>`)
    .join("");
  $("workType").addEventListener("change", toggleSolarFields);
  toggleSolarFields();
}
function toggleSolarFields() {
  $("solarFields").style.display = $("workType").value === "solar_pv_residential" ? "" : "none";
}

// --- Jurisdiction profile banner ---------------------------------------------
async function refreshProfileBanner() {
  const state = $("state").value.trim();
  const ahj = $("ahj").value.trim();
  const banner = $("profileBanner");
  if (!state) { banner.style.display = "none"; return; }
  try {
    const { profile } = await (await api(`/api/code-profiles/resolve?state=${encodeURIComponent(state)}&ahj=${encodeURIComponent(ahj)}`)).json();
    banner.style.display = "";
    if (!profile) {
      banner.className = "rv-banner defaults";
      banner.textContent = "No code profile for this jurisdiction yet — findings will cite model codes and say 'verify locally'. Research it below to onboard it.";
    } else if (profile.confidence === "verified") {
      banner.className = "rv-banner verified";
      banner.textContent = `Verified profile — citations use the adopted editions: ${profile.adoptedCodes.map((c) => `${c.code} ${c.edition}`).join(", ") || "(none recorded)"}.`;
    } else {
      banner.className = "rv-banner seeded";
      banner.textContent = "Seeded (AI-researched) profile — findings will say 'verify locally' until a human verifies it below.";
    }
  } catch { banner.style.display = "none"; }
}
["state", "ahj"].forEach((id) => $(id).addEventListener("blur", refreshProfileBanner));

// --- Run a review --------------------------------------------------------------
function buildSubject() {
  const fields = {};
  const put = (k, v) => { if (v !== "" && v != null) fields[k] = String(v); };
  put("snow", $("snow").value); put("deadLoad", $("deadLoad").value); put("roofRafterSpacing", $("rafter").value);
  put("wind", $("wind").value); put("busRating", $("bus").value); put("mainBreaker", $("mainBreaker").value);
  put("pvBreaker", $("pvBreaker").value); put("dcKw", $("dcKw").value); put("acKw", $("acKw").value);
  put("projectDescriptionText", $("description").value);
  const subject = {
    workType: $("workType").value,
    state: $("state").value.trim(),
    ahj: $("ahj").value.trim(),
    applicant: { name: $("applicant").value.trim(), address: $("address").value.trim(), city: $("city").value.trim() },
    fields,
  };
  const utility = $("utility").value.trim();
  if (utility) subject.utility = utility;
  const dc = Number($("dcKw").value); const ac = Number($("acKw").value);
  subject.system = {};
  if (Number.isFinite(dc) && $("dcKw").value !== "") subject.system.sizeDcKw = dc;
  if (Number.isFinite(ac) && $("acKw").value !== "") subject.system.sizeAcKw = ac;
  if ($("interco").value.trim()) subject.system.interconnectionMethod = $("interco").value.trim();
  return subject;
}

async function runReview() {
  const subject = buildSubject();
  if (!subject.state || !subject.ahj) { $("runStatus").textContent = "State and AHJ are required."; return; }
  $("runBtn").disabled = true;
  $("runStatus").textContent = "Reviewing… (with a plan set this can take a minute)";
  try {
    const file = $("planset").files[0];
    let body;
    if (file) {
      body = await (await fetch(`/api/review/upload?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-review-subject": JSON.stringify(subject) },
        body: file,
      })).json();
      if (body.error) throw new Error(body.error);
    } else {
      body = await (await api("/api/review", { method: "POST", body: JSON.stringify(subject) })).json();
    }
    lastSubmissionId = body.submissionId;
    renderReport(body.report, body.aiSummary, body.aiNotes);
    $("runStatus").textContent = "";
    loadSubmissions();
  } catch (err) {
    $("runStatus").textContent = `Review failed: ${err.message || err}`;
  } finally {
    $("runBtn").disabled = false;
  }
}

// The severity words are the report's own vocabulary and are matched on
// elsewhere; these are DISPLAY labels only, keyed by that vocabulary.
const SEVERITY_LABEL = { blocker: "Blocker", warning: "Potential issue", callout: "Note" };
// Where the finding's observation comes from, keyed by the report's own category. Every card
// used to say "Plan set", including "Homeowner name missing" (which comes from the form).
const SOURCE_LABEL = {
  project_data: "Intake form", plan_set: "Plan set", structural: "Plan set", electrical: "Plan set",
  ahj_profile: "Jurisdiction", utility_nem: "Utility", ai_review: "AI page review",
  installer: "Installer", portal: "Portal",
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One "POTENTIAL ISSUE" panel, laid out exactly as the AHJ preflight card on the
// marketing site: what the code requires, what the plan set shows, what to do.
function issueHtml(f) {
  // Several rules set cityFeedback to the same sentence as message (the
  // "Critical project field missing" family, for one). Printing it twice — once
  // as what the plan set shows and again as what to do about it — makes the card
  // look padded and teaches the reader to skip the green box.
  const rec = (f.cityFeedback || "").trim() === (f.message || "").trim() ? "" : f.cityFeedback;
  const refs = (f.codeReferences || []).map((c) => `
        <p>§ ${esc(c.code)} ${esc(c.section)} — ${esc(c.title)}${c.sourceUrl ? ` · <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ""}
           ${c.adoptionScope ? `<i class="rv-scope">${esc(c.adoptionScope)}</i>` : ""}</p>`).join("");
  return `
    <div class="rv-issue ${esc(f.severity)}">
      <span class="rv-issue-kind">${esc(SEVERITY_LABEL[f.severity] || f.severity)}</span>
      <h4>${esc(f.title)}${f.category === "ai_review" ? '<span class="rv-ai-badge">AI-assisted — confirm before acting</span>' : ""}</h4>
      ${refs ? `<div class="rv-issue-line"><span>AHJ requirement</span>${refs}</div>` : ""}
      ${f.message ? `<div class="rv-issue-line"><span>${esc(SOURCE_LABEL[f.category] || "Finding")}</span><p>${esc(f.message)}</p></div>` : ""}
      ${rec ? `<div class="rv-rec"><span>Recommended action</span><p>${esc(rec)}</p></div>` : ""}
    </div>`;
}

function renderReport(report, aiSummary, aiNotes) {
  const order = { blocker: 0, warning: 1, callout: 2, pass: 3 };
  const findings = [...report.findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const passes = findings.filter((f) => f.severity === "pass");
  const issues = findings.filter((f) => f.severity !== "pass");
  const blockers = issues.filter((f) => f.severity === "blocker").length;
  $("resultSummary").textContent = `— ${plural(findings.length, "finding", "findings")}, ${plural(blockers, "blocker", "blockers")}${aiSummary ? ` · AI: ${aiSummary}` : ""}${aiNotes ? ` · ${aiNotes}` : ""}`;

  const subject = [$("ahj").value.trim(), $("state").value.trim()].filter(Boolean).join(", ") || "This project";
  // The option text carries a "(deterministic checks)" / "(AI pre-review)" suffix
  // that belongs in the picker, not in a chip on the result card.
  const workType = (($("workType").selectedOptions[0] || {}).textContent || "").replace(/\s*\(.*\)\s*$/, "").trim();

  // An empty column is worse than no column: with nothing passing, a 40%-wide
  // blank rail beside twenty findings reads as a rendering fault.
  const cols = [];
  if (passes.length) {
    cols.push(`<div class="rv-checks"><div class="rv-col-title">Project checks</div>
        <ul class="rv-checklist">${passes.map((f) => `<li>${esc(f.title)}</li>`).join("")}</ul></div>`);
  }
  cols.push(`<div class="rv-issues">
        <div class="rv-col-title">${issues.length
          ? `${plural(issues.length, "item", "items")} to review`
          : "Nothing flagged"}</div>
        ${issues.length
          ? issues.map(issueHtml).join("")
          : '<p class="rv-empty">No potential issues found. A human plans examiner still completes the review.</p>'}
        ${passes.length ? "" : '<p class="rv-empty" style="margin-top:14px">No check passed outright, so there is no "project checks" column yet — the intake is too thin to confirm anything.</p>'}
      </div>`);

  $("findings").innerHTML = `
    <div class="rv-preflight">
      <div class="rv-preflight-head">
        <div>
          <span class="rv-eyebrow">AHJ preflight</span>
          <span class="rv-subject">${esc(subject)}</span>
        </div>
        ${workType ? `<span class="rv-chip">${esc(workType)}</span>` : ""}
      </div>
      <div class="rv-preflight-body${cols.length === 1 ? " one-col" : ""}">
        ${cols.join("")}
      </div>
      <p class="rv-disclaimer">Keelix identifies potential issues for review. Final code interpretation
        and project approval remain with the applicable authority and the responsible project
        professionals.</p>
    </div>`;
  $("resultCard").style.display = "";
  $("resultCard").scrollIntoView({ behavior: "smooth" });
}

$("runBtn").addEventListener("click", runReview);
$("printBtn").addEventListener("click", () => {
  if (lastSubmissionId) window.open(`/api/review/submissions/${lastSubmissionId}?format=html`, "_blank");
});
$("shareBtn").addEventListener("click", async () => {
  if (!lastSubmissionId) return;
  try {
    const { url } = await (await api(`/api/review/submissions/${lastSubmissionId}/share`, { method: "POST", body: "{}" })).json();
    await navigator.clipboard.writeText(url);
    $("runStatus").textContent = "Share link copied — anyone with it can read this report (no login).";
  } catch (err) { $("runStatus").textContent = `Share failed: ${err.message}`; }
});

// --- Past submissions -----------------------------------------------------------
async function loadSubmissions() {
  try {
    const { submissions } = await (await api("/api/review/submissions")).json();
    // The id used to be interpolated into an inline onclick, i.e. into a JS string
    // inside an HTML attribute — esc() turns a quote into &#39;, which the attribute
    // parser hands BACK to the JS parser as a quote. Carried as data, bound as a
    // listener, the same id is inert.
    $("subs").innerHTML = submissions.map((s) => `
      <div class="rv-sub" role="button" tabindex="0" data-submission="${esc(s.id)}">
        <span>${esc(s.ahj)}, ${esc(s.state)} · ${esc(s.workType.replace(/_/g, " "))}</span>
        <span class="rv-muted">${plural(Number(s.blockers) || 0, "blocker", "blockers")} / ${plural(Number(s.findings) || 0, "finding", "findings")} ·${new Date(s.createdAt).toLocaleString()}</span>
      </div>`).join("") || '<span class="rv-muted">No reviews yet.</span>';
    $("subs").querySelectorAll("[data-submission]").forEach((row) => {
      const open = () => window.open(`/api/review/submissions/${encodeURIComponent(row.dataset.submission)}?format=html`, "_blank");
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  } catch { $("subs").textContent = "Could not load submissions."; }
}

// --- Jurisdiction code profile manager -------------------------------------------
let editingProfile = null;
async function loadProfiles() {
  // The verify panel opens inside the list (under its row); re-rendering the list would take it along.
  if ($("profiles").contains($("verifyPanel"))) closeVerifyPanel();
  try {
    const { profiles } = await (await api("/api/code-profiles")).json();
    $("profiles").innerHTML = profiles.map((p, i) => `
      <div class="rv-profile-row">
        <span>${esc(profileName(p))} <span class="${p.confidence === "verified" ? "badge-verified" : "badge-seeded"}">${esc(p.confidence)}</span></span>
        <span style="display:flex;align-items:center;gap:12px">
          <span class="rv-codes">${(p.adoptedCodes || []).map((c) => `${esc(c.code)} ${esc(c.edition)}`).join(", ") || "no codes recorded"}</span>
          <button class="secondary" data-edit="${i}">Review / verify</button>
        </span>
      </div>`).join("") || '<span class="rv-muted">No profiles yet — research one above.</span>';
    document.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
      editingProfile = profiles[Number(btn.dataset.edit)];
      const editable = {
        state: editingProfile.state, ahj: editingProfile.ahj,
        adoptedCodes: editingProfile.adoptedCodes, amendments: editingProfile.amendments,
        designCriteria: editingProfile.designCriteria, prescriptive: editingProfile.prescriptive,
        fireSetbacks: editingProfile.fireSetbacks, citations: editingProfile.citations,
      };
      // The raw JSON is still what the PUT sends (and what an operator edits under "Edit raw");
      // the readable summary above it is display only.
      $("verifyEditor").value = JSON.stringify(editable, null, 2);
      $("verifyRaw").open = false;
      $("verifyTitle").textContent = `Verify ${profileName(editingProfile)}`;
      $("verifySummary").innerHTML = profileSummaryHtml(editingProfile);
      const sources = (editingProfile.citations || []).length;
      $("verifyStatus").textContent = `Check every value against ${sources === 1 ? "its cited source" : `its ${sources} cited sources`} before verifying.`;
      // Open directly under the row that was clicked, not at the bottom of a 25-row list.
      btn.closest(".rv-profile-row").after($("verifyPanel"));
      $("verifyPanel").style.display = "";
      $("verifyPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
  } catch { $("profiles").textContent = "Could not load profiles."; }
}

function profileName(p) {
  return `${p.state}${p.ahj ? ` · ${p.ahj}` : " (state default)"}`;
}
const httpUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
const sourceLink = (u) => (httpUrl(u) ? ` <a href="${esc(httpUrl(u))}" target="_blank" rel="noopener">source</a>` : "");
const KEY_WORDS = { kw: "kW", dc: "DC", ac: "AC", psf: "psf", mph: "mph", pv: "PV", ahj: "AHJ", nec: "NEC", ibc: "IBC", irc: "IRC", ifc: "IFC" };
const humanKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()
  .split(" ").map((w) => KEY_WORDS[w] || w).join(" ").replace(/^[a-z]/, (c) => c.toUpperCase());
const plainValue = (v) => (v == null ? "" : typeof v === "object" ? Object.entries(v).filter(([, x]) => x !== "" && x != null).map(([k, x]) => `${humanKey(k)}: ${typeof x === "object" ? JSON.stringify(x) : x}`).join("; ") : String(v));

// A readable table of what the operator is about to lock as human-verified.
function profileSummaryHtml(p) {
  const rows = [];
  const section = (title, items) => rows.push(`<div class="rv-vsec"><h4>${esc(title)}</h4>${items.length
    ? `<ul>${items.join("")}</ul>` : '<p class="rv-muted">None recorded.</p>'}</div>`);
  section("Adopted codes", (p.adoptedCodes || []).map((c) =>
    `<li><b>${esc(c.code)} ${esc(c.edition)}</b>${c.title ? ` — ${esc(c.title)}` : ""}${c.basedOn ? ` <span class="rv-muted">(based on ${esc(c.basedOn)})</span>` : ""}${c.effectiveDate ? ` <span class="rv-muted">effective ${esc(c.effectiveDate)}</span>` : ""}${sourceLink(c.sourceUrl)}</li>`));
  section("Amendments", (p.amendments || []).map((a) =>
    `<li><b>${esc([a.code, a.section].filter(Boolean).join(" "))}</b>${a.summary ? ` — ${esc(a.summary)}` : ""}${sourceLink(a.sourceUrl)}</li>`));
  const kv = (obj) => Object.entries(obj || {}).filter(([k, v]) => k !== "sourceUrl" && v !== "" && v != null)
    .map(([k, v]) => `<li><b>${esc(humanKey(k))}:</b> ${esc(plainValue(v))}</li>`);
  const dc = kv(p.designCriteria);
  if (dc.length && httpUrl(p.designCriteria?.sourceUrl)) dc.push(`<li class="rv-muted">Design criteria${sourceLink(p.designCriteria.sourceUrl)}</li>`);
  section("Design criteria", dc);
  section("Prescriptive limits", kv(p.prescriptive));
  section("Fire setbacks", (p.fireSetbacks || []).map((f) => `<li>${esc(plainValue(f))}</li>`));
  section("Citations", (p.citations || []).map((c) =>
    `<li>${esc(c.label || httpUrl(c.sourceUrl) || "Source")}${sourceLink(c.sourceUrl)}</li>`));
  return rows.join("");
}

function closeVerifyPanel() {
  $("verifyPanel").style.display = "none";
  // Park the panel back outside #profiles so a list re-render never destroys it.
  $("profiles").after($("verifyPanel"));
  editingProfile = null;
}
$("verifyCancel").addEventListener("click", closeVerifyPanel);

$("researchBtn").addEventListener("click", async () => {
  const state = $("cpState").value.trim();
  if (!state) { $("cpStatus").textContent = "State is required."; return; }
  $("researchBtn").disabled = true;
  $("cpStatus").textContent = "Researching official sources (web search)… this can take a minute.";
  try {
    const body = await (await api("/api/code-profiles/research", { method: "POST", body: JSON.stringify({ state, ahj: $("cpAhj").value.trim() }) })).json();
    $("cpStatus").textContent = `${body.webGrounded ? "Web-grounded research saved (seeded)." : "Saved from model knowledge only (seeded)."} ${body.notes || ""} Review and verify it below.`;
    loadProfiles();
  } catch (err) {
    $("cpStatus").textContent = `Research failed: ${err.message}`;
  } finally { $("researchBtn").disabled = false; }
});

$("verifyBtn").addEventListener("click", async () => {
  let payload;
  try { payload = JSON.parse($("verifyEditor").value); } catch (err) {
    $("verifyRaw").open = true;
    $("verifyStatus").textContent = `The raw profile is not valid JSON: ${err.message}`;
    return;
  }
  const name = profileName({ state: payload.state || "", ahj: payload.ahj || "" });
  // Verifying locks the profile against automatic overwrite (hard rule 3) — one stray click
  // used to do that with no confirmation.
  if (!window.confirm(`Mark ${name} verified?\n\nThis locks it from automatic overwrite: later research will not change it. Only confirm after checking every value against its cited source.`)) return;
  $("verifyBtn").disabled = true;
  try {
    await api("/api/code-profiles/verify", { method: "PUT", body: JSON.stringify(payload) });
    closeVerifyPanel();
    // Written OUTSIDE the panel it just closed, so the operator actually sees it.
    $("cpStatus").textContent = `${name} verified — its citations are now authoritative.`;
    loadProfiles();
    refreshProfileBanner();
  } catch (err) {
    $("verifyStatus").textContent = `Verify failed: ${err.message}`;
  } finally {
    $("verifyBtn").disabled = false;
  }
});

loadWorkTypes();
loadSubmissions();
loadProfiles();
