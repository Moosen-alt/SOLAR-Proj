// ---------------------------------------------------------------------------
// ON-SCREEN PII MASKING FOR A RECORDED PORTAL RUN — rendering only, never the DOM's values.
//
// A demo video of a REAL portal run shows a real homeowner's name, address, phone, account
// number and the installer's login unless something hides them at record time. This hides
// them in the RENDERING: an overlay layer of solid boxes, positioned over every control and
// every run of text that carries a known value, redrawn on every DOM change. The portal's own
// state is untouched — the bot fills what it fills, the portal saves what it saves, and the
// review page still echoes the values into the DOM; only the pixels change.
//
// Contract (what the smoke pins — scripts/demoMaskReplica.dom.smoke.ts):
//   · NEVER INTERCEPTS. The layer is pointer-events:none (a hit test passes through it, so
//     Playwright's click actionability is unaffected), it carries NO text nodes (dots are drawn
//     with CSS, so body.innerText is byte-identical with the layer present), it is appended to
//     <html> outside any <form>, and every listener it adds is passive and capture-phase with no
//     preventDefault/stopPropagation. The replica's recorded POST state is identical masked and
//     unmasked; that identity is the proof.
//   · NEVER CHANGES A VALUE OR AN ATTRIBUTE of the page's own elements. No class, no data-*,
//     no -webkit-text-security on the inputs: the engine's own in-page predicates
//     (readOnlyPageInPage, fieldIdentityInPage, boxOk) see exactly the page they would without it.
//   · RE-APPLIES on DOM mutation (a MutationObserver on the DOCUMENT node — the only node that
//     exists when an init script runs; documentElement is still null then, so an observer on
//     it would never attach and the interval would be the real mechanism), on
//     input/change/focus (a value change fires no mutation record — and the re-scan on `input`
//     is SYNCHRONOUS, so a value never paints a frame before its box), on scroll/resize, and on
//     a 250ms backstop interval (a programmatic `el.value =` fires nothing at all).
//   · MATCHES BY VALUE, BY FIELD IDENTITY AND BY REGION:
//       value  — a control whose value (a select: its chosen option's text; a listbox —
//                size>1 or multiple — EVERY option's text, since they are all painted) contains
//                a known value, or IS A PREFIX of one (typing paths emit `input` per keystroke);
//                text carrying a known value, boxed to the matched characters only. Text is
//                matched per LINE BOX, not per text node: the text nodes under one block
//                element (inline children — <span>, <b>, <a> — do not break a run) are
//                flattened and the match mapped back to each node, so "(541) <span>555-0163"
//                and "8802 <b>4680</b> 13" are caught. Matching is on the letters and digits
//                alone, UNICODE-AWARE (NFKD, marks stripped, \p{L}\p{N}): "8802 4680 13",
//                "(541) 555-0163", "Иван Петров", "山田太郎", "Zoë" and "José" are all values,
//                and "Jose" in the page matches "José" — ONE normaliser (piiTextMatcher) serves
//                the value list, the page and the OCR hit counter, so no two can disagree.
//                Purely alphabetic values match at word boundaries (a neighbouring CASED
//                letter — "Desmond" in "Desmondia", "Иван" in "Иванов" — is not a match;
//                an uncased script has no word spaces, so "山田太郎" in "山田太郎様" is).
//       field  — isSecretField (shared/src/portalSafety, THE ONE copy, evaluated in the page)
//                over label/name/id/autocomplete/type: a secret field is boxed whenever it is
//                focused or non-empty, whatever it holds.
//       region — per-platform-shape selector lists keyed by URL pattern (the account header,
//                the "My Applications" list — other customers' rows are values we do not know),
//                plus an operator-supplied selector list.
//   · SELF-CONTAINED. The in-page function closes over nothing: its source is serialised into
//     an init script, exactly like portalSafetyFactory; the matcher it uses is serialised the
//     same way and handed to it as an argument.
//   · AUDITABLE, INDEPENDENTLY. The in-page api's audit(rawValues) looks for every raw value by
//     plain case-insensitive substring (NOT the matcher — an instrument that shares the
//     predicate it checks cannot disagree with it) over text characters (each letter or
//     digit its own rect), inputs and options, and reports how many rendered rects sit
//     outside every box: counts and element descriptors, never the values. The recorder runs
//     it at the review stop.
//
// Known limits (a human still reviews every frame before a video is used): a value the page
// renders through CSS (content:, a background image), a native <select> popup while it is
// open (OS-drawn), and text inside a canvas or an iframe from another origin are not covered.
// ---------------------------------------------------------------------------
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";

