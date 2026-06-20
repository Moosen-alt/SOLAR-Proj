const state = {
  projects: [],
  selectedProjectId: null,
  detail: null,
  workflow: null,
  applicationDocs: null,
  reviewerReport: null,
  historicalReport: null,
  opsPlan: null,
  opsBrief: null,
  handoffPacket: null,
  communicationDrafts: null,
  runbook: null,
  opsBoard: null,
  opsActions: null,
  opsReport: null,
  liveReadiness: null,
  projectTimeline: null,
  processMap: null,
  installerPacket: null,
  submitGate: null,
  knowledgeProfiles: [],
  emailTracker: null,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.details = data.details || {};
    throw err;
  }
  return data;
}

function showMessage(message, kind = "info") {
  const el = $("message");
  el.hidden = false;
  el.textContent = message;
  el.style.borderLeftColor = kind === "error" ? "var(--danger)" : kind === "warning" ? "var(--warning)" : "var(--info)";
}

function clearMessage() {
  $("message").hidden = true;
  $("message").textContent = "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusBadge(status) {
  const label = String(status ?? "unknown").replaceAll("_", " ");
  if (status === "handoff_ready") return `<span class="badge badge-pass">${esc(label)}</span>`;
  if (status === "nem_approved") return `<span class="badge badge-info">${esc(label)}</span>`;
  if (status === "issued" || status === "ready_for_issue") return `<span class="badge badge-info">${esc(label)}</span>`;
  if (status === "correction_received" || status === "correction_triaged") return `<span class="badge badge-warning">${esc(label)}</span>`;
  if (status === "blocked") return `<span class="badge badge-fail">${esc(label)}</span>`;
  return `<span class="badge">${esc(label)}</span>`;
}

function projectLaneStatusCell(label, outcome, checkedAt, ready, readyLabel) {
  const display = ready ? readyLabel : label || (outcome ? outcome.replaceAll("_", " ") : "not checked");
  const dateText = checkedAt ? esc(new Date(checkedAt).toLocaleDateString()) : "";
  return `${statusBadge(display)}<br><span class="muted">${dateText}</span>`;
}

async function checkHealth() {
  try {
    const health = await api("/health");
    $("serviceStatus").textContent = `${health.service} is running`;
  } catch {
    $("serviceStatus").textContent = "Backend is not reachable";
  }
}

async function loadProjects() {
  await fetchProjectPage(false);
  await loadOpsReport();
  await loadOpsBoard();
  await loadOpsActions();
  await loadKnowledgeBase();
  await loadEmailTracker();
  const selectedStillExists = state.projects.some((project) => project.id === state.selectedProjectId);
  if (!state.selectedProjectId && state.projects[0]) {
    await selectProject(state.projects[0].id);
  } else if (state.selectedProjectId && selectedStillExists) {
    await selectProject(state.selectedProjectId);
  } else if (!selectedStillExists) {
    state.selectedProjectId = null;
    state.detail = null;
    state.opsPlan = null;
    state.opsBrief = null;
    state.handoffPacket = null;
    state.communicationDrafts = null;
    state.runbook = null;
    state.liveReadiness = null;
    state.projectTimeline = null;
    state.processMap = null;
    state.installerPacket = null;
    state.submitGate = null;
    $("detailView").hidden = true;
    $("emptyState").hidden = false;
  }
}

async function refreshProjectListOnly() {
  await fetchProjectPage(false);
  await loadOpsReport();
  await loadOpsBoard();
  await loadOpsActions();
  await loadKnowledgeBase();
  await loadEmailTracker();
}

async function loadOpsBoard() {
  try {
    state.opsBoard = await api("/api/ops-board");
    renderOpsBoard();
  } catch (err) {
    $("opsBoardStatus").textContent = "error";
    $("opsBoard").innerHTML = `<p class="muted">${esc(err.message || "Ops Board unavailable.")}</p>`;
  }
}

async function loadOpsReport() {
  try {
    state.opsReport = await api("/api/ops-report");
    renderOpsReport();
  } catch (err) {
    $("opsReportStatus").textContent = "error";
    $("opsReport").innerHTML = `<p class="muted">${esc(err.message || "Daily report unavailable.")}</p>`;
  }
}

async function loadOpsActions() {
  try {
    state.opsActions = await api("/api/ops-actions");
    renderOpsActions();
  } catch (err) {
    $("opsActionsStatus").textContent = "error";
    $("opsActions").innerHTML = `<p class="muted">${esc(err.message || "Action Queue unavailable.")}</p>`;
  }
}

async function loadKnowledgeBase() {
  const data = await api("/api/knowledge-base");
  state.knowledgeProfiles = data.profiles || [];
  $("knowledgeCount").textContent = state.knowledgeProfiles.length;
  renderKnowledgeBase();
}

async function loadEmailTracker() {
  try {
    state.emailTracker = await api("/api/email-tracker");
    renderEmailTracker();
  } catch (err) {
    $("emailTrackerStatus").textContent = err.message || "Email tracker status unavailable.";
  }
}

async function loadOpsPlan() {
  if (!state.selectedProjectId) {
    state.opsPlan = null;
    state.opsBrief = null;
    return;
  }
  const [plan, brief] = await Promise.all([
    api(`/api/projects/${state.selectedProjectId}/ops-plan`),
    api(`/api/projects/${state.selectedProjectId}/ops-brief`),
  ]);
  state.opsPlan = plan;
  state.opsBrief = brief;
}

async function loadLiveReadiness() {
  if (!state.selectedProjectId) {
    state.liveReadiness = null;
    return;
  }
  state.liveReadiness = await api(`/api/projects/${state.selectedProjectId}/live-readiness`);
}

async function loadRunbook() {
  if (!state.selectedProjectId) {
    state.runbook = null;
    return;
  }
  state.runbook = await api(`/api/projects/${state.selectedProjectId}/runbook`);
}

async function loadHandoffPacket() {
  if (!state.selectedProjectId) {
    state.handoffPacket = null;
    return;
  }
  state.handoffPacket = await api(`/api/projects/${state.selectedProjectId}/handoff-packet`);
}

async function loadCommunicationDrafts() {
  if (!state.selectedProjectId) {
    state.communicationDrafts = null;
    return;
  }
  state.communicationDrafts = await api(`/api/projects/${state.selectedProjectId}/communication-drafts`);
}

async function loadPmPackets() {
  await loadSubmitGate();
  await loadRunbook();
  await loadHandoffPacket();
  await loadCommunicationDrafts();
}

async function loadProjectTimeline() {
  if (!state.selectedProjectId) {
    state.projectTimeline = null;
    return;
  }
  state.projectTimeline = await api(`/api/projects/${state.selectedProjectId}/timeline`);
}

async function loadProcessMap() {
  if (!state.selectedProjectId) {
    state.processMap = null;
    return;
  }
  state.processMap = await api(`/api/projects/${state.selectedProjectId}/process-map`);
}

async function loadInstallerPacket() {
  if (!state.selectedProjectId) {
    state.installerPacket = null;
    return;
  }
  state.installerPacket = await api(`/api/projects/${state.selectedProjectId}/installer-actions`);
}

async function loadSubmitGate() {
  if (!state.selectedProjectId) {
    state.submitGate = null;
    return;
  }
  state.submitGate = await api(`/api/projects/${state.selectedProjectId}/submit-gate`);
}

function renderEmailTracker() {
  const sources = state.emailTracker?.sources || [];
  const active = sources.find((source) => source.active) || sources[0];
  if (active && !$("emailWatchPath").value) $("emailWatchPath").value = active.filePath || "";
  if (!sources.length) {
    $("emailTrackerStatus").textContent = "No email watch source configured.";
    return;
  }
  const totalMatches = (state.emailTracker?.recentMatches || []).length;
  $("emailTrackerStatus").textContent = `${sources.filter((source) => source.active).length} active email watch source(s). Last scan: ${active?.lastCheckedAt ? new Date(active.lastCheckedAt).toLocaleString() : "not run"}; last matched ${active?.lastMatchedCount || 0}/${active?.lastMessageCount || 0}; recent matches ${totalMatches}.${active?.lastError ? ` Error: ${active.lastError}` : ""}`;
}

function renderProjects() {
  const body = $("projectsBody");
  const projects = state.projects;
  const total = state.projectsTotal ?? projects.length;
  $("projectCount").textContent = `${projects.length}${total > projects.length ? `/${total}` : ""}`;
  if (!projects.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted">No projects saved yet.</td></tr>`;
    return;
  }
  const userMap = Object.fromEntries((state.users || []).map((u) => [u.id, u]));
  body.innerHTML = projects.map((project) => {
    const assignee = project.assignedUserId ? userMap[project.assignedUserId] : null;
    const assigneeHtml = assignee
      ? `<span style="display:inline-flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(assignee.color)}"></span>${esc(assignee.name)}</span>`
      : `<span class="muted">—</span>`;
    return `
    <tr data-project-id="${project.id}" class="${project.id === state.selectedProjectId ? "active" : ""}">
      <td><strong>${esc(project.homeownerName || "Unnamed")}</strong><br><span class="muted">${esc(project.projectAddress || "No address")}</span></td>
      <td>${assigneeHtml}</td>
      <td>${statusBadge(project.status)}</td>
      <td>${projectLaneStatusCell(project.latestPermitLabel, project.latestPermitOutcome, project.latestPermitCheckedAt, project.readyForIssue, "ready for issue")}</td>
      <td>${projectLaneStatusCell(project.latestNemLabel, project.latestNemOutcome, project.latestNemCheckedAt, project.nemApproved, "NEM approved")}</td>
      <td>${project.qcFailCount ? `<strong class="danger">${project.qcFailCount} fail</strong>` : "0 fail"}<br><span class="muted">${project.qcWarningCount} warn</span></td>
      <td>${project.pendingReviewCount}</td>
    </tr>`;
  }).join("");
  if (total > projects.length) {
    const loadMoreRow = document.createElement("tr");
    loadMoreRow.innerHTML = `<td colspan="7" style="text-align:center;padding:12px"><button id="loadMoreBtn" class="secondary">Load more (${total - projects.length} remaining)</button></td>`;
    body.appendChild(loadMoreRow);
    loadMoreRow.querySelector("#loadMoreBtn").addEventListener("click", loadMoreProjects);
  }
  body.querySelectorAll("tr[data-project-id]").forEach((row) => {
    row.addEventListener("click", () => selectProject(row.dataset.projectId));
  });
}

function renderOpsReport() {
  const report = state.opsReport;
  if (!report) {
    $("opsReportStatus").textContent = "not synced";
    $("opsReport").innerHTML = `<p class="muted">Daily report has not loaded yet.</p>`;
    $("copyOpsReportBtn").disabled = true;
    return;
  }
  $("copyOpsReportBtn").disabled = !report.reportText;
  $("opsReportStatus").textContent = `${report.board?.blockedProjects || 0} blocked`;
  const owners = report.ownerWorkload || [];
  const dueNow = report.dueNow || [];
  const topActions = report.topActions || [];
  $("opsReport").innerHTML = `
    <article class="item ${report.board?.blockedProjects ? "blocker" : report.actionQueue?.totalActions ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(report.headline)}</span>${statusBadge(report.actionQueue?.totalActions || 0)}</div>
      ${(report.summary || []).map((line) => `<p>${esc(line)}</p>`).join("")}
    </article>
    <div class="ops-report-grid">
      <article class="ops-report-section">
        <div class="item-title"><span>Owners</span>${statusBadge(owners.length)}</div>
        ${owners.length ? owners.slice(0, 5).map((owner) => `
          <p><strong>${esc(owner.ownerRole)}</strong>: ${owner.totalActions} action(s), ${owner.blockedActions} blocked, ${owner.overdueActions} overdue</p>
        `).join("") : `<p class="muted">No active owner workload.</p>`}
      </article>
      <article class="ops-report-section">
        <div class="item-title"><span>Due Now</span>${statusBadge(dueNow.length)}</div>
        ${dueNow.length ? dueNow.slice(0, 4).map((action) => `
          <p><strong>${esc(action.ownerRole)}</strong>: ${esc(action.phaseName)} | ${esc(action.homeownerName || "Unnamed")}</p>
        `).join("") : `<p class="muted">No actions due today or overdue.</p>`}
      </article>
      <article class="ops-report-section wide">
        <div class="item-title"><span>Top Actions</span>${statusBadge(topActions.length)}</div>
        ${topActions.length ? topActions.slice(0, 5).map((action) => `
          <p><strong>${esc(action.ownerRole)}</strong>: ${esc(action.homeownerName || "Unnamed")} | ${esc(action.phaseName)}<br><span class="muted">${esc(action.action)}</span></p>
        `).join("") : `<p class="muted">No active actions.</p>`}
      </article>
    </div>
  `;
}

function renderOpsBoard() {
  const board = state.opsBoard;
  if (!board) {
    $("opsBoardStatus").textContent = "not synced";
    $("opsBoard").innerHTML = `<p class="muted">Portfolio action board has not loaded yet.</p>`;
    return;
  }
  $("opsBoardStatus").textContent = `${board.blockedProjects} blocked`;
  const projects = board.projects || [];
  $("opsBoard").innerHTML = `
    <div class="ops-board-metrics">
      <div><strong>${board.totalProjects || 0}</strong><span>Projects</span></div>
      <div><strong>${board.totalBlockers || 0}</strong><span>Blockers</span></div>
      <div><strong>${board.totalActiveActions || 0}</strong><span>Actions</span></div>
    </div>
    <div class="ops-board-list">
      ${projects.length ? projects.slice(0, 8).map((project) => `
        <button class="ops-board-card ${briefClass(project.health)} ${project.projectId === state.selectedProjectId ? "active" : ""}" data-board-project-id="${project.projectId}">
          <span class="ops-board-card-head">
            <strong>${esc(project.homeownerName || "Unnamed")}</strong>
            ${statusBadge(project.health)}
          </span>
          <span>${esc(project.projectAddress || "No address")}</span>
          <span><strong>${esc(project.currentPhase)}</strong>: ${esc(project.nextAction)}</span>
          <span class="muted">${esc(project.ownerRole)} | ${project.blockerCount} blocker(s) | ${project.activeActionCount} action(s)</span>
        </button>
      `).join("") : `<p class="muted">No projects on the board yet.</p>`}
    </div>
  `;
  $("opsBoard").querySelectorAll("button[data-board-project-id]").forEach((button) => {
    button.addEventListener("click", () => selectProject(button.dataset.boardProjectId));
  });
}

function dueLabel(action) {
  if (action.dueBucket === "overdue") return `overdue${action.dueAt ? ` ${action.dueAt}` : ""}`;
  if (action.dueBucket === "today") return "due today";
  if (action.dueBucket === "upcoming") return `due ${action.dueAt}`;
  return "no due date";
}

function renderOpsActions() {
  const queue = state.opsActions;
  if (!queue) {
    $("opsActionsStatus").textContent = "not synced";
    $("opsActions").innerHTML = `<p class="muted">Active action queue has not loaded yet.</p>`;
    return;
  }
  $("opsActionsStatus").textContent = `${queue.totalActions || 0} actions`;
  const actions = queue.actions || [];
  $("opsActions").innerHTML = `
    <div class="ops-action-metrics">
      <span>${queue.blockedActions || 0} blocked</span>
      <span>${queue.waitingActions || 0} waiting</span>
      <span>${queue.inProgressActions || 0} active</span>
      <span>${queue.overdueActions || 0} overdue</span>
    </div>
    <div class="ops-action-list">
      ${actions.length ? actions.slice(0, 12).map((action) => `
        <article class="ops-action-card ${opsClass(action.status)} ${action.projectId === state.selectedProjectId ? "active" : ""}" data-action-project-id="${action.projectId}" data-action-step-id="${action.stepId}">
          <div class="ops-action-card-head" style="cursor:pointer" data-action-toggle="${action.stepId}">
            <strong>${esc(action.ownerRole || "Operations")}</strong>
            ${statusBadge(action.status)}
          </div>
          <span>${esc(action.phaseName)} | ${esc(action.homeownerName || "Unnamed")}</span>
          <span>${esc(action.action)}</span>
          <span class="muted">${esc(dueLabel(action))} | ${esc(action.source)} | ${action.blockerCount} project blocker(s)</span>
          <form class="ops-action-form" data-action-form="${action.projectId}:${action.stepId}" method="post" action="/api/projects/${action.projectId}/ops-steps/${action.stepId}" target="opsActionFrame" hidden>
            <div class="ops-action-controls">
              <label>Status<select id="action-status-${action.stepId}" name="status">${opsStatusOptions(action.status)}</select></label>
              <label>Owner<input id="action-owner-${action.stepId}" name="ownerRole" value="${esc(action.ownerRole || "")}" /></label>
              <label>Due<input id="action-due-${action.stepId}" name="dueAt" type="date" value="${esc(action.dueAt || "")}" /></label>
              <button type="button" class="secondary" data-action-open="${action.projectId}"><i data-lucide="folder-open"></i><span>Open</span></button>
              <button type="submit" class="primary"><i data-lucide="save"></i><span>Save</span></button>
            </div>
            <textarea id="action-notes-${action.stepId}" name="notes" placeholder="PM note for this action">${esc(action.notes || "")}</textarea>
          </form>
        </article>
      `).join("") : `<p class="muted">No active actions. Keep monitoring email and approvals.</p>`}
    </div>
  `;
}

function handleOpsActionClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const openButton = target.closest("button[data-action-open]");
  if (openButton) {
    selectProject(openButton.dataset.actionOpen);
    return;
  }
  const toggleHead = target.closest("[data-action-toggle]");
  if (toggleHead) {
    const stepId = toggleHead.dataset.actionToggle;
    const card = toggleHead.closest(".ops-action-card");
    const form = card?.querySelector(`.ops-action-form[data-action-form*="${stepId}"]`);
    if (form) form.hidden = !form.hidden;
    return;
  }
}

async function handleOpsActionFrameLoad() {
  if (!state.opsActions) return;
  showMessage("Action saved.");
  await refreshProjectListOnly();
}

function renderKnowledgeProfile(profile) {
  const title = [profile.state, profile.ahj || "Any AHJ", profile.utility || "Any utility"].filter(Boolean).join(" / ");
  const timeline = profile.averageTimelineDays == null
    ? null
    : `${profile.averageTimelineDays.toFixed(1)} days avg (${profile.timelineSampleCount} sample${profile.timelineSampleCount === 1 ? "" : "s"})`;
  const docs = profile.requiredDocuments || [];
  const corrections = (profile.commonCorrections || []).slice(0, 4);
  const sourceSummary = (() => {
    const types = [...new Set((profile.sources || []).map((s) => s.sourceType))];
    const labels = types.map((t) => ({
      official: "official", sanitized_reference: "reference", learned_project: "projects",
      learned_correction: "corrections", learned_permit_status: "permit status", learned_batch_import: "batch scan",
    }[t] || t));
    return labels.join(", ");
  })();
  const lastLearned = profile.lastLearnedAt ? new Date(profile.lastLearnedAt).toLocaleDateString() : null;
  const colorClass = profile.correctionCount > 0 ? "warning" : profile.projectCount > 0 ? "info" : "pass";
  return `
    <article class="item ${colorClass}" style="margin-bottom:8px">
      <div class="item-title">
        <span>${esc(title)}</span>
        ${statusBadge(profile.confidence)}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin:4px 0 6px">
        <span>📁 ${profile.projectCount} project(s)</span>
        <span>⚠️ ${profile.correctionCount} correction(s)</span>
        ${timeline ? `<span>📅 ${esc(timeline)}</span>` : ""}
        ${lastLearned ? `<span>🔄 Last learned ${esc(lastLearned)}</span>` : ""}
        ${sourceSummary ? `<span class="muted">Sources: ${esc(sourceSummary)}</span>` : ""}
      </div>
      ${profile.portalName ? `<p style="margin:2px 0;font-size:12px"><strong>Portal:</strong> ${esc(profile.portalName)}${profile.portalUrl ? ` — <a href="${esc(profile.portalUrl)}" target="_blank" rel="noopener">${esc(profile.portalUrl)}</a>` : ""}</p>` : ""}
      ${docs.length ? `<p style="margin:4px 0;font-size:12px"><strong>Required docs (${docs.length}):</strong> ${esc(docs.join(" · "))}</p>` : `<p style="margin:4px 0;font-size:12px;color:var(--muted)">No required documents learned yet.</p>`}
      ${corrections.length ? `<div style="margin-top:4px;font-size:12px"><strong>Common corrections:</strong> <ul style="margin:2px 0 0 16px;padding:0">${corrections.map((c) => `<li>${esc(c.rootCause)}${c.count > 1 ? ` (×${c.count})` : ""}</li>`).join("")}</ul></div>` : ""}
      ${profile.notes ? `<p style="margin:4px 0;font-size:12px;color:var(--muted)">${esc(profile.notes)}</p>` : ""}
    </article>
  `;
}

function renderKnowledgeBase() {
  const profiles = state.knowledgeProfiles || [];
  if (!profiles.length) {
    $("knowledgeBase").innerHTML = `<p class="muted">No knowledge profiles yet. Import mbox data or run a batch PDF scan to start learning.</p>`;
    return;
  }
  const sorted = [...profiles].sort((a, b) =>
    (b.projectCount - a.projectCount) || (b.correctionCount - a.correctionCount) || a.state.localeCompare(b.state),
  );
  const learned = sorted.filter((p) => (p.sources || []).some((s) => ["learned_batch_import", "learned_correction", "learned_project", "learned_permit_status"].includes(s.sourceType)));
  const seeded = sorted.filter((p) => !learned.includes(p));
  const totalLearned = learned.length;
  const totalDocs = learned.reduce((n, p) => n + (p.requiredDocuments || []).length, 0);
  const totalCorrections = learned.reduce((n, p) => n + p.correctionCount, 0);

  let html = `
    <div style="background:var(--surface-2,#f5f5f5);border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:13px">
      <strong>KB Summary:</strong>
      ${sorted.length} profile(s) total —
      ${totalLearned} learned (${totalDocs} required-doc entries, ${totalCorrections} corrections),
      ${seeded.length} seeded/reference.
    </div>
  `;

  if (learned.length) {
    html += `<h3 style="font-size:13px;margin:8px 0 4px;font-weight:600">Learned profiles (${learned.length})</h3>`;
    html += learned.map(renderKnowledgeProfile).join("");
  }
  if (seeded.length) {
    const showSeeded = state.kbShowSeeded;
    html += `
      <button type="button" id="kbToggleSeeded" style="font-size:12px;background:none;border:none;color:var(--accent,#0066cc);cursor:pointer;padding:4px 0;margin-top:6px">
        ${showSeeded ? "▾ Hide" : "▸ Show"} ${seeded.length} seeded/reference profile(s)
      </button>
    `;
    if (showSeeded) {
      html += `<div id="kbSeededList">${seeded.map(renderKnowledgeProfile).join("")}</div>`;
    }
  }
  $("knowledgeBase").innerHTML = html;
  const toggleBtn = $("kbToggleSeeded");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      state.kbShowSeeded = !state.kbShowSeeded;
      renderKnowledgeBase();
    });
  }
}

async function selectProject(projectId) {
  state.selectedProjectId = projectId;
  state.detail = await api(`/api/projects/${projectId}`);
  state.workflow = null;
  state.applicationDocs = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  state.opsPlan = null;
  state.opsBrief = null;
  state.handoffPacket = null;
  state.communicationDrafts = null;
  state.runbook = null;
  state.liveReadiness = null;
  state.projectTimeline = null;
  state.processMap = null;
  state.installerPacket = null;
  state.submitGate = null;
  $("emptyState").hidden = true;
  $("detailView").hidden = false;
  clearMessage();
  renderProjects();
  renderOpsBoard();
  renderOpsActions();
  await loadKnowledgeBase();
  await Promise.all([loadOpsPlan(), loadSubmitGate(), loadRunbook(), loadHandoffPacket(), loadCommunicationDrafts(), loadLiveReadiness(), loadProjectTimeline(), loadProcessMap(), loadInstallerPacket()]);
  renderDetail();
}

function renderHandoffBanner() {
  const { project, projectNotes } = state.detail;
  let banner = $("handoffBanner");
  if (!banner) return;
  if (project.status !== "handoff_ready") { banner.hidden = true; return; }
  const handoffNote = (projectNotes || []).find((n) => n.noteType === "handoff");
  banner.hidden = false;
  banner.innerHTML = `
    <div class="handoff-banner-head">
      <span>✓ Permit Issued + NEM Approved — Ready for installer handoff</span>
    </div>
    ${handoffNote ? `<pre class="handoff-checklist">${esc(handoffNote.body)}</pre>` : ""}
  `;
}

// Friendly display labels for every canonical ProjectStatus (shared/src/types.ts).
const STATUS_LABELS = {
  intake_uploaded: "Intake uploaded",
  parsed: "Parsed",
  qc_failed: "QC failed",
  qc_passed: "QC passed",
  ready_to_stage: "Ready to stage",
  submit_staging: "Submit staging",
  awaiting_human_submit: "Awaiting human submit",
  submitted: "Submitted",
  correction_received: "Correction received",
  correction_triaged: "Correction triaged",
  waiting_on_designer: "Waiting on designer",
  ready_to_resubmit: "Ready to resubmit",
  resubmit_staging: "Resubmit staging",
  awaiting_human_resubmit: "Awaiting human resubmit",
  ready_for_issue: "Ready for issue",
  issued: "Permit issued",
  approved: "Approved",
  nem_approved: "NEM approved",
  handoff_ready: "Ready for handoff",
  blocked: "Blocked",
};

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "unknown").replaceAll("_", " ");
}

// Plain-language "what do I do next" guidance for every canonical status.
// tone: "info" (blue, normal), "warn" (amber, needs attention), "done" (green).
const NEXT_STEPS = {
  intake_uploaded: { tone: "warn", step: "Step 1", text: "Files uploaded but not parsed yet. Open the <strong>Parser</strong>, click <strong>Parse</strong>, then <strong>Save to project</strong>." },
  parsed: { tone: "info", step: "Step 2", text: "Parsed. Click <strong>2 · Run QC</strong> to check the data for missing or wrong info." },
  qc_failed: { tone: "warn", step: "Step 2", text: "QC found problems. Open <strong>QC Results</strong> below, fix the flagged fields, then click <strong>2 · Run QC</strong> again." },
  qc_passed: { tone: "info", step: "Step 3", text: "QC passed. Click <strong>3 · Build AHJ/NEM Docs</strong>, then <strong>4 · Reviewer Gate</strong>." },
  ready_to_stage: { tone: "info", step: "Step 4", text: "Docs built. Click <strong>4 · Reviewer Gate</strong>, then <strong>5 · Prepare Submittal</strong>." },
  submit_staging: { tone: "info", step: "Step 5", text: "Staging for submission. Click <strong>5 · Prepare Submittal</strong> to finish staging." },
  awaiting_human_submit: { tone: "warn", step: "Step 5", text: "Staged and ready. <strong>A person must do the final submit</strong> in the portal now — automation stops here." },
  submitted: { tone: "info", step: "Step 6", text: "Submitted. Track it with <strong>Permit Checks</strong> / <strong>NEM Checks</strong>. Paste any correction letter into <strong>Corrections</strong>." },
  correction_received: { tone: "warn", step: "Step 6", text: "A correction came in. Open <strong>Corrections</strong> to triage it — the AI drafts a reply you review before sending." },
  correction_triaged: { tone: "warn", step: "Step 6", text: "Correction triaged. Fix the docs per the reply, then move the project to <strong>Ready to resubmit</strong>." },
  waiting_on_designer: { tone: "warn", step: "Step 6", text: "Waiting on the designer to revise stamped plans. Follow up if it has been a while." },
  ready_to_resubmit: { tone: "info", step: "Step 5", text: "Revisions done. Click <strong>5 · Prepare Submittal</strong> to re-stage for resubmission." },
  resubmit_staging: { tone: "info", step: "Step 5", text: "Staging the resubmission. Click <strong>5 · Prepare Submittal</strong> to finish." },
  awaiting_human_resubmit: { tone: "warn", step: "Step 5", text: "Resubmission staged. <strong>A person must do the final resubmit</strong> in the portal — automation stops here." },
  ready_for_issue: { tone: "info", step: "Step 6", text: "Approved — issuance/fees pending. Confirm the permit is issued, then keep tracking NEM." },
  issued: { tone: "info", step: "Step 6", text: "Permit issued. Waiting on <strong>NEM approval</strong> to finish — keep running NEM Checks." },
  approved: { tone: "info", step: "Step 6", text: "Approved. Confirm both permit issued and NEM approved to reach handoff." },
  nem_approved: { tone: "info", step: "Step 7", text: "NEM approved. Once the permit is also issued, you will reach handoff." },
  handoff_ready: { tone: "done", step: "Done", text: "Permit issued + NEM approved. Copy the <strong>Project Handoff Packet</strong> to the installer. PTO is the installer's job — our scope ends here." },
  blocked: { tone: "warn", step: "Blocked", text: "This project is blocked — see the red items below. Clear the blocker, then continue the steps." },
};

function nextStepFor(status) {
  return NEXT_STEPS[status] || { tone: "info", step: "Step 2", text: "Click <strong>2 · Run QC</strong> to check the parsed data for missing or wrong info." };
}

function renderNextStep() {
  const banner = $("nextStepBanner");
  if (!banner) return;
  const { project } = state.detail;
  if (!project) { banner.hidden = true; return; }
  const guide = nextStepFor(project.status);
  banner.hidden = false;
  banner.className = `next-step-banner${guide.tone === "done" ? " is-done" : guide.tone === "warn" ? " is-warn" : ""}`;
  banner.innerHTML = `<span class="next-step-step">${esc(guide.step)}</span><span class="next-step-text">${guide.text}</span>`;
}

function renderDetail() {
  const { project } = state.detail;
  $("detailTitle").textContent = project.homeownerName || "Unnamed project";
  $("detailSubtitle").textContent = project.projectAddress || "No address captured";
  $("metricStatus").textContent = statusLabel(project.status);
  $("metricUtility").textContent = project.utility || "Missing";
  $("metricAhj").textContent = project.ahj || "Missing";
  $("metricSystem").textContent = `${project.systemSizeDcKw ?? "?"} DC / ${project.systemSizeAcKw ?? "?"} AC`;
  $("metricPermit").textContent = state.processMap
    ? `Permit ${state.processMap.permitStatus.replaceAll("_", " ")} / NEM ${state.processMap.nemStatus.replaceAll("_", " ")}`
    : "Not checked";
  syncProjectClientSelect();
  renderNextStep();
  renderHandoffBanner();
  syncPermitForm();
  renderWorkflow();
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderProcessMap();
  renderInstallerPacket();
  // Auto-open the "later steps" accordion if any panel has real data
  const laterAccordion = $("laterStepsAccordion");
  if (laterAccordion) {
    const hasLaterData = state.opsBrief || state.handoffPacket || state.communicationDrafts?.length || state.runbook || state.processMap || state.installerPacket;
    laterAccordion.open = Boolean(hasLaterData);
  }
  renderOpsPlan();
  renderLiveTestReadiness();
  renderHistoricalFailures();
  renderReviewerGate();
  renderQc();
  renderReview();
  renderApplicationDocs();
  renderPermitMonitor();
  renderCorrections();
  renderPortalRuns();
  renderProjectTimeline();
  renderAudit();
  if (window.lucide) window.lucide.createIcons();
}

function opsClass(status) {
  if (status === "blocked") return "blocker";
  if (status === "waiting") return "warning";
  if (status === "done") return "pass";
  return "info";
}

function briefClass(value) {
  if (value === "blocked" || value === "blocker") return "blocker";
  if (value === "watch" || value === "warning") return "warning";
  if (value === "ready" || value === "pass") return "pass";
  return "info";
}

function submitGateClass(value) {
  if (value === "blocked" || value === "blocker") return "blocker";
  if (value === "staged_awaiting_human" || value === "warning") return "warning";
  if (value === "ready_to_stage" || value === "submitted_tracking" || value === "pass") return "pass";
  return "info";
}

