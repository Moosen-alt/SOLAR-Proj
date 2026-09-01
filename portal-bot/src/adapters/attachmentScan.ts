// A DOCUMENT THAT IS ALREADY ATTACHED HAS NO FILE INPUT LEFT.
//
// Counting `input[type=file]` counts only the slots still WAITING for a document. Once a
// portal accepts a file it swaps the picker for a display of the file's name — PowerClerk
// renders a disabled text input holding "one-line-diagram.pdf" beside Download/Remove
// buttons — so a form carrying 9 slots and 3 documents reports "0/6 attached", and an upload
// that worked is indistinguishable from an upload that never happened. That ambiguity is
// exactly what made an audit untrustworthy: it could name what was blank but not what landed.
//
// The discriminator is the REMOVE control, not proximity to upload UI. Upload areas commonly
// carry a "download the blank template" link — a filename sitting inside upload UI that
// nobody attached — but nothing offers to remove a file that isn't there.
//
// Runs inside the page (passed to page.evaluate), so it must be self-contained.

export interface FoundAttachment { name: string; label: string }

export function findAttachmentsInPage(): FoundAttachment[] {
  const FILE_NAME = /^[\w][\w\-. ()&+]{0,90}\.(?:pdf|docx?|xlsx?|csv|jpe?g|png|gif|bmp|heic|webp|tiff?|dwg|zip)$/i;
  const REMOVE_TEXT = /^(remove|delete|clear|discard|detach|x|×|✕)$/i;

  // "Near" has to mean THIS slot, not this page. Walking up unbounded reaches <body>, where
  // some other slot's Remove button makes every filename on the page look attached — which is
  // how a blank-template link would be counted as a document. Stop at the page/section
  // boundary, and at any ancestor too big to be one slot's own container.
  const hasRemoveNear = (el: Element): boolean => {
    let box: Element | null = el;
    for (let up = 0; up < 4 && box; up++) {
      box = box.parentElement;
      if (!box) break;
      if (/^(BODY|HTML|FORM|MAIN|SECTION|TABLE|TBODY)$/.test(box.tagName)) break;
      if ((box.textContent || "").length > 400) break;
      for (const b of Array.from(box.querySelectorAll("button, a, [role='button']"))) {
        const t = `${b.textContent || ""} ${b.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
        if (REMOVE_TEXT.test(t)) return true;
      }
    }
    return false;
  };

  // The document's name is rarely the slot's name, so look upward for the question the
  // portal actually asked ("Please attach the Data Sheet for the DC Source/PV Module").
  const nearbyLabel = (el: Element): string => {
    let box: Element | null = el;
    for (let up = 0; up < 6 && box; up++) {
      box = box.parentElement;
      if (!box) break;
      const lbl = box.querySelector("label, .control-label, .field-label, [data-test-role='input-label']");
      const t = ((lbl as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > 3) return t;
    }
    return "";
  };

  const out: FoundAttachment[] = [];
  const push = (name: string, el: Element): void => {
    out.push({ name: name.slice(0, 80), label: nearbyLabel(el).slice(0, 70) });
  };

  // 1) A READ-ONLY field whose value is a filename (PowerClerk's shape). Read-only matters:
  //    an editable box someone typed a filename into is a text answer, not a document.
  for (const el of Array.from(document.querySelectorAll("input")) as HTMLInputElement[]) {
    const v = (el.value || "").trim();
    if (!v || !FILE_NAME.test(v) || !(el.disabled || el.readOnly)) continue;
    if (!hasRemoveNear(el)) continue;
    el.setAttribute("data-al-attach", "1"); // so the field pass doesn't count it as an answer
    push(v, el);
  }

  // 2) A link or text node naming a file, with a remove control beside it (Accela, OpenGov,
  //    and most attachment TABLES render an attached document this way).
  for (const el of Array.from(document.querySelectorAll("a, span, div, td, li, p"))) {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!FILE_NAME.test(t)) continue;
    // Innermost element only, so one filename isn't reported once per ancestor.
    if (Array.from(el.children).some((c) => FILE_NAME.test((c.textContent || "").replace(/\s+/g, " ").trim()))) continue;
    if (!hasRemoveNear(el)) continue;
    push(t, el);
  }

  return out;
}
