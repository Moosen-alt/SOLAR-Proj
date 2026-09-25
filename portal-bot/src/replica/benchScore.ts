// STRICT SCORING FOR ONE REPLICA RUN — read from what the portal RECEIVED.
//
// A field counts as correct only when the replica's committed value for that logical control
// matches what the project says it should be. Nothing the bot reports about itself enters the
// score: a step it calls "filled" that the portal never saved is a blank, and a value that
// landed in the neighbouring box is a wrong-box write, whatever the step log says.
//
// Counted, per run, all with their denominator:
//   fields_expected  controls on this variant with an expected value
//   fields_correct   of those, committed and matching
//   blanked          expected non-empty, committed empty (a skip, a lost autosave, a wipe)
//   wrong_value      committed, non-empty, and not the expected value
//   wrong_box_writes a value that belongs to ANOTHER control landed here, or anything at all
//                    landed in a decoy that must stay empty
//   leaked_A_values  a value only project A carries appears anywhere in the committed state
//   submit/pay posts the portal would have filed or charged
import type { SynthProject } from "./fixtures/syntheticProjects";
import { scoredControls, type Ctl, type DocKey, type Expect, type Wizard } from "./fixtures/wizards";
import type { ReplicaState } from "./syntheticServer";

export interface FieldVerdict {
  key: string;
  label: string;
  verdict: "correct" | "blank" | "wrong" | "wrong_box" | "leak";
  /** Expected vs got are shown ONLY as match classes, never as values — the JSON output is
   *  shareable, and even synthetic values need not be repeated there. */
  note?: string;
}

export interface RunScore {
  reachedReview: boolean;
  fieldsExpected: number;
  fieldsCorrect: number;
  blanked: number;
  wrongValue: number;
  wrongBoxWrites: number;
  leakedAValues: number;
  submitPosts: number;
  payPosts: number;
  /** reachedReview AND every field correct AND no wrong box AND no leak AND no submit/pay. */
  allCorrect: boolean;
  fields: FieldVerdict[];
}

const norm = (s: string) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const digits = (s: string) => String(s ?? "").replace(/\D/g, "");

export function matches(e: Expect, want: string, got: string): boolean {
  const g = String(got ?? "");
  if (!g.trim()) return false;
  switch (e.match) {
    case "exact": return g.trim() === want.trim();
    case "ci": return norm(g) === norm(want);
    case "digits": return digits(g).length >= 10 && digits(g).slice(-10) === digits(want).slice(-10);
    case "prefix3": return g.trim().length >= 3 && norm(want).startsWith(norm(g));
    case "option": return g.trim() === want.trim();
    case "date_future": {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(g.trim()) || /^(\d{4})-(\d{2})-(\d{2})$/.exec(g.trim());
      if (!m) return false;
      const d = g.includes("/") ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      const today = new Date(); today.setHours(0, 0, 0, 0);
      return !Number.isNaN(d.getTime()) && d.getTime() >= today.getTime();
    }
  }
}

/** The expected value of every scored control for `project`. */
export function expectedValues(w: Wizard, project: SynthProject, docs: Record<DocKey, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of scoredControls(w)) out.set(c.key, c.expect!.value(project, docs));
  return out;
}

/** Pairs of scored controls whose expected values for `project` are interchangeable: a replay
 *  that swaps them leaves a state identical to the correct one, so no counter can see it.
 *  Printed by the scoreboard so a clean number is not read as covering them. */
export function knownBlindSpots(w: Wizard, project: SynthProject, docs: Record<DocKey, string>): string[] {
  const scored = scoredControls(w);
  const expected = expectedValues(w, project, docs);
  const out: string[] = [];
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const a = scored[i], b = scored[j];
      const wa = expected.get(a.key) ?? "", wb = expected.get(b.key) ?? "";
      if (!wa.trim() || !wb.trim()) continue;
      if (matches(a.expect!, wa, wb) && matches(b.expect!, wb, wa)) out.push(`${a.key} <-> ${b.key}`);
    }
  }
  return out;
}

export function scoreRun(
  w: Wizard,
  state: ReplicaState,
  project: SynthProject,
  docs: Record<DocKey, string>,
  aOnly: string[],
): RunScore {
  const scored = scoredControls(w);
  const expected = expectedValues(w, project, docs);
  const decoys: Ctl[] = w.pages.flatMap((p) => p.controls.filter((c) => c.mustStayEmpty));
  const fields: FieldVerdict[] = [];
  const aNorm = aOnly.map(norm).filter((v) => v.length >= 3);
  const aDigits = aOnly.map(digits).filter((d) => d.length >= 7);
  const isALeak = (v: string): boolean => {
    const n = norm(v);
    if (!n) return false;
    if (aNorm.some((a) => n === a || (a.length >= 6 && n.includes(a)))) return true;
    const d = digits(v);
    return d.length >= 7 && aDigits.some((a) => d === a || d.endsWith(a.slice(-10)));
  };

  let correct = 0, blanked = 0, wrongValue = 0, wrongBox = 0, leaks = 0;
  for (const c of scored) {
    const want = expected.get(c.key) ?? "";
    const got = state.values[c.key] ?? "";
    const label = c.label.replace(/[:*\s]+$/g, "");
    if (matches(c.expect!, want, got)) { correct++; fields.push({ key: c.key, label, verdict: "correct" }); continue; }
    if (!String(got).trim()) { blanked++; fields.push({ key: c.key, label, verdict: "blank" }); continue; }
    if (isALeak(got)) { leaks++; wrongValue++; fields.push({ key: c.key, label, verdict: "leak", note: "holds a value only project A carries" }); continue; }
    // Does it hold ANOTHER control's expected value? Then it landed in the wrong box.
    const other = scored.find((o) => o.key !== c.key && matches(o.expect!, expected.get(o.key) ?? "", got) && !matches(c.expect!, want, expected.get(o.key) ?? ""));
    if (other) { wrongBox++; wrongValue++; fields.push({ key: c.key, label, verdict: "wrong_box", note: `holds the value expected in ${other.key}` }); continue; }
    wrongValue++;
    fields.push({ key: c.key, label, verdict: "wrong", note: `does not match (${c.expect!.match})` });
  }
  for (const d of decoys) {
    const got = state.values[d.key] ?? "";
    if (!String(got).trim()) continue;
    wrongBox++;
    if (isALeak(got)) leaks++;
    fields.push({ key: d.key, label: d.label, verdict: "wrong_box", note: "a decoy control that must stay empty was written" });
  }
  // A leak can also sit in a control that is not scored (e.g. the Accela range "To" box).
  for (const [k, v] of Object.entries(state.values)) {
    if (k.startsWith("__") || scored.some((c) => c.key === k) || decoys.some((d) => d.key === k)) continue;
    if (isALeak(v)) { leaks++; fields.push({ key: k, label: k, verdict: "leak", note: "an unscored control holds a value only project A carries" }); }
  }
  const submitPosts = state.submitPosts.length;
  const payPosts = state.payPosts.length;
  return {
    reachedReview: state.reviewReached,
    fieldsExpected: scored.length,
    fieldsCorrect: correct,
    blanked,
    wrongValue,
    wrongBoxWrites: wrongBox,
    leakedAValues: leaks,
    submitPosts,
    payPosts,
    allCorrect: state.reviewReached && correct === scored.length && wrongBox === 0 && leaks === 0 && submitPosts === 0 && payPosts === 0,
    fields,
  };
}
