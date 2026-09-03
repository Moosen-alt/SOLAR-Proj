// ---------------------------------------------------------------------------
// CORRECTING A FILED APPLICATION — choosing the form that reopens it.
//
// A suspended filing is not re-filed, it is REOPENED. A portal that suspends an application
// exposes a named form on the project's landing page; beginning it reopens the ORIGINAL
// wizard with the reviewer's notes rendered inline beside the offending fields, and
// submitting it replaces the filing rather than creating a second one.
//
// Live shape (PacifiCorp PowerClerk, APP-111681): the landing page lists "Current Forms" and
// "Previously Submitted Forms". Under Current Forms sat:
//
//     PP - Suspended - Changes Needed From Customer     [Begin]
//     PP - Cancellation Form                            [Begin]
//
// Two rows. Same table, same markup, byte-identical buttons, adjacent. One reopens the
// application for correction; the other CANCELS the customer's interconnection request.
// Nothing but the NAME separates them.
//
// So this module exists to make that choice explainable rather than positional. It is the
// same lesson as the wrong permit record type and the rebate programme, in a third costume,
// and it is the most destructive of the three: a cancelled interconnection is not a
// correction cycle, it is a lost project.
//
// The rules:
//
//   NAME DECIDES, NEVER POSITION. Every candidate is matched against what it is called.
//   Anything cancellation- or withdrawal-shaped is refused outright and can never be chosen,
//   no matter how the preference list scores. Refusal beats preference, always.
//
//   ONLY AN ACTIONABLE FORM. A row whose only control is "View" is a receipt for something
//   already submitted, not a way in. The correction form for THIS filing appears under
//   Current Forms with Begin (never started) or Continue (started and left); after it is
//   submitted it moves to Previously Submitted with View, which is exactly how we confirm
//   the resubmission landed.
//
//   AMBIGUITY IS REFUSED. Two plausible correction forms means the portal is offering a
//   choice this code cannot make. Refuse and let a human look, rather than guess between
//   them — guessing is how the mechanical permit got filed.
//
// Portal-agnostic by construction: PacifiCorp names it "Suspended - Changes Needed From
// Customer", PGE uses the same reopen-the-wizard shape with per-correction confirmation
// checkboxes, and other vendors word it differently again ("More Information Required",
// "Deficiency Response"). The preference list reads intent, not one vendor's wording.
// ---------------------------------------------------------------------------

/** One row of a project's form list. */
export interface ProjectFormRow {
  /** Learn-time marker attribute value, for clicking the exact row that was scanned. */
  key: string;
  /** The form's visible name, e.g. "PP - Suspended - Changes Needed From Customer". */
  name: string;
  /** Visible label of the row's control: "Begin", "Continue", "View", ... */
  action: string;
  /** Heading of the card the row sits under, e.g. "Current Forms". */
  section: string;
}

/**
 * NEVER eligible. A cancellation or withdrawal form ends the customer's interconnection
 * request; it is the single most destructive control on the page and it sits directly
 * beside the one we want. Also refuses the appeal/complaint shapes some portals list here.
 */
export const CORRECTION_REFUSE = /cancel|withdraw|terminate|rescind|abandon|delete|close[\s-]?out|opt[\s-]?out|dispute|appeal|complaint/i;

/**
 * What a "the utility wants something changed" form is called, most explicit first.
 * Ordered: an exact "suspended / changes needed" beats a generic "update".
 */
export const CORRECTION_PREFER: RegExp[] = [
  /suspend|changes?\s+needed|correction/i,
  /(more|additional)\s+information|information\s+(required|needed|request)/i,
  /deficien|incomplete|revision|revise|remediat/i,
  /resubmit|re-?submit/i,
];

/** A control that opens a form for editing. "View" is a receipt, not a way in. */
export const CORRECTION_ACTIONABLE = /^\s*(begin|continue|start|resume|edit|open|update)\s*$/i;

/**
 * Runs INSIDE the page (passed to page.evaluate). Self-contained by necessity: it is
 * serialized across the CDP boundary and cannot close over module scope.
 *
 * Tags each row's control with data-al-cform so the caller clicks the exact element that
 * was scanned rather than re-resolving by a name that may appear twice on the page (the
 * same form name shows up again under Previously Submitted once it has been sent).
 */
