import type { AhjProcessProfile, CodeReference, ProjectRecord, ReviewerFinding, ReviewerFindingEvidence, ReviewerReport } from "../../shared/src/types";
import { evaluateDesignCodeFindings } from "./codeReviewRules";
import { findAhjProcessProfile } from "./processProfiles";
import { evidenceForTopic, evidenceLines, fieldValue, requirementsForTopic, type EvidenceTopic, type ProjectEvidence } from "./projectEvidence";
import { nowIso } from "./time";

function payload(project: ProjectRecord, key: string): string {
  return fieldValue(project, key);
}

function finding(
  id: string,
  severity: ReviewerFinding["severity"],
  category: ReviewerFinding["category"],
  title: string,
  message: string,
  installerCallout = false,
  options: {
    cityFeedback?: string;
    designTeamAction?: string;
    evidenceNeeded?: string[];
    codeReferences?: CodeReference[];
    evidenceFound?: ReviewerFindingEvidence[];
    evidenceStatus?: ReviewerFinding["evidenceStatus"];
  } = {},
): ReviewerFinding {
  return {
    id,
    severity,
    category,
    title,
    message,
    cityFeedback: options.cityFeedback || message,
    designTeamAction: options.designTeamAction || "Verify and correct this item before staging the submittal.",
    evidenceNeeded: options.evidenceNeeded || [],
    codeReferences: options.codeReferences || [],
    installerCallout,
    evidenceStatus: options.evidenceStatus,
    evidenceFound: options.evidenceFound,
  };
}

function evidenceSummary(check: ProjectEvidence): string {
  if (!check.excerpts.length) return `No parsed ${check.topic} evidence was found.`;
  return evidenceLines(check).join(" ");
}

function evidenceNeeded(check: ProjectEvidence): string[] {
  return [
    ...check.missingEvidence,
    ...check.excerpts.map((excerpt) => `Parsed evidence: ${excerpt}`),
  ].slice(0, 8);
}

function confidenceVerb(check: ProjectEvidence): string {
  if (!check.present) return "Missing";
  if (check.confidence === "high") return "Verified";
  if (check.confidence === "medium") return "Verify";
  return "Missing";
}

export function buildReviewerReport(project: ProjectRecord): ReviewerReport {
  const profile = findAhjProcessProfile(project);
  const findings: ReviewerFinding[] = [];

  addCoreProjectFindings(project, findings);
  findings.push(...evaluateDesignCodeFindings(project, profile));
  addPlanSetFindings(project, findings);
  addUtilityFindings(project, findings);
  addProfileFindings(project, profile, findings);
  addInstallerCallouts(project, profile, findings);

  // Deduplicate by finding ID — keep first occurrence (most specific rule wins).
  const seenIds = new Set<string>();
  for (let i = findings.length - 1; i >= 0; i--) {
    if (seenIds.has(findings[i].id)) { findings.splice(i, 1); continue; }
    seenIds.add(findings[i].id);
  }

  if (!profile) {
    findings.push(finding(
      "reviewer.profile.missing",
      "warning",
      "ahj_profile",
    "No seeded AHJ process profile matched",
    "Use generic AHJ docs and verify local application/stamp/signature requirements manually before submittal.",
    true,
    {
      cityFeedback: "The project jurisdiction/process requirements could not be matched to the seeded AHJ profile table. Provide confirmation of the AHJ, portal path, required applications, signature/stamp requirements, and utility sequencing before submission.",
      designTeamAction: "Confirm the AHJ/process profile and add any required local forms or stamped documents.",
      evidenceNeeded: ["Verified AHJ/jurisdiction", "Portal/process path", "Required local forms", "Stamp/signature requirements"],
    },
  ));
  }

  const blockerCount = findings.filter((item) => item.severity === "blocker").length;
  findings.push(finding(
    "reviewer.submit.preview-required",
    blockerCount ? "blocker" : "callout",
    "portal",
    "Final AHJ preview is required",
    "Do not rely on seeing only a submit button. The operator must see the actual AHJ/utility final-review page or generated final review packet, compare all fields/uploads, then manually click submit.",
    false,
    {
      cityFeedback: "Automation may stage the package but may not complete legal submission. Final review requires visible AHJ/utility preview, uploaded file list, application fields, fees/acknowledgements, and manual human submit.",
      designTeamAction: "Use the final review packet and portal preview to reconcile every field and upload before manual submit.",
      evidenceNeeded: ["Visible portal final-review screen or internal final review packet", "Uploaded file list", "Application field summary", "Human submit confirmation"],
    },
  ));

  const enrichedFindings = findings.map((item) => attachEvidence(project, profile, item));

  return {
    projectId: project.id,
    generatedAt: nowIso(),
    matchedProcessProfile: profile,
    findings: enrichedFindings,
    installerCallouts: enrichedFindings.filter((item) => item.installerCallout),
    finalSubmitGate: {
      mustShowAhjPreviewWindow: true,
      finalSubmitButtonAloneIsEnough: false,
      requirements: [
        "Show actual AHJ/utility portal final-review screen when a real adapter is running.",
        "Show internal final review packet when using mock/manual staging.",
        "Block final submit staging if blocker findings remain.",
        "Human must compare final portal fields, uploaded files, fees, and acknowledgements before clicking submit.",
      ],
    },
  };
}

