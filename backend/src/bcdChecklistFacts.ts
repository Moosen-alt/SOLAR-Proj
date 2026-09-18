import type { ProjectRecord } from "../../shared/src/types";
type Answer = "Yes" | "No" | "";
type Fact = boolean | null;
const all = (...v: Fact[]): Fact => v.includes(false) ? false : v.includes(null) ? null : true;
const any = (...v: Fact[]): Fact => v.includes(true) ? true : v.includes(null) ? null : false;

/** BCD 5952 compound statements. A numeric fact alone does not establish a
 * separate code-compliance clause. Unknown remains blank, never a false No. */
export function bcdChecklistAnswers(project: ProjectRecord): Record<string, Answer> {
  const s = project.parserSnapshot ?? {};
  const str = (k: string) => String(s[k] ?? "").trim().toLowerCase();
  const flag = (k: string): Fact => /^(yes|true)$/.test(str(k)) ? true : /^(no|false)$/.test(str(k)) ? false : null;
  const n = (k: string) => { const m = str(k).match(/^\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const max = (k: string, limit: number): Fact => n(k) == null ? null : n(k)! <= limit;
  const frame = str("framingType");
  const truss = all(frame ? /truss/.test(frame) : null, max("roofRafterSpacing", 24));
  const rafter = all(frame ? /rafter/.test(frame) : null, max("roofRafterSpacing", 24), flag("rafterExceptionCompliant"));
  const roof = str("roofMaterial");
  const roofing = !roof ? null : /metal/.test(roof) ? true
    : /compos|asphalt/.test(roof) ? max("roofLayers", 2)
    : /wood|shake/.test(roof) ? max("roofLayers", 1) : null;
  const exposure = str("wind").toUpperCase();
  const spaced = n("attachmentSpacingIn");
  const method1 = all(flag("attachmentToFraming"), spaced == null ? null : spaced <= 24 ? true :
    all(spaced <= 48, max("snow", 36),
      any(flag("attachmentsOutsideEdgeZone"), max("attachmentEdgeSpacingIn", 24)),
      exposure === "B" ? max("windSpeed", 120) : exposure === "C" ? max("windSpeed", 110) : null));
  const method2 = flag("standingSeamMethod2Compliant");
  const facts: Record<string, Fact> = {
    designInstallation: all(flag("gravityWindDesign"), flag("manufacturerInstallation")),
    framing: any(truss, rafter), truss, rafter, roofing,
    heightFigures: all(max("moduleHeightAboveRoof", 18), flag("moduleFiguresCompliant")),
    attachments: any(method1, method2), method1, method2,
  };
  return Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v === true ? "Yes" : v === false ? "No" : ""]));
}