function renderSubmitGate() {
  const gate = state.submitGate;
  if (!gate) {
    $("submitGateStatus").textContent = "not synced";
    $("submitGate").innerHTML = `<p class="muted">Open a project to generate the PermitFlow + NEMflow submit gate.</p>`;
    $("copySubmitGateBtn").disabled = true;
    $("prepareBtn").disabled = false;
    $("prepareBtn").title = "";
    return;
  }
  $("copySubmitGateBtn").disabled = !gate.reportText;
  $("submitGateStatus").textContent = gate.decision.replaceAll("_", " ");
  $("prepareBtn").disabled = !gate.canPrepareSubmission;
  $("prepareBtn").title = gate.canPrepareSubmission ? "Stage to final review. Human submit remains manual." : gate.nextAction || "Submit gate is not ready.";
  const checks = gate.checks || [];
  const manualItems = gate.manualSubmitChecklist || [];
  const blockers = checks.filter((check) => check.status === "blocker");
  const warnings = checks.filter((check) => check.status === "warning");
  const importantChecks = [
    ...blockers,
    ...warnings,
    ...checks.filter((check) => check.status === "pass"),
  ].slice(0, 10);
  $("submitGate").innerHTML = `
    <article class="item ${submitGateClass(gate.decision)}">
      <div class="item-title"><span>${esc(gate.headline)}</span>${statusBadge(gate.decision.replaceAll("_", " "))}</div>
      <p><strong>Next action:</strong> ${esc(gate.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${gate.blockerCount || 0} blockers</span>
        <span>${gate.warningCount || 0} warnings</span>
        <span>${gate.passCount || 0} pass</span>
        <span>${gate.canPrepareSubmission ? "can stage" : "do not stage"}</span>
        <span>${gate.canHumanSubmit ? "human submit ready" : "no human submit"}</span>
      </div>
    </article>
    <div class="submit-gate-grid">
      <article class="submit-gate-manual">
        <div class="item-title"><span>Manual Submit Guardrail</span>${statusBadge("human only")}</div>
        <ul class="manual-submit-list">
          ${manualItems.slice(0, 7).map((item) => `<li>${esc(item)}</li>`).join("")}
        </ul>
      </article>
      <article class="submit-gate-focus">
        <div class="item-title"><span>Focus Checks</span>${statusBadge(importantChecks.length)}</div>
        <div class="submit-gate-checks">
          ${importantChecks.length ? importantChecks.map((check) => `
            <article class="submit-gate-check ${briefClass(check.status)}">
              <div class="item-title">
                <span>${esc(check.title)}</span>
                ${statusBadge(`${check.lane} | ${check.status}`)}
              </div>
              <p><strong>Owner:</strong> ${esc(check.ownerRole)}<br><strong>Next:</strong> ${esc(check.nextAction)}</p>
              <p class="muted">${esc(check.requirement)}</p>
              ${(check.evidence || []).length ? `<ul class="evidence-list">${check.evidence.slice(0, 4).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
              <p class="muted">${esc(check.source)}</p>
            </article>
          `).join("") : `<p class="muted">No submit gate checks generated yet.</p>`}
        </div>
      </article>
    </div>
  `;
}

function renderOpsBrief() {
  const brief = state.opsBrief;
  if (!brief) {
    $("opsBriefStatus").textContent = "not synced";
    $("opsBrief").innerHTML = `<p class="muted">Open or sync a project to generate the PM brief.</p>`;
    $("copyHandoffBtn").disabled = true;
    return;
  }
  $("copyHandoffBtn").disabled = !brief.handoffNote;
  $("opsBriefStatus").textContent = brief.health;
  const counts = brief.counts || {};
  const actions = brief.immediateActions || [];
  const blockers = brief.blockers || [];
  const ready = brief.readySignals || [];
  const activity = brief.recentActivity || [];
  $("opsBrief").innerHTML = `
    <article class="item ${briefClass(brief.health)}">
      <div class="item-title"><span>${esc(brief.headline)}</span>${statusBadge(brief.currentPhase)}</div>
      <p><strong>Next action:</strong> ${esc(brief.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${counts.blocked || 0} blocked</span>
        <span>${counts.waiting || 0} waiting</span>
        <span>${counts.in_progress || 0} active</span>
        <span>${counts.not_started || 0} not started</span>
        <span>${counts.done || 0} done</span>
      </div>
    </article>
    <div class="brief-grid">
      <article class="brief-section">
        <div class="item-title"><span>Action Queue</span>${statusBadge(actions.length)}</div>
        ${actions.length ? actions.map((item) => `
          <div class="brief-row ${opsClass(item.status)}">
            <strong>${esc(item.phaseName)}</strong>
            <p>${esc(item.action)}</p>
            <span>${esc(item.ownerRole || "Unassigned")}${item.dueAt ? ` | Due ${esc(item.dueAt)}` : ""}</span>
          </div>
        `).join("") : `<p class="muted">No active actions. Keep monitoring approvals and email.</p>`}
      </article>
      <article class="brief-section">
        <div class="item-title"><span>Blockers</span>${statusBadge(blockers.length)}</div>
        ${blockers.length ? blockers.map((item) => `
          <div class="brief-row ${briefClass(item.severity)}">
            <strong>${esc(item.title)}</strong>
            <p>${esc(item.detail)}</p>
            <span>${esc(item.source)}</span>
          </div>
        `).join("") : `<p class="muted">No blockers currently flagged.</p>`}
      </article>
      <article class="brief-section">
        <div class="item-title"><span>Ready Signals</span>${statusBadge(ready.length)}</div>
        ${ready.length ? ready.slice(0, 6).map((item) => `
          <div class="brief-row ${briefClass(item.severity)}">
            <strong>${esc(item.title)}</strong>
            <p>${esc(item.detail)}</p>
            <span>${esc(item.source)}</span>
          </div>
        `).join("") : `<p class="muted">Run workflow/QC/reviewer/docs to build ready signals.</p>`}
      </article>
      <article class="brief-section">
        <div class="item-title"><span>Recent Activity</span>${statusBadge(activity.length)}</div>
        ${activity.length ? activity.slice(0, 6).map((item) => `
          <div class="brief-row ${briefClass(item.severity)}">
            <strong>${esc(item.title)}</strong>
            <p>${esc(item.detail)}</p>
            <span>${esc(new Date(item.occurredAt).toLocaleString())} | ${esc(item.source)}</span>
          </div>
        `).join("") : `<p class="muted">No recent activity yet.</p>`}
      </article>
    </div>
  `;
}

function renderRunbook() {
  const runbook = state.runbook;
  if (!runbook) {
    $("runbookStatus").textContent = "not synced";
    $("runbook").innerHTML = `<p class="muted">Open a project to generate the PM runbook.</p>`;
    $("copyRunbookBtn").disabled = true;
    return;
  }
  $("copyRunbookBtn").disabled = !runbook.reportText;
  $("runbookStatus").textContent = runbook.status.replaceAll("_", " ");
  const steps = runbook.steps || [];
  const notes = runbook.recentNotes || [];
  const currentStep = steps.find((step) => step.isCurrent) || steps.find((step) => ["blocked", "waiting", "in_progress", "not_started"].includes(step.status));
  $("runbook").innerHTML = `
    <article class="item ${opsClass(runbook.status)}">
      <div class="item-title"><span>${esc(runbook.headline)}</span>${statusBadge(`${runbook.doneCount || 0}/${runbook.totalSteps || 0} done`)}</div>
      <p><strong>Next action:</strong> ${esc(runbook.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${runbook.blockedCount || 0} blocked</span>
        <span>${runbook.waitingCount || 0} waiting</span>
        <span>${runbook.inProgressCount || 0} active</span>
        <span>${runbook.noteCount || 0} notes</span>
      </div>
      ${currentStep ? `
        <div class="runbook-current-update">
          <div class="item-title"><span>Current Step Update</span>${statusBadge(currentStep.phaseName)}</div>
          <div class="runbook-update-controls">
            <label>Status<select id="runbookQuickStatus">${opsStatusOptions(currentStep.status)}</select></label>
            <label>Owner<input id="runbookQuickOwner" value="${esc(currentStep.ownerRole || "Operations")}" /></label>
            <label>Due<input id="runbookQuickDue" type="date" value="${esc(currentStep.dueAt || "")}" /></label>
            <button id="runbookQuickSaveBtn" class="primary" type="button"><i data-lucide="save"></i><span>Save Current</span></button>
          </div>
          <textarea id="runbookQuickNotes" placeholder="PM note for the current step">${esc(currentStep.notes || "")}</textarea>
        </div>
      ` : ""}
    </article>
    <div class="runbook-steps">
      ${steps.map((step, index) => `
        <article class="runbook-step ${opsClass(step.status)} ${step.isCurrent ? "current" : ""}">
          <div class="item-title">
            <span>${index + 1}. ${esc(step.phaseName)}</span>
            ${statusBadge(step.isCurrent ? `${step.status.replaceAll("_", " ")} current` : step.status.replaceAll("_", " "))}
          </div>
          <p><strong>Do:</strong> ${esc(step.whatToDo)}</p>
          <p><strong>Why:</strong> ${esc(step.why)}</p>
          <p class="muted">${esc(step.ownerRole || "Operations")}${step.dueAt ? ` | Due ${esc(step.dueAt)}` : ""} | ${esc(step.source)}</p>
          ${(step.doneCriteria || []).length ? `<div class="done-criteria"><strong>Done when</strong><ul>${step.doneCriteria.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></div>` : ""}
          ${(step.evidence || []).length ? `<ul class="evidence-list">${step.evidence.slice(0, 4).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
          ${step.notes ? `<p><strong>PM note:</strong> ${esc(step.notes)}</p>` : ""}
        </article>
      `).join("")}
    </div>
    <div class="runbook-notes">
      <div class="item-title"><span>Recent PM Notes</span>${statusBadge(notes.length)}</div>
      ${notes.length ? notes.slice(0, 5).map((note) => `
        <article class="brief-row ${note.noteType === "blocker" ? "blocker" : "info"}">
          <strong>${esc(note.noteType.replaceAll("_", " "))}</strong>
          <p>${esc(note.body)}</p>
          <span>${esc(note.createdBy || "Operations")} | ${esc(new Date(note.createdAt).toLocaleString())}</span>
        </article>
      `).join("") : `<p class="muted">No PM notes yet.</p>`}
    </div>
  `;
  const quickSave = $("runbookQuickSaveBtn");
  if (quickSave) quickSave.addEventListener("click", saveRunbookCurrentStep);
}

function renderHandoffPacket() {
  const packet = state.handoffPacket;
  if (!packet) {
    $("handoffPacketStatus").textContent = "not synced";
    $("handoffPacket").innerHTML = `<p class="muted">Open a project to generate the project handoff packet.</p>`;
    $("copyHandoffPacketBtn").disabled = true;
    return;
  }
  $("copyHandoffPacketBtn").disabled = !packet.reportText;
  $("handoffPacketStatus").textContent = packet.health;
  const sections = packet.sections || [];
  $("handoffPacket").innerHTML = `
    <article class="item ${briefClass(packet.health)}">
      <div class="item-title"><span>${esc(packet.headline)}</span>${statusBadge(packet.readinessStatus.replaceAll("_", " "))}</div>
      <p><strong>Current:</strong> ${esc(packet.currentPhase)}<br><strong>Next:</strong> ${esc(packet.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${packet.blockerCount || 0} blockers</span>
        <span>${packet.actionCount || 0} actions</span>
        <span>${packet.timelineEventCount || 0} events</span>
        <span>${(packet.ownerRoles || []).length} owners</span>
      </div>
      ${(packet.ownerRoles || []).length ? `<p class="muted">Owners: ${esc(packet.ownerRoles.join(", "))}</p>` : ""}
    </article>
    <div class="handoff-sections">
      ${sections.map((section) => `
        <article class="handoff-section ${briefClass(section.severity)}">
          <div class="item-title">
            <span>${esc(section.title)}</span>
            ${statusBadge(section.severity)}
          </div>
          ${(section.lines || []).length ? `<ul class="evidence-list">${section.lines.slice(0, 8).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : `<p class="muted">No items.</p>`}
          <p class="muted">${esc(section.source)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderCommunicationDrafts() {
  const packet = state.communicationDrafts;
  if (!packet) {
    $("communicationDraftsStatus").textContent = "not synced";
    $("communicationDrafts").innerHTML = `<p class="muted">Open a project to generate communication drafts.</p>`;
    $("copyCommunicationDraftsBtn").disabled = true;
    return;
  }
  $("copyCommunicationDraftsBtn").disabled = !packet.reportText;
  $("communicationDraftsStatus").textContent = packet.status;
  const drafts = packet.drafts || [];
  $("communicationDrafts").innerHTML = `
    <article class="item ${briefClass(packet.status)}">
      <div class="item-title"><span>${esc(packet.headline)}</span>${statusBadge("draft only")}</div>
      <p><strong>Next action:</strong> ${esc(packet.nextAction)}</p>
      <p class="muted">Human review required before sending. The app does not send email or portal responses.</p>
    </article>
    <div class="communication-draft-list">
      ${drafts.map((draft, index) => `
        <article class="communication-draft ${briefClass(draft.severity)}">
          <div class="item-title">
            <span>${esc(draft.title)}</span>
            <button class="secondary compact-button" type="button" data-copy-draft="${index}"><i data-lucide="clipboard-copy"></i><span>Copy</span></button>
          </div>
          <p><strong>Subject:</strong> ${esc(draft.subject)}</p>
          <pre class="draft-body">${esc(draft.body)}</pre>
          <p class="muted">${esc(draft.audience.replaceAll("_", " "))} | ${esc(draft.source)}</p>
        </article>
      `).join("")}
    </div>
  `;
  $("communicationDrafts").querySelectorAll("button[data-copy-draft]").forEach((button) => {
    button.addEventListener("click", () => copyCommunicationDraft(Number(button.dataset.copyDraft)));
  });
}

function opsStatusOptions(selected) {
  return ["not_started", "in_progress", "waiting", "blocked", "done"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`)
    .join("");
}

function renderOpsPlan() {
  const plan = state.opsPlan;
  if (!plan) {
    $("opsPlanStatus").textContent = "not synced";
    $("opsPlan").innerHTML = `<p class="muted">Sync the operations plan to generate PM phases, owners, and next actions.</p>`;
    $("opsNotes").innerHTML = `<p class="muted">No PM notes yet.</p>`;
    return;
  }
  $("opsPlanStatus").textContent = plan.status.replaceAll("_", " ");
  const counts = plan.counts || {};
  $("opsPlan").innerHTML = `
    <article class="item ${opsClass(plan.status)}">
      <div class="item-title"><span>Current phase: ${esc(plan.currentPhase)}</span>${statusBadge(plan.status)}</div>
      <p><strong>Next action:</strong> ${esc(plan.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${counts.blocked || 0} blocked</span>
        <span>${counts.waiting || 0} waiting</span>
        <span>${counts.in_progress || 0} active</span>
        <span>${counts.not_started || 0} not started</span>
        <span>${counts.done || 0} done</span>
      </div>
    </article>
    <div class="ops-grid">
      ${(plan.steps || []).map((step) => `
        <article class="item ops-step ${opsClass(step.status)}">
          <div class="item-title"><span>${esc(step.phaseName)}</span>${statusBadge(step.statusSource === "manual" ? `${step.status} manual` : step.status)}</div>
          <p>${esc(step.summary)}</p>
          <p><strong>Next:</strong> ${esc(step.nextAction)}</p>
          <p class="muted">Owner: ${esc(step.ownerRole || "Unassigned")} ${step.dueAt ? `| Due ${esc(step.dueAt)}` : ""} | Source: ${esc(step.source)}</p>
          ${step.notes ? `<p><strong>PM note:</strong> ${esc(step.notes)}</p>` : ""}
          <div class="ops-controls">
            <label>Status<select id="ops-status-${step.id}">${opsStatusOptions(step.status)}</select></label>
            <label>Owner<input id="ops-owner-${step.id}" value="${esc(step.ownerRole || "")}" /></label>
            <label>Due<input id="ops-due-${step.id}" type="date" value="${esc(step.dueAt || "")}" /></label>
            <button class="secondary" data-ops-save="${step.id}"><i data-lucide="save"></i><span>Save</span></button>
          </div>
          <textarea id="ops-notes-${step.id}" placeholder="PM notes for this phase">${esc(step.notes || "")}</textarea>
        </article>
      `).join("")}
    </div>
  `;
  $("opsNotes").innerHTML = (plan.notes || []).length ? plan.notes.map((note) => `
    <article class="item ${note.noteType === "blocker" ? "blocker" : note.noteType === "client_update" ? "info" : "pass"}">
      <div class="item-title"><span>${esc(note.noteType.replaceAll("_", " "))}</span><span>${esc(new Date(note.createdAt).toLocaleString())}</span></div>
      <p>${esc(note.body)}</p>
      <p class="muted">${esc(note.createdBy || "Operations")}</p>
    </article>
  `).join("") : `<p class="muted">No PM notes yet.</p>`;

  $("opsPlan").querySelectorAll("button[data-ops-save]").forEach((button) => {
    button.addEventListener("click", () => saveOpsStep(button.dataset.opsSave));
  });
}

function renderLiveTestReadiness() {
  const report = state.liveReadiness;
  if (!report) {
    $("liveReadinessCounts").textContent = "not synced";
    $("liveReadiness").innerHTML = `<p class="muted">Open a project to generate the live-test readiness report.</p>`;
    const copy = $("copyLiveReadinessBtn");
    if (copy) copy.disabled = true;
    return;
  }
  const copy = $("copyLiveReadinessBtn");
  if (copy) copy.disabled = !report.reportText;
  $("liveReadinessCounts").textContent = `${report.doneCount}/${report.totalCount} ready`;
  $("liveReadiness").innerHTML = `
    <article class="item ${report.status === "blocked" ? "blocker" : report.status === "needs_review" ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(report.headline)}</span>${statusBadge(report.status.replaceAll("_", " "))}</div>
      <p><strong>Next action:</strong> ${esc(report.nextAction)}</p>
      <p>Use this as the live-project test path: parse, resolve blockers, build docs, rehearse mock staging, connect tracking/email, then perform a supervised real portal preview.</p>
    </article>
    ${(report.items || []).map((item) => `
      <div class="check-row ${item.status === "done" ? "present" : item.status === "blocked" ? "missing" : "needs_review"}">
        <strong>${esc(item.status.replaceAll("_", " ").toUpperCase())}: ${esc(item.title)}</strong>
        <p>${esc(item.detail)}</p>
        <p><strong>Owner:</strong> ${esc(item.ownerRole)} | <strong>Next:</strong> ${esc(item.nextAction)}</p>
        ${(item.evidence || []).length ? `<ul class="evidence-list">${item.evidence.slice(0, 3).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : `<p class="muted">No evidence captured yet.</p>`}
        <span class="muted">${esc(item.source)}</span>
      </div>
    `).join("")}
  `;
}

function renderProcessMap() {
  const map = state.processMap;
  if (!map) {
    $("processMapStatus").textContent = "not synced";
    $("processMap").innerHTML = `<p class="muted">Open a project to generate the PermitFlow + NEMflow map.</p>`;
    $("copyProcessMapBtn").disabled = true;
    return;
  }
  $("copyProcessMapBtn").disabled = !map.reportText;
  $("processMapStatus").textContent = map.status.replaceAll("_", " ");
  $("processMap").innerHTML = `
    <article class="item ${opsClass(map.status)}">
      <div class="item-title"><span>${esc(map.headline)}</span>${statusBadge(`Permit ${map.permitStatus.replaceAll("_", " ")} / NEM ${map.nemStatus.replaceAll("_", " ")}`)}</div>
      <p><strong>Next action:</strong> ${esc(map.nextAction)}</p>
    </article>
    <div class="process-lanes">
      ${(map.lanes || []).map((lane) => `
        <article class="process-lane ${opsClass(lane.status)}">
          <div class="process-lane-head">
            <div>
              <strong>${esc(lane.title)}</strong>
              <span>${esc(lane.summary)}</span>
            </div>
            ${statusBadge(lane.status.replaceAll("_", " "))}
          </div>
          <p><strong>Current:</strong> ${esc(lane.currentStep)}<br><strong>Next:</strong> ${esc(lane.nextAction)}</p>
          <div class="process-steps">
            ${(lane.steps || []).map((step) => `
              <div class="process-step ${opsClass(step.status)}">
                <div class="item-title"><span>${esc(step.label)}</span>${statusBadge(step.status.replaceAll("_", " "))}</div>
                <p>${esc(step.summary)}</p>
                <p class="muted">${esc(step.ownerRole)} | ${esc(step.source)}</p>
                <p><strong>Next:</strong> ${esc(step.nextAction)}</p>
                ${(step.evidence || []).length ? `<ul class="evidence-list">${step.evidence.slice(0, 2).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
              </div>
            `).join("")}
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderInstallerPacket() {
  const packet = state.installerPacket;
  if (!packet) {
    $("installerPacketStatus").textContent = "not synced";
    $("installerPacket").innerHTML = `<p class="muted">Open a project to generate installer/design action requests.</p>`;
    $("copyInstallerPacketBtn").disabled = true;
    return;
  }
  $("copyInstallerPacketBtn").disabled = !packet.reportText;
  $("installerPacketStatus").textContent = packet.status.replaceAll("_", " ");
  const items = packet.items || [];
  $("installerPacket").innerHTML = `
    <article class="item ${packet.status === "blocked" ? "blocker" : packet.status === "needs_action" ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(packet.headline)}</span>${statusBadge(`${packet.nemActionCount || 0} NEM`)}</div>
      <p><strong>Next action:</strong> ${esc(packet.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${packet.blockerCount || 0} blockers</span>
        <span>${packet.warningCount || 0} warnings</span>
        <span>${packet.installerActionCount || 0} installer</span>
        <span>${packet.designActionCount || 0} design</span>
      </div>
    </article>
    <div class="installer-action-list">
      ${items.length ? items.slice(0, 18).map((item) => `
        <article class="installer-action ${briefClass(item.severity)}">
          <div class="item-title">
            <span>${esc(item.title)}</span>
            ${statusBadge(item.category.replaceAll("_", " "))}
          </div>
          <p><strong>Ask:</strong> ${esc(item.ask)}</p>
          <p><strong>Why:</strong> ${esc(item.why)}</p>
          <p class="muted">${esc(item.ownerRole)} | ${esc(item.dueBefore)} | ${esc(item.source)}</p>
          ${(item.evidence || []).length ? `<ul class="evidence-list">${item.evidence.slice(0, 3).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
        </article>
      `).join("") : `<p class="muted">No installer/design actions are currently blocking the package.</p>`}
    </div>
  `;
}

function renderProjectTimeline() {
  const report = state.projectTimeline;
  if (!report) {
    $("timelineCounts").textContent = "not synced";
    $("projectTimeline").innerHTML = `<p class="muted">Project timeline has not loaded yet.</p>`;
    $("copyTimelineBtn").disabled = true;
    return;
  }
  $("copyTimelineBtn").disabled = !report.reportText;
  $("timelineCounts").textContent = `${report.totalEvents || 0} events`;
  const events = report.events || [];
  $("projectTimeline").innerHTML = `
    <article class="item ${report.blockerCount ? "blocker" : report.warningCount ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(report.headline)}</span>${statusBadge(`${report.blockerCount || 0} blockers`)}</div>
      <p>${report.latestActivityAt ? `Latest activity: ${esc(new Date(report.latestActivityAt).toLocaleString())}` : "No activity recorded yet."}</p>
      <div class="ops-status-strip">
        <span>${report.totalEvents || 0} events</span>
        <span>${report.warningCount || 0} warnings</span>
        <span>${report.emailCount || 0} emails</span>
        <span>${report.correctionCount || 0} corrections</span>
      </div>
    </article>
    ${events.length ? events.slice(0, 24).map((event) => `
      <article class="timeline-item ${briefClass(event.severity)}">
        <div class="item-title">
          <span>${esc(event.title)}</span>
          ${statusBadge(event.category.replaceAll("_", " "))}
        </div>
        <p>${esc(event.detail)}</p>
        <p class="timeline-meta">${esc(new Date(event.occurredAt).toLocaleString())} | ${esc(event.actor || "system")} | ${esc(event.source || "source")}</p>
        ${event.ownerRole || event.nextAction ? `<p><strong>Owner:</strong> ${esc(event.ownerRole || "Operations")} ${event.nextAction ? `| <strong>Next:</strong> ${esc(event.nextAction)}` : ""}</p>` : ""}
        ${(event.evidence || []).length ? `<ul class="evidence-list">${event.evidence.slice(0, 3).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
      </article>
    `).join("") : `<p class="muted">No timeline events yet.</p>`}
  `;
}

function renderWorkflow() {
  const workflow = state.workflow;
  const prepareBtn = $("prepareBtn");
  if (!workflow) {
    $("workflowStatus").textContent = "not run";
    $("workflowSteps").innerHTML = `
      <article class="item info">
        <div class="item-title"><span>Start here</span>${statusBadge("simple flow")}</div>
        <p>Run the workflow before submission. It checks historical failures, QC, city-reviewer blockers, AHJ/NEM docs, and staging readiness in order.</p>
      </article>
    `;
    prepareBtn.disabled = false;
    return;
  }

  $("workflowStatus").textContent = workflow.status.replaceAll("_", " ");
  prepareBtn.disabled = workflow.status === "blocked";
  $("workflowSteps").innerHTML = `
    <article class="item ${workflow.status === "blocked" ? "blocker" : workflow.status === "needs_review" ? "warning" : "pass"}">
      <div class="item-title"><span>Next action</span>${statusBadge(workflow.canPrepareSubmission ? "ready" : workflow.status)}</div>
      <p>${esc(workflow.nextAction)}</p>
    </article>
    ${workflow.steps.map((step) => `
      <article class="item ${step.status === "blocked" ? "blocker" : step.status === "needs_review" ? "warning" : step.status === "ready" ? "info" : "pass"}">
        <div class="item-title"><span>${esc(step.label)}</span>${statusBadge(step.status)}</div>
        <p>${esc(step.summary)}</p>
        <p class="muted">${esc(step.action)}</p>
      </article>
    `).join("")}
  `;
}

function renderHistoricalFailures() {
  const report = state.historicalReport;
  if (!report) {
    $("historicalCounts").textContent = "not run";
    $("historicalFailures").innerHTML = `<p class="muted">Run this before submission to compare the project against prior approved, delayed, and rejected patterns.</p>`;
    return;
  }
  const missing = report.checklist.filter((item) => item.status === "missing").length;
  const review = report.checklist.filter((item) => item.status === "needs_review").length;
  $("historicalCounts").textContent = `${report.matchedProjectCount} match / ${missing} missing`;
  $("historicalFailures").innerHTML = `
    <article class="item ${missing ? "warning" : "pass"}">
      <div class="item-title"><span>Historical match</span>${statusBadge(report.dataConfidence)}</div>
      <p>${esc(report.summaryLabel)}</p>
      <p class="muted">${esc(report.matchTags.slice(0, 12).join(", "))}</p>
    </article>
    <article class="item ${report.topRejectionCauses.some((cause) => cause.count > 0) ? "warning" : "info"}">
      <div class="item-title"><span>Top rejection causes</span>${statusBadge(report.topRejectionCauses.length)}</div>
      ${report.topRejectionCauses.map((cause) => `
        <div class="check-row ${esc(cause.severity || "callout")}">
          <strong>${esc(cause.title)}</strong> ${statusBadge(cause.severity || "callout")}
          <p>${cause.count ? `<strong>${cause.count} prior record(s)</strong>` : "Baseline rule (no learned records yet)"}${cause.rootCause ? ` · ${esc(cause.rootCause)}` : ""}. ${esc(cause.requiredAction)}</p>
          ${cause.sample ? `<p class="muted evidence-sample"><strong>Evidence:</strong> "${esc(String(cause.sample).slice(0, 280))}${String(cause.sample).length > 280 ? "…" : ""}"</p>` : `<p class="muted">No source excerpt — derived from a deterministic baseline rule.</p>`}
        </div>
      `).join("")}
    </article>
    <article class="item ${missing ? "blocker" : review ? "warning" : "pass"}">
      <div class="item-title"><span>Generated checklist</span>${statusBadge(`${missing} missing / ${review} review`)}</div>
      ${report.checklist.map((item) => `
        <div class="check-row ${esc(item.status)}">
          <strong>${esc(item.status.toUpperCase())}: ${esc(item.title)}</strong>
          <p>${esc(item.why)} ${esc(item.action)}</p>
          <p class="muted">${esc(item.evidence.join(", "))}</p>
        </div>
      `).join("")}
    </article>
  `;
}

function severityClass(severity) {
  if (severity === "blocker") return "blocker";
  if (severity === "warning") return "warning";
  if (severity === "pass") return "pass";
  return "info";
}

function renderCodeRefs(refs = []) {
  if (!refs.length) return "";
  return `
    <div class="code-refs">
      ${refs.map((ref) => `
        <p><strong>${esc(ref.code)} ${esc(ref.section)}</strong> | ${esc(ref.title)}<br><span class="muted">${esc(ref.adoptionScope || "")}</span></p>
      `).join("")}
    </div>
  `;
}

function renderFindingEvidence(finding) {
  const evidence = finding.evidenceFound || [];
  if (!evidence.length) return "";
  const visible = evidence.slice(0, 4);
  return `
    <div class="evidence-trail">
      <p><strong>Evidence check:</strong> ${esc(finding.evidenceStatus || "unknown")}</p>
      ${visible.map((item) => {
        if (item.kind === "screenshot_placeholder") {
          return `<div class="evidence-card screenshot-slot"><strong>${esc(item.label)}</strong><br><span>${esc(item.note || "Screenshot/crop pending.")}</span></div>`;
        }
        return `
          <div class="evidence-card">
            <strong>${esc(item.label)}</strong>
            <p>${esc(item.excerpt || item.note || "")}</p>
            <span class="muted">${esc(item.source || "")}${item.pageHint ? ` | ${esc(item.pageHint)}` : ""} | ${esc(item.confidence || "unknown")} confidence</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderReviewerGate() {
  const report = state.reviewerReport;
  if (!report) {
    $("reviewerCounts").textContent = "not run";
    $("reviewerGate").innerHTML = `<p class="muted">Run the reviewer gate to generate city-style correction comments, code anchors, and installer callouts before staging.</p>`;
    return;
  }
  const blockers = report.findings.filter((item) => item.severity === "blocker");
  const warnings = report.findings.filter((item) => item.severity === "warning");
  $("reviewerCounts").textContent = `${blockers.length} blocker / ${warnings.length} warn`;
  const topFindings = report.findings.slice(0, 18);
  $("reviewerGate").innerHTML = `
    <article class="item ${blockers.length ? "blocker" : warnings.length ? "warning" : "pass"}">
      <div class="item-title"><span>Final submit gate</span>${statusBadge(report.finalSubmitGate.finalSubmitButtonAloneIsEnough ? "button enough" : "preview required")}</div>
      <p>Submit button alone is ${report.finalSubmitGate.finalSubmitButtonAloneIsEnough ? "enough" : "not enough"}. The real AHJ/utility preview window or this internal correction packet must be visible before a human submits.</p>
      <p class="muted">${report.matchedProcessProfile ? `Matched profile: ${esc(report.matchedProcessProfile.state)} / ${esc(report.matchedProcessProfile.ahj)} / ${esc(report.matchedProcessProfile.submissionMethod)}` : "No seeded AHJ process profile matched."}</p>
    </article>
    ${topFindings.map((finding) => `
      <article class="item ${severityClass(finding.severity)}">
        <div class="item-title"><span>${esc(finding.title)}</span>${statusBadge(finding.severity)}</div>
        <p><strong>Reviewer comment:</strong> ${esc(finding.cityFeedback || finding.message)}</p>
        <p><strong>Correction:</strong> ${esc(finding.designTeamAction || "Resolve before submittal.")}</p>
        ${finding.evidenceNeeded?.length ? `<p><strong>Evidence:</strong> ${esc(finding.evidenceNeeded.join(", "))}</p>` : ""}
        ${renderFindingEvidence(finding)}
        ${renderCodeRefs(finding.codeReferences)}
      </article>
    `).join("")}
    ${report.installerCallouts.length ? `
      <article class="item info">
        <div class="item-title"><span>Installer callouts before submittal</span>${statusBadge(report.installerCallouts.length)}</div>
        ${report.installerCallouts.slice(0, 8).map((item) => `<p>${esc(item.designTeamAction || item.message)}</p>`).join("")}
      </article>
    ` : ""}
  `;
}

function syncPermitForm() {
  const target = state.detail.permitCheckTargets?.[0];
  const project = state.detail.project;
  $("permitJurisdiction").value = target?.jurisdiction || project.ahj || "";
  $("permitPortalName").value = target?.portalName || "";
  $("permitPortalUrl").value = target?.portalUrl || "";
  $("permitApplicationNumber").value = target?.applicationNumber || latestSubmissionValue("applicationNumber") || "";
  $("permitTrackingNumber").value = target?.permitNumber || latestSubmissionValue("permitNumber") || "";
  $("permitCheckFrequencyDays").value = target?.checkFrequencyDays || 7;
}

function latestSubmissionValue(key) {
  const submission = state.detail.submissions?.find((item) => item[key]);
  return submission?.[key] || "";
}

function renderQc() {
  const results = state.detail.qcResults || [];
  const fails = results.filter((x) => x.qcStatus === "fail").length;
  const warnings = results.filter((x) => x.qcStatus === "warning").length;
  $("qcCounts").textContent = `${fails} fail / ${warnings} warn`;
  $("qcResults").innerHTML = results.length ? results.map((result) => `
    <article class="item ${esc(result.qcStatus)}">
      <div class="item-title"><span>${esc(result.ruleName)}</span>${statusBadge(result.qcStatus)}</div>
      <p>${esc(result.message)}</p>
    </article>
  `).join("") : `<p class="muted">No QC results yet.</p>`;
}

function renderReview() {
  const items = state.detail.humanReviewItems || [];
  const pending = items.filter((x) => x.status === "pending");
  $("reviewCounts").textContent = `${pending.length} pending`;
  $("reviewItems").innerHTML = items.length ? items.map((item) => `
    <article class="item ${item.status === "pending" ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(item.issueType)}: ${esc(item.fieldName)}</span>${statusBadge(item.status)}</div>
      <p>${esc(item.notes || "Review required.")}</p>
      ${item.sourceExcerpt ? `<p><strong>Source:</strong> ${esc(item.sourceExcerpt)}</p>` : ""}
      ${item.status === "pending" ? `
        <div class="review-actions">
          <input id="review-${item.id}" value="${esc(item.llmSuggestedValue || item.parserValue)}" placeholder="Verified value" />
          <div class="actions">
            <button class="secondary" data-review-action="reject" data-review-id="${item.id}"><i data-lucide="x"></i><span>Reject</span></button>
            <button class="secondary" data-review-action="approve" data-review-id="${item.id}"><i data-lucide="check"></i><span>Approve</span></button>
            <button class="primary" data-review-action="edit" data-review-id="${item.id}"><i data-lucide="pencil"></i><span>Save Edit</span></button>
          </div>
        </div>
      ` : ""}
    </article>
  `).join("") : `<p class="muted">No human review items.</p>`;

  $("reviewItems").querySelectorAll("button[data-review-action]").forEach((button) => {
    button.addEventListener("click", () => updateReview(button.dataset.reviewId, button.dataset.reviewAction));
  });
}

function renderApplicationDocs() {
  const pkg = state.applicationDocs;
  if (!pkg) {
    $("applicationDocs").innerHTML = `<p class="muted">Build the AHJ docs to see required forms for this jurisdiction.</p>`;
    return;
  }
  $("applicationDocs").innerHTML = `
    <article class="item ${pkg.missingFields?.length ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(pkg.profile.name)}</span>${statusBadge(pkg.profile.requiresAhjApplication || pkg.profile.requiresPortalEntryOnly ? "docs required" : "manifest only")}</div>
      <p>${pkg.profile.notes.map(esc).join("<br>")}</p>
      ${pkg.missingFields?.length ? `<p><strong>Missing fields:</strong> ${esc(pkg.missingFields.join(", "))}</p>` : "<p>No critical document fields missing from the generated packet.</p>"}
    </article>
    ${pkg.docs.map((doc) => `
      <article class="item ${doc.required ? "info" : "pass"}">
        <div class="item-title"><span>${esc(doc.title)}</span>${statusBadge(doc.required ? "required" : "optional")}</div>
        <p class="muted">${esc(doc.fileName)} | ${esc(doc.documentType)}</p>
      </article>
    `).join("")}
  `;
}

function renderPermitMonitor() {
  const targets = state.detail.permitCheckTargets || [];
  const checks = state.detail.permitStatusChecks || [];
  const emailMatches = state.detail.emailProjectMatches || [];

  $("permitTargets").innerHTML = targets.length ? targets.map((target) => `
    <article class="item info">
      <div class="item-title"><span>${esc(target.portalName || target.jurisdiction || "Permit target")}</span>${statusBadge(target.latestOutcome || "active")}</div>
      <p>${esc([target.applicationNumber && `Application ${target.applicationNumber}`, target.permitNumber && `Permit ${target.permitNumber}`].filter(Boolean).join(" | ") || "No application/permit number recorded yet.")}</p>
      <p class="muted">Every ${target.checkFrequencyDays} day(s). Next check: ${target.nextCheckAt ? esc(new Date(target.nextCheckAt).toLocaleString()) : "not scheduled"}</p>
    </article>
  `).join("") : `<p class="muted">No permit check targets yet.</p>`;

  $("permitChecks").innerHTML = checks.length ? checks.map((check) => `
    <article class="item ${check.outcome === "correction_flagged" ? "fail" : check.readyForIssue ? "pass" : check.outcome === "needs_human_review" ? "warning" : "info"}">
      <div class="item-title"><span>${esc(check.statusLabel)}</span>${statusBadge(check.outcome)}</div>
      <p>${esc(check.message)}</p>
      <p class="muted">${esc(new Date(check.createdAt).toLocaleString())} | confidence ${Math.round((check.confidence || 0) * 100)}%</p>
      ${check.rawStatusText ? `<p class="muted">${esc(check.rawStatusText.slice(0, 600))}</p>` : ""}
    </article>
  `).join("") : `<p class="muted">No permit status checks yet.</p>`;

  if (emailMatches.length) {
    $("permitChecks").innerHTML += `
      <article class="item info">
        <div class="item-title"><span>Matched email updates</span>${statusBadge(emailMatches.length)}</div>
        ${emailMatches.slice(0, 6).map((match) => `
          <p><strong>${esc(match.emailBucket.replaceAll("_", " "))}</strong> ${esc(match.subject || "No subject")}</p>
          <p class="muted">${esc(match.matchReason)} | confidence ${Math.round((match.confidence || 0) * 100)}% | ${esc(new Date(match.createdAt).toLocaleString())}</p>
        `).join("")}
      </article>
    `;
  }
}

function correctionSlaBadge(correction) {
  if (correction.closedAt) return `<span class="badge badge-pass">Closed</span>`;
  if (correction.isOverdue) return `<span class="badge badge-fail">Overdue (${correction.daysOpen}d)</span>`;
  const daysLeft = correction.slaDays - correction.daysOpen;
  if (daysLeft <= 1) return `<span class="badge badge-warning">Due tomorrow</span>`;
  return `<span class="badge badge-info">Due ${esc(correction.dueAt)} (${daysLeft}d left)</span>`;
}

function renderCorrections() {
  const corrections = state.detail.corrections || [];
  $("corrections").innerHTML = corrections.length ? corrections.map((correction) => `
    <article class="item ${correction.isOverdue ? "fail" : correction.closedAt ? "pass" : "info"}">
      <div class="item-title">
        <span>${esc(correction.correctionBucket)}</span>
        <span>${correctionSlaBadge(correction)}</span>
        <span class="muted">${esc(new Date(correction.createdAt).toLocaleDateString())}</span>
      </div>
      <p>${esc(correction.requiredAction)}</p>
      <p class="muted">${esc(correction.correctionText)}</p>
    </article>
  `).join("") : `<p class="muted">No corrections recorded.</p>`;
}

function renderPortalRuns() {
  const runs = state.detail.portalRuns || [];
  const awaiting = runs.find((run) => run.status === "awaiting_human_submit");
  $("portalRuns").innerHTML = runs.length ? runs.map((run) => `
    <article class="item ${run.status === "failed" ? "fail" : "info"}">
      <div class="item-title"><span>${esc(run.runType)}</span>${statusBadge(run.status)}</div>
      <p>${run.humanActionRequired ? "Human action required before legal submission is complete." : "No human action currently flagged."}</p>
      <p class="muted">${esc(run.errorMessage || run.startedAt)}</p>
    </article>
  `).join("") : `<p class="muted">No portal runs yet.</p>`;

  const form = $("confirmationForm");
  form.hidden = !awaiting;
  form.dataset.portalRunId = awaiting?.id || "";
}

function renderAudit() {
  const logs = state.detail.auditLogs || [];
  $("auditLog").innerHTML = logs.length ? logs.map((log) => `
    <article class="item info">
      <div class="item-title"><span>${esc(log.action)}</span><span>${esc(new Date(log.createdAt).toLocaleString())}</span></div>
      <p>${esc(log.actorType)}: ${esc(log.actorName)}</p>
    </article>
  `).join("") : `<p class="muted">No audit entries yet.</p>`;
}

async function updateReview(reviewItemId, action) {
  const input = $(`review-${reviewItemId}`);
  const body = {
    reviewItemId,
    action,
    fieldValue: input?.value || "",
    notes: action === "reject" ? "Rejected from dashboard." : "Verified from dashboard.",
  };
  state.detail = await api(`/api/projects/${state.selectedProjectId}/human-verify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.reviewerReport = null;
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Human review item updated. QC was rerun automatically.");
  renderDetail();
  await loadProjects();
}

async function syncOpsPlan() {
  if (!state.selectedProjectId) return;
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/ops-plan/sync`, { method: "POST", body: "{}" });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage(`Operations plan synced. Next: ${state.opsPlan.nextAction}`);
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

async function saveRunbookCurrentStep() {
  if (!state.selectedProjectId || !state.runbook) return;
  const step = (state.runbook.steps || []).find((item) => item.isCurrent)
    || (state.runbook.steps || []).find((item) => ["blocked", "waiting", "in_progress", "not_started"].includes(item.status));
  if (!step) {
    showMessage("No current runbook step to update.", "warning");
    return;
  }
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/ops-steps/${step.id}`, {
    method: "POST",
    body: JSON.stringify({
      status: $("runbookQuickStatus").value,
      ownerRole: $("runbookQuickOwner").value,
      dueAt: $("runbookQuickDue").value || null,
      notes: $("runbookQuickNotes").value,
    }),
  });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Current runbook step updated.");
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  renderProjectTimeline();
  await refreshProjectListOnly();
  if (window.lucide) window.lucide.createIcons();
}

async function saveOpsStep(stepId) {
  if (!state.selectedProjectId || !stepId) return;
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/ops-steps/${stepId}`, {
    method: "POST",
    body: JSON.stringify({
      status: $(`ops-status-${stepId}`).value,
      ownerRole: $(`ops-owner-${stepId}`).value,
      dueAt: $(`ops-due-${stepId}`).value || null,
      notes: $(`ops-notes-${stepId}`).value,
    }),
  });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Operations phase updated.");
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  await refreshProjectListOnly();
  if (window.lucide) window.lucide.createIcons();
}

async function saveActionStep(projectId, stepId) {
  if (!projectId || !stepId) return;
  const updatedPlan = await api(`/api/projects/${projectId}/ops-steps/${stepId}`, {
    method: "POST",
    body: JSON.stringify({
      status: $(`action-status-${stepId}`).value,
      ownerRole: $(`action-owner-${stepId}`).value,
      dueAt: $(`action-due-${stepId}`).value || null,
      notes: $(`action-notes-${stepId}`).value,
    }),
  });
  if (projectId === state.selectedProjectId) {
    state.opsPlan = updatedPlan;
    state.opsBrief = await api(`/api/projects/${projectId}/ops-brief`);
    state.detail = await api(`/api/projects/${projectId}`);
    await loadPmPackets();
    await loadLiveReadiness();
    await loadProjectTimeline();
    await loadProcessMap();
    await loadInstallerPacket();
    renderDetail();
  }
  showMessage("Action updated.");
  await refreshProjectListOnly();
  if (window.lucide) window.lucide.createIcons();
}

async function addOpsNote() {
  if (!state.selectedProjectId) return;
  const body = $("opsNoteBody").value.trim();
  if (!body) {
    showMessage("Add a note before saving.", "warning");
    return;
  }
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      noteType: $("opsNoteType").value,
      body,
      createdBy: $("opsNoteAuthor").value || "Operations",
    }),
  });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  $("opsNoteBody").value = "";
  showMessage("PM note added.");
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

async function copyHandoff() {
  const note = state.opsBrief?.handoffNote || "";
  if (!note) {
    showMessage("No handoff note generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(note);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = note;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("PM handoff copied.");
}

async function copyRunbook() {
  const text = state.runbook?.reportText || "";
  if (!text) {
    showMessage("No PM runbook generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("PM runbook copied.");
}

async function copyHandoffPacket() {
  const text = state.handoffPacket?.reportText || "";
  if (!text) {
    showMessage("No project handoff packet generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("Project handoff packet copied.");
}

function communicationDraftText(draft) {
  return [`Subject: ${draft.subject}`, "", draft.body].join("\n");
}

async function writeClipboardText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage(successMessage);
}

async function copyCommunicationDraft(index) {
  const draft = state.communicationDrafts?.drafts?.[index];
  if (!draft) {
    showMessage("Communication draft not found.", "warning");
    return;
  }
  await writeClipboardText(communicationDraftText(draft), `${draft.title} copied.`);
}

async function copyCommunicationDrafts() {
  const text = state.communicationDrafts?.reportText || "";
  if (!text) {
    showMessage("No communication drafts generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Communication drafts copied.");
}

async function copySubmitGate() {
  const text = state.submitGate?.reportText || "";
  if (!text) {
    showMessage("No submit gate generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "PermitFlow + NEMflow submit gate copied.");
}

async function copyOpsReport() {
  const text = state.opsReport?.reportText || "";
  if (!text) {
    showMessage("No Daily Ops Report generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("Daily Ops Report copied.");
}

async function copyLiveReadiness() {
  const text = state.liveReadiness?.reportText || "";
  if (!text) {
    showMessage("No live readiness report generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("Live readiness report copied.");
}

async function copyProcessMap() {
  const text = state.processMap?.reportText || "";
  if (!text) {
    showMessage("No PermitFlow + NEMflow map generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("PermitFlow + NEMflow map copied.");
}

async function copyInstallerPacket() {
  const text = state.installerPacket?.reportText || "";
  if (!text) {
    showMessage("No installer action packet generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("Installer action packet copied.");
}

async function copyProjectTimeline() {
  const text = state.projectTimeline?.reportText || "";
  if (!text) {
    showMessage("No project timeline generated yet.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage("Project timeline copied.");
}

async function runQc() {
  state.detail = await api(`/api/projects/${state.selectedProjectId}/qc`, { method: "POST", body: "{}" });
  state.workflow = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("QC rerun complete.");
  renderDetail();
  await loadProjects();
}

async function runWorkflow() {
  if (!state.selectedProjectId) return;
  const workflow = await api(`/api/projects/${state.selectedProjectId}/workflow`, { method: "POST", body: "{}" });
  state.workflow = workflow;
  state.historicalReport = workflow.historicalReport;
  state.reviewerReport = workflow.reviewerReport;
  state.applicationDocs = workflow.applicationDocs;
  state.detail = await api(`/api/projects/${state.selectedProjectId}`);
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage(`Workflow complete. Next: ${workflow.nextAction}`, workflow.status === "blocked" ? "warning" : "info");
  renderDetail();
  await refreshProjectListOnly();
}

async function runHistoricalCheck() {
  if (!state.selectedProjectId) return;
  state.historicalReport = await api(`/api/projects/${state.selectedProjectId}/historical-failures`);
  state.workflow = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  const missing = state.historicalReport.checklist.filter((item) => item.status === "missing").length;
  showMessage(`Historical check complete: ${state.historicalReport.matchedProjectCount} similar project(s), ${state.historicalReport.matchedFailureRecordCount} failure/delay record(s), ${missing} missing checklist item(s).`);
  renderSubmitGate();
  renderHistoricalFailures();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

async function prepareSubmission() {
  try {
    state.detail = await api(`/api/projects/${state.selectedProjectId}/prepare-submission`, { method: "POST", body: "{}" });
    await loadOpsPlan();
    await loadPmPackets();
    await loadLiveReadiness();
    await loadProjectTimeline();
    await loadProcessMap();
    await loadInstallerPacket();
    showMessage("Mock portal staged to final review. Automation did not click final submit.");
    renderDetail();
    await loadProjects();
  } catch (err) {
    const details = err.details ? Object.entries(err.details).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join(" | ") : "";
    showMessage([err.message, details].filter(Boolean).join("\n"), "warning");
  }
}

async function addCorrection() {
  const correctionText = $("correctionText").value.trim();
  if (!correctionText) {
    showMessage("Paste correction text before adding.", "warning");
    return;
  }
  state.detail = await api(`/api/projects/${state.selectedProjectId}/corrections`, {
    method: "POST",
    body: JSON.stringify({ correctionText, source: "manual" }),
  });
  $("correctionText").value = "";
  state.workflow = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Correction added and classified.");
  renderDetail();
  await loadProjects();
}

async function addPermitTarget() {
  if (!state.selectedProjectId) return;
  state.detail = await api(`/api/projects/${state.selectedProjectId}/permit-targets`, {
    method: "POST",
    body: JSON.stringify({
      jurisdiction: $("permitJurisdiction").value,
      portalName: $("permitPortalName").value,
      portalUrl: $("permitPortalUrl").value,
      applicationNumber: $("permitApplicationNumber").value,
      permitNumber: $("permitTrackingNumber").value,
      checkFrequencyDays: Number($("permitCheckFrequencyDays").value || 7),
    }),
  });
  state.workflow = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Permit check target saved.");
  renderDetail();
  await loadProjects();
}

async function recordPermitStatus(source = "manual") {
  if (!state.selectedProjectId) return;
  const target = state.detail.permitCheckTargets?.[0];
  const rawStatusText = source === "mock" ? "" : $("permitStatusText").value.trim();
  if (source === "manual" && !rawStatusText) {
    showMessage("Paste AHJ/portal status text before classifying.", "warning");
    return;
  }
  state.detail = await api(`/api/projects/${state.selectedProjectId}/permit-checks`, {
    method: "POST",
    body: JSON.stringify({
      targetId: target?.id || null,
      source,
      rawStatusText,
      applicationNumber: $("permitApplicationNumber").value,
      permitNumber: $("permitTrackingNumber").value,
    }),
  });
  $("permitStatusText").value = "";
  state.workflow = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  const latest = state.detail.permitStatusChecks?.[0];
  showMessage(latest ? `Permit check classified: ${latest.statusLabel}` : "Permit check recorded.");
  renderDetail();
  await loadProjects();
}

async function buildApplicationDocs() {
  if (!state.selectedProjectId) return;
  state.applicationDocs = await api(`/api/projects/${state.selectedProjectId}/application-docs`);
  state.workflow = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage(`Built AHJ docs for ${state.applicationDocs.profile.name}.`);
  renderSubmitGate();
  renderApplicationDocs();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

function openApplicationDocs() {
  if (!state.selectedProjectId) return;
  window.open(`/api/projects/${state.selectedProjectId}/application-docs?format=html`, "_blank");
}

async function runReviewerGate() {
  if (!state.selectedProjectId) return;
  state.reviewerReport = await api(`/api/projects/${state.selectedProjectId}/reviewer-report`);
  state.workflow = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  const blockers = state.reviewerReport.findings.filter((item) => item.severity === "blocker").length;
  const warnings = state.reviewerReport.findings.filter((item) => item.severity === "warning").length;
  showMessage(`Reviewer gate complete: ${blockers} blocker(s), ${warnings} warning(s).`);
  renderSubmitGate();
  renderReviewerGate();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

function setMboxProgress(percent, text, visible = true) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  $("mboxProgressWrap").hidden = !visible;
  $("mboxProgressBar").style.width = `${clamped}%`;
  $("mboxProgressPercent").textContent = `${clamped}%`;
  $("mboxProgressText").textContent = text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function mboxResultMessage(result) {
  const counts = result.bucketCounts || {};
  const bucketSummary = Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([bucket, count]) => `${bucket.replaceAll("_", " ")}: ${count}`)
    .join(" | ");
  return [
    `MBOX import learned ${result.learningEvents} event(s), imported ${result.failureExamplesImported} failure example(s), touched ${result.profilesTouched} profile(s).`,
    bucketSummary ? `Buckets: ${bucketSummary}.` : "",
    result.duplicateMessages ? `Duplicates skipped: ${result.duplicateMessages}.` : "",
    result.llmReviewRecommended ? `LLM review recommended for ${result.llmReviewRecommended} uncertain message(s).` : "",
  ].filter(Boolean).join("\n");
}

function uploadMboxFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const sourceLabel = encodeURIComponent(file.name || "Imported MBOX file");
    xhr.open("POST", `/api/knowledge-base/import-mbox-file?sourceLabel=${sourceLabel}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setMboxProgress((event.loaded / event.total) * 92, `Uploading ${file.name} (${formatBytes(event.loaded)} / ${formatBytes(event.total)})...`);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `MBOX upload failed with status ${xhr.status}.`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Browser could not upload the selected MBOX file. Paste the local file path below and use Import Path."));
    xhr.onabort = () => reject(new Error("MBOX import was canceled."));
    setMboxProgress(1, `Starting upload for ${file.name} (${formatBytes(file.size)})...`);
    xhr.send(file);
  });
}

async function importMbox(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setMboxProgress(1, `Reading ${file.name} (${formatBytes(file.size)})…`);
  try {
    const result = await uploadMboxFile(file);
    setMboxProgress(100, "Import complete.");
    event.target.value = "";
    showMessage(mboxResultMessage(result));
    await loadKnowledgeBase();
    if (state.selectedProjectId) {
      await loadPmPackets();
      await loadLiveReadiness();
      await loadProcessMap();
      await loadInstallerPacket();
      renderSubmitGate();
      renderHandoffPacket();
      renderCommunicationDrafts();
      renderRunbook();
      renderLiveTestReadiness();
      renderProcessMap();
      renderInstallerPacket();
    }
    window.setTimeout(() => setMboxProgress(0, "", false), 1800);
  } catch (err) {
    event.target.value = "";
    setMboxProgress(0, "Import failed.", true);
    showMessage(`${err.message || "MBOX import failed."}\nIf the file is cloud-only, locked by Outlook, or too large for browser upload, paste its full local path and click Import Path.`, "error");
  }
}

async function importMboxPath() {
  const filePath = $("mboxPath").value.trim();
  if (!filePath) {
    $("mboxPath").value = "";
    showMessage("Paste the full local MBOX file path before using Import Path.", "warning");
    return;
  }
  try {
    setMboxProgress(15, "Reading local file path on backend...");
    const result = await api("/api/knowledge-base/import-mbox-path", {
      method: "POST",
      body: JSON.stringify({ filePath }),
    });
    setMboxProgress(100, "Import complete.");
    showMessage(mboxResultMessage(result));
    await loadKnowledgeBase();
    if (state.selectedProjectId) {
      await loadPmPackets();
      await loadLiveReadiness();
      await loadProcessMap();
      await loadInstallerPacket();
      renderSubmitGate();
      renderHandoffPacket();
      renderCommunicationDrafts();
      renderRunbook();
      renderLiveTestReadiness();
      renderProcessMap();
      renderInstallerPacket();
    }
    window.setTimeout(() => setMboxProgress(0, "", false), 1800);
  } catch (err) {
    setMboxProgress(0, "Import failed.", true);
    showMessage(err.message || "MBOX path import failed.", "error");
  }
}

async function saveEmailWatch() {
  const filePath = $("emailWatchPath").value.trim();
  if (!filePath) {
    showMessage("Paste the full local MBOX path to watch before saving an email tracker source.", "warning");
    return;
  }
  state.emailTracker = await api("/api/email-tracker/sources", {
    method: "POST",
    body: JSON.stringify({ filePath, label: "Live permitting/NEM mailbox" }),
  });
  renderEmailTracker();
  if (state.selectedProjectId) {
    await loadPmPackets();
    await loadLiveReadiness();
    await loadProcessMap();
    await loadInstallerPacket();
    renderSubmitGate();
    renderHandoffPacket();
    renderCommunicationDrafts();
    renderRunbook();
    renderLiveTestReadiness();
    renderProcessMap();
    renderInstallerPacket();
  }
  showMessage("Email watch source saved. Use Scan Email to match corrections, NEM approvals, fees, and status updates to projects.");
}

async function runEmailTracker() {
  const filePath = $("emailWatchPath").value.trim();
  const body = filePath && !(state.emailTracker?.sources || []).some((source) => source.filePath === filePath)
    ? { filePath }
    : {};
  try {
    const result = await api("/api/email-tracker/run", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.emailTracker = await api("/api/email-tracker");
    renderEmailTracker();
    if (state.selectedProjectId) state.detail = await api(`/api/projects/${state.selectedProjectId}`);
    if (state.selectedProjectId) await loadOpsPlan();
    if (state.selectedProjectId) await loadPmPackets();
    if (state.selectedProjectId) await loadLiveReadiness();
    if (state.selectedProjectId) await loadProjectTimeline();
    if (state.selectedProjectId) await loadProcessMap();
    if (state.selectedProjectId) await loadInstallerPacket();
    renderDetail();
    await refreshProjectListOnly();
    const errorText = result.sourceErrors?.length ? ` Errors: ${result.sourceErrors.join("; ")}` : "";
    showMessage(`Email scan complete: ${result.messagesScanned} message(s), ${result.projectMatches} project match(es), ${result.statusChecksCreated} status update(s), ${result.correctionsCreated} correction(s).${errorText}`, result.sourceErrors?.length ? "warning" : "info");
  } catch (err) {
    showMessage(err.message || "Email scan failed.", "error");
  }
}

async function deleteSelectedProject() {
  if (!state.selectedProjectId || !state.detail?.project) return;
  const project = state.detail.project;
  const label = project.homeownerName || project.projectAddress || project.id;
  const confirmed = window.confirm(`Delete this test project and its project-specific learned history?\n\n${label}`);
  if (!confirmed) return;
  const deletedId = state.selectedProjectId;
  await api(`/api/projects/${deletedId}`, { method: "DELETE" });
  state.selectedProjectId = null;
  state.detail = null;
  state.workflow = null;
  state.applicationDocs = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  state.opsPlan = null;
  state.opsBrief = null;
  state.handoffPacket = null;
  state.communicationDrafts = null;
  state.runbook = null;
  state.liveReadiness = null;
  state.projectTimeline = null;
  state.processMap = null;
  state.installerPacket = null;
  state.submitGate = null;
  await loadProjects();
  if (state.detail) showMessage(`Deleted test project ${deletedId}.`);
}

function openReviewerPacket() {
  if (!state.selectedProjectId) return;
  window.open(`/api/projects/${state.selectedProjectId}/reviewer-report?format=html`, "_blank");
}

async function runPermitMonitor() {
  const result = await api("/api/permit-monitor/run", { method: "POST", body: "{}" });
  showMessage(`Permit monitor ran ${result.checked || 0} due check(s).`);
  await loadProjects();
}

async function captureConfirmation(event) {
  event.preventDefault();
  const portalRunId = $("confirmationForm").dataset.portalRunId;
  if (!portalRunId) return;
  state.detail = await api(`/api/portal-runs/${portalRunId}/capture-confirmation`, {
    method: "POST",
    body: JSON.stringify({
      applicationNumber: $("applicationNumber").value,
      permitNumber: $("permitNumber").value,
      confirmationNumber: $("confirmationNumber").value,
      submittedBy: $("submittedBy").value,
      notes: $("confirmationNotes").value,
    }),
  });
  state.workflow = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Confirmation captured after human submit.");
  renderDetail();
  await loadProjects();
}

$("refreshBtn").addEventListener("click", loadProjects);
$("runPermitMonitorBtn").addEventListener("click", runPermitMonitor);
$("opsActions").addEventListener("click", handleOpsActionClick);
$("opsActionFrame").addEventListener("load", handleOpsActionFrameLoad);
$("syncOpsPlanBtn").addEventListener("click", syncOpsPlan);
$("addOpsNoteBtn").addEventListener("click", addOpsNote);
$("copyHandoffBtn").addEventListener("click", copyHandoff);
$("copyRunbookBtn").addEventListener("click", copyRunbook);
$("copyHandoffPacketBtn").addEventListener("click", copyHandoffPacket);
$("copyCommunicationDraftsBtn").addEventListener("click", copyCommunicationDrafts);
$("copySubmitGateBtn").addEventListener("click", copySubmitGate);
$("copyOpsReportBtn").addEventListener("click", copyOpsReport);
$("copyLiveReadinessBtn").addEventListener("click", copyLiveReadiness);
$("copyProcessMapBtn").addEventListener("click", copyProcessMap);
$("copyInstallerPacketBtn").addEventListener("click", copyInstallerPacket);
$("copyTimelineBtn").addEventListener("click", copyProjectTimeline);
$("runWorkflowBtn").addEventListener("click", runWorkflow);
$("runQcBtn").addEventListener("click", runQc);
$("runHistoricalBtn").addEventListener("click", runHistoricalCheck);
$("runReviewerGateBtn").addEventListener("click", runReviewerGate);
$("buildAppDocsBtn").addEventListener("click", buildApplicationDocs);
$("openAppDocsBtn").addEventListener("click", openApplicationDocs);
$("openReviewerPacketBtn").addEventListener("click", openReviewerPacket);
$("prepareBtn").addEventListener("click", prepareSubmission);
$("deleteProjectBtn").addEventListener("click", deleteSelectedProject);
$("addCorrectionBtn").addEventListener("click", addCorrection);
$("addPermitTargetBtn").addEventListener("click", addPermitTarget);
$("recordPermitStatusBtn").addEventListener("click", () => recordPermitStatus("manual"));
$("mockPermitCheckBtn").addEventListener("click", () => recordPermitStatus("mock"));
$("confirmationForm").addEventListener("submit", captureConfirmation);
$("mboxFile").addEventListener("change", importMbox);
$("importMboxPathBtn").addEventListener("click", importMboxPath);
$("saveEmailWatchBtn").addEventListener("click", saveEmailWatch);
$("runEmailTrackerBtn").addEventListener("click", runEmailTracker);

// ----- MBOX drag-and-drop -----
(function () {
  const zone = $("mboxDropZone");
  function highlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.add("drag-over"); }
  function unhighlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove("drag-over"); }
  zone.addEventListener("dragenter", highlight);
  zone.addEventListener("dragover", highlight);
  zone.addEventListener("dragleave", unhighlight);
  zone.addEventListener("drop", async (e) => {
    unhighlight(e);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    try {
      setMboxProgress(1, `Reading ${file.name}…`);
      const result = await uploadMboxFile(file);
      setMboxProgress(100, "Import complete.");
      showMessage(mboxResultMessage(result));
      await loadKnowledgeBase();
      window.setTimeout(() => setMboxProgress(0, "", false), 1800);
    } catch (err) {
      setMboxProgress(0, "Import failed.", true);
      showMessage(err.message || "MBOX import failed.", "error");
    }
  });
})();

// ----- Batch import drag-and-drop: a .zip uploads + extracts + scans -----
function uploadBatchZip(file) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ label: file.name || "batch" });
    const ahj = $("batchDefaultAhj").value.trim();
    const utility = $("batchDefaultUtility").value.trim();
    const stateVal = $("batchDefaultState").value.trim();
    if (ahj) params.set("defaultAhj", ahj);
    if (utility) params.set("defaultUtility", utility);
    if (stateVal) params.set("defaultState", stateVal);
    if ($("batchUseLlm").checked) params.set("useLlm", "true");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/batch-import/upload-zip?${params.toString()}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round((event.loaded / event.total) * 100);
      $("batchScanStatus").textContent = `Uploading ${file.name}… ${pct}% (${formatBytes(event.loaded)} / ${formatBytes(event.total)})`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { data = {}; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `Zip upload failed (status ${xhr.status}).`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Browser could not upload the zip. If it's very large, unzip it to a folder and use the Scan Folder path instead."));
    $("batchScanStatus").textContent = `Reading ${file.name} (${formatBytes(file.size)})…`;
    xhr.send(file);
  });
}

async function handleBatchDrop(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".7z") || name.endsWith(".rar") || name.endsWith(".tar") || name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    showMessage(`"${file.name}" is a ${name.split(".").pop().toUpperCase()} archive — only .zip is supported for browser upload. Extract it to a folder on your machine first, then paste that folder path into the "Scan Folder" field below and click Scan Folder.`, "error");
    $("batchScanStatus").textContent = `Unsupported archive format. Extract to a folder and use Scan Folder path instead.`;
    return;
  }
  if (name.endsWith(".zip")) {
    try {
      const job = await uploadBatchZip(file);
      $("batchScanStatus").textContent = `Extracted ${job.extractedPdfCount} PDF${job.extractedPdfCount === 1 ? "" : "s"} — scanning now…`;
      if (typeof pollBatchJob === "function") pollBatchJob(job.id);
    } catch (err) {
      $("batchScanStatus").textContent = err.message || "Zip import failed.";
      showMessage(err.message || "Zip import failed.", "error");
    }
  } else if (name.endsWith(".pdf")) {
    showMessage("For loose PDFs, zip them into one .zip and drop that — or put them in a folder and use Scan Folder. Single-file upload isn't wired to the disk scanner.", "info");
  } else {
    showMessage("Drop a .zip of your project PDFs here.", "error");
  }
}

(function () {
  const zone = $("batchDropZone");
  const input = $("batchDropInput");
  function highlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.add("drag-over"); }
  function unhighlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove("drag-over"); }
  zone.addEventListener("dragenter", highlight);
  zone.addEventListener("dragover", highlight);
  zone.addEventListener("dragleave", unhighlight);
  zone.addEventListener("drop", (e) => {
    unhighlight(e);
    const file = e.dataTransfer.files?.[0];
    if (file) handleBatchDrop(file);
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) handleBatchDrop(file);
    input.value = "";
  });
})();

// ----- Clients & contractor licensing -----
const CLIENT_TEXT_FIELDS = [
  "companyName", "legalBusinessName", "dba", "contactName", "contactEmail", "phone", "billingStatus",
  "ccbLicenseNumber", "ccbExpiration", "electricalLicenseNumber", "electricalSupervisorName",
  "ein", "bondCarrier", "insuranceCarrier", "businessAddress", "businessCity", "businessState",
  "businessZip", "businessPhone", "businessEmail", "authorizedSignerName", "authorizedSignerTitle", "notes",
];

function clientFormStatus(message, kind) {
  const el = $("clientFormStatus");
  if (!message) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = message;
  el.style.borderLeftColor = kind === "error" ? "var(--danger)" : "var(--info)";
}

async function loadClients() {
  const data = await api("/api/clients");
  state.clients = data.clients || [];
  renderClientsList();
  renderProjectClientOptions();
}

function renderClientsList() {
  const list = $("clientsList");
  if (!state.clients || state.clients.length === 0) {
    list.innerHTML = `<p class="muted">No clients yet. Click New to add one.</p>`;
    return;
  }
  list.innerHTML = state.clients.map((client) => `
    <button type="button" class="client-row${client.id === state.editingClientId ? " active" : ""}" data-client-id="${esc(client.id)}">
      <strong>${esc(client.companyName || client.legalBusinessName || "Unnamed")}</strong>
      <span class="muted">${esc(client.ccbLicenseNumber ? "CCB " + client.ccbLicenseNumber : "No CCB on file")}</span>
    </button>
  `).join("");
  list.querySelectorAll("[data-client-id]").forEach((btn) => {
    btn.addEventListener("click", () => editClient(btn.dataset.clientId));
  });
}

function renderProjectClientOptions() {
  const select = $("projectClientSelect");
  if (!select) return;
  const current = select.value;
  const options = ['<option value="">— none —</option>'].concat(
    (state.clients || []).map((c) => `<option value="${esc(c.id)}">${esc(c.companyName || c.legalBusinessName || "Unnamed")}</option>`),
  );
  select.innerHTML = options.join("");
  select.value = current;
}

function syncProjectClientSelect() {
  const select = $("projectClientSelect");
  if (!select) return;
  renderProjectClientOptions();
  select.value = state.detail?.project?.clientId || "";
}

function blankClientForm() {
  state.editingClientId = null;
  $("clientId").value = "";
  CLIENT_TEXT_FIELDS.forEach((field) => { const el = $("c_" + field); if (el) el.value = ""; });
  state.portalIdentitiesDraft = [];
  renderPortalIdentities();
  clientFormStatus("");
  renderClientsList();
}

function editClient(clientId) {
  const client = (state.clients || []).find((c) => c.id === clientId);
  if (!client) return;
  state.editingClientId = clientId;
  $("clientId").value = clientId;
  CLIENT_TEXT_FIELDS.forEach((field) => { const el = $("c_" + field); if (el) el.value = client[field] || ""; });
  state.portalIdentitiesDraft = (client.portalIdentities || []).map((i) => ({
    portalType: i.portalType, installerCompanyLabel: i.installerCompanyLabel, installerContactCode: i.installerContactCode, notes: i.notes,
  }));
  renderPortalIdentities();
  clientFormStatus("");
  renderClientsList();
}

function renderPortalIdentities() {
  const wrap = $("portalIdentitiesList");
  const drafts = state.portalIdentitiesDraft || [];
  if (drafts.length === 0) {
    wrap.innerHTML = `<p class="muted">No portal identities. Add one if this client submits through PowerClerk or Accela.</p>`;
    return;
  }
  wrap.innerHTML = drafts.map((identity, idx) => `
    <div class="portal-identity-row">
      <select data-pi="portalType" data-idx="${idx}">
        <option value="powerclerk_pge"${identity.portalType === "powerclerk_pge" ? " selected" : ""}>PowerClerk (PGE)</option>
        <option value="accela_oregon"${identity.portalType === "accela_oregon" ? " selected" : ""}>Oregon ePermitting (Accela)</option>
      </select>
      <input data-pi="installerCompanyLabel" data-idx="${idx}" placeholder="Installer company label" value="${esc(identity.installerCompanyLabel || "")}" />
      <input data-pi="installerContactCode" data-idx="${idx}" placeholder="Contact / account code" value="${esc(identity.installerContactCode || "")}" />
      <button type="button" class="danger-button" data-remove-pi="${idx}"><i data-lucide="x"></i></button>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-pi]").forEach((el) => {
    el.addEventListener("input", () => {
      const idx = Number(el.dataset.idx);
      state.portalIdentitiesDraft[idx][el.dataset.pi] = el.value;
    });
  });
  wrap.querySelectorAll("[data-remove-pi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.portalIdentitiesDraft.splice(Number(btn.dataset.removePi), 1);
      renderPortalIdentities();
      if (window.lucide) window.lucide.createIcons();
    });
  });
  if (window.lucide) window.lucide.createIcons();
}

function collectClientPayload() {
  const payload = { portalIdentities: state.portalIdentitiesDraft || [] };
  CLIENT_TEXT_FIELDS.forEach((field) => { payload[field] = $("c_" + field)?.value ?? ""; });
  return payload;
}

async function saveClient(event) {
  event.preventDefault();
  const payload = collectClientPayload();
  if (!payload.companyName && !payload.legalBusinessName) {
    clientFormStatus("Company name (or legal business name) is required.", "error");
    return;
  }
  try {
    const clientId = $("clientId").value;
    const saved = clientId
      ? await api(`/api/clients/${clientId}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/clients", { method: "POST", body: JSON.stringify(payload) });
    await loadClients();
    editClient(saved.id);
    clientFormStatus("Saved.", "info");
  } catch (err) {
    clientFormStatus(err.message || "Save failed.", "error");
  }
}

async function removeClient() {
  const clientId = $("clientId").value;
  if (!clientId) { blankClientForm(); return; }
  if (!confirm("Delete this client? This cannot be undone.")) return;
  try {
    await api(`/api/clients/${clientId}`, { method: "DELETE" });
    await loadClients();
    blankClientForm();
    clientFormStatus("Client deleted.", "info");
  } catch (err) {
    clientFormStatus(err.message || "Delete failed.", "error");
  }
}

async function openClientsModal() {
  $("clientsModal").hidden = false;
  await loadClients();
  if ((state.clients || []).length > 0) editClient(state.clients[0].id);
  else blankClientForm();
  if (window.lucide) window.lucide.createIcons();
}

function closeClientsModal() {
  $("clientsModal").hidden = true;
}

async function assignProjectClient() {
  if (!state.selectedProjectId) return;
  const clientId = $("projectClientSelect").value || null;
  try {
    state.detail = await api(`/api/projects/${state.selectedProjectId}/client`, {
      method: "POST",
      body: JSON.stringify({ clientId }),
    });
    renderDetail();
    showMessage(clientId ? "Client assigned to project." : "Client cleared.", "info");
  } catch (err) {
    showMessage(err.message || "Could not assign client.", "error");
  }
}

$("openClientsBtn").addEventListener("click", openClientsModal);
$("closeClientsBtn").addEventListener("click", closeClientsModal);
$("newClientBtn").addEventListener("click", blankClientForm);
$("clientForm").addEventListener("submit", saveClient);
$("deleteClientBtn").addEventListener("click", removeClient);
$("addPortalIdentityBtn").addEventListener("click", () => {
  state.portalIdentitiesDraft = state.portalIdentitiesDraft || [];
  state.portalIdentitiesDraft.push({ portalType: "powerclerk_pge", installerCompanyLabel: "", installerContactCode: "", notes: "" });
  renderPortalIdentities();
});
$("projectClientSelect").addEventListener("change", assignProjectClient);
$("clientsModal").addEventListener("click", (e) => { if (e.target.id === "clientsModal") closeClientsModal(); });

// ----- Leads / Customers + communication log -----
const CUSTOMER_TEXT_FIELDS = ["name", "email", "phone", "leadSource", "address", "city", "state", "zip", "notes"];
const COMM_CHANNEL_LABELS = { note: "Note", call: "Call", email: "Email", sms: "Text", meeting: "Meeting" };

async function loadCustomers() {
  const params = new URLSearchParams();
  const search = $("customerSearch").value.trim();
  const stage = $("customerStageFilter").value;
  if (search) params.set("search", search);
  if (stage) params.set("stage", stage);
  const qs = params.toString();
  state.customers = await api(`/api/customers${qs ? "?" + qs : ""}`);
  renderCustomersList();
}

function renderCustomersList() {
  const list = $("customersList");
  if (!state.customers || state.customers.length === 0) {
    list.innerHTML = `<p class="muted">No contacts. Click New to add a lead.</p>`;
    return;
  }
  list.innerHTML = state.customers.map((c) => `
    <button type="button" class="client-row${c.id === state.editingCustomerId ? " active" : ""}" data-customer-id="${esc(c.id)}">
      <strong>${esc(c.name || "Unnamed")}</strong>
      <span class="muted">${esc(STAGE_LABELS[c.leadStage] || c.leadStage)}${c.phone ? " · " + esc(c.phone) : ""}</span>
    </button>
  `).join("");
  list.querySelectorAll("[data-customer-id]").forEach((btn) => {
    btn.addEventListener("click", () => editCustomer(btn.dataset.customerId));
  });
}

const STAGE_LABELS = { new_lead: "New lead", contacted: "Contacted", quoted: "Quoted", won: "Won", customer: "Customer", lost: "Lost" };

function customerFormStatus(text, kind) {
  const el = $("customerFormStatus");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "message" + (kind ? " " + kind : "");
}

function blankCustomerForm() {
  state.editingCustomerId = null;
  $("cu_id").value = "";
  CUSTOMER_TEXT_FIELDS.forEach((f) => { const el = $("cu_" + f); if (el) el.value = ""; });
  $("cu_leadStage").value = "new_lead";
  $("commLogAddRow").hidden = true;
  $("commLogList").innerHTML = `<p class="muted">Save the contact first to start logging communication.</p>`;
  customerFormStatus("");
  renderCustomersList();
}

async function editCustomer(id) {
  const c = (state.customers || []).find((x) => x.id === id);
  if (!c) return;
  state.editingCustomerId = id;
  $("cu_id").value = id;
  CUSTOMER_TEXT_FIELDS.forEach((f) => { const el = $("cu_" + f); if (el) el.value = c[f] || ""; });
  $("cu_leadStage").value = c.leadStage || "new_lead";
  $("commLogAddRow").hidden = false;
  customerFormStatus("");
  renderCustomersList();
  await loadCommunications(id);
}

function collectCustomerPayload() {
  const payload = { leadStage: $("cu_leadStage").value };
  CUSTOMER_TEXT_FIELDS.forEach((f) => { payload[f] = $("cu_" + f)?.value ?? ""; });
  return payload;
}

async function saveCustomer(event) {
  event.preventDefault();
  const payload = collectCustomerPayload();
  if (!payload.name.trim()) { customerFormStatus("Name is required.", "error"); return; }
  try {
    const id = $("cu_id").value;
    const saved = id
      ? await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/customers", { method: "POST", body: JSON.stringify(payload) });
    await loadCustomers();
    editCustomer(saved.id);
    customerFormStatus("Saved.", "info");
  } catch (err) {
    customerFormStatus(err.message || "Save failed.", "error");
  }
}

async function removeCustomer() {
  const id = $("cu_id").value;
  if (!id) { blankCustomerForm(); return; }
  if (!confirm("Delete this contact? Communication history will be unlinked.")) return;
  try {
    await api(`/api/customers/${id}`, { method: "DELETE" });
    await loadCustomers();
    blankCustomerForm();
    customerFormStatus("Contact deleted.", "info");
  } catch (err) {
    customerFormStatus(err.message || "Delete failed.", "error");
  }
}

async function loadCommunications(customerId) {
  const comms = await api(`/api/customers/${customerId}/communications`);
  const list = $("commLogList");
  if (!comms || comms.length === 0) {
    list.innerHTML = `<p class="muted">No communication logged yet.</p>`;
    return;
  }
  list.innerHTML = comms.map((m) => `
    <div class="comm-entry">
      <div class="comm-meta">
        <strong>${esc(COMM_CHANNEL_LABELS[m.channel] || m.channel)}</strong>
        <span class="muted">${esc(m.direction)} · ${esc(new Date(m.occurredAt).toLocaleString())}</span>
      </div>
      ${m.subject ? `<div class="comm-subject">${esc(m.subject)}</div>` : ""}
      ${m.body ? `<div class="comm-body">${esc(m.body)}</div>` : ""}
    </div>
  `).join("");
}

async function addCommunication() {
  const customerId = $("cu_id").value;
  if (!customerId) { customerFormStatus("Save the contact first.", "error"); return; }
  const body = $("comm_body").value.trim();
  const subject = $("comm_subject").value.trim();
  if (!subject && !body) { customerFormStatus("Add a subject or details to log.", "error"); return; }
  try {
    await api("/api/communications", {
      method: "POST",
      body: JSON.stringify({
        customerId,
        channel: $("comm_channel").value,
        direction: $("comm_direction").value,
        subject,
        body,
      }),
    });
    $("comm_subject").value = "";
    $("comm_body").value = "";
    await loadCommunications(customerId);
    customerFormStatus("Logged.", "info");
  } catch (err) {
    customerFormStatus(err.message || "Could not log entry.", "error");
  }
}

async function openCustomersModal() {
  $("customersModal").hidden = false;
  await loadCustomers();
  if ((state.customers || []).length > 0) editCustomer(state.customers[0].id);
  else blankCustomerForm();
  if (window.lucide) window.lucide.createIcons();
}

function closeCustomersModal() { $("customersModal").hidden = true; }

let _customerSearchTimer = null;
$("openCustomersBtn").addEventListener("click", openCustomersModal);
$("closeCustomersBtn").addEventListener("click", closeCustomersModal);
$("newCustomerBtn").addEventListener("click", blankCustomerForm);
$("customerForm").addEventListener("submit", saveCustomer);
$("deleteCustomerBtn").addEventListener("click", removeCustomer);
$("addCommBtn").addEventListener("click", addCommunication);
$("customerStageFilter").addEventListener("change", loadCustomers);
$("customerSearch").addEventListener("input", () => {
  clearTimeout(_customerSearchTimer);
  _customerSearchTimer = setTimeout(loadCustomers, 250);
});
$("customersModal").addEventListener("click", (e) => { if (e.target.id === "customersModal") closeCustomersModal(); });

// ----- Project search / sort / filter (server-side, paginated) -----
const PROJECT_PAGE_SIZE = 200;
const projectFilterState = { search: "", status: "", userId: "", sort: "updated_desc", offset: 0 };

// applyProjectFilters kept as a no-op alias — filtering now happens on the server
function applyProjectFilters(projects) { return projects; }

let _searchDebounceTimer = null;

async function reloadProjects() {
  projectFilterState.offset = 0;
  await fetchProjectPage(false);
}

async function loadMoreProjects() {
  projectFilterState.offset = state.projects.length;
  await fetchProjectPage(true);
}

async function fetchProjectPage(append) {
  const params = new URLSearchParams({ limit: String(PROJECT_PAGE_SIZE), offset: String(projectFilterState.offset) });
  if (projectFilterState.search) params.set("search", projectFilterState.search);
  if (projectFilterState.status) params.set("status", projectFilterState.status);
  if (projectFilterState.userId) params.set("userId", projectFilterState.userId);
  if (projectFilterState.sort && projectFilterState.sort !== "overdue") params.set("sort", projectFilterState.sort);
  const data = await api(`/api/projects?${params}`);
  const page = data.projects || [];
  state.projectsTotal = data.total ?? page.length;
  if (append) {
    state.projects = [...state.projects, ...page];
  } else {
    state.projects = page;
  }
  renderProjects();
}

function renderProjectUserOptions() {
  const filterSel = $("projectUserFilter");
  const current = filterSel.value;
  filterSel.innerHTML = `<option value="">All assignees</option>` +
    (state.users || []).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("");
  filterSel.value = current;

  const assignSel = $("projectAssignSelect");
  if (assignSel) {
    const cur2 = assignSel.value;
    assignSel.innerHTML = `<option value="">— unassigned —</option>` +
      (state.users || []).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("");
    assignSel.value = cur2;
  }
}

async function assignProjectUser() {
  if (!state.selectedProjectId) return;
  const userId = $("projectAssignSelect").value || null;
  try {
    await api(`/api/projects/${state.selectedProjectId}/assign`, { method: "POST", body: JSON.stringify({ userId }) });
    await loadProjects();
    await loadTeamWorkload();
    showMessage(userId ? "Project assigned." : "Assignment cleared.", "info");
  } catch (err) {
    showMessage(err.message || "Could not assign project.", "error");
  }
}

if ($("projectAssignSelect")) $("projectAssignSelect").addEventListener("change", assignProjectUser);

$("projectSearch").addEventListener("input", (e) => {
  projectFilterState.search = e.target.value;
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(reloadProjects, 300);
});
$("projectStatusFilter").addEventListener("change", (e) => {
  projectFilterState.status = e.target.value;
  reloadProjects();
});
$("projectUserFilter").addEventListener("change", (e) => {
  projectFilterState.userId = e.target.value;
  reloadProjects();
});
$("projectSort").addEventListener("change", (e) => {
  projectFilterState.sort = e.target.value;
  reloadProjects();
});

// ----- Batch folder import -----
async function startBatchScan() {
  const folderPath = $("batchFolderPath").value.trim();
  if (!folderPath) { showMessage("Enter a folder path first.", "error"); return; }
  const btn = $("startBatchScanBtn");
  btn.disabled = true;
  $("batchScanStatus").textContent = "Queuing scan job…";
  $("batchScanResults").hidden = true;
  try {
    const job = await api("/api/batch-import/scan", {
      method: "POST",
      body: JSON.stringify({
        folderPath,
        defaultAhj: $("batchDefaultAhj").value.trim() || undefined,
        defaultUtility: $("batchDefaultUtility").value.trim() || undefined,
        defaultState: $("batchDefaultState").value.trim() || undefined,
        useLlm: $("batchUseLlm").checked,
      }),
    });
    $("batchScanStatus").textContent = `Job ${job.id.slice(0, 8)} queued (status: ${job.status}). Polling for result…`;
    pollBatchJob(job.id);
  } catch (err) {
    $("batchScanStatus").textContent = `Error: ${err.message}`;
    btn.disabled = false;
  }
}

async function pollBatchJob(jobId) {
  const btn = $("startBatchScanBtn");
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      const pct = job.progressTotal > 0 ? Math.round((job.progress / job.progressTotal) * 100) : 0;
      if (job.status === "running" || job.status === "pending") {
        $("batchScanStatus").textContent = `Scanning… ${job.progress}/${job.progressTotal} files (${pct}%)`;
        setTimeout(tick, 2000);
      } else if (job.status === "done") {
        const r = job.result || {};
        $("batchScanStatus").textContent =
          `Done — ${r.scanned} PDFs scanned, ${r.learned} trained the parser, ${r.lowSignal} low-signal, ${r.errors} errors. ` +
          `${r.profilesTouched || 0} AHJ/utility profile(s) updated, ${r.correctionsLearned || 0} correction pattern(s) added.` +
          (r.reportPath ? ` Full report: ${r.reportPath}` : "");
        renderBatchResults(job);
        await loadKnowledgeBase();
        btn.disabled = false;
      } else {
        $("batchScanStatus").textContent = `Job ${job.status}: ${job.error || "unknown error"}`;
        btn.disabled = false;
      }
    } catch (err) {
      $("batchScanStatus").textContent = `Poll error: ${err.message}`;
      btn.disabled = false;
    }
  };
  setTimeout(tick, 1500);
}

function renderBatchResults(job) {
  const wrap = $("batchScanResults");
  const results = (job.result?.results || []);
  if (!results.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = `<div class="table-wrap"><table class="batch-results-table">
    <thead><tr><th>File</th><th>Type</th><th>Status</th><th>Details</th></tr></thead>
    <tbody>${results.map((r) => `
      <tr class="${r.status}">
        <td>${esc(r.filePath.split(/[\\/]/).pop())}</td>
        <td>${esc(r.docType.replace("_", " "))}</td>
        <td>${r.status === "learned" ? "✓ learned" : r.status === "error" ? "✗ error" : "— low signal"}</td>
        <td>${esc(r.message)}${r.docLabel ? ` · <strong>${esc(String(r.docLabel))}</strong>` : ""}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

if ($("startBatchScanBtn")) $("startBatchScanBtn").addEventListener("click", startBatchScan);

// ----- NEM monitor button -----
async function runNemMonitor() {
  $("runNemMonitorBtn").disabled = true;
  try {
    const result = await api("/api/nem-monitor/run", { method: "POST" });
    showMessage(`NEM check: ${result.checked} target(s) checked.`, "info");
    await loadProjects();
  } catch (err) {
    showMessage(err.message || "NEM check failed.", "error");
  } finally {
    $("runNemMonitorBtn").disabled = false;
  }
}
$("runNemMonitorBtn").addEventListener("click", runNemMonitor);

// ----- Team workload -----
async function loadTeamWorkload() {
  $("workloadStatus").textContent = "syncing";
  try {
    const workload = await api("/api/users/workload");
    renderTeamWorkload(workload);
    $("workloadStatus").textContent = "live";
  } catch {
    $("workloadStatus").textContent = "error";
  }
}

function renderTeamWorkload(workload) {
  if (!workload || workload.length === 0) {
    $("teamWorkload").innerHTML = `<p class="muted">No team members configured. Add operators via the Team button.</p>`;
    return;
  }
  $("teamWorkload").innerHTML = workload.map((w) => {
    const color = (state.users || []).find((u) => u.id === w.user.id)?.color || "#6366f1";
    return `
      <article class="item ${w.overdueCorrections > 0 ? "fail" : "info"}" style="border-left-color:${esc(color)}">
        <div class="item-title">
          <span>${esc(w.user.name)}</span>
          <span class="muted">${esc(w.user.role)}</span>
        </div>
        <div class="workload-stats">
          <span><strong>${w.openProjects}</strong> open</span>
          <span><strong>${w.openCorrections}</strong> corrections</span>
          ${w.overdueCorrections > 0 ? `<span class="badge badge-fail">${w.overdueCorrections} overdue</span>` : ""}
          <span><strong>${w.pendingReviews}</strong> pending review</span>
        </div>
      </article>`;
  }).join("");
}

// ----- Users modal -----
async function loadUsers() {
  const users = await api("/api/users");
  state.users = Array.isArray(users) ? users : [];
  renderUsersList();
  renderProjectUserOptions();
}

function renderUsersList() {
  const list = $("usersList");
  if (!list) return;
  if (!state.users || state.users.length === 0) {
    list.innerHTML = `<p class="muted">No team members yet.</p>`;
    return;
  }
  list.innerHTML = state.users.map((u) => `
    <div class="client-list-item ${state.selectedUserId === u.id ? "active" : ""}" data-user-id="${esc(u.id)}">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(u.color)};margin-right:6px"></span>
      ${esc(u.name)}
      <span class="muted" style="font-size:12px">${esc(u.role)}</span>
    </div>`).join("");
  list.querySelectorAll("[data-user-id]").forEach((el) => {
    el.addEventListener("click", () => editUser(el.dataset.userId));
  });
}

function editUser(userId) {
  state.selectedUserId = userId;
  const user = (state.users || []).find((u) => u.id === userId);
  if (!user) return;
  $("userId").value = user.id;
  $("u_name").value = user.name;
  $("u_email").value = user.email;
  $("u_role").value = user.role;
  $("u_color").value = user.color;
  renderUsersList();
}

function blankUserForm() {
  state.selectedUserId = null;
  $("userId").value = "";
  $("u_name").value = "";
  $("u_email").value = "";
  $("u_role").value = "operator";
  $("u_color").value = "#6366f1";
  renderUsersList();
}

async function saveUser(event) {
  event.preventDefault();
  const payload = {
    name: $("u_name").value.trim(),
    email: $("u_email").value.trim(),
    role: $("u_role").value,
    color: $("u_color").value,
  };
  if (!payload.name || !payload.email) { showMessage("Name and email required.", "warning"); return; }
  try {
    const userId = $("userId").value;
    if (userId) {
      await api(`/api/users/${userId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
    }
    await loadUsers();
    showMessage("Saved.", "info");
  } catch (err) {
    showMessage(err.message || "Save failed.", "error");
  }
}

async function openUsersModal() {
  $("usersModal").hidden = false;
  await loadUsers();
  if ((state.users || []).length > 0) editUser(state.users[0].id);
  else blankUserForm();
  if (window.lucide) window.lucide.createIcons();
}

function closeUsersModal() { $("usersModal").hidden = true; }

$("openUsersBtn").addEventListener("click", openUsersModal);
$("closeUsersBtn").addEventListener("click", closeUsersModal);
$("newUserBtn").addEventListener("click", blankUserForm);
$("userForm").addEventListener("submit", saveUser);
$("usersModal").addEventListener("click", (e) => { if (e.target.id === "usersModal") closeUsersModal(); });

// ----- KPI Dashboard -----
function formatDays(days) {
  if (days == null) return "—";
  return `${days}d`;
}

async function loadKpi() {
  const start = $("kpiStart").value || "";
  const end = $("kpiEnd").value || "";
  const params = new URLSearchParams();
  if (start) params.set("startDate", start);
  if (end) params.set("endDate", end);
  try {
    const kpi = await api(`/api/kpi?${params}`);
    renderKpi(kpi);
  } catch (err) {
    $("kpiBody").innerHTML = `<p class="muted">Failed to load KPIs: ${esc(err.message)}</p>`;
  }
}

function renderKpi(kpi) {
  const body = $("kpiBody");
  body.innerHTML = `
    <div class="kpi-period">Period: ${esc(kpi.period.start)} → ${esc(kpi.period.end)}</div>
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-value">${kpi.projectsSubmitted}</div>
        <div class="kpi-label">Submitted</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${kpi.projectsHandedOff}</div>
        <div class="kpi-label">Handed Off ✓</div>
      </div>
      <div class="kpi-card ${kpi.avgTotalCycleDays != null && kpi.avgTotalCycleDays > 60 ? "kpi-warn" : ""}">
        <div class="kpi-value">${formatDays(kpi.avgTotalCycleDays)}</div>
        <div class="kpi-label">Avg Cycle (Submit→Handoff)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${formatDays(kpi.avgPermitCycleDays)}</div>
        <div class="kpi-label">Avg Permit Cycle</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${formatDays(kpi.avgNemCycleDays)}</div>
        <div class="kpi-label">Avg NEM Cycle</div>
      </div>
      <div class="kpi-card ${kpi.throughputPerWeek < 1 ? "kpi-warn" : ""}">
        <div class="kpi-value">${kpi.throughputPerWeek}</div>
        <div class="kpi-label">Handoffs/Week</div>
      </div>
      <div class="kpi-card ${kpi.correctionRate > 50 ? "kpi-warn" : ""}">
        <div class="kpi-value">${kpi.correctionRate}%</div>
        <div class="kpi-label">Correction Rate</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${kpi.avgCorrectionsPerProject}</div>
        <div class="kpi-label">Avg Corrections/Project</div>
      </div>
      <div class="kpi-card ${kpi.overdueCorrections > 0 ? "kpi-fail" : ""}">
        <div class="kpi-value">${kpi.overdueCorrections}</div>
        <div class="kpi-label">Overdue Corrections</div>
      </div>
      <div class="kpi-card ${kpi.slaBreachRate > 20 ? "kpi-warn" : ""}">
        <div class="kpi-value">${kpi.slaBreachRate}%</div>
        <div class="kpi-label">SLA Breach Rate</div>
      </div>
    </div>

    ${kpi.byUser.length > 0 ? `
    <h3 style="margin-top:24px">Per Operator</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Submitted</th><th>Handed Off</th><th>Open</th><th>Overdue</th><th>Avg Cycle</th></tr></thead>
        <tbody>
          ${kpi.byUser.map((u) => `
            <tr>
              <td>${esc(u.userName)}</td>
              <td>${u.submitted}</td>
              <td>${u.handedOff}</td>
              <td>${u.openProjects}</td>
              <td class="${u.overdueCorrections > 0 ? "text-danger" : ""}">${u.overdueCorrections}</td>
              <td>${formatDays(u.avgCycleDays)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
  `;
}

async function openKpiModal() {
  $("kpiModal").hidden = false;
  // Default: last 90 days
  if (!$("kpiEnd").value) $("kpiEnd").value = new Date().toISOString().slice(0, 10);
  if (!$("kpiStart").value) {
    const d = new Date(); d.setDate(d.getDate() - 90);
    $("kpiStart").value = d.toISOString().slice(0, 10);
  }
  await loadKpi();
}

function closeKpiModal() { $("kpiModal").hidden = true; }

$("openKpiBtn").addEventListener("click", openKpiModal);
$("closeKpiBtn").addEventListener("click", closeKpiModal);
$("refreshKpiBtn").addEventListener("click", loadKpi);
$("kpiModal").addEventListener("click", (e) => { if (e.target.id === "kpiModal") closeKpiModal(); });

await checkHealth();
await loadProjects();
await loadClients();
await loadUsers();
await loadTeamWorkload();
if (window.lucide) window.lucide.createIcons();