function maskIdentifier(value: string): string {
  const cleaned = value.replace(/\s+/g, "");
  if (!cleaned) return "";
  if (cleaned.length <= 4) return "[captured]";
  return `${"*".repeat(Math.max(0, cleaned.length - 4))}${cleaned.slice(-4)}`;
}

function evidenceStatus(check: ProjectEvidence): ReviewerFinding["evidenceStatus"] {
  if (!check.present) return "missing";
  if (check.confidence === "high") return "verified";
  if (check.confidence === "medium") return "weak";
  return "missing";
}

export function topicForFinding(finding: ReviewerFinding): EvidenceTopic | null {
  const idTitle = `${finding.id} ${finding.title}`.toLowerCase();
  if (/account/.test(idTitle)) return "accountVerification";
  if (/meter/.test(idTitle)) return "meterPhoto";
  if (/sld|one.line|single.line|3.line|three.line|load-side|supply-side|interconnection/.test(idTitle)) return "sld";
  if (/site|roof plan|layout/.test(idTitle)) return "siteRoofPlan";
  if (/fire|pathway|setback/.test(idTitle)) return "firePathway";
  if (/framing|rafter|truss|span/.test(idTitle)) return "roofFraming";
  if (/attachment|racking|flashing|mount/.test(idTitle)) return "rackingAttachment";
  if (/load criteria|snow|dead load|wind/.test(idTitle)) return "structuralLoads";
  if (/rapid|rsd|690\.12/.test(idTitle)) return "rapidShutdown";
  if (/label|placard|directory/.test(idTitle)) return "labels";
  if (/inverter settings|1741|smart inverter/.test(idTitle)) return "inverterSettings";
  if (/equipment schedule|spec package|equipment.*spec|spec.*sheet|dc.size|equipment field/.test(idTitle)) return "sld";
  if (/battery|ess|powerwall/.test(idTitle)) return "batteryMode";
  if (/utility approval|interconnection approval/.test(idTitle)) return "utilityApproval";
  if (/signature|owner authorization|customer authorization/.test(idTitle)) return "ownerAuthorization";
  return null;
}