// ---------------------------------------------------------------------------------------------
// THE ONE MATCHER. Self-contained (serialised into the page as well as imported by Node): how
// a value and a text are reduced to comparable letters and digits, and where a value sits in
// a text. Three consumers — piiMaskValues, the in-page masker, piiHitsInText (ocrFrames.ts).
// ---------------------------------------------------------------------------------------------
export interface PiiPreparedValue { norm: string; alpha: boolean; len: number }
export interface PiiTextMatcher {
  /** Letters and digits of `text`, lower-cased, decomposed (NFKD) with marks stripped, with a
   *  map from each kept char to the ORIGINAL index of the char it came from. */
  normalize(text: string): { norm: string; map: number[] };
  /** A value prepared for matching (empty norm when nothing is left). */
  prepare(raw: string): PiiPreparedValue;
  /** Character ranges of `text` (original offsets, [start, end)) carrying any prepared value,
   *  merged. Alphabetic values require a word boundary: the char before/after the match must
   *  not be a CASED letter (\p{Lu}\p{Ll}\p{Lt}) — an uncased script has no word spaces. */
  ranges(text: string, values: ReadonlyArray<PiiPreparedValue>): Array<[number, number]>;
}
export function piiTextMatcher(): PiiTextMatcher {
  const KEEP = /[\p{L}\p{N}]/u;
  const MARK = /\p{M}/gu;
  const CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u;
  const ALPHA = /^\p{L}+$/u;
  const normalize = (text: string): { norm: string; map: number[] } => {
    let norm = "";
    const map: number[] = [];
    let i = 0;
    for (const ch of String(text ?? "")) { // by code point, never half a surrogate pair
      const folded = ch.normalize("NFKD").replace(MARK, "").toLowerCase();
      for (const c of folded) if (KEEP.test(c)) { norm += c; map.push(i); }
      i += ch.length;
    }
    return { norm, map };
  };
  const prepare = (raw: string): PiiPreparedValue => {
    const norm = normalize(raw).norm;
    return { norm, alpha: ALPHA.test(norm), len: norm.length };
  };
  const ranges = (text: string, values: ReadonlyArray<PiiPreparedValue>): Array<[number, number]> => {
    if (!text || text.length < 3) return [];
    const { norm, map } = normalize(text);
    if (norm.length < 3) return [];
    const out: Array<[number, number]> = [];
    for (const v of values) {
      if (v.len < 3) continue;
      let from = 0;
      for (;;) {
        const at = norm.indexOf(v.norm, from);
        if (at < 0) break;
        from = at + 1;
        const start = map[at];
        const end = map[at + v.len - 1] + 1;
        if (v.alpha) {
          const before = start > 0 ? text[start - 1] : " ";
          const after = end < text.length ? text[end] : " ";
          if (CASED.test(before) || CASED.test(after)) continue;
        }
        out.push([start, end]);
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  };
  return { normalize, prepare, ranges };
}
/** The Node-side instance (the page gets its own, from the same source). */
export const PII_MATCHER: PiiTextMatcher = piiTextMatcher();

export const PII_MASK_GLOBAL = "__piiMask";
export const PII_MASK_LAYER_ID = "__piiMaskLayer";

/** A region rule: on a page whose URL matches `url` (a RegExp source, case-insensitive), every
 *  element matching one of `selectors` is boxed whole. */
export interface PiiMaskShape {
  url: string;
  selectors: string[];
}

export interface PiiMaskConfig {
  /** Known values, full and partial. Built by piiMaskValues; never logged. */
  values: string[];
  shapes: PiiMaskShape[];
  /** Operator-supplied selectors, boxed on every page. */
  extraSelectors: string[];
}

/**
 * Where a value can come from. Every field optional: the recorder passes a project row plus
 * the staging overlay's snapshot and the credential's username; the smoke passes a synthetic
 * project. Nothing here is printed by anything.
 */
export interface PiiMaskSource {
  project?: {
    homeownerName?: string | null;
    projectAddress?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    accountNumber?: string | null;
    meterNumber?: string | null;
    parserSnapshot?: Record<string, unknown> | null;
  } | null;
  /** The portal login's user name (never the password: it is type=password, masked by field). */
  credential?: { username?: string | null } | null;
  /** The installer / account-holder side: company, contact, email, phone, licence. */
  installer?: {
    company?: string | null;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    license?: string | null;
  } | null;
  /** Anything else the operator knows is on screen (an ESI id typed by hand, a signer's name). */
  extra?: string[] | null;
}

/** Snapshot keys whose scalar values are a person's or a service's identity. Bare "name" is
 *  included on purpose (homeownerName, installerContactName, ubAccountHolderName…). */
const PII_SNAPSHOT_KEY = /(name|address|street|county|parcel|apn|phone|email|account|meter|esi|\bsa\s*_?id|premise|service\s*point|service\s*agreement|customer|signat|licen[cs]e|owner|contact)/i;
/** Snapshot keys that name a thing, not a person — a "moduleModelName" is not PII. */
const NOT_PII_SNAPSHOT_KEY = /(module|inverter|panel|battery|equipment|manufacturer|make|model|utility(name)?$|ahj|jurisdiction|city$|state$|portal|platform|program|rate|tariff|file|path|url|type$|status|stage|method|kind|category)/i;

/** Words that are never a value on their own (street suffixes, company boilerplate). */
const STOP_WORDS = new Set([
  "ave", "avenue", "st", "street", "rd", "road", "ln", "lane", "dr", "drive", "ct", "court", "way", "blvd", "boulevard",
  "pl", "place", "cir", "circle", "ter", "terrace", "hwy", "highway", "pkwy", "parkway", "loop", "trail", "trl",
  "north", "south", "east", "west", "n", "s", "e", "w", "ne", "nw", "se", "sw", "apt", "unit", "suite", "ste",
  "solar", "energy", "power", "electric", "electrical", "llc", "inc", "co", "corp", "company", "corporation", "ltd",
  "services", "service", "systems", "system", "group", "the", "and", "of", "mr", "mrs", "ms", "dr", "jr", "sr", "ii", "iii",
  "usa", "us", "com", "net", "org", "example", "gmail", "yahoo", "outlook", "hotmail", "mail", "info", "office", "permits", "admin",
]);

const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
/** The comparable form of a value: its letters and digits, folded (THE one matcher). */
const alnum = (v: string): string => PII_MATCHER.normalize(v).norm;
/** How many letters (any script) a token carries. */
const letters = (t: string): number => (t.match(/\p{L}/gu) ?? []).length;

/**
 * The known values a run must hide, full and partial, de-duplicated. Partial variants:
 *   · a person's name → each token (≥ 3 letters, not a stop word);
 *   · an address → its first line, "<number> <street name>", and the street name alone (≥ 4 letters);
 *   · an email → the whole address and its local part (≥ 4 alphanumerics);
 *   · a company → the whole name and its first distinctive token (≥ 4 letters, not a stop word);
 *   · digit-bearing values (account, meter, phone, ZIP, licence) → the whole value (the in-page
 *     matcher ignores separators and matches across inline elements, so no spaced/dashed
 *     variants are needed).
 * Letters are letters in every script (\p{L}): "Иван Петров", "山田太郎", "Zoë" are values and
 * name tokens. Values shorter than 3 characters, or purely numeric and shorter than 4, are
 * dropped: they cannot be told from coincidence and would blank the page.
 */
export function piiMaskValues(src: PiiMaskSource): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    const s = clean(v);
    if (!s) return;
    const a = alnum(s);
    if (a.length < 3) return;
    if (/^\d+$/.test(a) && a.length < 4) return;
    if (/^\p{L}+$/u.test(a) && STOP_WORDS.has(a)) return;
    out.add(s);
  };
  const addName = (v: unknown): void => {
    const s = clean(v);
    if (!s) return;
    add(s);
    for (const tok of s.split(/[\s,]+/)) {
      const t = tok.replace(/[^\p{L}\p{M}'-]/gu, "");
      if (letters(t) >= 3) add(t);
    }
  };
  const addAddress = (v: unknown): void => {
    const s = clean(v);
    if (!s) return;
    add(s);
    const line = s.split(/,/)[0].trim();
    add(line);
    const m = /^(\d+\p{L}?)\s+(\p{L}[\p{L}\p{M}'.-]*)/u.exec(line);
    if (m) {
      add(`${m[1]} ${m[2]}`);
      if (letters(m[2]) >= 4) add(m[2]);
    }
  };
  const addEmail = (v: unknown): void => {
    const s = clean(v);
    if (!s) return;
    add(s);
    const local = s.split("@")[0];
    if (alnum(local).length >= 4) add(local);
  };
  const addCompany = (v: unknown): void => {
    const s = clean(v);
    if (!s) return;
    add(s);
    const first = s.split(/\s+/).find((t) => letters(t) >= 4 && !STOP_WORDS.has(alnum(t)));
    if (first) add(first);
  };

  const p = src.project;
  if (p) {
    addName(p.homeownerName);
    addAddress(p.projectAddress);
    add(p.city);
    add(p.zip);
    add(p.accountNumber);
    add(p.meterNumber);
    const snap = p.parserSnapshot && typeof p.parserSnapshot === "object" ? p.parserSnapshot : {};
    for (const [k, v] of Object.entries(snap)) {
      if (v == null || typeof v === "object" || typeof v === "boolean") continue;
      const s = clean(v);
      if (!s || s.length > 120) continue;
      if (!PII_SNAPSHOT_KEY.test(k) || NOT_PII_SNAPSHOT_KEY.test(k)) continue;
      if (/email/i.test(k)) addEmail(s);
      else if (/address|street/i.test(k)) addAddress(s);
      else if (/name|owner|contact|customer|signat/i.test(k) && !/company|business/i.test(k)) addName(s);
      else if (/company|business/i.test(k)) addCompany(s);
      else add(s);
    }
  }
  if (src.credential?.username) add(src.credential.username);
  const i = src.installer;
  if (i) {
    addCompany(i.company);
    addName(i.contactName);
    addEmail(i.email);
    add(i.phone);
    add(i.license);
  }
  // An extra that reads as a person's name ("Ines Coldharbour") gets a name's token variants;
  // an id or a number is taken whole.
  for (const e of src.extra ?? []) {
    const s = clean(e);
    if (/^\p{L}[\p{L}\p{M}'.-]*(\s+\p{L}[\p{L}\p{M}'.-]*)+$/u.test(s)) addName(s); else add(s);
  }
  return [...out];
}

/**
 * Region rules per platform shape. VALUES we know are caught by value wherever they appear;
 * these cover what we cannot know — the other rows in an account's application list, the
 * account header. The PowerClerk entries are generic by design: nothing here has been checked
 * against a live PowerClerk DOM, which is why a human reviews every frame and why the recorder
 * takes --mask-selectors for the operator's own additions.
 */
export const PII_MASK_SHAPES: Record<string, PiiMaskShape[]> = {
  powerclerk: [
    // The application list: every grid/table row on a dashboard / "My Projects" page.
    { url: "dashboard|my-?(projects|applications)|/projects\\b|projectlist|home", selectors: ["table", "[role=grid]", "[role=table]", ".projects", "[class*=project-list]", "[class*=ProjectList]"] },
    // The logged-in user / company block, wherever it sits.
    { url: ".", selectors: ["[class*=user-name]", "[class*=username]", "[class*=user-info]", "[class*=userinfo]", "[class*=account-name]", "[class*=logged-in]", "[id*=userName]", "[id*=UserName]:not(input)", "[class*=navbar] [class*=dropdown-toggle]", "[data-test-role*=user]", "[data-test-role*=account]"] },
  ],
  accela: [
    { url: "welcome|myrecords|caphome|default\\.aspx", selectors: ["table[id*=PermitList]", "table[id*=gdv]", "[id*=RecordList]"] },
    { url: ".", selectors: ["[id*=lblUserName]", "[id*=LoginStatus]", "[id*=lblWelcome]", "[class*=ACA_Welcome]", "[id*=Welcome]"] },
  ],
  generic: [
    { url: "dashboard|my-?(projects|applications|records)|home", selectors: ["table", "[role=grid]", "[role=table]"] },
    { url: ".", selectors: ["[class*=user-name]", "[class*=username]", "[class*=user-info]", "[class*=account-name]", "[class*=logged-in]", "[id*=lblUserName]", "[id*=Welcome]"] },
  ],
};

/** The shapes for a recipe's platform (falls back to the generic set). */
export function piiMaskShapesFor(portalPlatform: string | null | undefined): PiiMaskShape[] {
  const key = String(portalPlatform ?? "").toLowerCase();
  if (/powerclerk/.test(key)) return PII_MASK_SHAPES.powerclerk;
  if (/accela/.test(key)) return PII_MASK_SHAPES.accela;
  return PII_MASK_SHAPES.generic;
}

// ---------------------------------------------------------------------------------------------
// The in-page half. SELF-CONTAINED: it references nothing outside its own body except the
// config it is called with and window.__portalSafety (installed by the same init script).
// ---------------------------------------------------------------------------------------------

export interface PiiMaskAudit {
  /** How many raw values were looked for (never which). */
  valuesChecked: number;
  /** Rendered rects found carrying a raw value (text characters, inputs, options). */
  rectsChecked: number;
  /** Of those, how many sit outside every box. 0 with rectsChecked > 0 is the proof. */
  uncovered: number;
  /** Element descriptors of the uncovered rects (tag#id / tag.class), never the values. */
  where: string[];
}

export interface PiiMaskInPageApi {
  /** Re-scan and redraw synchronously. Returns how many boxes are drawn. */
  scan(): number;
  /** The boxes currently drawn (viewport coordinates). */
  boxes(): Array<{ x: number; y: number; w: number; h: number; kind: "field" | "text" | "region" }>;
  /** How many known values the page was configured with (never the values). */
  valueCount: number;
  /** The independent instrument: raw case-insensitive substring search, per-character rects,
   *  against the boxes as drawn (see the header). Does not re-scan. */
  audit(rawValues: string[]): PiiMaskAudit;
}

function piiMaskInPage(cfg: PiiMaskConfig, layerId: string, safetyGlobal: string, apiGlobal: string, matcher: PiiTextMatcher): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[apiGlobal]) return; // idempotent per document
  const d = document;
  type Box = { x: number; y: number; w: number; h: number; kind: "field" | "text" | "region" };
  interface Safety { isSecretField(f: unknown): boolean; fieldIdentityInPage(el: Element): unknown }
  const safety = (g[safetyGlobal] as Safety | undefined) ?? null;

  // Prepared values, through THE matcher (the same source that prepared the list in Node).
  const values = cfg.values.map((raw) => matcher.prepare(raw)).filter((v) => v.len >= 3);
  const shapes = cfg.shapes.map((s) => { try { return { re: new RegExp(s.url, "i"), selectors: s.selectors }; } catch { return null; } })
    .filter((s): s is { re: RegExp; selectors: string[] } => !!s);

  /** Character ranges of `text` (original offsets) that carry a known value, merged. */
  const findRanges = (text: string): Array<[number, number]> => matcher.ranges(text, values);

  /** Does a control's displayed value carry (or begin) a known value? */
  const valueMatches = (shown: string): boolean => {
    const n = matcher.normalize(shown).norm;
    if (n.length < 3) return false;
    for (const v of values) {
      if (n.indexOf(v.norm) >= 0) {
        if (!v.alpha) return true;
        // Word boundary in the shown text, as for text nodes.
        if (findRanges(shown).length) return true;
        continue;
      }
      if (v.norm.indexOf(n) === 0) return true; // a prefix: the value is being typed
    }
    return false;
  };

  /** A listbox paints EVERY option, not only the chosen one. */
  const isListbox = (el: Element): boolean => el.tagName === "SELECT" && ((el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1);

  const shownValue = (el: Element): string => {
    const tag = el.tagName;
    if (tag === "SELECT") {
      const s = el as HTMLSelectElement;
      if (isListbox(s)) return Array.from(s.options).map((o) => `${o.textContent || ""} ${o.value || ""}`).join("\n");
      const o = s.options[s.selectedIndex];
      return o ? `${o.textContent || ""} ${o.value || ""}` : "";
    }
    if (tag === "INPUT" || tag === "TEXTAREA") return (el as HTMLInputElement).value || "";
    return (el as HTMLElement).innerText || el.textContent || "";
  };

  // Text is matched per LINE BOX: the text nodes under one block-level element form a run
  // (inline children do not break it), flattened with no separator and mapped back to nodes.
  const INLINE = new Set(["SPAN", "B", "I", "U", "EM", "STRONG", "A", "SMALL", "SUB", "SUP", "MARK", "ABBR", "CODE", "LABEL", "FONT", "S", "DEL", "INS", "Q", "CITE", "DFN", "KBD", "SAMP", "VAR", "TIME", "DATA", "BDI", "BDO", "WBR", "BR", "BIG", "TT", "NOBR", "STRIKE"]);
  const blockOf = (el: Element | null): Element | null => {
    let e = el;
    while (e && INLINE.has(e.tagName)) e = e.parentElement;
    return e;
  };
  type Run = { block: Element | null; nodes: Text[]; starts: number[]; text: string };
  const textRuns = (root: Node, layer: Element | null): Run[] => {
    const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const t = p.tagName;
        if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT" || t === "TEMPLATE" || t === "OPTION") return NodeFilter.FILTER_REJECT;
        if (layer && layer.contains(p)) return NodeFilter.FILTER_REJECT;
        return (n.nodeValue || "").length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const runs: Run[] = [];
    let cur: Run | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = blockOf(n.parentElement);
      if (!cur || cur.block !== block) { cur = { block, nodes: [], starts: [], text: "" }; runs.push(cur); }
      cur.starts.push(cur.text.length);
      cur.nodes.push(n as Text);
      cur.text += n.nodeValue || "";
    }
    return runs;
  };
  /** The rects of run offsets [s, e) — one Range per text node the span touches. */
  const runRects = (run: Run, s: number, e: number): DOMRect[] => {
    const out: DOMRect[] = [];
    for (let i = 0; i < run.nodes.length; i++) {
      const ns = run.starts[i];
      const ne = ns + (run.nodes[i].nodeValue || "").length;
      const a = Math.max(s, ns);
      const b = Math.min(e, ne);
      if (a >= b) continue;
      try {
        const range = d.createRange();
        range.setStart(run.nodes[i], a - ns);
        range.setEnd(run.nodes[i], b - ns);
        for (const r of Array.from(range.getClientRects())) out.push(r);
      } catch { /* a detached node between scans */ }
    }
    return out;
  };

  const isSecret = (el: Element): boolean => {
    if (!safety) return false;
    try { return safety.isSecretField(safety.fieldIdentityInPage(el)); } catch { return false; }
  };

  const visibleRect = (el: Element): DOMRect | null => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    return r;
  };

  const FIELD_SEL = "input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), select, textarea, [contenteditable=true], [contenteditable='']";

  const collect = (): Box[] => {
    const boxes: Box[] = [];
    const body = d.body;
    if (!body) return boxes;
    const layer = d.getElementById(layerId);
    const push = (r: DOMRect | DOMRectReadOnly, kind: Box["kind"], pad: number): void => {
      boxes.push({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2, kind });
    };
    // (c) regions by platform shape and operator selectors.
    const href = location.href;
    const regionSelectors: string[] = [...cfg.extraSelectors];
    for (const s of shapes) if (s.re.test(href)) regionSelectors.push(...s.selectors);
    for (const sel of regionSelectors) {
      let els: Element[] = [];
      try { els = Array.from(d.querySelectorAll(sel)); } catch { continue; }
      for (const el of els) {
        if (layer && (el === layer || layer.contains(el))) continue;
        const r = visibleRect(el);
        if (r) push(r, "region", 2);
      }
    }
    // (a) controls: secret by identity (focused or non-empty), or carrying a known value.
    for (const el of Array.from(d.querySelectorAll(FIELD_SEL))) {
      if (layer && layer.contains(el)) continue;
      const shown = shownValue(el);
      const focused = d.activeElement === el;
      const secret = isSecret(el);
      if (!(secret && (focused || shown.trim())) && !(shown.trim() && valueMatches(shown))) continue;
      const r = visibleRect(el);
      if (r) push(r, "field", 1);
    }
    // (b) text, per line box: only the matched characters, across inline element boundaries.
    for (const run of textRuns(body, layer)) {
      if (run.text.length < 3) continue;
      const ranges = findRanges(run.text);
      for (const [s, e] of ranges) {
        for (const r of runRects(run, s, e)) {
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
          push(r, "text", 2);
        }
      }
    }
    return boxes;
  };

  /** The independent instrument (see the header): raw substring, per-character rects. */
  const audit = (rawValues: string[]): PiiMaskAudit => {
    const layer = d.getElementById(layerId);
    const boxRects = layer ? Array.from(layer.children).map((c) => c.getBoundingClientRect()) : [];
    const covered = (r: DOMRect): boolean => {
      const pts: Array<[number, number]> = [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
      return pts.every(([x, y]) => boxRects.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom));
    };
    const onScreen = (r: DOMRect): boolean => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const desc = (el: Element | null): string => el ? `${el.tagName.toLowerCase()}#${el.id || (typeof el.className === "string" && el.className ? el.className.split(/\s+/)[0] : "?")}` : "?";
    const out: PiiMaskAudit = { valuesChecked: 0, rectsChecked: 0, uncovered: 0, where: [] };
    const raws = rawValues.map((v) => String(v ?? "").toLowerCase()).filter((v) => v.trim().length >= 3);
    out.valuesChecked = raws.length;
    if (!d.body || !raws.length) return out;
    const seenWhere = new Set<string>();
    const flag = (r: DOMRect, el: Element | null): void => {
      out.rectsChecked++;
      if (covered(r)) return;
      out.uncovered++;
      const w = desc(el);
      if (!seenWhere.has(w)) { seenWhere.add(w); out.where.push(w); }
    };
    // Text: every occurrence of every raw value in a line box, one rect per LETTER OR DIGIT
    // (a bare bracket, hyphen or space outside a box reveals nothing on its own).
    const INFORMATIVE = /[\p{L}\p{N}]/u;
    for (const run of textRuns(d.body, layer)) {
      const lower = run.text.toLowerCase();
      for (const v of raws) {
        let at = lower.indexOf(v);
        while (at >= 0) {
          for (let i = at; i < at + v.length; i++) {
            if (!INFORMATIVE.test(run.text[i])) continue;
            for (const r of runRects(run, i, i + 1)) if (onScreen(r)) flag(r, run.block);
          }
          at = lower.indexOf(v, at + 1);
        }
      }
    }
    // Controls: an input/textarea whose value carries a raw value; a select whose chosen
    // option (or, for a listbox, any option) does.
    for (const el of Array.from(d.querySelectorAll("input, textarea, select"))) {
      if (layer && layer.contains(el)) continue;
      const e = el as HTMLInputElement;
      if (e.type === "hidden" || e.type === "file" || e.type === "checkbox" || e.type === "radio") continue;
      let shown = "";
      if (el.tagName === "SELECT") {
        const s = el as HTMLSelectElement;
        shown = (isListbox(s) ? Array.from(s.options) : Array.from(s.selectedOptions)).map((o) => o.textContent || "").join("\n");
      } else shown = e.value || "";
      const l = shown.toLowerCase();
      if (!raws.some((v) => l.includes(v))) continue;
      const r = el.getBoundingClientRect();
      if (onScreen(r)) flag(r, el);
    }
    return out;
  };

  let current: Box[] = [];
  const ensureLayer = (): HTMLElement | null => {
    let layer = d.getElementById(layerId);
    if (layer) return layer;
    if (!d.documentElement) return null;
    layer = d.createElement("div");
    layer.id = layerId;
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;overflow:visible;";
    d.documentElement.appendChild(layer);
    return layer;
  };
  const draw = (boxes: Box[]): void => {
    const layer = ensureLayer();
    if (!layer) return;
    const kids = layer.children;
    while (kids.length > boxes.length) layer.removeChild(kids[kids.length - 1]);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      let el = kids[i] as HTMLElement | undefined;
      if (!el) { el = d.createElement("div"); layer.appendChild(el); }
      // No text inside: dots are a CSS pattern, so innerText of the document is unchanged.
      el.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;box-sizing:border-box;` +
        "background-color:#4b5563;background-image:radial-gradient(circle,#d1d5db 1.6px,transparent 2.2px);background-size:9px 9px;background-position:center;" +
        `border-radius:3px;pointer-events:none;${b.kind === "region" ? "opacity:.97;" : ""}`;
    }
    current = boxes;
  };

  let pending = false;
  const scanNow = (): number => {
    pending = false;
    try { draw(collect()); } catch { /* keep the last frame's boxes */ }
    return current.length;
  };
  const scanSoon = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(scanNow);
  };

  // Observers and listeners — all passive, none stop or cancel anything.
  const mo = new MutationObserver((records) => {
    const layer = d.getElementById(layerId);
    for (const r of records) {
      const t = r.target as Node;
      if (layer && (t === layer || layer.contains(t))) continue;
      scanSoon();
      return;
    }
  });
  // On the DOCUMENT node: it exists when an init script runs; documentElement does not yet
  // (and an observer that never attaches leaves the 250ms interval as the only re-apply —
  // up to two exposed frames at 8 fps for any late render).
  mo.observe(d, { childList: true, subtree: true, characterData: true, attributes: true });
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const ev of ["input", "change", "focusin", "focusout", "keyup"]) d.addEventListener(ev, () => { scanNow(); }, opts);
  addEventListener("scroll", scanSoon, opts);
  addEventListener("resize", scanSoon, opts);
  d.addEventListener("scroll", scanSoon, opts);
  setInterval(scanSoon, 250);
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", () => { scanNow(); }, opts);
  else scanNow();

  const api: PiiMaskInPageApi = { scan: scanNow, boxes: () => current.slice(), valueCount: values.length, audit };
  try { Object.defineProperty(g, apiGlobal, { value: Object.freeze(api), writable: false, configurable: false }); } catch { g[apiGlobal] = api; }
}

/**
 * The init script: the shared portalSafety predicates (with the __name shim), then the masker
 * with its config baked in and THE matcher built from its own source. Install with
 * context.addInitScript({ content }) BEFORE any page is opened, so every navigation, frame
 * and re-render of the run is covered.
 */
export function piiMaskInitScript(cfg: PiiMaskConfig): string {
  const config: PiiMaskConfig = {
    values: [...new Set(cfg.values.map(clean).filter(Boolean))],
    shapes: cfg.shapes,
    extraSelectors: cfg.extraSelectors,
  };
  return PORTAL_SAFETY_IN_PAGE_SOURCE + "\n" +
    "globalThis.__name = globalThis.__name || function (fn) { return fn; };\n" +
    `try { (${piiMaskInPage.toString()})(${JSON.stringify(config).replace(/</g, "\\u003c")}, ${JSON.stringify(PII_MASK_LAYER_ID)}, ${JSON.stringify(PORTAL_SAFETY_GLOBAL)}, ${JSON.stringify(PII_MASK_GLOBAL)}, (${piiTextMatcher.toString()})()); } catch (e) {}`;
}