export function scanProjectForms(): ProjectFormRow[] {
  const vis = (e: Element): boolean => {
    const r = (e as HTMLElement).getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const text = (e: Element | null): string =>
    e ? ((e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() : "";

  const rows: ProjectFormRow[] = [];
  let n = 0;

  // Iterate the ROWS once, globally. Scanning per-container instead counts every row once
  // per matching ancestor — on PowerClerk's real markup (div.card > div.card-body.capsule
  // > table) that yielded each form three times, which then read as an ambiguous choice and
  // refused a page that was never ambiguous.
  for (const row of Array.from(document.querySelectorAll("tbody tr, li"))) {
    if (!vis(row)) continue;
    const control = row.querySelector("button, a.btn, input[type='button'], input[type='submit']");
    if (!control || !vis(control)) continue;
    const action = (
      (control as HTMLElement).innerText ||
      (control as HTMLInputElement).value ||
      control.getAttribute("aria-label") ||
      ""
    ).replace(/\s+/g, " ").trim();

    // The NAME sits in the control's OWN cell. Reading the whole row instead drags in the
    // status column ("... Begin New Form Became available on 9/3/2026 at 8:31 AM"), which
    // buries the name that is the only thing distinguishing a correction form from a
    // cancellation form.
    const cell = (control.closest("td, th, li") as HTMLElement | null)
      ?? (row.children[0] as HTMLElement | null)
      ?? (row as HTMLElement);
    let name = text(cell);
    if (action && name.endsWith(action)) name = name.slice(0, -action.length).trim();
    if (!name || name.length > 120) continue;

    // The section heading is the nearest ancestor that carries one — "Current Forms" vs
    // "Previously Submitted Forms". Walking up stops at the row's own card, so a row never
    // borrows the heading of the card above it.
    let section = "";
    let el: Element | null = row.parentElement;
    while (el && !section) {
      const h = el.querySelector(".card-header, .capsule-title, caption, legend, h1, h2, h3");
      if (h) section = text(h).slice(0, 80);
      el = el.parentElement;
    }

    const key = "cf" + String(n++);
    (control as HTMLElement).setAttribute("data-al-cform", key);
    rows.push({ key, name, action, section });
  }
  return rows;
}

export interface CorrectionChoice {
  row: ProjectFormRow;
  /** Why this row won — recorded so a filing is never opened for a reason nobody can read. */
  why: string;
}

export interface CorrectionRefusal {
  refused: true;
  why: string;
  /** Every form name that was on offer, so the refusal is diagnosable. */
  offered: string[];
}

export function isRefusal(r: CorrectionChoice | CorrectionRefusal): r is CorrectionRefusal {
  return (r as CorrectionRefusal).refused === true;
}

/**
 * Picks the form that reopens a suspended filing, or refuses with a reason.
 *
 * Never throws and never guesses: every outcome is either a named choice or a refusal
 * carrying what was offered.
 */
export function chooseCorrectionForm(rows: ProjectFormRow[]): CorrectionChoice | CorrectionRefusal {
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.name === "string");
  const offered = all.map((r) => `${r.name}${r.action ? ` [${r.action}]` : ""}`);

  // Only rows that can actually be opened. A "View" row is the receipt for a form already
  // submitted — including, after a successful resubmission, this very form.
  const actionable = all.filter((r) => CORRECTION_ACTIONABLE.test(r.action || ""));
  if (actionable.length === 0) {
    return { refused: true, why: "no form on this project can be opened — every row is view-only", offered };
  }

  // Refusal beats preference. A name that reads as cancellation is out before scoring, so
  // no preference match can ever resurrect it.
  const safe = actionable.filter((r) => !CORRECTION_REFUSE.test(r.name));
  const barred = actionable.filter((r) => CORRECTION_REFUSE.test(r.name)).map((r) => r.name);
  if (safe.length === 0) {
    return {
      refused: true,
      why: `the only openable form(s) would cancel or withdraw the filing: ${barred.join(" | ")}`,
      offered,
    };
  }

  for (const re of CORRECTION_PREFER) {
    const hits = safe.filter((r) => re.test(r.name));
    if (hits.length === 1) {
      return {
        row: hits[0],
        why: `"${hits[0].name}" is the form that reopens this filing for correction`
          + (barred.length ? `; refused ${barred.join(" | ")} as cancellation-shaped` : ""),
      };
    }
    if (hits.length > 1) {
      return {
        refused: true,
        why: `${hits.length} forms read as a correction form (${hits.map((h) => h.name).join(" | ")}) — refusing rather than guessing between them`,
        offered,
      };
    }
  }

  return {
    refused: true,
    why: "no openable form reads as a correction/changes-needed form"
      + (barred.length ? `; ${barred.join(" | ")} was refused as cancellation-shaped` : ""),
    offered,
  };
}

/**
 * How the choice is recorded for replay. By NAME, never by position — and scoped to the
 * row's own control via the learn-time tag at click time, because the same form name
 * reappears under "Previously Submitted Forms" the moment it has been sent.
 */
export function correctionFormSelector(row: ProjectFormRow): {
  text: string;
  fallbacks: Array<{ role?: string; name?: string; text?: string }>;
} {
  return {
    text: row.name,
    fallbacks: [
      { role: "button", name: row.action || "Begin" },
      { text: `${row.name} ${row.action}`.trim() },
    ],
  };
}