function evidenceFromTopic(projectId: string, check: ProjectEvidence): ReviewerFindingEvidence[] {
  const found = check.hits.map<ReviewerFindingEvidence>((hit) => ({
    kind: "source_excerpt",
    label: `${check.topic} evidence`,
    source: hit.sourceLabel,
    excerpt: hit.excerpt,
    confidence: check.confidence,
    pageHint: hit.pageHint,
    screenshotPath: "",
    verifier: "parser",
    note: check.confidence === "high" ? "Parser found strong supporting source text." : "Parser found possible source text; human should verify on the source sheet.",
  }));

  if (found.length) {
    // Point the crop slot at the on-demand renderer. The endpoint locates the
    // plan-set PDF, picks the page backing this topic's evidence, and rasterizes
    // it. If no plan set is stored, the endpoint 404s and the report falls back
    // to the text hint via the <img onerror> handler in renderFinding.
    const cropUrl = `/api/projects/${encodeURIComponent(projectId)}/evidence-image?topic=${encodeURIComponent(check.topic)}`
      + `&hint=${encodeURIComponent(found[0].pageHint || "")}`
      + `&excerpt=${encodeURIComponent((found[0].excerpt || "").slice(0, 160))}`;
    found.push({
      kind: "screenshot_placeholder",
      label: "Screenshot crop slot",
      source: found[0].source,
      excerpt: "",
      confidence: check.confidence,
      pageHint: found[0].pageHint,
      screenshotPath: cropUrl,
      verifier: "parser",
      note: "Source page will render here. If no plan-set PDF is stored, upload it to Project Documents — then this slot shows the sheet. Use the source/page hint above meanwhile.",
    });
    return found;
  }

  return [{
    kind: "absence_check",
    label: `${check.topic} absence check`,
    source: "Parsed project package",
    excerpt: `No matching evidence found. Checked for: ${requirementsForTopic(check.topic).join(", ")}.`,
    confidence: "low",
    pageHint: "",
    screenshotPath: "",
    verifier: "rule_engine",
    note: "This is a missing-proof callout, not proof of a design defect. Verify the source package before sending to client.",
  }];
}

function fieldEvidence(label: string, value: string | number | null | undefined, sensitive = false): ReviewerFindingEvidence {
  const present = value != null && value !== "";
  const display = present ? String(value) : "Missing from normalized project fields.";
  return {
    kind: "field_value",
    label,
    source: "Normalized project field",
    excerpt: present && sensitive ? maskIdentifier(String(value)) : display,
    confidence: present ? "high" : "low",
    pageHint: "Project summary",
    screenshotPath: "",
    verifier: "normalized_field",
    note: present ? "Value was captured into the normalized project record." : "No normalized value was captured; confirm against source documents.",
  };
}

function coreFieldEvidence(project: ProjectRecord, findingId: string): ReviewerFindingEvidence | null {
  const map: Record<string, ReviewerFindingEvidence> = {
    "reviewer.core.homeowner": fieldEvidence("Homeowner name", project.homeownerName),
    "reviewer.core.address": fieldEvidence("Service address", project.projectAddress),
    "reviewer.core.ahj": fieldEvidence("AHJ", project.ahj),
    "reviewer.core.utility": fieldEvidence("Utility", project.utility),
    "reviewer.core.account": fieldEvidence("Utility account", project.accountNumber, true),
    "reviewer.core.meter": fieldEvidence("Meter number", project.meterNumber, true),
    "reviewer.core.dc": fieldEvidence("DC system size", project.systemSizeDcKw),
    "reviewer.core.ac": fieldEvidence("AC system size", project.systemSizeAcKw),
    "reviewer.core.interconnection": fieldEvidence("Interconnection method", project.interconnectionMethod),
  };
  return map[findingId] || null;
}

function profileEvidence(profile: AhjProcessProfile | null, finding: ReviewerFinding): ReviewerFindingEvidence | null {
  if (!profile || finding.category !== "ahj_profile") return null;
  return {
    kind: "process_profile",
    label: "Seeded AHJ process profile",
    source: profile.sourceSheet || "AHJ process profile",
    excerpt: `${profile.state} / ${profile.ahj} / ${profile.submissionMethod}. ${profile.otherRequirements || profile.reviewerNotes || "Profile matched by AHJ/state."}`,
    confidence: "medium",
    pageHint: "AHJ profile table",
    screenshotPath: "",
    verifier: "ahj_profile",
    note: "Profile-based callout. Confirm local AHJ requirements if this is a live submittal.",
  };
}

