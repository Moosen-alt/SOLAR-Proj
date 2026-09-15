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
    .map((w) => `<option value="${esc(w.workType)}" title="${esc(w.description)}">${esc(w.label)}${w.deterministic ? " (deterministic checks)" : " (AI pre-review)"}</option>`)
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
      ${f.message ? `<div class="rv-issue-line"><span>Plan set</span><p>${esc(f.message)}</p></div>` : ""}
      ${rec ? `<div class="rv-rec"><span>Recommended action</span><p>${esc(rec)}</p></div>` : ""}
    </div>`;
}

function renderReport(report, aiSummary, aiNotes) {
  const order = { blocker: 0, warning: 1, callout: 2, pass: 3 };
  const findings = [...report.findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const passes = findings.filter((f) => f.severity === "pass");
  const issues = findings.filter((f) => f.severity !== "pass");
  const blockers = issues.filter((f) => f.severity === "blocker").length;
  $("resultSummary").textContent = `— ${findings.length} finding(s), ${blockers} blocker(s)${aiSummary ? ` · AI: ${aiSummary}` : ""}${aiNotes ? ` · ${aiNotes}` : ""}`;

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
          ? `${issues.length} item(s) to review`
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
        <span class="rv-muted">${s.blockers} blocker(s) / ${s.findings} finding(s) · ${new Date(s.createdAt).toLocaleString()}</span>
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
  try {
    const { profiles } = await (await api("/api/code-profiles")).json();
    $("profiles").innerHTML = profiles.map((p, i) => `
      <div class="rv-profile-row">
        <span>${esc(p.state)}${p.ahj ? " · " + esc(p.ahj) : " · (state default)"} <span class="${p.confidence === "verified" ? "badge-verified" : "badge-seeded"}">${esc(p.confidence)}</span></span>
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
      $("verifyEditor").value = JSON.stringify(editable, null, 2);
      $("verifyPanel").style.display = "";
      $("verifyStatus").textContent = `Check every value against the citations (${(editingProfile.citations || []).length} source(s)) before verifying.`;
      $("verifyPanel").scrollIntoView({ behavior: "smooth" });
    }));
  } catch { $("profiles").textContent = "Could not load profiles."; }
}

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
  try {
    const payload = JSON.parse($("verifyEditor").value);
    await api("/api/code-profiles/verify", { method: "PUT", body: JSON.stringify(payload) });
    $("verifyStatus").textContent = "Verified — citations for this jurisdiction are now authoritative.";
    $("verifyPanel").style.display = "none";
    loadProfiles();
    refreshProfileBanner();
  } catch (err) {
    $("verifyStatus").textContent = `Verify failed: ${err.message}`;
  }
});

loadWorkTypes();
loadSubmissions();
loadProfiles();