function genericEvidence(project: ProjectRecord, profile: AhjProcessProfile | null, finding: ReviewerFinding): ReviewerFindingEvidence[] {
  const core = coreFieldEvidence(project, finding.id);
  if (core) return [core];
  const profileHit = profileEvidence(profile, finding);
  if (profileHit) return [profileHit];
  if (finding.category === "portal") {
    return [{
      kind: "process_profile",
      label: "Submission safeguard",
      source: "Portal automation policy",
      excerpt: "Automation must stop at final review. Human must verify fields/uploads/fees and manually submit.",
      confidence: "high",
      pageHint: "Final submit gate",
      screenshotPath: "",
      verifier: "rule_engine",
      note: "This is a required safety control, not a design deficiency.",
    }];
  }
  return [{
    kind: "absence_check",
    label: "General source check",
    source: "Parsed project package",
    excerpt: finding.message,
    confidence: finding.severity === "callout" ? "medium" : "low",
    pageHint: "",
    screenshotPath: "",
    verifier: "rule_engine",
    note: "Rule-generated callout. Human should verify the source package before forwarding.",
  }];
}

function attachEvidence(project: ProjectRecord, profile: AhjProcessProfile | null, finding: ReviewerFinding): ReviewerFinding {
  if (finding.evidenceFound?.length) return finding;
  const topic = topicForFinding(finding);
  const evidenceFound = topic ? evidenceFromTopic(project.id, evidenceForTopic(project, topic)) : genericEvidence(project, profile, finding);
  const status = topic ? evidenceStatus(evidenceForTopic(project, topic)) : evidenceFound.some((item) => item.kind === "process_profile") ? "profile" : evidenceFound.some((item) => item.confidence === "high") ? "verified" : "weak";
  return { ...finding, evidenceFound, evidenceStatus: status };
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findingClass(severity: ReviewerFinding["severity"]): string {
  if (severity === "blocker") return "blocker";
  if (severity === "warning") return "warning";
  if (severity === "pass") return "pass";
  return "callout";
}

function renderFinding(finding: ReviewerFinding): string {
  const refs = finding.codeReferences.length
    ? finding.codeReferences.map((ref) => `<li><strong>${esc(ref.code)} ${esc(ref.section)}</strong> - ${esc(ref.title)}<br><span>${esc(ref.note)}</span>${ref.sourceUrl ? `<br><a href="${esc(ref.sourceUrl)}">${esc(ref.sourceUrl)}</a>` : ""}</li>`).join("")
    : "<li>No exact code citation attached. Verify local AHJ policy.</li>";
  const evidence = finding.evidenceNeeded.length ? finding.evidenceNeeded.map((item) => `<li>${esc(item)}</li>`).join("") : "<li>Corrected plan/application evidence.</li>";
  const found = finding.evidenceFound?.length
    ? finding.evidenceFound.map((item) => {
        if (item.kind === "screenshot_placeholder") {
          // Try to render the source page; if the endpoint 404s (no plan-set PDF
          // stored), hide the broken image and reveal the text-hint fallback.
          return item.screenshotPath
            ? `<li><strong>${esc(item.label)}:</strong> <img class="crop" src="${esc(item.screenshotPath)}" alt="${esc(item.label)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'" /><span class="shot-slot" style="display:none">${esc(item.note)}</span></li>`
            : `<li><strong>${esc(item.label)}:</strong> <span class="shot-slot">${esc(item.note)}</span></li>`;
        }
        return `<li><strong>${esc(item.label)}:</strong> ${esc(item.excerpt)}<br><span>${esc(item.source)}${item.pageHint ? ` | ${esc(item.pageHint)}` : ""} | ${esc(item.confidence)} confidence | ${esc(item.verifier)}</span>${item.note ? `<br><span>${esc(item.note)}</span>` : ""}</li>`;
      }).join("")
    : "<li>No evidence trail attached yet.</li>";
  const v = finding.visionVerification;
  const visionHtml = v && v.checked
    ? `<div class="vision-verdict ${v.present ? "ok" : "warn"}"><strong>${v.present ? "✓ Vision-verified on the plan sheet" : "⚠ Vision could not confirm on the plan sheet"} (page ${esc(String(v.page))}, ${esc(v.confidence)} confidence)</strong><br><span>${esc(v.observed || v.note)}</span></div>`
    : "";
  return `
    <article class="finding ${findingClass(finding.severity)}">
      <div class="finding-head">
        <h3>${esc(finding.title)}</h3>
        <span>${esc(finding.severity)} | ${esc(finding.category)} | evidence: ${esc(finding.evidenceStatus || "unknown")}</span>
      </div>
      ${visionHtml}
      <p><strong>Reviewer comment:</strong> ${esc(finding.cityFeedback)}</p>
      <p><strong>Required correction:</strong> ${esc(finding.designTeamAction)}</p>
      <div class="grid">
        <div><strong>Evidence required</strong><ul>${evidence}</ul></div>
        <div><strong>Code / basis</strong><ul>${refs}</ul></div>
      </div>
      <div class="evidence-found"><strong>Evidence found / checked</strong><ul>${found}</ul></div>
    </article>`;
}

export function renderReviewerReportHtml(project: ProjectRecord, report: ReviewerReport): string {
  const blockers = report.findings.filter((item) => item.severity === "blocker");
  const warnings = report.findings.filter((item) => item.severity === "warning");
  const callouts = report.findings.filter((item) => item.severity === "callout");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AHJ Reviewer Gate - ${esc(project.homeownerName || project.projectAddress || project.id)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; color: #17202a; background: #f6f7f9; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header, .finding, .summary { background: #fff; border: 1px solid #d9e0e7; border-radius: 8px; padding: 18px; margin-bottom: 14px; }
    h1, h2, h3, p { margin: 0; } h1 { font-size: 24px; } h2 { font-size: 17px; margin-bottom: 8px; } h3 { font-size: 16px; }
    p { line-height: 1.45; margin-top: 8px; } a { color: #115e59; overflow-wrap: anywhere; }
    .meta, span { color: #687281; font-size: 13px; } .counts { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .pill { border-radius: 999px; padding: 6px 10px; background: #eef2f5; font-weight: 700; font-size: 12px; text-transform: uppercase; }
    .blocker { border-left: 5px solid #b91c1c; } .warning { border-left: 5px solid #a16207; } .callout { border-left: 5px solid #1d4ed8; } .pass { border-left: 5px solid #0f766e; }
    .finding-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 12px; }
    .evidence-found { border-top: 1px solid #d9e0e7; margin-top: 12px; padding-top: 10px; }
    .shot-slot { display: block; border: 1px dashed #94a3b8; border-radius: 6px; padding: 10px; color: #475569; background: #f8fafc; }
    img { max-width: 100%; border: 1px solid #d9e0e7; border-radius: 6px; margin-top: 6px; }
    img.crop { display: block; max-width: 520px; box-shadow: 0 1px 4px rgba(15,23,42,.12); }
    .vision-verdict { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 13px; }
    .vision-verdict.ok { background: #ecfdf5; border: 1px solid #0f766e; }
    .vision-verdict.warn { background: #fffbeb; border: 1px solid #a16207; }
    li { margin-bottom: 6px; } ul { padding-left: 20px; }
    @media print { body { background: #fff; } main { max-width: none; padding: 0; } .finding { break-inside: avoid; } }
    @media (max-width: 760px) { main { padding: 14px; } .grid, .finding-head { grid-template-columns: 1fr; display: grid; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AHJ Reviewer Gate</h1>
      <p class="meta">${esc(project.homeownerName || "Unnamed")} | ${esc(project.projectAddress || "No address")} | AHJ: ${esc(project.ahj || "Missing")} | Utility: ${esc(project.utility || "Missing")}</p>
      <div class="counts">
        <span class="pill">${blockers.length} blocker(s)</span>
        <span class="pill">${warnings.length} warning(s)</span>
        <span class="pill">${report.installerCallouts.length} installer callout(s)</span>
        <span class="pill">Generated ${esc(new Date(report.generatedAt).toLocaleString())}</span>
      </div>
    </header>
    <section class="summary">
      <h2>Final Submit Gate</h2>
      <p>Submit button alone is not enough: <strong>${report.finalSubmitGate.finalSubmitButtonAloneIsEnough ? "Yes" : "No"}</strong>. Actual AHJ/utility preview required: <strong>${report.finalSubmitGate.mustShowAhjPreviewWindow ? "Yes" : "No"}</strong>.</p>
      <ul>${report.finalSubmitGate.requirements.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      <p class="meta">Matched process profile: ${report.matchedProcessProfile ? `${esc(report.matchedProcessProfile.state)} / ${esc(report.matchedProcessProfile.ahj)} / ${esc(report.matchedProcessProfile.submissionMethod)}` : "none"}</p>
    </section>
    <section>
      <h2>City-Style Correction Comments</h2>
      ${report.findings.map(renderFinding).join("")}
    </section>
    <section class="summary">
      <h2>Installer Callouts Before Submittal</h2>
      ${report.installerCallouts.length ? report.installerCallouts.map(renderFinding).join("") : "<p>No installer callouts were generated.</p>"}
    </section>
  </main>
</body>
</html>`;
}

function addCoreProjectFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const required: Array<[string, string | number | null, string]> = [
    ["homeowner", project.homeownerName, "Homeowner name missing."],
    ["address", project.projectAddress, "Service/project address missing."],
    ["ahj", project.ahj, "AHJ missing."],
    ["utility", project.utility, "Utility missing."],
    ["account", project.accountNumber, "Utility account number missing."],
    ["meter", project.meterNumber, "Meter number missing."],
    ["dc", project.systemSizeDcKw, "DC system size missing."],
    ["ac", project.systemSizeAcKw, "AC system size missing."],
    ["interconnection", project.interconnectionMethod, "Interconnection method missing."],
  ];
  for (const [id, value, message] of required) {
    if (value == null || value === "") findings.push(finding(`reviewer.core.${id}`, "blocker", "project_data", "Critical project field missing", message, true));
  }
}

function addPlanSetFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const requiredDocs: Array<[string, ReturnType<typeof evidenceForTopic>, string, string]> = [
    ["sld", evidenceForTopic(project, "sld"), "SLD/one-line sheet not clearly mapped", "Provide or remap the one-line/SLD sheet so interconnection and equipment can be reviewed."],
    ["site", evidenceForTopic(project, "siteRoofPlan"), "Site/roof plan not clearly mapped", "Provide or remap the site/roof plan showing array layout and service equipment."],
    ["rapid-shutdown", evidenceForTopic(project, "rapidShutdown"), "Rapid shutdown evidence not clear", "Show rapid shutdown equipment, initiation/control location, and required labels."],
  ];
  for (const [id, check, title, action] of requiredDocs) {
    if (check.confidence === "high") continue;
    findings.push(finding(
      `reviewer.plan.${id}`,
      check.present ? "warning" : "blocker",
      "plan_set",
      check.present ? `${confidenceVerb(check)} ${title.toLowerCase()}` : title,
      check.present ? `${title}. ${evidenceSummary(check)}` : action,
      true,
      {
        cityFeedback: check.present
          ? `${title}. The parser found only ${check.confidence}-confidence evidence. ${evidenceSummary(check)}`
          : `${title}. ${action}`,
        designTeamAction: check.present ? `Confirm the parsed evidence is on the current plan set. ${action}` : action,
        evidenceNeeded: evidenceNeeded(check),
      },
    ));
  }

  const firePathway = evidenceForTopic(project, "firePathway");
  if (firePathway.confidence !== "high") {
    findings.push(finding(
      "reviewer.plan.fire-path",
      firePathway.present ? "warning" : "blocker",
      "plan_set",
      firePathway.present ? "Verify fire pathway evidence" : "Fire pathway evidence missing",
      firePathway.present
        ? `Fire pathway evidence is only ${firePathway.confidence}-confidence. ${evidenceSummary(firePathway)}`
        : "Confirm the site/roof plan clearly shows AHJ-required access and escape pathways.",
      true,
      {
        cityFeedback: firePathway.present
          ? `The plan set may include fire/access pathway evidence, but it needs human verification before submittal. ${evidenceSummary(firePathway)}`
          : "Fire pathway/setback dimensions were not found in parsed plan text.",
        designTeamAction: "Confirm dimensioned fire access pathways, setbacks, ridge/eave notes, and any local exception basis on the roof/site plan.",
        evidenceNeeded: evidenceNeeded(firePathway),
      },
    ));
  }
}

function addUtilityFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const account = evidenceForTopic(project, "accountVerification");
  if (/PGE|PORTLAND GENERAL/i.test(project.utility) && account.confidence !== "high") {
    findings.push(finding(
      "reviewer.utility.pge-account",
      account.present ? "warning" : "blocker",
      "utility_nem",
      account.present ? "Verify PGE account evidence" : "PGE account verification unresolved",
      account.present
        ? `PGE/NEM submission has an account value, but parsed utility bill/account match evidence is not strong enough. ${evidenceSummary(account)}`
        : "PGE/NEM submission should not be staged without a verified utility account number.",
      true,
      {
        cityFeedback: account.present
          ? "Utility account evidence is incomplete: account number alone is not enough for a clean intake pass."
          : "Utility account number and account verification were not found.",
        designTeamAction: "Verify utility bill/account holder/service address match before staging the NEM application.",
        evidenceNeeded: evidenceNeeded(account),
      },
    ));
  }
  if (/PACIFIC|PACIFICORP/i.test(project.utility)) {
    const meterPhoto = evidenceForTopic(project, "meterPhoto");
    if (meterPhoto.confidence !== "high") {
      findings.push(finding(
        "reviewer.utility.pacpower-meter-photo",
        meterPhoto.present ? "warning" : "blocker",
        "utility_nem",
        meterPhoto.present ? "Verify Pacific Power meter photo" : "Pacific Power meter photo missing",
        meterPhoto.present
          ? `Meter evidence needs review before customer generation staging. ${evidenceSummary(meterPhoto)}`
          : "Pacific Power customer generation packages should not be staged without meter photo/evidence.",
        true,
        {
          cityFeedback: meterPhoto.present
            ? "A meter number or weak meter evidence was captured, but a meter photo/evidence match was not proven."
            : "Meter photo/evidence was not found in the parsed project package.",
          designTeamAction: "Confirm the meter photo is present, legible, and matches the parsed meter number before staging.",
          evidenceNeeded: evidenceNeeded(meterPhoto),
        },
      ));
    }

    const inverterSettings = evidenceForTopic(project, "inverterSettings");
    if (inverterSettings.confidence !== "high") {
      findings.push(finding(
        "reviewer.utility.pacpower-settings",
        "warning",
        "utility_nem",
        inverterSettings.present ? "Verify Pacific Power inverter settings" : "Pacific Power inverter settings evidence missing",
        inverterSettings.present
          ? `UL 1741/inverter spec evidence was captured, but utility-specific settings are not fully proven. ${evidenceSummary(inverterSettings)}`
          : "Confirm UL 1741 SB / smart inverter settings evidence is included before NEM submission.",
        true,
        {
          cityFeedback: inverterSettings.present
            ? "Utility-required inverter settings need human verification, not just a generic inverter spec."
            : "Utility-required inverter settings/UL 1741 SB evidence was not found.",
          designTeamAction: "Add or verify Pacific Power inverter settings/UL 1741 SB evidence in the utility upload package.",
          evidenceNeeded: evidenceNeeded(inverterSettings),
        },
      ));
    }
  }
  if (payload(project, "ubMeterVerification") && /mismatch/i.test(payload(project, "ubMeterVerification"))) {
    findings.push(finding("reviewer.utility.meter-mismatch", "blocker", "utility_nem", "Meter mismatch", payload(project, "ubMeterVerification"), true));
  }
}

function addProfileFindings(project: ProjectRecord, profile: AhjProcessProfile | null, findings: ReviewerFinding[]): void {
  if (!profile) return;
  const docs = `${payload(project, "splitPagesText")}\n${payload(project, "utilityDownloadChecklistText")}\n${payload(project, "projectDescriptionText")}`;
  const stampText = `${payload(project, "stampRecommendation")}\n${payload(project, "reviewFlags")}`;
  if (profile.requiresPlanSet && !docs.trim()) {
    findings.push(finding("reviewer.profile.plan-set", "blocker", "ahj_profile", "AHJ profile requires plan set", `${profile.ahj} profile requires a plan set/upload package. No split mapping found.`, true));
  }
  if (profile.requiresStructuralStamp && !/stamp|engineer|structural letter|calc/i.test(stampText + docs)) {
    findings.push(finding("reviewer.profile.structural-stamp", "warning", "structural", "Structural stamp/letter may be required", `${profile.ahj} process profile indicates structural stamp/letter may be required. Confirm before submittal.`, true));
  }
  if (profile.requiresElectricalStamp && !/electrical stamp|engineer|sealed/i.test(docs)) {
    findings.push(finding("reviewer.profile.electrical-stamp", "warning", "electrical", "Electrical stamp may be required", `${profile.ahj} process profile indicates electrical stamp may be required.`, true));
  }
  const ownerAuthorization = evidenceForTopic(project, "ownerAuthorization");
  if (profile.requiresCustomerSignature && ownerAuthorization.confidence !== "high") {
    findings.push(finding(
      "reviewer.profile.customer-signature",
      "warning",
      "ahj_profile",
      ownerAuthorization.present ? "Verify customer/owner authorization" : "Customer/owner authorization may be required",
      `${profile.ahj} process profile indicates customer signature/authorization may be required. ${evidenceSummary(ownerAuthorization)}`,
      true,
      {
        cityFeedback: `${profile.ahj} appears to require customer/owner authorization. The parsed package does not prove this is complete.`,
        designTeamAction: "Confirm signed application, owner authorization, or representative authorization before submittal.",
        evidenceNeeded: evidenceNeeded(ownerAuthorization),
      },
    ));
  }
  const utilityApproval = evidenceForTopic(project, "utilityApproval");
  if (profile.requiresUtilityApproval && utilityApproval.confidence !== "high") {
    findings.push(finding(
      "reviewer.profile.utility-approval",
      "warning",
      "utility_nem",
      utilityApproval.present ? "Verify utility approval before permit" : "Utility approval may be required before permit",
      `${profile.ahj} process profile indicates utility approval/interconnection evidence may be needed before permit submission. ${evidenceSummary(utilityApproval)}`,
      true,
      {
        cityFeedback: `${profile.ahj} profile references utility approval/interconnection sequencing. The parsed package does not prove approval is ready.`,
        designTeamAction: "Confirm whether utility/NEM approval must be attached or completed before permit submission.",
        evidenceNeeded: evidenceNeeded(utilityApproval),
      },
    ));
  }
  if (profile.requiresFloodplainCheck && !/flood|FEMA/i.test(docs)) {
    findings.push(finding("reviewer.profile.flood", "warning", "ahj_profile", "Floodplain check required by profile", `${profile.ahj} process profile references flood/FEMA review. Confirm before submittal.`, true));
  }
  if (profile.requiresJurisdictionCheck) {
    findings.push(finding("reviewer.profile.jurisdiction", "callout", "ahj_profile", "Jurisdiction/address verification recommended", `${profile.ahj} process profile calls out jurisdiction or address verification. Confirm before submittal.`, true));
  }
}

function addInstallerCallouts(project: ProjectRecord, profile: AhjProcessProfile | null, findings: ReviewerFinding[]): void {
  findings.push(finding(
    "installer.scope-confirm",
    "callout",
    "installer",
    "Installer pre-submittal scope confirmation",
    `Confirm with installer: roof planes, array layout, interconnection method (${project.interconnectionMethod || "missing"}), MSP/main/PV breaker, battery backup mode, and any MPU/LST/locate-triggering work.`,
    true,
  ));
  if (profile?.reviewerNotes) {
    findings.push(finding(
      "installer.profile-notes",
      "callout",
      "installer",
      "AHJ process note to verify",
      `${profile.ahj}: ${profile.reviewerNotes}`,
      true,
    ));
  }
  if (payload(project, "locateCalloutText") && !/no locate|not needed|not found/i.test(payload(project, "locateCalloutText"))) {
    findings.push(finding("installer.locates", "callout", "installer", "Locates/utility coordination", payload(project, "locateCalloutText"), true));
  }
}
